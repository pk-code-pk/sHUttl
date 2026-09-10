import { useState, useEffect, useMemo, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { createPortal } from "react-dom";
import { MapPin, Navigation as NavigationIcon, ArrowUpDown, Clock, Info, ChevronDown, ChevronLeft, X, Share2, Check, TriangleAlert } from "lucide-react";
import clsx from "clsx";
import type { TripResponse, TripCandidate, TripCandidatesResponse } from "./types";
import {
    metersToMinutes,
    formatMinutesLabel,
    isWalkReasonable,
} from "../utils/timeAndDistance";
import { formatEtaSeconds, splitEtaLabel } from "../utils/time";
import logo from "../assets/logo.svg";
import { API_BASE_URL } from "@/config";
import { describeFailure, getLocation } from "@/lib/geolocation";
import { NextBusPanel } from "./NextBusPanel";
import { Button } from "./ui/Button";
import { Alert, AlertActions, AlertContent, AlertDescription, AlertIcon, AlertTitle } from "./ui/Alert";
import { cn } from "./ui/styles";
import { SegmentedControl } from "./ui/SegmentedControl";
import { PanelSheet } from "./ui/PanelSheet";
import { SNAP_DEFAULT, SNAP_MINIMISED } from "./ui/sheetSnaps";
import {
    buildTripUrl,
    copyToClipboard,
    hasTripLink,
    parseTripLink,
    type TripEndpointRef,
} from "@/lib/tripLink";

interface System {
    id: number;
    name: string;
}

interface TripPlannerPanelProps {
    className?: string;

    system: System | null;
    trip: TripResponse | null;
    onTripChange: (trip: TripResponse | null) => void;
    onUserLocationChange?: (location: { lat: number; lng: number } | null) => void;
}

interface StopOption {
    id: string;
    name: string;
    lat: number;
    lng: number;
}

// Helper for total trip ETA
function computeTripEtaLabel(segments: TripResponse['segments']): { label: string | null, partial: boolean } {
    let totalSeconds = 0;
    let any = false;
    let allValid = true;

    for (const seg of segments) {
        // Only count shuttle segments for 'allValid' check
        // (if we had walk segments here we would skip them)
        const v = seg.next_bus?.segment_eta_s;
        if (v != null && Number.isFinite(v) && v > 0) {
            totalSeconds += v;
            any = true;
        } else {
            allValid = false;
        }
    }

    if (!any) return { label: null, partial: false };
    const label = formatEtaSeconds(totalSeconds);
    return { label, partial: !allValid };
}

function useIsMobile() {
    const [isMobile, setIsMobile] = useState(false);
    useEffect(() => {
        const check = () => setIsMobile(window.innerWidth < 768);
        check();
        window.addEventListener('resize', check);
        return () => window.removeEventListener('resize', check);
    }, []);
    return isMobile;
}

interface CandidateCardProps {
    candidate: TripCandidate;
    isSelected: boolean;
    onSelect: () => void;
}

function CandidateCard({ candidate, isSelected, onSelect }: CandidateCardProps) {
    const firstSeg = candidate.segments[0];
    const waitSeconds =
        firstSeg?.next_bus?.eta_to_boarding_stop_s ??
        firstSeg?.next_bus?.eta_to_origin_stop ??
        null;
    const eta = splitEtaLabel(formatEtaSeconds(waitSeconds));
    const routeLabel = candidate.segments
        .map((s) => s.short_name || s.route_name || 'Route')
        .join(' → ');

    return (
        <button
            type="button"
            onClick={onSelect}
            className={clsx(
                "w-full rounded-xl p-2.5 text-left border transition-all",
                isSelected
                    ? "bg-crimson/10 border-crimson/40"
                    : "bg-neutral-900/70 border-white/5 hover:bg-white/5 hover:border-white/10"
            )}
        >
            <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                    <div className="flex items-center gap-0.5 shrink-0">
                        {candidate.segments.map((s, si) => (
                            <div
                                key={si}
                                className="w-2 h-2 rounded-full"
                                style={{ backgroundColor: s.color || '#A51C30' }}
                            />
                        ))}
                    </div>
                    <span className="text-[11px] font-bold text-white truncate">{routeLabel}</span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                    {candidate.num_transfers > 0 && (
                        <span className="text-[9px] text-neutral-500 bg-neutral-800/50 px-1.5 py-0.5 rounded border border-white/5">
                            {candidate.num_transfers}× transfer
                        </span>
                    )}
                    {eta ? (
                        // The figure carries the row. It was a 9px green pill,
                        // the same size as the metadata around it and in a
                        // colour that means nothing here — green is not one of
                        // the route colours and the app's accent is crimson.
                        // White, large, with the unit set small beside it.
                        <span className="flex items-baseline gap-0.5 tabular-nums">
                            <span className="text-[17px] font-bold leading-none text-white">
                                {eta.value}
                            </span>
                            {eta.unit && (
                                <span className="text-[10px] font-semibold leading-none text-neutral-400">
                                    {eta.unit}
                                </span>
                            )}
                        </span>
                    ) : (
                        <span className="text-[10px] font-semibold text-neutral-600">
                            No ETA
                        </span>
                    )}
                </div>
            </div>
            {candidate.total_walk_m > 20 && (
                <p className="mt-1 text-[9px] text-neutral-500">~{Math.round(candidate.total_walk_m)}m walk</p>
            )}
        </button>
    );
}

export const TripPlannerPanel = ({
    className,
    system,
    trip,
    onTripChange,
    onUserLocationChange
}: TripPlannerPanelProps) => {
    const [stops, setStops] = useState<StopOption[]>([]);
    const [loadingStops, setLoadingStops] = useState(false);
    const [originStopId, setOriginStopId] = useState<string>('');
    const [destStopId, setDestStopId] = useState<string>('');
    const [planning, setPlanning] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [showSuccess, setShowSuccess] = useState(false);
    const [itineraryOpen, setItineraryOpen] = useState(true);
    const isMobile = useIsMobile();

    // Focus states for autocomplete
    const [originOpen, setOriginOpen] = useState(false);
    const [destOpen, setDestOpen] = useState(false);

    // Which snap point the sheet is resting at. The gesture itself — tracking
    // the finger, velocity, snapping — belongs to react-modal-sheet now; see
    // ui/PanelSheet for what that replaced.
    const [snap, setSnap] = useState(SNAP_DEFAULT);

    type InputMode = 'search' | 'dropdown';
    const [originMode, setOriginMode] = useState<InputMode>('search');
    const [destMode, setDestMode] = useState<InputMode>('search');

    const [originQuery, setOriginQuery] = useState('');
    const [destQuery, setDestQuery] = useState('');

    const [originUseCurrentLocation, setOriginUseCurrentLocation] = useState(false);
    const [originCoords, setOriginCoords] = useState<{ lat: number; lng: number } | null>(null);
    const [locating, setLocating] = useState(false);
    const [locationError, setLocationError] = useState<string | null>(null);

    // Live update state
    interface TripRequestParams {
        systemId: number;
        originLat: number;
        originLng: number;
        destLat: number;
        destLng: number;
    }
    const [activeTripParams, setActiveTripParams] = useState<TripRequestParams | null>(null);
    const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
    const [isLiveUpdating, setIsLiveUpdating] = useState(false);
    const POLL_INTERVAL_MS = 8000; // ~8 seconds

    // Multi-candidate state
    // Two modes. "Next bus out" is the common case — standing somewhere,
    // wanting to know what is leaving — and it needs no input at all, so it
    // does not belong behind the from/to form.
    type PanelMode = 'next' | 'plan';
    // A shared link is a request for a specific trip, so it opens the planner.
    const [mode, setMode] = useState<PanelMode>(
        hasTripLink(window.location.search) ? 'plan' : 'next',
    );

    // A mode switch that would discard a planned trip waits for confirmation.
    // Switching to Next Bus Out has to clear the trip — the panel below it is
    // a departures list, so leaving a planned route drawn on the map would
    // show a trip nothing on screen refers to.
    const [pendingMode, setPendingMode] = useState<PanelMode | null>(null);

    // Shareable-link state. `sharedEndpoints` remembers what the current
    // result was planned from, because the trip response only carries the
    // matched stops — not whether the user asked for a stop or dropped a pin,
    // which is what the link has to preserve.
    const [sharedEndpoints, setSharedEndpoints] = useState<{
        origin: TripEndpointRef;
        destination: TripEndpointRef;
    } | null>(null);
    const [shareState, setShareState] = useState<'idle' | 'copied' | 'failed'>('idle');
    const [shareUrl, setShareUrl] = useState<string>('');
    // Guards the auto-plan so a shared link is planned once, not on every
    // stops refresh.
    const linkPlannedRef = useRef(false);

    const [candidates, setCandidates] = useState<TripCandidate[]>([]);
    const [selectedIndex, setSelectedIndex] = useState(0);
    type TripView = 'candidates' | 'itinerary';
    const [view, setView] = useState<TripView>('candidates');
    const selectedIndexRef = useRef(0);
    const candidatesRef = useRef<TripCandidate[]>([]);
    // Keep refs in sync with state for use inside async callbacks
    useEffect(() => { selectedIndexRef.current = selectedIndex; }, [selectedIndex]);
    useEffect(() => { candidatesRef.current = candidates; }, [candidates]);


    // Autocomplete filtering logic
    function filterStops(query: string, stops: StopOption[]): StopOption[] {
        const q = query.trim().toLowerCase();
        if (!q) return [];

        const startsWith: StopOption[] = [];
        const contains: StopOption[] = [];

        for (const s of stops) {
            const name = s.name.toLowerCase();
            if (name.startsWith(q)) {
                startsWith.push(s);
            } else if (name.includes(q)) {
                contains.push(s);
            }
        }

        const sortByName = (a: StopOption, b: StopOption) =>
            a.name.localeCompare(b.name);

        startsWith.sort(sortByName);
        contains.sort(sortByName);

        return [...startsWith, ...contains].slice(0, 10);
    }

    const originSuggestions = useMemo(
        () => filterStops(originQuery, stops),
        [originQuery, stops]
    );

    const destSuggestions = useMemo(
        () => filterStops(destQuery, stops),
        [destQuery, stops]
    );

    const [stopsError, setStopsError] = useState<string | null>(null);

    // Fetch stops for the current system
    useEffect(() => {
        if (!system?.id) {
            setStops([]);
            setStopsError(null);
            setOriginStopId('');
            setDestStopId('');
            resetLiveState();
            return;
        }

        setLoadingStops(true);
        setStopsError(null);
        fetch(`${API_BASE_URL}/stops?system_id=${system.id}`)
            .then(async (res) => {
                if (!res.ok) {
                    let message = `Failed to load stops (Status ${res.status})`;
                    try {
                        const data = await res.json();
                        if (data?.detail) message = data.detail;
                    } catch { /* ignore */ }
                    throw new Error(message);
                }
                return res.json();
            })
            .then((data: StopOption[]) => {
                const loaded = data || [];
                setStops(loaded);

                // A shared link names its endpoints in the URL; resolve them
                // against the stop list now that we have one, instead of
                // clearing the selection as we would on a normal load.
                const linked = hasTripLink(window.location.search)
                    ? parseTripLink(window.location.search, loaded)
                    : { origin: null, destination: null };

                // Set the visible query text alongside the id. Without this the
                // trip plans correctly from the link but the From/To boxes
                // render empty, so the form looks blank and pressing Plan Trip
                // again fails validation.
                const nameFor = (id: string) =>
                    loaded.find((s) => s.id.toString() === id.toString())?.name ?? '';

                if (linked.origin?.stopId) {
                    setOriginStopId(linked.origin.stopId);
                    setOriginQuery(nameFor(linked.origin.stopId));
                } else {
                    setOriginStopId('');
                }
                if (linked.destination?.stopId) {
                    setDestStopId(linked.destination.stopId);
                    setDestQuery(nameFor(linked.destination.stopId));
                } else {
                    setDestStopId('');
                }

                if (linked.origin?.coords) {
                    // Reuse the current-location path: it already routes a raw
                    // coordinate pair through planning without a stop id.
                    setOriginCoords(linked.origin.coords);
                    setOriginUseCurrentLocation(true);
                }

                resetLiveState();
            })
            .catch((err) => {
                setStops([]);
                setStopsError(err.message || 'Could not load stops.');
            })
            .finally(() => setLoadingStops(false));
    }, [system?.id]);

    const findStopById = (id: string) =>
        stops.find((s) => s.id.toString() === id.toString());

    const handleUseCurrentLocation = () => {
        setLocationError(null);
        setLocating(true);

        // force: this is an explicit tap, so it should override the cache and
        // the failure cooldown — the user may have just enabled Location
        // Services. Shares one request with Next Bus Out either way.
        void getLocation(true).then((result) => {
            setLocating(false);
            if (result.coords) {
                setOriginCoords(result.coords);
                setOriginUseCurrentLocation(true);
                setOriginQuery('Current location');
                setOriginStopId('');
                onUserLocationChange?.(result.coords);
                resetLiveState();
                return;
            }
            if (result.failure) {
                // Same wording as Next Bus Out: one cause, one explanation.
                setLocationError(describeFailure(result.failure));
            }
        });
    };

    // `pair` lets a caller plan a specific origin/destination straight away.
    // Next Bus Out uses it: setting the state and then calling would read the
    // previous values, since state updates are not applied synchronously.
    const handlePlanTrip = async (pair?: {
        originStopId: string;
        destStopId: string;
        /** Constrain the answer to one route — see /trip's route_id. */
        routeId?: string;
    }) => {
        setError(null);

        if (!system?.id) {
            setError('Please select a system first.');
            return;
        }

        const effectiveOriginStopId = pair?.originStopId ?? originStopId;
        const effectiveDestStopId = pair?.destStopId ?? destStopId;

        // Determine origin coordinates
        let originLat: number | null = null;
        let originLng: number | null = null;

        if (!pair && originUseCurrentLocation && originCoords) {
            originLat = originCoords.lat;
            originLng = originCoords.lng;
        } else if (effectiveOriginStopId) {
            const stop = findStopById(effectiveOriginStopId);
            if (stop) {
                originLat = stop.lat;
                originLng = stop.lng;
            }
        }

        // Determine destination coordinates
        let destLat: number | null = null;
        let destLng: number | null = null;

        if (effectiveDestStopId) {
            const stop = findStopById(effectiveDestStopId);
            if (stop) {
                destLat = stop.lat;
                destLng = stop.lng;
            }
        }

        if (originLat === null || originLng === null || destLat === null || destLng === null) {
            setError('Please choose both origin and destination.');
            return;
        }

        setPlanning(true);
        try {
            const params = new URLSearchParams({
                lat: originLat.toString(),
                lng: originLng.toString(),
                lat2: destLat.toString(),
                lng2: destLng.toString(),
                system_id: system.id.toString(),
            });
            if (pair?.routeId) params.set('route_id', pair.routeId);

            const res = await fetch(`${API_BASE_URL}/trip?${params.toString()}`);
            if (!res.ok) {
                let message = `Trip request failed with status ${res.status}`;
                try {
                    const data = await res.json();
                    if (data?.detail) message = data.detail;
                    else if (data?.error) message = data.error;
                } catch {
                    // ignore JSON parse error, keep default message
                }
                throw new Error(message);
            }
            const data: TripCandidatesResponse = await res.json();
            const newCandidates = data.candidates || [];
            if (newCandidates.length === 0) throw new Error("No trip candidates found.");
            setCandidates(newCandidates);
            setSelectedIndex(0);
            selectedIndexRef.current = 0;
            candidatesRef.current = newCandidates;
            onTripChange(newCandidates[0]);
            // If only one option, go straight to itinerary; otherwise show candidate list
            setView(newCandidates.length === 1 ? 'itinerary' : 'candidates');
            // Surface the result if the sheet was tucked away.
            if (isMobile && snap === SNAP_MINIMISED) setSnap(SNAP_DEFAULT);

            // Start live updates on success
            setActiveTripParams({
                systemId: system.id,
                originLat,
                originLng,
                destLat,
                destLng,
            });
            setLastUpdatedAt(new Date());
            setIsLiveUpdating(true);
            setShowSuccess(true);
            setTimeout(() => setShowSuccess(false), 800);

            // Make the result addressable. replaceState rather than pushState:
            // planning a trip is not a navigation, and stacking history
            // entries would make Back walk through every plan attempt.
            const endpoints = {
                origin: effectiveOriginStopId
                    ? { stopId: effectiveOriginStopId }
                    : { coords: { lat: originLat, lng: originLng } },
                destination: effectiveDestStopId
                    ? { stopId: effectiveDestStopId }
                    : { coords: { lat: destLat, lng: destLng } },
            };
            setSharedEndpoints(endpoints);
            setShareState('idle');
            const url = buildTripUrl(endpoints.origin, endpoints.destination, stops);
            if (url) window.history.replaceState(null, '', url);
        } catch (e) {
            console.error(e);
            const message = e instanceof Error ? e.message : "Unknown error";
            setError(message);
            onTripChange(null);
        } finally {
            setPlanning(false);
        }
    };

    const handleShare = async () => {
        if (!sharedEndpoints) return;
        const url = buildTripUrl(sharedEndpoints.origin, sharedEndpoints.destination, stops);
        if (!url) return;
        setShareUrl(url);
        const ok = await copyToClipboard(url);
        // On failure the URL is shown for manual copying rather than claiming
        // it was copied — in-app browsers routinely block clipboard access,
        // and that is exactly where shared links get opened.
        setShareState(ok ? 'copied' : 'failed');
        if (ok) setTimeout(() => setShareState('idle'), 2000);
    };

    // Plan the trip named in the URL, once, after stops resolve.
    useEffect(() => {
        if (linkPlannedRef.current) return;
        if (!system?.id || stops.length === 0) return;
        if (!hasTripLink(window.location.search)) return;

        const linked = parseTripLink(window.location.search, stops);
        if (!linked.origin || !linked.destination) return;

        // Coordinate origins land in originCoords via the stops effect; wait
        // for that so planning does not run against a half-applied selection.
        const originReady = linked.origin.stopId
            ? originStopId === linked.origin.stopId
            : Boolean(originCoords);
        const destReady = linked.destination.stopId
            ? destStopId === linked.destination.stopId
            : true;
        if (!originReady || !destReady) return;

        linkPlannedRef.current = true;
        void handlePlanTrip();
        // handlePlanTrip is intentionally omitted: it is redefined on every
        // render, and depending on it would re-run this effect continuously.
        // The ref guard is what makes the auto-plan fire exactly once.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [system?.id, stops, originStopId, destStopId, originCoords]);

    /**
     * Draw a departure on the map, without leaving Next Bus Out.
     *
     * The panel keeps its own list UI; only the map behaviour is shared. That
     * sharing is the point: this runs the same /trip request and pushes the
     * result through the same `trip` prop the planner uses, so the panning,
     * the route highlight, the drawn path, the endpoint markers and the live
     * refresh are the Plan Trip implementation rather than a second one that
     * drifts from it.
     *
     * The planner's own fields are filled too, so switching to Plan Trip
     * afterwards shows the trip you were just looking at instead of an empty
     * form. What it deliberately does not do is switch modes.
     */
    const showDepartureOnMap = (
        originStopId: string,
        destStopId: string | null,
        routeId?: string,
    ) => {
        if (!destStopId) {
            onTripChange(null);
            resetLiveState();
            return;
        }

        const origin = findStopById(originStopId);
        const dest = findStopById(destStopId);
        if (!origin || !dest) return;

        setOriginUseCurrentLocation(false);
        setOriginCoords(null);
        setOriginStopId(originStopId);
        setOriginQuery(origin.name);
        setDestStopId(destStopId);
        setDestQuery(dest.name);
        void handlePlanTrip({ originStopId, destStopId, routeId });
    };

    const requestMode = (next: PanelMode) => {
        if (next === mode) return;
        // Only worth interrupting when there is something to lose: a trip on
        // the map, or candidates the user is still choosing between.
        const wouldDiscardTrip = next === 'next' && (Boolean(trip) || candidates.length > 0);
        if (wouldDiscardTrip) {
            setPendingMode(next);
            return;
        }
        setPendingMode(null);
        setMode(next);
    };

    const confirmModeSwitch = () => {
        if (!pendingMode) return;
        onTripChange(null);
        resetLiveState();
        setMode(pendingMode);
        setPendingMode(null);
    };

    // Helper: Reset live updates and candidates when inputs change significantly
    const resetLiveState = () => {
        setSharedEndpoints(null);
        setShareState('idle');
        setActiveTripParams(null);
        setIsLiveUpdating(false);
        setLastUpdatedAt(null);
        setCandidates([]);
        setSelectedIndex(0);
        selectedIndexRef.current = 0;
        candidatesRef.current = [];
        setView('candidates');
    };

    // Helper: Check if trip has real-time data
    const hasRealtimeData = (t: TripResponse | null): boolean => {
        if (!t) return false;
        return t.segments.some((seg) => seg.next_bus != null);
    };

    // Polling logic for live updates
    useEffect(() => {
        if (!isLiveUpdating || !activeTripParams || !trip) return;
        // Keep polling as long as at least one candidate has live data
        if (!candidatesRef.current.some((c) => c.is_live)) {
            setIsLiveUpdating(false);
            return;
        }

        let isCancelled = false;

        const fetchTripUpdate = async () => {
            try {
                const { systemId, originLat, originLng, destLat, destLng } = activeTripParams;
                const params = new URLSearchParams({
                    lat: originLat.toString(),
                    lng: originLng.toString(),
                    lat2: destLat.toString(),
                    lng2: destLng.toString(),
                    system_id: systemId.toString(),
                });

                const res = await fetch(`${API_BASE_URL}/trip?${params.toString()}`);
                if (!res.ok) throw new Error(`Trip refresh failed: ${res.status}`);
                const data: TripCandidatesResponse = await res.json();
                const newCandidates = data.candidates || [];

                if (!isCancelled && newCandidates.length > 0) {
                    setCandidates(newCandidates);
                    candidatesRef.current = newCandidates;
                    const idx = Math.min(selectedIndexRef.current, newCandidates.length - 1);
                    onTripChange(newCandidates[idx]);
                    setLastUpdatedAt(new Date());
                }
            } catch (err) {
                console.error("Error refreshing trip:", err);
                setIsLiveUpdating(false);
            }
        };

        const intervalId = window.setInterval(fetchTripUpdate, POLL_INTERVAL_MS);
        return () => {
            isCancelled = true;
            window.clearInterval(intervalId);
        };
    }, [isLiveUpdating, activeTripParams, trip, onTripChange]);

    // Custom hook for relative updated label
    const useRelativeUpdatedLabel = (updatedAt: Date | null) => {
        const [now, setNow] = useState(new Date());
        useEffect(() => {
            if (!updatedAt) return;
            const id = window.setInterval(() => setNow(new Date()), 1000);
            return () => window.clearInterval(id);
        }, [updatedAt]);

        if (!updatedAt) return "Not updated yet";
        const diffSec = Math.round((now.getTime() - updatedAt.getTime()) / 1000);
        if (diffSec <= 2) return "Updated just now";
        if (diffSec < 60) return `Updated ${diffSec}s ago`;
        const diffMin = Math.round(diffSec / 60);
        return `Updated ${diffMin} min ago`;
    };

    const updatedLabel = useRelativeUpdatedLabel(lastUpdatedAt);

    const normalizedSegments = useMemo(() => {
        if (!trip || !trip.segments) return [];
        return trip.segments;
    }, [trip]);

    const hasTrip = !!trip && normalizedSegments.length > 0;

    const originWalkM = trip?.origin.distance_m ?? 0;
    const originWalkMin = metersToMinutes(originWalkM);
    const shouldShowOriginWalk = isWalkReasonable(originWalkM);

    const destWalkM = trip?.destination.distance_m ?? 0;
    const destWalkMin = metersToMinutes(destWalkM);
    const shouldShowDestWalk = destWalkM > 5 && destWalkM <= 5000; // Show even for short walks, but cap at reasonable distance

    const numSegments = normalizedSegments.length;
    const numTransfers = Math.max(0, numSegments - 1);


    const totalWalkM =
        (shouldShowOriginWalk ? originWalkM : 0) +
        (shouldShowDestWalk ? destWalkM : 0);
    const totalWalkMin = metersToMinutes(totalWalkM);

    const { label: tripEtaLabel, partial: isTripEtaPartial } = useMemo(() => computeTripEtaLabel(normalizedSegments), [normalizedSegments]);

    return (
        <PanelSheet isMobile={isMobile} snap={snap} onSnap={setSnap} className={className}>
            <>

                {/* Header and mode switch share one row. The old header spent a
                    whole row on a logo, the app's former name, the system name
                    and a "Change" button — on a sheet where vertical space is
                    the scarcest thing there is, and with only one system left
                    to change to. The logo already says what the app is. */}
                <div className="mb-2 flex shrink-0 items-center gap-2">
                    <img src={logo} alt="sHUttl" className="h-5 w-auto shrink-0 opacity-90" />
                    <SegmentedControl
                        className="flex-1"
                        layoutGroup="panel-mode"
                        value={mode}
                        onChange={requestMode}
                        segments={[
                            { id: 'next' as PanelMode, label: 'Next Bus Out' },
                            { id: 'plan' as PanelMode, label: 'Plan Trip' },
                        ]}
                    />
                </div>

                {/* Centred over the whole screen, not inline in the sheet.
                    A confirmation that appears in the flow of a panel is easy
                    to miss and easy to mis-tap; this is a decision that
                    discards work, so it takes the screen until it is answered. */}
                {/* Portalled to the body: the sheet is transformed, and a
                    transformed ancestor makes position:fixed resolve against
                    it rather than the viewport — so the overlay was trapped
                    inside the sheet and landed at its bottom edge. */}
                {createPortal(
                    <AnimatePresence>
                        {pendingMode && (
                        <>
                            <motion.div
                                className="fixed inset-0 z-[70] bg-black/60 backdrop-blur-sm"
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                onClick={() => setPendingMode(null)}
                            />
                            <motion.div
                                className="fixed inset-x-4 top-1/2 z-[71] -translate-y-1/2"
                                initial={{ opacity: 0, scale: 0.96, y: '-46%' }}
                                animate={{ opacity: 1, scale: 1, y: '-50%' }}
                                exit={{ opacity: 0, scale: 0.97, y: '-48%' }}
                                transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                            >
                                <Alert variant="warning" className="mx-auto max-w-sm shadow-2xl">
                                    <AlertIcon>
                                        <TriangleAlert size={16} />
                                    </AlertIcon>
                                    <AlertContent>
                                        <AlertTitle>Clear your planned trip?</AlertTitle>
                                        <AlertDescription>
                                            Next Bus Out shows departures near you, so the
                                            route you planned will come off the map.
                                        </AlertDescription>
                                        <AlertActions>
                                            <Button variant="primary" size="sm" block onClick={confirmModeSwitch}>
                                                Clear and switch
                                            </Button>
                                            <Button variant="secondary" size="sm" block onClick={() => setPendingMode(null)}>
                                                Keep trip
                                            </Button>
                                        </AlertActions>
                                    </AlertContent>
                                </Alert>
                            </motion.div>
                        </>
                        )}
                    </AnimatePresence>,
                    document.body,
                )}

                {mode === 'next' && (
                    <NextBusPanel
                        systemId={system?.id}
                        onShowOnMap={showDepartureOnMap}
                    />
                )}

                {mode === 'plan' && (<>
                {/* Inputs */}
                <div className="space-y-4 pt-1 shrink-0 relative">
                    {/* Origin Field */}
                    <div className="space-y-1.5 relative">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-1.5 px-0.5">
                                <NavigationIcon size={12} className="text-neutral-400" />
                                <span className="text-[10px] font-bold text-neutral-500 uppercase tracking-wider">From</span>
                            </div>
                            <button
                                type="button"
                                onClick={() => setOriginMode((m) => (m === 'search' ? 'dropdown' : 'search'))}
                                className="text-[9px] font-bold text-neutral-500 hover:text-white transition-colors uppercase tracking-tight bg-neutral-800/50 px-2 py-0.5 rounded-full border border-white/5"
                            >
                                {originMode === 'search' ? 'Browse All' : 'Search'}
                            </button>
                        </div>

                        {originMode === 'search' ? (
                            <div className="relative">
                                <input
                                    type="text"
                                    value={originQuery}
                                    onChange={(e) => {
                                        setOriginUseCurrentLocation(false);
                                        setOriginCoords(null);
                                        setOriginQuery(e.target.value);
                                        setOriginStopId('');
                                        setOriginOpen(true);
                                        resetLiveState();
                                    }}
                                    onFocus={() => {
                                        setOriginOpen(true);
                                    }}
                                    onBlur={() => {
                                        setTimeout(() => setOriginOpen(false), 120);
                                    }}
                                    placeholder="Search for a stop..."
                                    className="w-full bg-neutral-800/70 border border-white/5 focus:border-crimson/50 rounded-lg px-3 py-2 text-[16px] md:text-xs text-white outline-none transition-all placeholder:text-neutral-600"
                                />

                                <button
                                    type="button"
                                    onClick={handleUseCurrentLocation}
                                    className={clsx(
                                        "absolute right-2 top-1.5 px-2 py-1 rounded-md text-[9px] font-bold transition-all border",
                                        originUseCurrentLocation
                                            ? "bg-crimson/25 border-crimson/60 text-white"
                                            : "bg-neutral-900 border-white/5 text-neutral-400 hover:text-white"
                                    )}
                                >
                                    {locating ? 'Locating...' : 'My Location'}
                                </button>

                                {/* Suggestions */}
                                {originOpen && originQuery && !originUseCurrentLocation && (
                                    <div className="absolute z-50 left-0 right-0 mt-1 max-h-48 overflow-y-auto rounded-lg bg-neutral-900 border border-white/10 shadow-2xl custom-scrollbar py-1">
                                        {originSuggestions.length > 0 ? (
                                            originSuggestions.map((s) => (
                                                <button
                                                    key={s.id}
                                                    type="button"
                                                    onMouseDown={(e) => e.preventDefault()}
                                                    onClick={() => {
                                                        setOriginStopId(s.id.toString());
                                                        setOriginQuery(s.name);
                                                        setOriginOpen(false); // Immediate close
                                                        setItineraryOpen(true);

                                                        // Force blur to hide mobile keyboard
                                                        if (document.activeElement instanceof HTMLElement) {
                                                            document.activeElement.blur();
                                                        }
                                                    }}
                                                    className="w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-white/5 hover:text-white transition-colors flex items-center gap-2"
                                                >
                                                    <div className="w-1 h-1 rounded-full bg-neutral-600" />
                                                    {s.name}
                                                </button>
                                            ))
                                        ) : (
                                            <div className="px-3 py-2 text-[10px] text-neutral-500 italic">
                                                No matches found
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        ) : (
                            <select
                                value={originStopId}
                                onChange={(e) => {
                                    setOriginUseCurrentLocation(false);
                                    setOriginCoords(null);
                                    setOriginStopId(e.target.value);
                                    const stop = findStopById(e.target.value);
                                    setOriginQuery(stop ? stop.name : '');
                                    resetLiveState();
                                }}
                                className="w-full bg-neutral-800/70 border border-white/5 focus:border-crimson/50 rounded-lg px-3 py-2 text-[16px] md:text-xs text-white outline-none transition-all appearance-none"
                                disabled={loadingStops || !system}
                            >
                                <option value="">{loadingStops ? 'Loading stops...' : 'Select origin...'}</option>
                                {stops.map((s) => (
                                    <option key={s.id} value={s.id.toString()}>{s.name}</option>
                                ))}
                            </select>
                        )}
                        {locationError && <p className="text-[9px] text-red-500 mt-1 pl-1">{locationError}</p>}
                    </div>

                    {/* Destination Field */}
                    <div className="space-y-1.5 relative">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-1.5 px-0.5">
                                <MapPin size={12} className="text-crimson" />
                                <span className="text-[10px] font-bold text-neutral-500 uppercase tracking-wider">To</span>
                            </div>
                            <button
                                type="button"
                                onClick={() => setDestMode((m) => (m === 'search' ? 'dropdown' : 'search'))}
                                className="text-[9px] font-bold text-neutral-500 hover:text-white transition-colors uppercase tracking-tight bg-neutral-800/50 px-2 py-0.5 rounded-full border border-white/5"
                            >
                                {destMode === 'search' ? 'Browse All' : 'Search'}
                            </button>
                        </div>

                        {destMode === 'search' ? (
                            <div className="relative">
                                <input
                                    type="text"
                                    value={destQuery}
                                    onChange={(e) => {
                                        setDestQuery(e.target.value);
                                        setDestStopId('');
                                        setDestOpen(true);
                                        resetLiveState();
                                    }}
                                    onFocus={() => {
                                        setDestOpen(true);
                                    }}
                                    onBlur={() => {
                                        setTimeout(() => setDestOpen(false), 120);
                                    }}
                                    placeholder="Search for a stop..."
                                    className="w-full bg-neutral-800/70 border border-white/5 focus:border-crimson/50 rounded-lg px-3 py-2 text-[16px] md:text-xs text-white outline-none transition-all placeholder:text-neutral-600"
                                />

                                {/* Suggestions */}
                                {destOpen && destQuery && (
                                    <div className="absolute z-50 left-0 right-0 mt-1 max-h-48 overflow-y-auto rounded-lg bg-neutral-900 border border-white/10 shadow-2xl custom-scrollbar py-1">
                                        {destSuggestions.length > 0 ? (
                                            destSuggestions.map((s) => (
                                                <button
                                                    key={s.id}
                                                    type="button"
                                                    onMouseDown={(e) => e.preventDefault()}
                                                    onClick={() => {
                                                        setDestStopId(s.id.toString());
                                                        setDestQuery(s.name);
                                                        setDestOpen(false); // Immediate close
                                                        setItineraryOpen(true);

                                                        // Force blur to hide mobile keyboard
                                                        if (document.activeElement instanceof HTMLElement) {
                                                            document.activeElement.blur();
                                                        }
                                                    }}
                                                    className="w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-white/5 hover:text-white transition-colors flex items-center gap-2"
                                                >
                                                    <div className="w-1 h-1 rounded-full bg-neutral-600" />
                                                    {s.name}
                                                </button>
                                            ))
                                        ) : (
                                            <div className="px-3 py-2 text-[10px] text-neutral-500 italic">
                                                No matches found
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        ) : (
                            <select
                                value={destStopId}
                                onChange={(e) => {
                                    setDestStopId(e.target.value);
                                    const stop = findStopById(e.target.value);
                                    setDestQuery(stop ? stop.name : '');
                                    resetLiveState();
                                }}
                                className="w-full bg-neutral-800 border border-white/5 focus:border-crimson/50 rounded-lg px-3 py-2 text-[16px] md:text-xs text-white outline-none transition-all appearance-none"
                                disabled={loadingStops || !system}
                            >
                                <option value="">{loadingStops ? 'Loading stops...' : 'Select destination...'}</option>
                                {stops.map((s) => (
                                    <option key={s.id} value={s.id.toString()}>{s.name}</option>
                                ))}
                            </select>
                        )}
                    </div>
                </div>

                {stopsError && (
                    <div className="mt-3 rounded-xl border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-[11px] text-yellow-100/90 leading-relaxed shadow-sm">
                        <div className="flex items-center gap-2 mb-0.5">
                            <Info size={12} className="text-yellow-500" />
                            <span className="font-bold uppercase tracking-tight">System Info</span>
                        </div>
                        {stopsError}
                    </div>
                )}

                <AnimatePresence initial={false}>
                    {error && (
                        <motion.div
                            initial={{ opacity: 0, y: -4 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -4 }}
                            transition={{ duration: 0.18 }}
                            className="mt-3 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2 text-[11px] text-red-100/90 leading-relaxed shadow-sm"
                        >
                            <div className="flex items-center gap-2 mb-0.5">
                                <div className="w-1 h-1 rounded-full bg-red-500 animate-pulse" />
                                <span className="font-bold uppercase tracking-tight">Trip Error</span>
                            </div>
                            {error}
                        </motion.div>
                    )}
                </AnimatePresence>

                {/* Actions Row - improved spacing and layout */}
                <div className="flex items-center gap-3 pt-3 mt-2 shrink-0 mb-4">
                    <button
                        onClick={() => {
                            const tempS = originStopId;
                            setOriginStopId(destStopId);
                            setDestStopId(tempS);

                            const tempQ = originQuery;
                            setOriginQuery(destQuery);
                            setDestQuery(tempQ);

                            const tempM = originMode;
                            setOriginMode(destMode);
                            setDestMode(tempM);

                            setOriginUseCurrentLocation(false);
                            setOriginCoords(null);
                            resetLiveState();
                        }}
                        className={cn(
                            "flex h-10 items-center justify-center rounded-xl px-3",
                            "bg-neutral-800 text-neutral-400 transition-all duration-150",
                            "hover:bg-neutral-700 hover:text-white active:scale-[0.97]",
                            "shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]",
                        )}
                        aria-label="Swap origin and destination"
                    >
                        <ArrowUpDown size={16} />
                    </button>

                    <motion.button
                        onClick={() => void handlePlanTrip()}
                        disabled={planning || !system || (!originStopId && !originUseCurrentLocation) || !destStopId}
                        whileTap={{ scale: 0.98 }}
                        animate={error ? { x: [0, -4, 4, -4, 4, 0] } : {}}
                        transition={{ duration: 0.4 }}
                        className={clsx(
                            "h-10 flex-1 text-sm font-bold rounded-lg transition-all relative overflow-hidden",
                            (system && (originStopId || originUseCurrentLocation) && destStopId)
                                ? (planning
                                    ? "bg-crimson-dark text-white/50"
                                    : "bg-crimson hover:bg-crimson-light text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]")
                                : "bg-neutral-800 text-neutral-500 cursor-not-allowed"
                        )}
                        aria-busy={planning}
                        aria-live="polite"
                    >
                        {/* Progress Fill with Shimmer */}
                        <AnimatePresence>
                            {(planning || showSuccess) && (
                                <motion.div
                                    className="absolute inset-y-0 left-0 bg-white/10"
                                    style={{
                                        background: "linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.15) 50%, transparent 100%)",
                                        backgroundSize: "200% 100%",
                                    }}
                                    initial={{ width: 0, x: "-100%" }}
                                    animate={{
                                        width: showSuccess ? "100%" : ["0%", "40%", "75%", "98%"],
                                        x: 0,
                                        backgroundPosition: ["200% 0", "-200% 0"]
                                    }}
                                    exit={{ opacity: 0 }}
                                    transition={{
                                        width: {
                                            times: [0, 0.05, 0.2, 1],
                                            duration: showSuccess ? 0.3 : 60,
                                            ease: showSuccess ? "easeOut" : "circOut"
                                        },
                                        backgroundPosition: {
                                            duration: 1.5,
                                            repeat: Infinity,
                                            ease: "linear"
                                        }
                                    }}
                                />
                            )}
                        </AnimatePresence>

                        <span className="relative z-10 flex items-center justify-center gap-2">
                            {planning ? 'Planning...' : 'Plan Trip'}
                        </span>
                    </motion.button>

                    {/* Cancel Trip Button - visible only when trip is active */}
                    {trip && (
                        <button
                            onClick={() => {
                                onTripChange(null);
                                resetLiveState();
                            }}
                            className="h-10 px-3 rounded-lg bg-neutral-800 hover:bg-red-900/50 text-neutral-400 hover:text-red-400 transition-colors flex items-center justify-center border border-transparent hover:border-red-500/30"
                            aria-label="Cancel trip"
                        >
                            <X size={16} />
                        </button>
                    )}
                </div>

                {/* Itinerary Section */}
                <div className="flex-1 overflow-hidden flex flex-col pt-2 min-h-0 border-t border-white/5 mt-auto">
                    {/* Header — shows back button when in itinerary view, section title otherwise */}
                    <div className="py-2 flex items-center justify-between shrink-0">
                        {view === 'itinerary' && candidates.length > 1 ? (
                            <button
                                type="button"
                                onClick={() => setView('candidates')}
                                className="flex items-center gap-1.5 text-neutral-400 hover:text-white transition-colors"
                                aria-label="Back to route options"
                            >
                                <ChevronLeft size={14} />
                                <span className="text-[10px] font-bold uppercase tracking-wider">Route Options</span>
                            </button>
                        ) : (
                            <span className="tracking-[0.2em] uppercase font-bold text-[10px] text-neutral-500">
                                {hasTrip ? 'Routes' : 'Itinerary'}
                            </span>
                        )}
                        <div className="flex items-center gap-1.5">
                        {sharedEndpoints && (
                            <button
                                type="button"
                                onClick={handleShare}
                                aria-label="Copy a link to this trip"
                                className={clsx(
                                    "flex items-center gap-1 rounded-full px-2.5 py-1.5 transition-colors",
                                    shareState === 'copied'
                                        ? "bg-crimson/20 text-crimson-light"
                                        : "bg-neutral-800/50 text-neutral-400 hover:bg-neutral-800 hover:text-white"
                                )}
                            >
                                {shareState === 'copied'
                                    ? <Check size={12} />
                                    : <Share2 size={12} />}
                                <span className="text-[10px] font-bold uppercase tracking-wider">
                                    {shareState === 'copied' ? 'Copied' : 'Share'}
                                </span>
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={() => setItineraryOpen((o) => !o)}
                            aria-label={itineraryOpen ? 'Collapse itinerary' : 'Expand itinerary'}
                            className="rounded-full bg-neutral-800/50 p-1.5 hover:bg-neutral-800 transition-colors"
                        >
                            <ChevronDown
                                size={12}
                                className={clsx(
                                    "text-neutral-400 transition-transform duration-300",
                                    itineraryOpen ? "rotate-180" : ""
                                )}
                            />
                        </button>
                        </div>
                    </div>

                    {/* Clipboard blocked (common in in-app browsers): show the
                        link so it can still be copied by hand. */}
                    {shareState === 'failed' && shareUrl && (
                        <div className="mb-2 rounded-lg bg-neutral-800/60 px-2.5 py-2">
                            <p className="text-[10px] text-neutral-400 mb-1">
                                Copy this link:
                            </p>
                            <input
                                readOnly
                                value={shareUrl}
                                onFocus={(e) => e.currentTarget.select()}
                                className="w-full bg-transparent text-[10px] text-white outline-none"
                            />
                        </div>
                    )}

                    <AnimatePresence initial={false}>
                        {itineraryOpen && (
                            <motion.div
                                key="itinerary-content"
                                initial={{ opacity: 0, height: 0 }}
                                animate={{ opacity: 1, height: 'auto' }}
                                exit={{ opacity: 0, height: 0 }}
                                transition={{ duration: 0.3, ease: 'circOut' }}
                                className="min-h-0 flex flex-col flex-1"
                            >
                                <AnimatePresence mode="wait" initial={false}>
                                    {view === 'candidates' ? (
                                        /* ── CANDIDATES VIEW ── */
                                        <motion.div
                                            key="candidates-view"
                                            initial={{ opacity: 0, x: -12 }}
                                            animate={{ opacity: 1, x: 0 }}
                                            exit={{ opacity: 0, x: -12 }}
                                            transition={{ duration: 0.18 }}
                                            className="flex-1 min-h-0 overflow-y-auto overscroll-contain touch-pan-y custom-scrollbar pr-1 pb-2 space-y-1.5"
                                        >
                                            {!hasTrip ? (
                                                <div className="flex flex-col items-center justify-center py-6 text-center text-neutral-500">
                                                    <Info size={24} className="mb-2 opacity-20" />
                                                    <p className="text-[11px] leading-relaxed max-w-[180px]">
                                                        Select your stops and tap <span className="text-neutral-400 font-semibold">Plan Trip</span>.
                                                    </p>
                                                </div>
                                            ) : (
                                                <>
                                                    {candidates.some((c) => c.is_live) && (
                                                        <div className="flex items-center gap-1.5 pb-0.5">
                                                            <div className="h-1 w-1 rounded-full bg-crimson-light" />
                                                            <span className="text-[9px] font-medium text-neutral-400">Live tracking</span>
                                                        </div>
                                                    )}
                                                    {candidates
                                                        .map((c, idx) => ({ c, idx }))
                                                        .filter(({ c }) => c.is_live)
                                                        .map(({ c, idx }) => (
                                                            <CandidateCard
                                                                key={idx}
                                                                candidate={c}
                                                                isSelected={selectedIndex === idx}
                                                                onSelect={() => {
                                                                    setSelectedIndex(idx);
                                                                    selectedIndexRef.current = idx;
                                                                    onTripChange(c);
                                                                    setView('itinerary');
                                                                }}
                                                            />
                                                        ))}
                                                    {candidates.some((c) => c.is_live) && candidates.some((c) => !c.is_live) && (
                                                        <div className="flex items-center gap-2 py-0.5">
                                                            <div className="flex-1 border-t border-white/5" />
                                                            <span className="text-[9px] text-neutral-600 uppercase tracking-wider">No live tracking</span>
                                                            <div className="flex-1 border-t border-white/5" />
                                                        </div>
                                                    )}
                                                    {candidates
                                                        .map((c, idx) => ({ c, idx }))
                                                        .filter(({ c }) => !c.is_live)
                                                        .map(({ c, idx }) => (
                                                            <CandidateCard
                                                                key={idx}
                                                                candidate={c}
                                                                isSelected={selectedIndex === idx}
                                                                onSelect={() => {
                                                                    setSelectedIndex(idx);
                                                                    selectedIndexRef.current = idx;
                                                                    onTripChange(c);
                                                                    setView('itinerary');
                                                                }}
                                                            />
                                                        ))}
                                                </>
                                            )}
                                        </motion.div>
                                    ) : (
                                        /* ── ITINERARY VIEW ── */
                                        <motion.div
                                            key="itinerary-view"
                                            initial={{ opacity: 0, x: 12 }}
                                            animate={{ opacity: 1, x: 0 }}
                                            exit={{ opacity: 0, x: 12 }}
                                            transition={{ duration: 0.18 }}
                                            className="flex-1 min-h-0 overflow-y-auto overscroll-contain touch-pan-y custom-scrollbar pr-1 pb-2 space-y-3"
                                        >
                                            <motion.div
                                                    key="itinerary-list"
                                                    initial={{ opacity: 0, y: 6 }}
                                                    animate={{ opacity: 1, y: 0 }}
                                                    className="space-y-4"
                                                >
                                                    {/* Overview */}
                                                    <div className="rounded-xl bg-neutral-900/80 p-3 text-xs border border-white/5 shadow-sm">
                                                        <div className="flex items-center justify-between">
                                                            <div className="flex flex-col flex-1 min-w-0">
                                                                <div className="flex items-center gap-2 mb-1">
                                                                    <div className="h-1.5 w-1.5 rounded-full bg-crimson-light" />
                                                                    <span className="text-[11px] font-bold text-white uppercase tracking-tight">Route Overview</span>
                                                                </div>
                                                                <div className="text-[10px] text-neutral-300 truncate">
                                                                    From <span className="font-medium text-white">{trip?.origin.nearest_stop.name}</span> to{' '}
                                                                    <span className="font-medium text-white">{trip?.destination.nearest_stop.name}</span>
                                                                </div>
                                                                <div className="mt-1 text-[10px] text-neutral-500 font-medium whitespace-nowrap overflow-hidden text-ellipsis">
                                                                    {numSegments} bus segment{numSegments !== 1 ? 's' : ''} •{' '}
                                                                    {numTransfers > 0
                                                                        ? `${numTransfers} transfer${numTransfers > 1 ? 's' : ''}`
                                                                        : 'no transfers'}
                                                                </div>
                                                            </div>

                                                            <div className="flex flex-col items-end gap-1.5 self-start mt-0.5 sm:mt-0">
                                                                {tripEtaLabel ? (
                                                                    <div className="rounded-full bg-neutral-900/80 border border-white/10 px-2.5 py-1 text-[10px] text-white font-bold whitespace-nowrap shadow-sm flex items-center gap-1.5">
                                                                        <Clock size={10} className="text-neutral-400" />
                                                                        <span>
                                                                            Trip ≈ {tripEtaLabel}
                                                                            {isTripEtaPartial && <span className="text-[9px] opacity-60 font-medium ml-1">(partial)</span>}
                                                                        </span>
                                                                    </div>
                                                                ) : (
                                                                    <div className="rounded-full bg-neutral-950/80 px-2 py-1 text-[10px] text-neutral-500 font-medium whitespace-nowrap border border-white/5">
                                                                        No ETA
                                                                    </div>
                                                                )}
                                                                {totalWalkMin != null && totalWalkMin > 0 && (
                                                                    <div className="text-[9px] text-neutral-400 font-bold uppercase tracking-tight bg-neutral-800/50 px-1.5 py-0.5 rounded border border-white/5">
                                                                        {Math.round(totalWalkMin)} min walk
                                                                    </div>
                                                                )}
                                                            </div>
                                                        </div>

                                                        {!isWalkReasonable(trip?.origin.distance_m ?? 0) && !isWalkReasonable(trip?.destination.distance_m ?? 0) && (
                                                            <div className="mt-2 pt-2 border-t border-white/5 flex items-start gap-1.5 text-[9px] text-amber-500/90 leading-relaxed italic">
                                                                <Info size={10} className="shrink-0 mt-0.5" />
                                                                <span>You seem far from this shuttle system. For realistic directions, set your origin near campus.</span>
                                                            </div>
                                                        )}
                                                    </div>

                                                    {/* Walking leg: origin → nearest stop */}
                                                    {shouldShowOriginWalk && (
                                                        <div className="rounded-xl bg-neutral-900/80 p-3 text-xs border border-white/5">
                                                            <div className="flex items-center justify-between">
                                                                <div className="flex items-center gap-2">
                                                                    <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-neutral-800 text-[11px]">🚶</span>
                                                                    <div className="font-bold text-white text-[11px]">Walk to stop</div>
                                                                </div>
                                                                <span className="rounded-full bg-neutral-950/80 px-2 py-1 text-[10px] text-neutral-300 font-medium">
                                                                    {originWalkMin != null ? formatMinutesLabel(originWalkMin) : ''}
                                                                </span>
                                                            </div>
                                                            <div className="mt-1.5 text-neutral-300 text-[10px] leading-relaxed">
                                                                Walk from your location to{' '}
                                                                <span className="font-medium text-white">{trip?.origin.nearest_stop.name}</span>.
                                                            </div>
                                                            <div className="mt-1 text-[9px] text-neutral-500 font-medium tracking-tight">
                                                                ~{Math.round(originWalkM)} m
                                                            </div>
                                                        </div>
                                                    )}

                                                    {/* Segments */}
                                                    {normalizedSegments.map((seg, idx) => (
                                                        <div
                                                            key={`${seg.route_id}-${idx}`}
                                                            className="relative pl-4 border-l-2 border-dashed border-neutral-700 pb-2 last:pb-0"
                                                        >
                                                            <div
                                                                className="absolute -left-[5px] top-0 w-2 h-2 rounded-full border border-neutral-800"
                                                                style={{ backgroundColor: seg.color || '#A51C30' }}
                                                            />
                                                            <div className="rounded-xl bg-neutral-900/70 p-3 hover:bg-white/[0.07] transition-colors border border-white/5">
                                                                <div className="flex items-center justify-between mb-2">
                                                                    <span className="text-[11px] font-bold text-white tracking-tight">
                                                                        {seg.short_name || seg.route_name || 'Shuttle'}
                                                                    </span>
                                                                    <div className="flex items-center gap-1.5">
                                                                        {(() => {
                                                                            const nb = seg.next_bus;
                                                                            const waitSeconds = nb?.eta_to_boarding_stop_s ?? nb?.eta_to_origin_stop ?? null;
                                                                            const waitLabel = formatEtaSeconds(waitSeconds);
                                                                            return waitLabel ? (
                                                                                <span className="rounded-full bg-neutral-950/80 px-2 py-0.5 text-[9px] text-neutral-100 font-bold flex items-center gap-1 border border-white/5">
                                                                                    <Clock size={10} className="text-neutral-400" />
                                                                                    <span>Bus in {waitLabel}</span>
                                                                                </span>
                                                                            ) : (
                                                                                <span className="rounded-full bg-neutral-950/80 px-2 py-0.5 text-[9px] text-neutral-500 font-bold border border-white/5 tracking-tight">
                                                                                    No real-time ETA
                                                                                </span>
                                                                            );
                                                                        })()}
                                                                    </div>
                                                                </div>

                                                                <div className="text-[10px] text-neutral-400 mb-1">
                                                                    Board at <span className="text-neutral-200 font-medium">{seg.start_stop.name}</span>
                                                                </div>

                                                                {(() => {
                                                                    const nb = seg.next_bus;
                                                                    const waitSeconds = nb?.eta_to_boarding_stop_s ?? nb?.eta_to_origin_stop ?? null;
                                                                    const waitLabel = formatEtaSeconds(waitSeconds);
                                                                    const segEtaLabel = formatEtaSeconds(nb?.segment_eta_s ?? null);
                                                                    const rideEtaLabel = formatEtaSeconds(nb?.ride_eta_s ?? null);
                                                                    return (
                                                                        <div className="mb-3 space-y-0.5">
                                                                            {waitLabel && (
                                                                                <p className="text-[10px] text-neutral-500">Bus arrives at this stop in {waitLabel}.</p>
                                                                            )}
                                                                            {segEtaLabel && (
                                                                                <p className="text-[10px] text-neutral-500 leading-tight">
                                                                                    Approx. segment time ≈ {segEtaLabel}
                                                                                    {waitLabel && rideEtaLabel && (
                                                                                        <span className="opacity-70"> — bus in {waitLabel}, then ~{rideEtaLabel} ride</span>
                                                                                    )}
                                                                                </p>
                                                                            )}
                                                                        </div>
                                                                    );
                                                                })()}

                                                                <div className="space-y-1.5 pt-2 border-t border-white/5">
                                                                    <span className="text-[9px] font-bold text-neutral-500 uppercase tracking-tighter block mb-1">Stops</span>
                                                                    <div className="max-h-24 overflow-y-auto pr-1">
                                                                        {seg.stops.map((s, sIdx) => (
                                                                            <div key={s.id} className="flex items-center gap-2 text-[10px] text-neutral-400 py-0.5">
                                                                                <div className={clsx(
                                                                                    "w-1 h-1 rounded-full",
                                                                                    sIdx === 0 || sIdx === seg.stops.length - 1 ? "bg-white/40" : "bg-white/10"
                                                                                )} />
                                                                                <span className={clsx(sIdx === seg.stops.length - 1 && "text-neutral-200 font-medium")}>
                                                                                    {s.name}
                                                                                </span>
                                                                            </div>
                                                                        ))}
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        </div>
                                                    ))}

                                                    {/* Walking leg: destination stop → final destination */}
                                                    {shouldShowDestWalk && (
                                                        <div className="rounded-xl bg-neutral-900/80 p-3 text-xs border border-white/5">
                                                            <div className="flex items-center justify-between">
                                                                <div className="flex items-center gap-2">
                                                                    <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-neutral-800 text-[11px]">🚶</span>
                                                                    <div className="font-bold text-white text-[11px]">Walk to destination</div>
                                                                </div>
                                                                <span className="rounded-full bg-neutral-950/80 px-2 py-1 text-[10px] text-neutral-300 font-medium">
                                                                    {destWalkMin != null ? formatMinutesLabel(destWalkMin) : ''}
                                                                </span>
                                                            </div>
                                                            <div className="mt-1.5 text-neutral-300 text-[10px] leading-relaxed">
                                                                From{' '}
                                                                <span className="font-medium text-white">{trip?.destination.nearest_stop.name}</span>{' '}
                                                                walk to your destination.
                                                            </div>
                                                            <div className="mt-1 text-[9px] text-neutral-500 font-medium tracking-tight">
                                                                ~{Math.round(destWalkM)} m
                                                            </div>
                                                        </div>
                                                    )}

                                                    {/* Live status footer */}
                                                    <div className="text-[10px] text-neutral-500 text-center pt-2 pb-1 border-t border-white/5 mx-2">
                                                        {hasRealtimeData(trip) ? (
                                                            <div className="flex flex-col gap-0.5">
                                                                <div className="flex items-center justify-center gap-1.5">
                                                                    {isLiveUpdating && (
                                                                        <div className="h-1 w-1 rounded-full bg-crimson-light" />
                                                                    )}
                                                                    <span>{updatedLabel}</span>
                                                                </div>
                                                                {isLiveUpdating && (
                                                                    <span className="text-[9px] opacity-70">Live tracking every {POLL_INTERVAL_MS / 1000}s</span>
                                                                )}
                                                            </div>
                                                        ) : (
                                                            <span className="italic opacity-70">No real-time data for this route</span>
                                                        )}
                                                    </div>
                                                </motion.div>
                                        </motion.div>
                                    )}
                                </AnimatePresence>
                            </motion.div>
                        )}
                    </AnimatePresence>
                </div>
                </>)}
            </>
        </PanelSheet>
    );
};
