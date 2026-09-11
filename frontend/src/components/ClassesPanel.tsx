/**
 * Classes — screenshot-powered schedule import.
 *
 * The rider screenshots their my.harvard enrollment page and drops the
 * image(s) here. The backend reads them with a vision model and returns the
 * structured schedule — course, section, days, times, room, term dates. That
 * is saved to localStorage, and from then on this panel generates the next
 * week of meetings from it and plans an arrival for each.
 *
 * It replaces a Google Calendar integration that Harvard's Workspace admin
 * policy blocks outright (`admin_policy_enforced` on consent, before any of
 * our code runs). A screenshot needs no OAuth, no admin approval, and no
 * account, and carries what the calendar did not: the section meetings.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import {
    Bell,
    BellOff,
    Camera,
    ChevronDown,
    ChevronUp,
    Clock,
    MapPin,
    RefreshCw,
    Trash2,
    TriangleAlert,
    Upload,
} from 'lucide-react';
import clsx from 'clsx';
import { API_BASE_URL } from '@/config';
import { describeFailure, getLocation } from '@/lib/geolocation';
import {
    type Reminder,
    SubscribeError,
    disablePush,
    enablePush,
    fetchPublicKey,
    isPushSupported,
    isReminderEnabled,
    putReminders,
    setReminderEnabled,
} from '@/lib/reminders';
import { textOnRouteColor } from './mapUtils';
import { Alert, AlertActions, AlertContent, AlertDescription, AlertIcon } from './ui/Alert';
import { buttonVariants, cn } from './ui/styles';

// ---------------------------------------------------------------------------
// Stored schedule shape
// ---------------------------------------------------------------------------

/** The server normalises every field before it gets here — each key is always
 * present and of this type. The guards below are for schedules saved by an
 * older build, not for the current endpoint. */
export interface StoredClass {
    id: string;
    title: string;
    code: string;
    section: string;
    location: string;
    days: string[];       // "M","T","W","TH","F","SA","SU"
    start_time: string;   // "HH:MM" 24h
    end_time: string;     // "HH:MM" 24h
    term_start: string;   // "YYYY-MM-DD"
    term_end: string;     // "YYYY-MM-DD"
    /** False when the screenshot had no readable day row or meeting time, so
     * there is nothing to place in the week. Listed, never planned. */
    plannable: boolean;
}

const STORAGE_KEY = 'shuttl:classes:schedule';
const ORIGIN_KEY = 'shuttl:classes:origin';

function loadSchedule(): StoredClass[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch { return []; }
}

function saveSchedule(classes: StoredClass[]) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(classes)); } catch { /* private mode */ }
}

const hasMeeting = (c: StoredClass) => Boolean(c.days?.length && c.start_time && c.end_time);

/** Same course, by code where there is one and by name where there is not. */
function sameCourse(a: StoredClass, b: StoredClass): boolean {
    const codeA = a.code?.trim().toLowerCase();
    const codeB = b.code?.trim().toLowerCase();
    if (codeA && codeB) return codeA === codeB;
    return Boolean(a.title && b.title && a.title.trim().toLowerCase() === b.title.trim().toLowerCase());
}

/** `primary` with its empty fields filled from `fallback`. Keeps primary's id,
 * so the caller decides which half names the result by choosing the order. */
function fillBlanks(primary: StoredClass, fallback: StoredClass): StoredClass {
    const merged: StoredClass = { ...fallback, ...primary };
    for (const key of ['title', 'code', 'section', 'location', 'start_time', 'end_time'] as const) {
        if (!primary[key] && fallback[key]) merged[key] = fallback[key];
    }
    if (!primary.days?.length && fallback.days?.length) merged.days = fallback.days;
    merged.id = primary.id;
    merged.plannable = hasMeeting(merged);
    return merged;
}

/**
 * Fold a freshly parsed batch into the stored schedule.
 *
 * Riders upload a few screenshots at a time, so one course can arrive in
 * pieces across separate uploads: the name and room in today's batch, the day
 * circles and time in the next. The two halves get different ids — the id
 * carries the meeting pattern — so appending blindly would leave a stub row
 * sitting beside the finished one. A record that matches a stored course and
 * completes it replaces it; one that adds nothing merges in and disappears.
 *
 * Two records for the same course that BOTH carry a meeting pattern are left
 * as two rows: that is a lecture and its section, not a split card.
 */
