/**
 * Classes.
 *
 * Next Bus Out answers "what is leaving from here". Plan Trip answers "how do
 * I get from A to B". Neither answers the question a student actually has at
 * 9:40: "when do I need to leave for my 10:30". The calendar already knows the
 * where and the when, so this reads it and works backwards — for each class,
 * which shuttle, which stop, and the one number that matters: the time to be
 * standing at it.
 *
 * The list keeps Next Bus Out's visual grammar on purpose — route badge, a
 * big white figure on the right, small grey labels — so a rider who knows one
 * mode can read the other. The difference is what the figure means: there it
 * is minutes until a bus, here it is a clock time to be at a stop, because
 * "be there by 10:04" is what you set an alarm to and "in 23 minutes" is not.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import {
    Bell,
    BellOff,
    CalendarDays,
    Clock,
    Info,
    LogOut,
    MapPin,
    RefreshCw,
    TriangleAlert,
} from 'lucide-react';
import clsx from 'clsx';
import { API_BASE_URL } from '@/config';
import { describeFailure, getLocation } from '@/lib/geolocation';
import {
    type CalendarEvent,
    NotSignedInError,
    getAccountEmail,
    isCalendarConfigured,
    isSignedIn,
    listUpcomingEvents,
    signIn,
    signOut,
} from '@/lib/googleCalendar';
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
import { Alert, AlertActions, AlertContent, AlertDescription, AlertIcon, AlertTitle } from './ui/Alert';
import { buttonVariants, cn } from './ui/styles';

// ---------------------------------------------------------------------------
// /arrival_plan contract
// ---------------------------------------------------------------------------

interface PlanStop {
    id: string;
    name: string;
    lat: number;
    lng: number;
}

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

// Below this the geocoder is guessing between similarly named buildings, and
// the rider should glance at the resolved name before trusting the stop.
const LOW_CONFIDENCE = 0.6;
const LOOKAHEAD_HOURS = 36;
const LEAD_MINUTES = 10;

interface ClassesPanelProps {
    systemId: number | undefined;
    /**
     * Show a class's plan on the map, or clear it when passed a null
     * destination. Same callback Next Bus Out uses, so the drawn route, the
     * framing and the live refresh are the planner's — not a copy kept here.
     */
    onShowOnMap?: (originStopId: string, destStopId: string | null, routeId?: string) => void;
}

// ---------------------------------------------------------------------------
// Time formatting. Plans are all clock times, so the figure and its AM/PM are
// split the way ETA figures split from "min": the digits are the content.
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

