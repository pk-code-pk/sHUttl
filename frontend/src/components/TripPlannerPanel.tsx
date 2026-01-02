import { useState, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { MapPin, Navigation, ArrowUpDown, Clock, Info, ChevronDown } from "lucide-react";
import clsx from "clsx";
import type { TripResponse, TripSegment } from "./types";
import { computeOverallEtaLabel } from "../utils/eta";
import { formatWalkLeg } from "../utils/walk";
import logo from "../assets/logo.svg";

interface System {
    id: number;
    name: string;
}

interface TripPlannerPanelProps {
    className?: string;
    onGo?: () => void;
    system: System | null;
    onChangeSystem: () => void;
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

export const TripPlannerPanel = ({
    className,
    system,
    onChangeSystem,
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
    const [itineraryOpen, setItineraryOpen] = useState(true);

    // Focus states for autocomplete
    const [originOpen, setOriginOpen] = useState(false);
    const [destOpen, setDestOpen] = useState(false);

    // New state for autocomplete and location
    type InputMode = 'search' | 'dropdown';
    const [originMode, setOriginMode] = useState<InputMode>('search');
    const [destMode, setDestMode] = useState<InputMode>('search');

    const [originQuery, setOriginQuery] = useState('');
    const [destQuery, setDestQuery] = useState('');

    const [originUseCurrentLocation, setOriginUseCurrentLocation] = useState(false);
    const [originCoords, setOriginCoords] = useState<{ lat: number; lng: number } | null>(null);
    const [locating, setLocating] = useState(false);
    const [locationError, setLocationError] = useState<string | null>(null);

    const overallEtaLabel = computeOverallEtaLabel(trip);

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

    // Fetch stops for the current system
    useEffect(() => {
        if (!system?.id) {
            setStops([]);
            setOriginStopId('');
            setDestStopId('');
            return;
        }

        setLoadingStops(true);
        fetch(`http://localhost:8000/stops?system_id=${system.id}`)
            .then((res) => res.json())
            .then((data: StopOption[]) => {
                setStops(data || []);
                setOriginStopId('');
                setDestStopId('');
            })
            .catch(() => {
                setStops([]);
            })
            .finally(() => setLoadingStops(false));
    }, [system?.id]);

    const findStopById = (id: string) =>
        stops.find((s) => s.id.toString() === id.toString());

    const handleUseCurrentLocation = () => {
        if (!navigator.geolocation) {
            setLocationError('Geolocation is not supported by this browser.');
            return;
        }

        setLocationError(null);
        setLocating(true);

        navigator.geolocation.getCurrentPosition(
            (pos) => {
                const { latitude, longitude } = pos.coords;
                const coords = { lat: latitude, lng: longitude };
                setOriginCoords(coords);
                setOriginUseCurrentLocation(true);
                setOriginQuery('Current location');
                setOriginStopId('');
                setLocating(false);
                onUserLocationChange?.(coords);
            },
            (err) => {
                console.error(err);
                setLocationError('Could not get your location.');
                setLocating(false);
            },
            {
                enableHighAccuracy: true,
                timeout: 10000,
                maximumAge: 10000,
            }
        );
    };

    const handlePlanTrip = async () => {
        setError(null);

        if (!system?.id) {
            setError('Please select a system first.');
            return;
        }

        // Determine origin coordinates
        let originLat: number | null = null;
        let originLng: number | null = null;

        if (originUseCurrentLocation && originCoords) {
            originLat = originCoords.lat;
            originLng = originCoords.lng;
        } else if (originStopId) {
            const stop = findStopById(originStopId);
            if (stop) {
                originLat = stop.lat;
                originLng = stop.lng;
            }
        }

        // Determine destination coordinates
        let destLat: number | null = null;
        let destLng: number | null = null;

        if (destStopId) {
            const stop = findStopById(destStopId);
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

            const res = await fetch(`http://localhost:8000/trip?${params.toString()}`);
            if (!res.ok) {
                throw new Error(`Trip request failed with status ${res.status}`);
            }
            const data: TripResponse = await res.json();
            onTripChange(data);
        } catch (e) {
            console.error(e);
            setError('Could not plan trip. Please try again.');
            onTripChange(null);
        } finally {
            setPlanning(false);
        }
    };

    const formatEta = (seg: TripSegment) => {
        const nb = seg.next_bus;
        if (!nb) return 'No real-time data';
        if (nb.eta_to_origin_stop_minutes != null && nb.eta_to_origin_stop_minutes >= 1) {
            return `${nb.eta_to_origin_stop_minutes.toFixed(1)} min`;
        }
        if (nb.eta_to_origin_stop != null) {
            const seconds = nb.eta_to_origin_stop;
            if (seconds < 60) return '< 1 min';
            return `${Math.round(seconds / 60)} min`;
        }
        return 'No ETA';
    };

    const hasTrip = !!trip && trip.segments && trip.segments.length > 0;

    const ORIGIN_WALK_THRESHOLD_M = 30;
    const DEST_WALK_THRESHOLD_M = 30;

    const originNeedsWalk =
        !!trip &&
        trip.origin &&
        typeof trip.origin.distance_m === 'number' &&
        trip.origin.distance_m > ORIGIN_WALK_THRESHOLD_M;

    const destNeedsWalk =
        !!trip &&
        trip.destination &&
        typeof trip.destination.distance_m === 'number' &&
        trip.destination.distance_m > DEST_WALK_THRESHOLD_M;

    const originWalkInfo = originNeedsWalk
        ? formatWalkLeg(trip.origin.distance_m)
        : null;

    const destWalkInfo = destNeedsWalk
        ? formatWalkLeg(trip.destination.distance_m)
        : null;

    return (
        <motion.div
            className={clsx(
                "bg-neutral-900/90 backdrop-blur-md border border-white/5 shadow-xl rounded-xl overflow-hidden flex flex-col max-h-[85vh]",
                className
            )}
            initial={{ y: -20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ delay: 0.5, duration: 0.5 }}
        >
            <div className="p-4 flex flex-col h-full max-h-[85vh]">
                {/* Header with System Selector */}
                <div className="flex items-center justify-between shrink-0">
                    <div className="flex items-center gap-2">
                        <img src={logo} alt="Crimson Shuttle" className="h-6 w-auto opacity-90" />
                        <div className="flex flex-col">
                            <span className="text-sm font-bold text-white leading-tight">
                                Crimson Shuttle
                            </span>
                            <span className="text-[10px] text-neutral-400 font-medium leading-tight">
                                {system ? system.name : 'Select system'}
                            </span>
                        </div>
                    </div>

                    <button
                        type="button"
                        onClick={onChangeSystem}
                        className="inline-flex items-center rounded-full border border-neutral-700/50 bg-neutral-800/50 px-2.5 py-1 text-[10px] font-medium text-neutral-300 hover:border-crimson/50 hover:text-white transition-all"
                    >
                        Change
                    </button>
                </div>

                {/* Inputs */}
                <div className="space-y-4 pt-1 shrink-0 relative">
                    {/* Origin Field */}
                    <div className="space-y-1.5 relative">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-1.5 px-0.5">
                                <Navigation size={12} className="text-neutral-400" />
                                <span className="text-[10px] font-bold text-neutral-500 uppercase tracking-wider">From</span>
                            </div>
                            <button
                                type="button"
                                onClick={() => setOriginMode((m) => (m === 'search' ? 'dropdown' : 'search'))}
                                className="text-[9px] font-bold text-neutral-500 hover:text-white transition-colors uppercase tracking-tight bg-neutral-800/50 px-2 py-0.5 rounded-full border border-white/5"
                            >
                                {originMode === 'search' ? 'Use List' : 'Use Search'}
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
                                    }}
                                    onFocus={() => setOriginOpen(true)}
                                    onBlur={() => {
                                        setTimeout(() => setOriginOpen(false), 120);
                                    }}
                                    placeholder="Search for a stop..."
                                    className="w-full bg-neutral-800/70 border border-white/5 focus:border-crimson/50 rounded-lg px-3 py-2 text-xs text-white outline-none transition-all placeholder:text-neutral-600"
                                />

                                <button
                                    type="button"
                                    onClick={handleUseCurrentLocation}
                                    className={clsx(
                                        "absolute right-2 top-1.5 px-2 py-1 rounded-md text-[9px] font-bold transition-all border",
                                        originUseCurrentLocation
                                            ? "bg-crimson/20 border-crimson/40 text-crimson"
                                            : "bg-neutral-900 border-white/5 text-neutral-400 hover:text-white"
                                    )}
                                >
                                    {locating ? 'Locating...' : 'My Location'}
                                </button>

                                {/* Suggestions */}
                                {originOpen && !originUseCurrentLocation && originQuery && originSuggestions.length > 0 && (
                                    <div className="absolute z-50 left-0 right-0 mt-1 max-h-48 overflow-y-auto rounded-lg bg-neutral-900 border border-white/10 shadow-2xl custom-scrollbar py-1">
                                        {originSuggestions.map((s) => (
                                            <button
                                                key={s.id}
                                                type="button"
                                                onMouseDown={(e) => e.preventDefault()}
                                                onClick={() => {
                                                    setOriginStopId(s.id.toString());
                                                    setOriginQuery(s.name);
                                                    setOriginOpen(false);
                                                }}
                                                className="w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-white/5 hover:text-white transition-colors flex items-center gap-2"
                                            >
                                                <div className="w-1 h-1 rounded-full bg-neutral-600" />
                                                {s.name}
                                            </button>
                                        ))}
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
                                }}
                                className="w-full bg-neutral-800/70 border border-white/5 focus:border-crimson/50 rounded-lg px-3 py-2 text-xs text-white outline-none transition-all appearance-none"
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
                                {destMode === 'search' ? 'Use List' : 'Use Search'}
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
                                    }}
                                    onFocus={() => setDestOpen(true)}
                                    onBlur={() => {
                                        setTimeout(() => setDestOpen(false), 120);
                                    }}
                                    placeholder="Search for a stop..."
                                    className="w-full bg-neutral-800/70 border border-white/5 focus:border-crimson/50 rounded-lg px-3 py-2 text-xs text-white outline-none transition-all placeholder:text-neutral-600"
                                />

                                {/* Suggestions */}
                                {destOpen && destQuery && destSuggestions.length > 0 && (
                                    <div className="absolute z-50 left-0 right-0 mt-1 max-h-48 overflow-y-auto rounded-lg bg-neutral-900 border border-white/10 shadow-2xl custom-scrollbar py-1">
                                        {destSuggestions.map((s) => (
                                            <button
                                                key={s.id}
                                                type="button"
                                                onMouseDown={(e) => e.preventDefault()}
                                                onClick={() => {
                                                    setDestStopId(s.id.toString());
                                                    setDestQuery(s.name);
                                                    setDestOpen(false);
                                                }}
                                                className="w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-white/5 hover:text-white transition-colors flex items-center gap-2"
                                            >
                                                <div className="w-1 h-1 rounded-full bg-neutral-600" />
                                                {s.name}
                                            </button>
                                        ))}
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
                                }}
                                className="w-full bg-neutral-800 border border-white/5 focus:border-crimson/50 rounded-lg px-3 py-2 text-xs text-white outline-none transition-all appearance-none"
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
                        }}
                        className="h-10 px-3 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-400 hover:text-white transition-colors flex items-center justify-center"
                        title="Swap locations"
                    >
                        <ArrowUpDown size={16} />
                    </button>

                    <button
                        onClick={handlePlanTrip}
                        disabled={planning || !system || (!originStopId && !originUseCurrentLocation) || !destStopId}
                        className={clsx(
                            "h-10 flex-1 text-sm font-bold rounded-lg transition-all",
                            (system && (originStopId || originUseCurrentLocation) && destStopId)
                                ? "bg-[#A20202] hover:bg-[#8a0101] text-white shadow-lg shadow-red-900/30"
                                : "bg-neutral-800 text-neutral-500 cursor-not-allowed"
                        )}
                    >
                        {planning ? 'Planning...' : 'Plan Trip'}
                    </button>
                </div>

                {error && <p className="text-xs text-red-400 font-medium -mt-2 mb-2 px-1">{error}</p>}

                {/* Itinerary Section */}
                <div className="flex-1 overflow-hidden flex flex-col pt-2 min-h-0">
                    {/* ITINERARY header with collapse toggle */}
                    <div className="mb-2 flex items-center justify-between text-xs text-neutral-500">
                        <button
                            type="button"
                            onClick={() => setItineraryOpen((o) => !o)}
                            className="flex items-center gap-2 group"
                        >
                            <span className="tracking-[0.2em] uppercase font-bold text-[10px] text-neutral-500">Itinerary</span>
                            <span className="text-[10px] text-neutral-600 font-medium opacity-0 group-hover:opacity-100 transition-opacity">
                                {itineraryOpen ? 'Hide' : 'Show'}
                            </span>
                        </button>

                        <button
                            type="button"
                            onClick={() => setItineraryOpen((o) => !o)}
                            className="rounded-full bg-neutral-800/50 p-1 hover:bg-neutral-800 transition-colors"
                            aria-label={itineraryOpen ? 'Collapse itinerary' : 'Expand itinerary'}
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

                    <AnimatePresence initial={false}>
                        {itineraryOpen && (
                            <motion.div
                                key="itinerary-content"
                                initial={{ opacity: 0, height: 0 }}
                                animate={{ opacity: 1, height: 'auto' }}
                                exit={{ opacity: 0, height: 0 }}
                                transition={{ duration: 0.2, ease: 'easeOut' }}
                                className="mt-2 overflow-hidden flex-1 flex flex-col min-h-0"
                            >
                                <div className="flex-1 overflow-y-auto overscroll-contain touch-pan-y [-webkit-overflow-scrolling:touch] space-y-3 pr-1 custom-scrollbar">
                                    <AnimatePresence mode="wait">
                                        {!hasTrip ? (
                                            <motion.div
                                                key="empty-state"
                                                initial={{ opacity: 0 }}
                                                animate={{ opacity: 1 }}
                                                exit={{ opacity: 0 }}
                                                className="flex flex-col items-center justify-center py-8 text-center text-neutral-500"
                                            >
                                                <Info size={24} className="mb-2 opacity-20" />
                                                <p className="text-[11px] leading-relaxed max-w-[180px]">
                                                    Select your stops and tap <span className="text-neutral-400 font-semibold">Plan Trip</span> to see the best route and live ETAs.
                                                </p>
                                            </motion.div>
                                        ) : (
                                            <motion.div
                                                key="itinerary-content"
                                                initial={{ opacity: 0, y: 10 }}
                                                animate={{ opacity: 1, y: 0 }}
                                                className="space-y-4"
                                            >
                                                {/* Overview */}
                                                <div className="rounded-xl bg-neutral-900/70 p-3 text-xs border border-white/5">
                                                    <div className="flex items-center justify-between mb-2">
                                                        <div className="flex items-center gap-2">
                                                            <div className="w-1.5 h-1.5 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]" />
                                                            <span className="text-[11px] font-bold text-white">Route Overview</span>
                                                        </div>
                                                        <div className="rounded-full bg-neutral-950/80 px-2 py-1 text-[10px] text-neutral-300 font-medium">
                                                            {overallEtaLabel}
                                                        </div>
                                                    </div>
                                                    <div className="text-[10px] text-neutral-300 leading-relaxed">
                                                        From <span className="font-medium text-white">{trip.origin.nearest_stop.name}</span> to{' '}
                                                        <span className="font-medium text-white">{trip.destination.nearest_stop.name}</span>
                                                    </div>
                                                </div>

                                                {/* Walking leg: origin → nearest stop */}
                                                {originNeedsWalk && originWalkInfo && (
                                                    <div className="rounded-xl bg-neutral-900/80 p-3 text-xs border border-white/5">
                                                        <div className="flex items-center justify-between">
                                                            <div className="flex items-center gap-2">
                                                                <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-neutral-800 text-[11px]">
                                                                    🚶
                                                                </span>
                                                                <div className="font-bold text-white text-[11px]">Walk to stop</div>
                                                            </div>
                                                            <span className="rounded-full bg-neutral-950/80 px-2 py-1 text-[10px] text-neutral-300 font-medium">
                                                                {originWalkInfo.minutesLabel}
                                                            </span>
                                                        </div>
                                                        <div className="mt-1.5 text-neutral-300 text-[10px] leading-relaxed">
                                                            Walk from your location to{' '}
                                                            <span className="font-medium text-white">{trip.origin.nearest_stop.name}</span>.
                                                        </div>
                                                        <div className="mt-1 text-[9px] text-neutral-500 font-medium">
                                                            ~{Math.round(trip.origin.distance_m)} m
                                                        </div>
                                                    </div>
                                                )}

                                                {/* Segments */}
                                                {trip.segments.map((seg, idx) => (
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
                                                                <div className="flex items-center gap-1.5 text-[10px] text-neutral-400 bg-neutral-900/50 px-2 py-0.5 rounded-full">
                                                                    <Clock size={10} />
                                                                    {formatEta(seg)}
                                                                </div>
                                                            </div>

                                                            <div className="text-[10px] text-neutral-400 mb-3">
                                                                Board at <span className="text-neutral-200 font-medium">{seg.start_stop.name}</span>
                                                            </div>

                                                            <div className="space-y-1.5 pt-2 border-t border-white/5">
                                                                <span className="text-[9px] font-bold text-neutral-500 uppercase tracking-tighter block mb-1">Stops on track</span>
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
                                                {destNeedsWalk && destWalkInfo && (
                                                    <div className="rounded-xl bg-neutral-900/80 p-3 text-xs border border-white/5">
                                                        <div className="flex items-center justify-between">
                                                            <div className="flex items-center gap-2">
                                                                <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-neutral-800 text-[11px]">
                                                                    🚶
                                                                </span>
                                                                <div className="font-bold text-white text-[11px]">Walk to destination</div>
                                                            </div>
                                                            <span className="rounded-full bg-neutral-950/80 px-2 py-1 text-[10px] text-neutral-300 font-medium">
                                                                {destWalkInfo.minutesLabel}
                                                            </span>
                                                        </div>
                                                        <div className="mt-1.5 text-neutral-300 text-[10px] leading-relaxed">
                                                            From{' '}
                                                            <span className="font-medium text-white">{trip.destination.nearest_stop.name}</span>{' '}
                                                            walk to your destination.
                                                        </div>
                                                        <div className="mt-1 text-[9px] text-neutral-500 font-medium">
                                                            ~{Math.round(trip.destination.distance_m)} m
                                                        </div>
                                                    </div>
                                                )}

                                                <div className="text-[9px] text-neutral-500 italic text-center pt-2">
                                                    Live tracking data updated every 3 seconds
                                                </div>
                                            </motion.div>
                                        )}
                                    </AnimatePresence>
                                </div>
                            </motion.div>
                        )}
                    </AnimatePresence>
                </div>
            </div>
        </motion.div>
    );
};