function mergeClasses(existing: StoredClass[], incoming: StoredClass[]): StoredClass[] {
    const out = [...existing];
    for (const next of incoming) {
        const exact = out.findIndex((c) => c.id === next.id);
        if (exact >= 0) {
            out[exact] = fillBlanks(next, out[exact]);
            continue;
        }
        const partial = out.findIndex(
            (c) => sameCourse(c, next) && !(hasMeeting(c) && hasMeeting(next)),
        );
        if (partial >= 0) {
            out[partial] = hasMeeting(next)
                ? fillBlanks(next, out[partial])
                : fillBlanks(out[partial], next);
            continue;
        }
        out.push(next);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Generate upcoming events from stored schedule
// ---------------------------------------------------------------------------

const DAY_MAP: Record<string, number> = { SU: 0, M: 1, T: 2, W: 3, TH: 4, F: 5, SA: 6 };

interface ClassEvent {
    id: string;
    classId: string;
    title: string;
    code: string;
    section: string;
    location: string;
    start: string;   // ISO
    end: string;      // ISO
}

/** A date-only string to local midnight, or null if it is not one. Never an
 * Invalid Date: every comparison against one is false, which silently turns a
 * term-bounds check into no check at all. */
function parseDay(value: string | undefined): Date | null {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const d = new Date(`${value}T00:00:00`);
    return Number.isNaN(d.getTime()) ? null : d;
}

/** "HH:MM" to [hours, minutes], or null. */
function parseClock(value: string | undefined): [number, number] | null {
    const m = /^(\d{1,2}):(\d{2})$/.exec(value ?? '');
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    return h <= 23 && min <= 59 ? [h, min] : null;
}

function upcomingEvents(classes: StoredClass[], hoursAhead: number): ClassEvent[] {
    const now = new Date();
    const horizon = new Date(now.getTime() + hoursAhead * 3600_000);
    const events: ClassEvent[] = [];
    const spanDays = Math.ceil(hoursAhead / 24) + 1;

    for (const c of classes) {
        const termStart = parseDay(c.term_start);
        const termEnd = parseDay(c.term_end);
        const jsDays = (c.days ?? []).map(d => DAY_MAP[d]).filter(d => d !== undefined);
        const startClock = parseClock(c.start_time);
        const endClock = parseClock(c.end_time);
        // No day row or no meeting time means there is no occurrence to place.
        // The course still shows in the list below, flagged.
        if (!jsDays.length || !startClock || !endClock) continue;
        const [startH, startM] = startClock;
        const [endH, endM] = endClock;

        const day = new Date(now);
        day.setHours(0, 0, 0, 0);

        for (let i = 0; i < spanDays; i++) {
            const check = new Date(day);
            check.setDate(day.getDate() + i);

            if (termStart && check < termStart) continue;
            if (termEnd && check > termEnd) continue;
            if (!jsDays.includes(check.getDay())) continue;

            const start = new Date(check);
            start.setHours(startH, startM, 0, 0);
            const end = new Date(check);
            end.setHours(endH, endM, 0, 0);

            if (end < now || start > horizon) continue;

            events.push({
                id: `${c.id}-${start.toISOString().slice(0, 10)}`,
                classId: c.id,
                title: c.title,
                code: c.code,
                section: c.section ?? '',
                location: c.location,
                start: start.toISOString(),
                end: end.toISOString(),
            });
        }
    }
    events.sort((a, b) => a.start.localeCompare(b.start));
    return events;
}

// ---------------------------------------------------------------------------
// /arrival_plan contract (unchanged from before)
// ---------------------------------------------------------------------------

interface PlanStop {
    id: string;
    name: string;
    lat: number;
    lng: number;
    /** Route ids calling at this stop, from /stops. */
    routes?: string[];
}

/** Routes that only run overnight or before the morning. A stop served by
 * nothing else is unusable as the start of a 10am trip, and saying so in the
 * picker is the difference between "this app is broken" and "not that one". */
const OFF_HOURS_ROUTES = new Set(['OVNT', 'QSTA']);

const daytimeServed = (s: PlanStop) =>
    !s.routes?.length || s.routes.some((r) => !OFF_HOURS_ROUTES.has(r));

interface PlanRecommendation {
    route_id: string;
    route_name: string;
    color: string | null;
    board_stop: PlanStop;
    alight_stop: PlanStop;
    depart_at: string;
    be_at_stop_by: string;
    arrive_stop_at: string;
    arrive_dest_at: string;
    slack_minutes: number;
    eta_source: string;
    viable: boolean;
}

interface ArrivalPlan {
    dest: {
        query: string;
        resolved_name: string;
        stop: PlanStop;
        walk_minutes: number;
        confidence: number;
    };
    origin_stop: PlanStop | null;
    options: PlanRecommendation[];
    recommended: PlanRecommendation | null;
}

type PlanState =
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'ok'; plan: ArrivalPlan };

const LOW_CONFIDENCE = 0.6;
/** A week. The calendar version looked 36 hours ahead because a calendar has
 * something in it most days; a class schedule does not. A Monday/Wednesday
 * course uploaded on a Friday evening has no occurrence inside 36 hours, so
 * the panel came up empty and read as broken. Seven days always has the next
 * meeting of every course in it. */
const LOOKAHEAD_HOURS = 168;
const LEAD_MINUTES = 10;

interface ClassesPanelProps {
    systemId: number | undefined;
    onShowOnMap?: (originStopId: string, destStopId: string | null, routeId?: string) => void;
}

// ---------------------------------------------------------------------------
// Time formatting
// ---------------------------------------------------------------------------

function clockParts(iso: string): { value: string; period: string } {
    const d = new Date(iso);
    const parts = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).formatToParts(d);
    const period = parts.find((p) => p.type === 'dayPeriod')?.value ?? '';
    const value = parts
        .filter((p) => p.type !== 'dayPeriod' && !(p.type === 'literal' && p.value.trim() === ''))
        .map((p) => p.value)
        .join('')
        .trim();
    return { value, period };
}