/** "10:30" today, "Tomorrow 10:30", or "Thu 10:30" further out. */
function whenLabel(iso: string): string {
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return clock(iso);
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    if (d.toDateString() === tomorrow.toDateString()) return `Tomorrow ${clock(iso)}`;
    return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${clock(iso)}`;
}

// ---------------------------------------------------------------------------

export const ClassesPanel = ({ systemId, onShowOnMap }: ClassesPanelProps) => {
    const configured = isCalendarConfigured();

    // Calendar
    const [signedIn, setSignedIn] = useState<boolean>(() => isSignedIn());
    const [email, setEmail] = useState<string | null>(null);
    const [events, setEvents] = useState<CalendarEvent[] | null>(null);
    const [eventsLoading, setEventsLoading] = useState(false);
    const [authError, setAuthError] = useState<string | null>(null);

    // Origin. Same fallback as Next Bus Out: geolocation fails often enough on
    // desktop that a mode built on it needs a hand-picked stop as a way in.
    const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
    const [locating, setLocating] = useState(false);
    const [locError, setLocError] = useState<string | null>(null);
    const [stops, setStops] = useState<PlanStop[]>([]);
    // The stop reminders and plans leave from, when the rider has chosen one.
    // Remembered across visits: a reminder is planned on the server from the
    // origin sent with it, and "where you were when the calendar loaded" is
    // the wrong origin by the time the class is near. A chosen stop — the
    // dorm's — is right every morning.
    const [manualStopId, setManualStopIdState] = useState<string>(() => {
        try { return localStorage.getItem('shuttl:classes:origin') ?? ''; } catch { return ''; }
    });
    const setManualStopId = (id: string) => {
        setManualStopIdState(id);
        try { id ? localStorage.setItem('shuttl:classes:origin', id) : localStorage.removeItem('shuttl:classes:origin'); } catch { /* private mode */ }
    };
    const [showStopPicker, setShowStopPicker] = useState(false);

    // Plans, one per event, filled in as each arrives rather than all at once:
    // the first class of the day is the one being asked about, and it should
    // not wait on a geocode for tomorrow's seminar.
    const [plans, setPlans] = useState<Record<string, PlanState>>({});
    const planGen = useRef(0);
    const [selectedId, setSelectedId] = useState<string | null>(null);

    // Reminders. `publicKey` undefined = still asking; null = server has no
    // push configured, which hides the toggle.
    const [publicKey, setPublicKey] = useState<string | null | undefined>(undefined);
    const [remindOn, setRemindOn] = useState<boolean>(() => isReminderEnabled());
    const [remindBusy, setRemindBusy] = useState(false);
    const [remindError, setRemindError] = useState<string | null>(null);

    const pushAvailable = isPushSupported() && Boolean(publicKey);

    // -- calendar -----------------------------------------------------------

    const loadEvents = useCallback(async () => {
        setEventsLoading(true);
        setAuthError(null);
        try {
            const [list, who] = await Promise.all([listUpcomingEvents(LOOKAHEAD_HOURS), getAccountEmail()]);
            setEvents(list);
            setEmail(who);
            setSelectedId(null);
        } catch (e) {
            if (e instanceof NotSignedInError) {
                // Token lapsed under us; back to the Connect button, quietly.
                setSignedIn(false);
                setEvents(null);
                setEmail(null);
            } else {
                setAuthError(e instanceof Error ? e.message : 'Could not load your calendar.');
            }
        } finally {
            setEventsLoading(false);
        }
    }, []);

    useEffect(() => {
        if (signedIn) void loadEvents();
    }, [signedIn, loadEvents]);

    const connect = async () => {
        setAuthError(null);
        try {
            await signIn();
            setSignedIn(true);
        } catch (e) {
            setAuthError(e instanceof Error ? e.message : 'Sign-in failed.');
        }
    };

    const disconnect = () => {
        signOut();
        setSignedIn(false);
        setEvents(null);
        setEmail(null);
        setPlans({});
        // A plan drawn from a class that is no longer listed would be a trip
        // nothing on screen refers to.
        if (selectedId) onShowOnMap?.('', null);
        setSelectedId(null);
    };

    // -- origin -------------------------------------------------------------

    const locate = useCallback((force = false) => {
        setLocating(true);
        setLocError(null);
        void getLocation(force).then((result) => {
            setLocating(false);
            if (result.coords) {
                setCoords(result.coords);
                return;
            }
            if (result.failure) {
                setLocError(describeFailure(result.failure));
                setShowStopPicker(true);
            }
        });
    }, []);

    useEffect(() => {
        if (configured && signedIn) locate();
    }, [configured, signedIn, locate]);

    useEffect(() => {
        if (!showStopPicker || !systemId || stops.length > 0) return;
        fetch(`${API_BASE_URL}/stops?system_id=${systemId}`)
            .then((r) => (r.ok ? r.json() : []))
            .then((d: PlanStop[]) => setStops(d || []))
            .catch(() => setStops([]));
    }, [showStopPicker, systemId, stops.length]);

    const chooseStop = (stopId: string) => {
        setManualStopId(stopId);
        const stop = stops.find((s) => String(s.id) === stopId);
        if (!stop) return;
        setCoords({ lat: stop.lat, lng: stop.lng });
        setLocError(null);
    };

    // -- plans --------------------------------------------------------------

    useEffect(() => {
        if (!events || (!coords && !manualStopId)) return;
        const gen = ++planGen.current;
        setPlans(Object.fromEntries(events.map((e) => [e.id, { status: 'loading' } as PlanState])));

        for (const ev of events) {
            // A chosen stop is the origin; a GPS fix only stands in when none
            // is chosen. Same rule the reminders use, so the plan on screen
            // and the notification agree.
            const params = new URLSearchParams({ dest: ev.location ?? ev.title, arrive_by: ev.start });
            if (manualStopId) params.set('origin_stop_id', manualStopId);
            else if (coords) { params.set('lat', coords.lat.toString()); params.set('lng', coords.lng.toString()); }
            fetch(`${API_BASE_URL}/arrival_plan?${params}`)
                .then(async (res) => {
                    if (res.status === 404) throw new Error('Planner unavailable right now.');
                    if (!res.ok) throw new Error(`Could not plan this trip (${res.status}).`);
                    return (await res.json()) as ArrivalPlan;
                })
                .then(
                    (plan) => {
                        if (gen !== planGen.current) return;
                        setPlans((p) => ({ ...p, [ev.id]: { status: 'ok', plan } }));
                    },
                    (e: unknown) => {
                        if (gen !== planGen.current) return;
                        setPlans((p) => ({
                            ...p,
                            [ev.id]: {
                                status: 'error',
                                message: e instanceof Error ? e.message : 'Could not plan this trip.',
                            },
                        }));
                    },
                );
        }
    }, [events, coords, manualStopId]);

    const refresh = () => {
        if (!signedIn) return;
        void loadEvents();
        if (!coords) locate(true);
    };

    const toggleRow = (ev: CalendarEvent) => {
        const state = plans[ev.id];
        const rec = state?.status === 'ok' ? state.plan.recommended : null;
        if (!rec) return;
        const opening = selectedId !== ev.id;
        setSelectedId(opening ? ev.id : null);
        if (opening) onShowOnMap?.(rec.board_stop.id, rec.alight_stop.id, rec.route_id);
        else onShowOnMap?.(rec.board_stop.id, null);
    };

    // -- reminders ----------------------------------------------------------

    useEffect(() => {
        if (!isPushSupported()) {
            setPublicKey(null);
            return;
        }
        void fetchPublicKey().then(setPublicKey);
    }, []);

    // Whenever the list changes and reminders are on, the server gets the new
    // list. Origin travels with it so the server can plan from where the
    // rider was, not from a stop it has to guess.
    useEffect(() => {
        if (!remindOn || !pushAvailable || !events) return;
        if (!coords && !manualStopId) return;
        const reminders: Reminder[] = events.map((ev) => ({
            id: ev.id,
            title: ev.title,
            arrive_by: ev.start,
            dest: ev.location ?? ev.title,
            // A chosen stop beats a GPS fix: the fix is where the rider was
            // when this ran, the stop is where they will actually leave from.
            origin_stop_id: manualStopId || null,
            origin_lat: manualStopId ? null : coords?.lat ?? null,
            origin_lng: manualStopId ? null : coords?.lng ?? null,
            lead_minutes: LEAD_MINUTES,
        }));
        putReminders(reminders).catch((e: unknown) => {
            setRemindError(e instanceof Error ? e.message : 'Could not save reminders.');
        });
    }, [remindOn, pushAvailable, events, coords, manualStopId]);

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
                setRemindError('Notifications are blocked for this site. Allow them in your browser settings to get reminders.');
            } else {
                setRemindError(e instanceof Error ? e.message : 'Could not change reminders.');
            }
        } finally {
            setRemindBusy(false);
        }
    };

    // -- render -------------------------------------------------------------

    if (!configured) {
        return (
            <div className="flex flex-col flex-1 min-h-0 pt-1">
                <Alert variant="info">
                    <AlertIcon className="text-neutral-400">
                        <Info size={14} />
                    </AlertIcon>
                    <AlertContent>
                        <AlertTitle>Calendar isn't configured</AlertTitle>
                        <AlertDescription>
                            This build has no Google client ID, so the Classes tab cannot
                            read a calendar. Set <code className="text-neutral-300">VITE_GOOGLE_CLIENT_ID</code> to
                            turn it on.
                        </AlertDescription>
                    </AlertContent>
                </Alert>
            </div>
        );
    }

    if (!signedIn) {
        return (
            <div className="flex flex-col flex-1 min-h-0 pt-1">
                {authError && (
                    <Alert variant="warning" className="mb-2">
                        <AlertIcon>
                            <TriangleAlert size={12} />
                        </AlertIcon>
                        <AlertContent>
                            <AlertDescription>{authError}</AlertDescription>
                        </AlertContent>
                    </Alert>
                )}
                <div className="flex flex-1 flex-col items-center justify-center gap-3 py-8 text-center">
                    <CalendarDays size={22} className="text-crimson" />
                    <div>
                        <p className="text-[12px] font-semibold text-white">Which shuttle gets you to class?</p>
                        <p className="mt-1 max-w-[260px] text-[11px] leading-relaxed text-neutral-500">
                            Connect Google Calendar and each upcoming class gets a bus, a
                            stop, and the time to be standing at it.
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={() => void connect()}
                        className={buttonVariants({ variant: 'primary', size: 'md' })}
                    >
                        Connect Google Calendar
                    </button>
                    <p className="text-[9px] text-neutral-600">Read-only. Nothing is stored on our servers.</p>
                </div>
            </div>
        );
    }

    return (
        <div className="flex flex-col flex-1 min-h-0 pt-1">
            {/* Who we are reading */}
            <div className="flex items-center justify-between shrink-0 pb-2">
                <div className="flex items-center gap-1.5 min-w-0">
                    <CalendarDays size={12} className="text-crimson shrink-0" />
                    <span className="text-[11px] text-neutral-300 truncate">
                        Google Calendar
                        {email && (
                            <>
                                {' '}· connected as <span className="font-semibold text-white">{email}</span>
                            </>
                        )}
                    </span>
                </div>
                <button
                    type="button"
                    onClick={() => setShowStopPicker((v) => !v)}
                    aria-label="Choose a starting stop manually"
                    className={cn(buttonVariants({ variant: 'ghost', size: 'iconSm' }), 'ml-auto')}
                >
                    <MapPin size={12} />
                </button>
                <button
                    type="button"
                    onClick={refresh}
                    aria-label="Refresh classes"
                    className={buttonVariants({ variant: 'ghost', size: 'iconSm' })}
                >
                    <RefreshCw size={12} className={clsx(eventsLoading && 'animate-spin')} />
                </button>
                <button
                    type="button"
                    onClick={disconnect}
                    className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'px-2')}
                >
                    <LogOut size={11} />
                    Sign out
                </button>
            </div>

            {/* Reminders. Rendered only when the server can push and the
                browser can listen; a switch that cannot work is not shown. */}
            {pushAvailable && (
                <div className="flex items-center justify-between gap-2 shrink-0 pb-2">
                    <span className="text-[10px] text-neutral-500">
                        {remindOn
                            ? `A notification ${LEAD_MINUTES} min before you need to leave.`
                            : 'Get a nudge when it is time to leave for the stop.'}
                    </span>
                    <button
                        type="button"
                        role="switch"
                        aria-checked={remindOn}
                        disabled={remindBusy}
                        onClick={() => void toggleRemind()}
                        className={cn(
                            buttonVariants({ variant: remindOn ? 'selected' : 'secondary', size: 'sm' }),
                            'shrink-0',
                        )}
                    >
                        {remindOn ? <Bell size={11} /> : <BellOff size={11} />}
                        Remind me
                    </button>
                </div>
            )}

            {(authError || locError || remindError) && (
                <Alert variant="warning" className="mb-2">
                    <AlertIcon>
                        <TriangleAlert size={12} />
                    </AlertIcon>
                    <AlertContent>
                        <AlertDescription>{authError ?? locError ?? remindError}</AlertDescription>
                        {locError && (
                            <AlertActions>
                                <button
                                    type="button"
                                    onClick={() => locate(true)}
                                    className={buttonVariants({ variant: 'secondary', size: 'sm' })}
                                >
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
                        <MapPin size={9} /> Starting from
                    </label>
                    <select
                        value={manualStopId}
                        onChange={(e) => chooseStop(e.target.value)}
                        className="w-full rounded-lg border border-white/5 bg-neutral-800/60 px-2.5 py-2 text-[11px] text-white outline-none focus:border-crimson/50"
                    >
                        <option value="">Choose a stop…</option>
                        {stops.map((s) => (
                            <option key={s.id} value={s.id}>{s.name}</option>
                        ))}
                    </select>
                </div>
            )}

            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain touch-pan-y custom-scrollbar pr-1 pb-2 space-y-1.5">
                {eventsLoading && !events && (
                    <div className="space-y-1.5">
                        {[0, 1, 2].map((i) => (
                            <div key={i} className="h-16 animate-pulse rounded-xl bg-neutral-800/40" />
                        ))}
                    </div>
                )}

                {events && events.length === 0 && (
                    <div className="py-6 text-center">
                        <p className="text-[11px] text-neutral-400">Nothing to get to.</p>
                        <p className="mt-1 text-[10px] text-neutral-500">
                            No events with a location in the next {LOOKAHEAD_HOURS} hours.
                        </p>
                    </div>
                )}

                {events && events.length > 0 && (
                    <p className="text-[10px] font-bold uppercase tracking-wider text-neutral-500">
                        {locating ? 'Finding you…' : coords ? (manualStopId ? 'From your chosen stop' : 'From where you are') : 'Pick a starting stop'}
                    </p>
                )}

                {events?.map((ev) => (
                    <ClassRow
                        key={ev.id}
                        event={ev}
                        state={coords ? plans[ev.id] : undefined}
                        hasOrigin={Boolean(coords)}
                        open={selectedId === ev.id}
                        onClick={() => toggleRow(ev)}
                    />
                ))}
            </div>
        </div>
    );
};

// ---------------------------------------------------------------------------

const ClassRow = ({
    event: ev,
    state,
    hasOrigin,
    open,
    onClick,
}: {
    event: CalendarEvent;
    state: PlanState | undefined;
    hasOrigin: boolean;
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
                    {/* Route badge, or a neutral slot until there is a route to
                        name — the column stays aligned while plans arrive. */}
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
                        <p className="truncate text-[12px] font-semibold leading-tight text-white">{ev.title}</p>
                        <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-neutral-400">
                            <span className="inline-flex shrink-0 items-center gap-0.5 tabular-nums">
                                <Clock size={9} />
                                {whenLabel(ev.start)}
                            </span>
                            {ev.location && (
                                <>
                                    <span className="text-neutral-600">·</span>
                                    <span className="truncate">{ev.location}</span>
                                </>
                            )}
                        </div>
                    </div>

                    {/* The one number. Same weight as Next Bus Out's ETA
                        figure; here it is a clock time. */}
                    <div className="shrink-0 text-right">
                        <p className="text-[9px] font-bold uppercase tracking-wider text-neutral-500">Be at stop</p>
                        {rec ? (
                            <BigClock iso={rec.be_at_stop_by} muted={!rec.viable} />
                        ) : (
                            <p className="text-[17px] font-bold leading-none text-neutral-600">—</p>
                        )}
                    </div>
                </div>

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
                        </div>
                    )}
                </div>
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
    if (!rec.viable) {
        return <span className="text-[10px] font-bold text-crimson-light">Won't make it</span>;
    }
    const m = Math.round(rec.slack_minutes);
    if (m <= 0) return <span className="text-[10px] font-bold text-crimson-light">Cutting it fine</span>;
    return (
        <span className="text-[10px] text-neutral-400 tabular-nums">
            {m} min spare
            {/* Harvard's timetable says "approximately", and a plan built from
                it is a headway midpoint, not a tracked bus. Say so where the
                rider will read it. */}
            {rec.eta_source === 'schedule' && <span className="text-neutral-500"> · scheduled, approx.</span>}
        </span>
    );
};

/** Where the planner thinks the class is. Shown always, because the map dot
 * it puts the trip on is only as good as this match; flagged when the
 * geocoder was not sure. */
const ResolvedDest = ({ plan, lowConfidence }: { plan: ArrivalPlan; lowConfidence: boolean }) => (
    <span className="min-w-0 truncate text-[10px] text-neutral-500">
        → {plan.dest.resolved_name || plan.dest.stop.name}
        {lowConfidence && (
            <span className="text-crimson-light"> · best guess, check the stop</span>
        )}
    </span>
);