const clock = (iso: string) => {
    const { value, period } = clockParts(iso);
    return period ? `${value} ${period}` : value;
};

/** "Today", "Tomorrow", then the weekday — a week of classes is only legible
 * once it is cut into days, and after tomorrow the date matters as much as the
 * name of the day. */
function dayHeading(iso: string): string {
    const d = new Date(iso);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return 'Today';
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    if (d.toDateString() === tomorrow.toDateString()) return 'Tomorrow';
    return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

interface DayGroup { key: string; label: string; items: ClassEvent[] }

/** Events in day buckets, in order. Events arrive sorted, so one pass keeps
 * them that way inside each bucket too. */
function groupByDay(events: ClassEvent[]): DayGroup[] {
    const groups: DayGroup[] = [];
    for (const ev of events) {
        const key = new Date(ev.start).toDateString();
        const last = groups[groups.length - 1];
        if (last?.key === key) last.items.push(ev);
        else groups.push({ key, label: dayHeading(ev.start), items: [ev] });
    }
    return groups;
}

// ---------------------------------------------------------------------------
// Origin chaining
// ---------------------------------------------------------------------------

const CHAIN_GAP_MINUTES = 60;
const GPS_HORIZON_MINUTES = 60;

interface OriginChoice {
    origin_place?: string;
    origin_stop_id?: string;
    lat?: number;
    lng?: number;
    from: 'gps' | 'previous class' | 'home';
}

function originForEach(
    events: ClassEvent[],
    homeStopId: string,
    coords: { lat: number; lng: number } | null,
    now: Date,
): Record<string, OriginChoice> {
    const out: Record<string, OriginChoice> = {};
    const sorted = [...events].sort((a, b) => a.start.localeCompare(b.start));

    sorted.forEach((ev, i) => {
        const startsInMin = (new Date(ev.start).getTime() - now.getTime()) / 60000;
        if (coords && startsInMin <= GPS_HORIZON_MINUTES) {
            out[ev.id] = { lat: coords.lat, lng: coords.lng, from: 'gps' };
            return;
        }
        const prev = sorted[i - 1];
        if (prev?.location && prev.end) {
            const gapMin = (new Date(ev.start).getTime() - new Date(prev.end).getTime()) / 60000;
            const sameDay = new Date(prev.end).toDateString() === new Date(ev.start).toDateString();
            if (sameDay && gapMin >= 0 && gapMin <= CHAIN_GAP_MINUTES) {
                out[ev.id] = { origin_place: prev.location, from: 'previous class' };
                return;
            }
        }
        out[ev.id] = { origin_stop_id: homeStopId, from: 'home' };
    });
    return out;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const ClassesPanel = ({ systemId, onShowOnMap }: ClassesPanelProps) => {
    const [schedule, setSchedule] = useState<StoredClass[]>(() => loadSchedule());
    const [parsing, setParsing] = useState(false);
    const [parseError, setParseError] = useState<string | null>(null);
    const [dragOver, setDragOver] = useState(false);
    const fileRef = useRef<HTMLInputElement>(null);

    // Generated events from stored schedule
    const [events, setEvents] = useState<ClassEvent[]>([]);
    useEffect(() => {
        setEvents(upcomingEvents(schedule, LOOKAHEAD_HOURS));
    }, [schedule]);

    // Origin
    const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
    const [locating, setLocating] = useState(false);
    const [locError, setLocError] = useState<string | null>(null);
    const [stops, setStops] = useState<PlanStop[]>([]);
    const [manualStopId, setManualStopIdState] = useState<string>(() => {
        try { return localStorage.getItem(ORIGIN_KEY) ?? ''; } catch { return ''; }
    });
    const setManualStopId = (id: string) => {
        setManualStopIdState(id);
        try {
            if (id) localStorage.setItem(ORIGIN_KEY, id);
            else localStorage.removeItem(ORIGIN_KEY);
        } catch { /* private mode */ }
    };
    const [showStopPicker, setShowStopPicker] = useState(false);
    const [showCourses, setShowCourses] = useState(false);
    const needsAttention = schedule.some((c) => c.plannable === false);
    // A stop chosen by hand is an origin in its own right and survives a
    // reload; the GPS fix does not. Keying the rows off coords alone told a
    // rider with a saved stop to "pick a starting stop" while their plans were
    // already loading behind the message.
    const hasOrigin = Boolean(coords || manualStopId);
    const chosenStop = stops.find((s) => String(s.id) === manualStopId);

    // Plans
    const [plans, setPlans] = useState<Record<string, PlanState>>({});
    const planGen = useRef(0);
    const [selectedId, setSelectedId] = useState<string | null>(null);

    // The next class is the question the panel was opened to answer, so it is
    // the one row that starts expanded. Everything behind it stays a single
    // line until asked for — a week of classes is fifteen rows, and fifteen
    // expanded plans is a wall. Collapsing it by hand sticks: the effect only
    // reaches for a default when the current pick is gone.
    useEffect(() => {
        setSelectedId((cur) => (cur && events.some((e) => e.id === cur) ? cur : events[0]?.id ?? null));
    }, [events]);

    // Reminders
    const [publicKey, setPublicKey] = useState<string | null | undefined>(undefined);
    const [remindOn, setRemindOn] = useState<boolean>(() => isReminderEnabled());
    const [remindBusy, setRemindBusy] = useState(false);
    const [remindError, setRemindError] = useState<string | null>(null);
    const pushAvailable = isPushSupported() && Boolean(publicKey);

    // -- screenshot parse ------------------------------------------------------

    const parseScreenshots = useCallback(async (files: File[]) => {
        const images = files.filter(f => f.type.startsWith('image/'));
        if (images.length === 0) return;
        setParsing(true);
        setParseError(null);
        try {
            const form = new FormData();
            for (const img of images) form.append('images', img);
            const res = await fetch(`${API_BASE_URL}/parse-schedule`, { method: 'POST', body: form });
            if (!res.ok) {
                const err = await res.json().catch(() => ({ detail: `Server error ${res.status}` }));
                throw new Error(err.detail || `Parse failed (${res.status})`);
            }
            const data = await res.json() as { classes?: StoredClass[] };
            const parsed = Array.isArray(data.classes) ? data.classes : [];
            if (parsed.length === 0) throw new Error('No courses were found in those screenshots.');
            const merged = mergeClasses(schedule, parsed);
            setSchedule(merged);
            saveSchedule(merged);
        } catch (e) {
            setParseError(e instanceof Error ? e.message : 'Could not parse screenshots');
        } finally {
            setParsing(false);
        }
    }, [schedule]);

    const handleDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setDragOver(false);
        const files = Array.from(e.dataTransfer.files);
        if (files.length) void parseScreenshots(files);
    }, [parseScreenshots]);

    const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files ?? []);
        if (files.length) void parseScreenshots(files);
        e.target.value = '';
    }, [parseScreenshots]);

    const removeClass = (id: string) => {
        const updated = schedule.filter(c => c.id !== id);
        setSchedule(updated);
        saveSchedule(updated);
    };

    const clearSchedule = () => {
        setSchedule([]);
        saveSchedule([]);
        setPlans({});
        if (selectedId) onShowOnMap?.('', null);
        setSelectedId(null);
    };

    // -- origin ----------------------------------------------------------------

    const locate = useCallback((force = false) => {
        setLocating(true);
        setLocError(null);
        void getLocation(force).then((result) => {
            setLocating(false);
            if (result.coords) { setCoords(result.coords); return; }
            if (result.failure) { setLocError(describeFailure(result.failure)); setShowStopPicker(true); }
        });
    }, []);

    useEffect(() => {
        if (schedule.length > 0) locate();
    }, [schedule.length, locate]);

    useEffect(() => {
        // Also fetched when a stop is already saved but the picker is shut:
        // the saved stop still has to be checked for service before its plans
        // are trusted, and that check needs the list.
        if ((!showStopPicker && !manualStopId) || !systemId || stops.length > 0) return;
        fetch(`${API_BASE_URL}/stops?system_id=${systemId}`)
            .then((r) => (r.ok ? r.json() : []))
            .then((d: PlanStop[]) => setStops(d || []))
            .catch(() => setStops([]));
    }, [showStopPicker, manualStopId, systemId, stops.length]);

    const chooseStop = (stopId: string) => {
        setManualStopId(stopId);
        const stop = stops.find((s) => String(s.id) === stopId);
        if (!stop) return;
        setCoords({ lat: stop.lat, lng: stop.lng });
        setLocError(null);
    };

    // -- plans -----------------------------------------------------------------

    // Where each class is travelled from, one entry per event. A rider's day
    // is a chain, not a series of trips from one fixed point: the 10am starts
    // at home, the 11:30 starts wherever the 10am let out. Recomputed whenever
    // the events or either origin changes, and shared by the plans below and
    // the reminders further down so the card and the notification agree.
    const origins = useMemo(
        () => originForEach(events, manualStopId, coords, new Date()),
        [events, manualStopId, coords],
    );

    useEffect(() => {
        if (!events.length || !hasOrigin) return;
        const gen = ++planGen.current;
        setPlans(Object.fromEntries(events.map((e) => [e.id, { status: 'loading' } as PlanState])));

        for (const ev of events) {
            const from = origins[ev.id];
            const params = new URLSearchParams({ dest: ev.location || ev.title, arrive_by: ev.start });
            // A named room beats a stop id: the planner resolves "Emerson 305"
            // to the stop that actually serves it, which is the whole point of
            // starting from the previous class rather than from home.
            if (from?.origin_place) params.set('origin_place', from.origin_place);
            else if (from?.origin_stop_id) params.set('origin_stop_id', from.origin_stop_id);
            else if (from?.lat != null && from?.lng != null) {
                params.set('lat', String(from.lat));
                params.set('lng', String(from.lng));
            } else {
                // A class far enough out that the GPS fix is meaningless, with
                // no home stop to fall back on. Say so rather than leaving the
                // row on a skeleton that never resolves.
                setPlans((p) => ({
                    ...p,
                    [ev.id]: { status: 'error', message: 'Set a home stop to plan this one.' },
                }));
                continue;
            }
            fetch(`${API_BASE_URL}/arrival_plan?${params}`)
                .then(async (res) => {
                    if (res.status === 404) throw new Error('Planner unavailable right now.');
                    if (!res.ok) throw new Error(`Could not plan this trip (${res.status}).`);
                    return (await res.json()) as ArrivalPlan;
                })
                .then(
                    (plan) => { if (gen === planGen.current) setPlans((p) => ({ ...p, [ev.id]: { status: 'ok', plan } })); },
                    (e: unknown) => {
                        if (gen === planGen.current) setPlans((p) => ({
                            ...p, [ev.id]: { status: 'error', message: e instanceof Error ? e.message : 'Could not plan this trip.' },
                        }));
                    },
                );
        }
    }, [events, origins, hasOrigin]);

    const toggleRow = (ev: ClassEvent) => {
        const state = plans[ev.id];
        const rec = state?.status === 'ok' ? state.plan.recommended : null;
        if (!rec) return;
        const opening = selectedId !== ev.id;
        setSelectedId(opening ? ev.id : null);
        if (opening) onShowOnMap?.(rec.board_stop.id, rec.alight_stop.id, rec.route_id);
        else onShowOnMap?.(rec.board_stop.id, null);
    };

    // -- reminders -------------------------------------------------------------

    useEffect(() => { if (!isPushSupported()) { setPublicKey(null); return; } void fetchPublicKey().then(setPublicKey); }, []);

    useEffect(() => {
        if (!remindOn || !pushAvailable || !events.length || !hasOrigin) return;
        // The same chain the cards use. The server re-plans each reminder at
        // send time, so it needs to know that the 11:30 is reached from the
        // 10am's room — planning it from home would send the rider to the
        // wrong stop, at the wrong time, for a bus they are nowhere near.
        const reminders: Reminder[] = events.map((ev) => {
            const from = origins[ev.id];
            return {
                id: ev.id,
                title: ev.title,
                arrive_by: ev.start,
                dest: ev.location || ev.title,
                origin_place: from?.origin_place ?? null,
                origin_stop_id: from?.origin_stop_id ?? null,
                origin_lat: from?.lat ?? null,
                origin_lng: from?.lng ?? null,
                lead_minutes: LEAD_MINUTES,
            };
        });
        putReminders(reminders).catch((e: unknown) => {
            setRemindError(e instanceof Error ? e.message : 'Could not save reminders.');
        });
    }, [remindOn, pushAvailable, events, origins, hasOrigin]);

    const toggleRemind = async () => {
        if (!publicKey || remindBusy) return;
        setRemindBusy(true);
        setRemindError(null);
        try {
            if (remindOn) {
                await disablePush();
                setReminderEnabled(false);
                setRemindOn(false);
            } else {
                await enablePush(publicKey);
                setReminderEnabled(true);
                setRemindOn(true);
            }
        } catch (e) {
            if (e instanceof SubscribeError && e.reason === 'denied') {
                setRemindError('Notifications blocked for this site. Allow them in browser settings.');
            } else {
                setRemindError(e instanceof Error ? e.message : 'Could not change reminders.');
            }
        } finally { setRemindBusy(false); }
    };

    // -- render: empty state (no schedule) ------------------------------------

    if (schedule.length === 0 && !parsing) {
        return (
            <div className="flex flex-col flex-1 min-h-0 pt-1">
                {parseError && (
                    <Alert variant="warning" className="mb-2">
                        <AlertIcon><TriangleAlert size={12} /></AlertIcon>
                        <AlertContent><AlertDescription>{parseError}</AlertDescription></AlertContent>
                    </Alert>
                )}
                <div
                    className={clsx(
                        'flex flex-1 flex-col items-center justify-center gap-3 py-8 text-center rounded-xl border-2 border-dashed transition-colors cursor-pointer',
                        dragOver ? 'border-crimson/60 bg-crimson/5' : 'border-white/10 bg-transparent',
                    )}
                    onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={handleDrop}
                    onClick={() => fileRef.current?.click()}
                >
                    <Camera size={22} className="text-crimson" />
                    <div>
                        <p className="text-[12px] font-semibold text-white">Screenshot your schedule</p>
                        <p className="mt-1 max-w-[260px] text-[11px] leading-relaxed text-neutral-500">
                            Open my.harvard → Enrollments and screenshot as you scroll.
                            Drop them here in any order — a few at a time is fine, and you
                            can add the rest later.
                        </p>
                    </div>
                    <div className={cn(buttonVariants({ variant: 'primary', size: 'md' }), 'pointer-events-none')}>
                        <Upload size={14} />
                        Upload Screenshots
                    </div>
                    {/* The sheet can be dragged back down over this, and a
                        half-covered drop zone reads as an app that does
                        nothing. Say where the rest of it went. */}
                    <p className="flex items-center gap-1 text-[9px] text-neutral-500 md:hidden">
                        <ChevronUp size={10} />
                        Swipe up on the bar above for the full form
                    </p>
                    <p className="max-w-[280px] text-[9px] leading-relaxed text-neutral-600">
                        Screenshots are sent to OpenAI to be read, and are not stored by
                        either service afterwards. Your schedule stays on this device.
                    </p>
                </div>
                <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    onChange={handleFileChange}
                />
            </div>
        );
    }

    // -- render: parsing state ------------------------------------------------

    if (parsing) {
        return (
            <div className="flex flex-col flex-1 min-h-0 pt-1">
                <div className="flex flex-1 flex-col items-center justify-center gap-3 py-8 text-center">
                    <RefreshCw size={22} className="text-crimson animate-spin" />
                    <p className="text-[12px] font-semibold text-white">Reading your schedule…</p>
                    <p className="text-[11px] text-neutral-500">This takes a few seconds.</p>
                </div>
            </div>
        );
    }

    // -- render: schedule loaded ----------------------------------------------

    return (
        <div className="flex flex-col flex-1 min-h-0 pt-1">
            {/* Header */}
            <div className="flex items-center justify-between shrink-0 pb-2">
                <div className="flex items-center gap-1.5 min-w-0">
                    <Camera size={12} className="text-crimson shrink-0" />
                    <span className="text-[11px] text-neutral-300 truncate">
                        {schedule.length} class{schedule.length !== 1 ? 'es' : ''} loaded
                    </span>
                </div>
                <div className="flex items-center gap-0.5">
                    <button
                        type="button"
                        onClick={() => setShowStopPicker((v) => !v)}
                        aria-label="Choose starting stop"
                        className={cn(buttonVariants({ variant: 'ghost', size: 'iconSm' }), 'ml-auto')}
                    >
                        <MapPin size={12} />
                    </button>
                    <button
                        type="button"
                        onClick={() => fileRef.current?.click()}
                        aria-label="Add more screenshots"
                        className={buttonVariants({ variant: 'ghost', size: 'iconSm' })}
                    >
                        <Camera size={12} />
                    </button>
                    <button
                        type="button"
                        onClick={clearSchedule}
                        aria-label="Clear schedule"
                        className={cn(buttonVariants({ variant: 'ghost', size: 'iconSm' }), 'text-neutral-500 hover:text-crimson')}
                    >
                        <Trash2 size={12} />
                    </button>
                </div>
            </div>

            {/* Reminders */}
            {pushAvailable && (
                <div className="flex items-center justify-between gap-2 shrink-0 pb-2">
                    <span className="text-[10px] text-neutral-500">
                        {remindOn
                            ? `Notification ${LEAD_MINUTES} min before you need to leave.`
                            : 'Get a nudge when it is time to leave for the stop.'}
                    </span>
                    <button
                        type="button"
                        role="switch"
                        aria-checked={remindOn}
                        disabled={remindBusy}
                        onClick={() => void toggleRemind()}
                        className={cn(buttonVariants({ variant: remindOn ? 'selected' : 'secondary', size: 'sm' }), 'shrink-0')}
                    >
                        {remindOn ? <Bell size={11} /> : <BellOff size={11} />}
                        Remind me
                    </button>
                </div>
            )}

            {(parseError || locError || remindError) && (
                <Alert variant="warning" className="mb-2">
                    <AlertIcon><TriangleAlert size={12} /></AlertIcon>
                    <AlertContent>
                        <AlertDescription>{parseError ?? locError ?? remindError}</AlertDescription>
                        {locError && (
                            <AlertActions>
                                <button type="button" onClick={() => locate(true)} className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
                                    Try again
                                </button>
                            </AlertActions>
                        )}
                    </AlertContent>
                </Alert>
            )}

            {showStopPicker && (
                <div className="mb-2 shrink-0">
                    <label className="mb-1 flex items-center gap-1 px-0.5 text-[9px] font-bold uppercase tracking-wider text-neutral-500">
                        <MapPin size={9} /> Home stop
                    </label>
                    <p className="mb-1.5 px-0.5 text-[9px] leading-relaxed text-neutral-500">
                        Where your day starts. Classes with a gap before them are planned
                        from here; back-to-back ones are planned from the class before.
                    </p>
                    <select
                        value={manualStopId}
                        onChange={(e) => chooseStop(e.target.value)}
                        className="w-full rounded-lg border border-white/5 bg-neutral-800/60 px-2.5 py-2 text-[11px] text-white outline-none focus:border-crimson/50"
                    >
                        <option value="">Choose a stop…</option>
                        {stops.map((s) => (
                            <option key={s.id} value={s.id}>
                                {s.name}
                                {!daytimeServed(s) && ` — ${s.routes?.join('/')} only, no daytime service`}
                            </option>
                        ))}
                    </select>
                    {chosenStop && !daytimeServed(chosenStop) && (
                        <p className="mt-1 px-0.5 text-[9px] leading-relaxed text-crimson-light">
                            {chosenStop.name} is only served by {chosenStop.routes?.join(' and ')} — overnight and
                            early morning. Daytime classes cannot be planned from here.
                        </p>
                    )}
                </div>
            )}

            {/* Event list */}
            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain touch-pan-y custom-scrollbar pr-1 pb-2 space-y-1.5">
                {events.length > 0 && (
                    <p className="text-[10px] font-bold uppercase tracking-wider text-neutral-500">
                        {locating ? 'Finding you…' : manualStopId ? 'From your chosen stop' : coords ? 'From where you are' : 'Pick a starting stop'}
                    </p>
                )}

                {events.length === 0 && (
                    <div className="py-6 text-center">
                        <p className="text-[11px] text-neutral-400">No upcoming classes.</p>
                        <p className="mt-1 text-[10px] text-neutral-500">
                            {schedule.some((c) => c.plannable === false)
                                ? 'Some courses had no readable meeting time — see the list below.'
                                : `Nothing on your schedule meets in the next ${Math.round(LOOKAHEAD_HOURS / 24)} days.`}
                        </p>
                    </div>
                )}

                {groupByDay(events).map(({ key, label, items }) => (
                    <div key={key} className="space-y-1">
                        <p className="px-0.5 pt-1.5 text-[9px] font-bold uppercase tracking-wider text-neutral-600">
                            {label}
                        </p>
                        {items.map((ev) => (
                            <ClassRow
                                key={ev.id}
                                event={ev}
                                state={hasOrigin ? plans[ev.id] : undefined}
                                hasOrigin={hasOrigin}
                                origin={origins[ev.id]}
                                open={selectedId === ev.id}
                                onClick={() => toggleRow(ev)}
                            />
                        ))}
                    </div>
                ))}

                {/* The stored courses. Folded away by default: it repeats what
                    the day groups above already say, and its real jobs —
                    deleting one course, and flagging a card that parsed
                    without a meeting time — are occasional. A course that
                    needs attention opens it unprompted. */}
                <div className="pt-3 border-t border-white/5">
                    <button
                        type="button"
                        onClick={() => setShowCourses((v) => !v)}
                        aria-expanded={showCourses || needsAttention}
                        className="flex w-full items-center justify-between py-0.5 text-left"
                    >
                        <span className="text-[9px] font-bold uppercase tracking-wider text-neutral-600">
                            Your courses · {schedule.length}
                        </span>
                        {needsAttention ? (
                            <span className="text-[9px] font-semibold text-crimson-light">
                                {schedule.filter((c) => c.plannable === false).length} need a re-shot
                            </span>
                        ) : (
                            <ChevronDown
                                size={11}
                                className={clsx('text-neutral-600 transition-transform', showCourses && 'rotate-180')}
                            />
                        )}
                    </button>
                </div>

                <div className={clsx(!(showCourses || needsAttention) && 'hidden')}>
                    {schedule.map((c) => (
                        <div key={c.id} className="flex items-center justify-between py-1 group">
                            <div className="min-w-0">
                                <p className="truncate text-[11px] text-neutral-300">
                                    {c.title}
                                    {c.section && <span className="text-neutral-500"> · {c.section}</span>}
                                </p>
                                {c.plannable === false ? (
                                    <p className="text-[9px] text-crimson-light">
                                        {c.code} · no meeting time read — screenshot this card again
                                    </p>
                                ) : (
                                    <p className="truncate text-[9px] text-neutral-500">
                                        {[c.code, (c.days ?? []).join('/'), `${c.start_time}–${c.end_time}`, c.location]
                                            .filter(Boolean)
                                            .join(' · ')}
                                    </p>
                                )}
                            </div>
                            <button
                                type="button"
                                onClick={() => removeClass(c.id)}
                                className="shrink-0 p-1 opacity-0 group-hover:opacity-100 transition-opacity text-neutral-600 hover:text-crimson"
                                aria-label={`Remove ${c.title}`}
                            >
                                <Trash2 size={10} />
                            </button>
                        </div>
                    ))}
                </div>
            </div>

            <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={handleFileChange} />
        </div>
    );
};

// ---------------------------------------------------------------------------
// ClassRow — same visual grammar as the old version
// ---------------------------------------------------------------------------

const ClassRow = ({
    event: ev,
    state,
    hasOrigin,
    origin,
    open,
    onClick,
}: {
    event: ClassEvent;
    state: PlanState | undefined;
    hasOrigin: boolean;
    origin: OriginChoice | undefined;
    open: boolean;
    onClick: () => void;
}) => {
    const plan = state?.status === 'ok' ? state.plan : null;
    const rec = plan?.recommended ?? null;
    const lowConfidence = plan != null && plan.dest.confidence < LOW_CONFIDENCE;
    const tappable = Boolean(rec);

    return (
        <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18 }}
            className={clsx(
                'overflow-hidden rounded-xl transition-colors',
                open ? 'bg-neutral-800/80 ring-1 ring-crimson/40' : 'bg-neutral-800/40',
            )}
        >
            <button
                type="button"
                onClick={onClick}
                disabled={!tappable}
                aria-pressed={open}
                className={clsx('w-full px-3 py-2.5 text-left', tappable && 'hover:bg-white/5')}
            >
                <div className="flex items-center gap-2.5">
                    <span
                        className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-black"
                        style={
                            rec
                                ? { backgroundColor: rec.color ?? '#525252', color: textOnRouteColor(rec.color) }
                                : { backgroundColor: 'rgba(82,82,82,0.5)', color: '#a3a3a3' }
                        }
                    >
                        {rec ? rec.route_id : '—'}
                    </span>

                    <div className="min-w-0 flex-1">
                        <p className="truncate text-[12px] font-semibold leading-tight text-white">
                            {ev.title}
                            {ev.section && ev.section !== 'Lecture' && (
                                <span className="font-normal text-neutral-400"> · {ev.section}</span>
                            )}
                        </p>
                        {/* The day is the group heading above, so the row only
                            carries the clock time. */}
                        <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-neutral-400">
                            <span className="inline-flex shrink-0 items-center gap-0.5 tabular-nums">
                                <Clock size={9} />
                                {clock(ev.start)}
                            </span>
                            {ev.location && (
                                <>
                                    <span className="text-neutral-600">·</span>
                                    <span className="truncate">{ev.location}</span>
                                </>
                            )}
                        </div>
                    </div>

                    <div className="shrink-0 text-right">
                        <p className="text-[9px] font-bold uppercase tracking-wider text-neutral-500">Be at stop</p>
                        {rec ? (
                            <BigClock iso={rec.be_at_stop_by} muted={!rec.viable} />
                        ) : (
                            <p className="text-[17px] font-bold leading-none text-neutral-600">—</p>
                        )}
                    </div>
                </div>

                {/* The full plan is only drawn for the open row. Every row
                    carrying its own "be at X by Y, route Z departs…" block is
                    what turned a week of classes into a wall of near-identical
                    paragraphs; collapsed, the figure on the right is the
                    answer and the rest is one tap away. */}
                {open && (
                    <div className="mt-2 border-t border-white/5 pt-2">
                        {!hasOrigin && (
                            <p className="text-[10px] text-neutral-500">Pick a starting stop to plan this one.</p>
                        )}
                        {hasOrigin && (!state || state.status === 'loading') && (
                            <div className="space-y-1.5">
                                <div className="h-2.5 w-2/3 animate-pulse rounded bg-neutral-700/50" />
                                <div className="h-2.5 w-1/2 animate-pulse rounded bg-neutral-700/50" />
                            </div>
                        )}
                        {state?.status === 'error' && (
                            <p className="text-[10px] text-neutral-500">{state.message}</p>
                        )}
                        {plan && !rec && (
                            <>
                                <p className="text-[11px] font-bold text-crimson-light">No shuttle gets there in time.</p>
                                <ResolvedDest plan={plan} lowConfidence={lowConfidence} />
                            </>
                        )}
                        {plan && rec && (
                            <div className="space-y-1">
                                <p className="text-[11px] leading-snug text-neutral-300">
                                    Be at <span className="font-semibold text-white">{rec.board_stop.name}</span> by{' '}
                                    <span className="font-semibold tabular-nums text-white">{clock(rec.be_at_stop_by)}</span>
                                </p>
                                <p className="text-[10px] leading-snug text-neutral-400 tabular-nums">
                                    <span className="font-semibold text-neutral-300">{rec.route_id}</span> departs {clock(rec.depart_at)}
                                    {' → '}
                                    {rec.alight_stop.name} {clock(rec.arrive_stop_at)}
                                    {plan.dest.walk_minutes > 0 && (
                                        <span className="text-neutral-500">
                                            {' '}· {Math.max(1, Math.round(plan.dest.walk_minutes))} min walk
                                        </span>
                                    )}
                                </p>
                                <div className="flex items-center justify-between gap-2">
                                    <Slack rec={rec} />
                                    <ResolvedDest plan={plan} lowConfidence={lowConfidence} />
                                </div>
                                {/* Which end of the chain this plan starts
                                    from. Without it "be at Harvard Square by
                                    11:43" is unfalsifiable — the rider cannot
                                    tell whether it assumed they are at home or
                                    walking out of their last class. */}
                                {origin && (
                                    <p className="pt-0.5 text-[9px] text-neutral-500">
                                        {origin.from === 'previous class'
                                            ? `Starting from your last class · ${origin.origin_place}`
                                            : origin.from === 'gps'
                                                ? 'Starting from where you are now'
                                                : 'Starting from your home stop'}
                                    </p>
                                )}
                            </div>
                        )}
                    </div>
                )}
            </button>
        </motion.div>
    );
};

const BigClock = ({ iso, muted }: { iso: string; muted: boolean }) => {
    const { value, period } = clockParts(iso);
    return (
        <p className="flex items-baseline justify-end gap-0.5 leading-none tabular-nums">
            <span className={clsx('text-[17px] font-bold', muted ? 'text-neutral-500 line-through decoration-crimson-light/70' : 'text-white')}>
                {value}
            </span>
            {period && <span className="text-[10px] font-semibold text-neutral-400">{period}</span>}
        </p>
    );
};

const Slack = ({ rec }: { rec: PlanRecommendation }) => {
    if (!rec.viable) return <span className="text-[10px] font-bold text-crimson-light">Won't make it</span>;
    const m = Math.round(rec.slack_minutes);
    if (m <= 0) return <span className="text-[10px] font-bold text-crimson-light">Cutting it fine</span>;
    return (
        <span className="text-[10px] text-neutral-400 tabular-nums">
            {m} min spare
            {rec.eta_source === 'schedule' && <span className="text-neutral-500"> · scheduled, approx.</span>}
        </span>
    );
};

const ResolvedDest = ({ plan, lowConfidence }: { plan: ArrivalPlan; lowConfidence: boolean }) => (
    <span className="min-w-0 truncate text-[10px] text-neutral-500">
        → {plan.dest.resolved_name || plan.dest.stop.name}
        {lowConfidence && <span className="text-crimson-light"> · best guess, check the stop</span>}
    </span>
);
