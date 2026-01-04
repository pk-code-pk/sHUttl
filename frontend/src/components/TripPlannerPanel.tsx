import { useState, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { MapPin, Navigation, ArrowUpDown, Clock, Info, ChevronDown } from "lucide-react";
import clsx from "clsx";
import type { TripResponse } from "./types";
import {
    metersToMinutes,
    formatMinutesLabel,
    isWalkReasonable,
    etaSecondsToMinutes,
} from "../utils/timeAndDistance";
import { formatEtaSeconds } from "../utils/time";
import logo from "../assets/logo.svg";
import { API_BASE_URL } from "@/config";

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

// Helper for total trip ETA
function computeTripEtaLabel(segments: any[]): { label: string | null, partial: boolean } {
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
                    } catch { }
                    throw new Error(message);
                }
                return res.json();
            })
            .then((data: StopOption[]) => {
                setStops(data || []);
                setOriginStopId('');
                setDestStopId('');
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
                resetLiveState();
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
            const data: TripResponse = await res.json();
            onTripChange(data);

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
        } catch (e: any) {
            console.error(e);
            setError(e.message || 'Could not plan trip. Please try again.');
            onTripChange(null);
        } finally {
            setPlanning(false);
        }
    };

    // Helper: Reset live updates when inputs change significantly
    const resetLiveState = () => {
        setActiveTripParams(null);
        setIsLiveUpdating(false);
        setLastUpdatedAt(null);
    };

    // Helper: Check if trip has real-time data
    const hasRealtimeData = (t: typeof trip): boolean => {
        if (!t) return false;
        return t.segments.some((seg) => seg.next_bus != null);
    };

    // Polling logic for live updates
    useEffect(() => {
        if (!isLiveUpdating || !activeTripParams || !trip) return;
        if (!hasRealtimeData(trip)) {
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
                const data: TripResponse = await res.json();

                if (!isCancelled) {
                    onTripChange(data);
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
        return trip.segments.map((seg) => {
            const etaSeconds = seg.next_bus?.eta_to_origin_stop ?? null;
            const etaMin = etaSecondsToMinutes(etaSeconds);
            return {
                ...seg,
                _etaMinutes: etaMin,
            };
        });
    }, [trip]);

    const hasTrip = !!trip && normalizedSegments.length > 0;

    const originWalkM = trip?.origin.distance_m ?? 0;
    const originWalkMin = metersToMinutes(originWalkM);
    const shouldShowOriginWalk = isWalkReasonable(originWalkM);

    const destWalkM = trip?.destination.distance_m ?? 0;
    const destWalkMin = metersToMinutes(destWalkM);
    const shouldShowDestWalk = isWalkReasonable(destWalkM);

    const numSegments = normalizedSegments.length;
    const numTransfers = Math.max(0, numSegments - 1);


    const totalWalkM =
        (shouldShowOriginWalk ? originWalkM : 0) +
        (shouldShowDestWalk ? destWalkM : 0);
    const totalWalkMin = metersToMinutes(totalWalkM);

    const { label: tripEtaLabel, partial: isTripEtaPartial } = useMemo(() => computeTripEtaLabel(normalizedSegments), [normalizedSegments]);

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
                                        resetLiveState();
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
                                    resetLiveState();
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
                                        resetLiveState();
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
                                    resetLiveState();
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

                {stopsError && (
                    <div className="mt-3 rounded-xl border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-[11px] text-yellow-100/90 leading-relaxed shadow-sm">
                        <div className="flex items-center gap-2 mb-0.5">
                            <Info size={12} className="text-yellow-500" />
                            <span className="font-bold uppercase tracking-tight">System Info</span>
                        </div>
                        {stopsError}
                    </div>
                )}

                {error && (
                    <div className="mt-3 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2 text-[11px] text-red-100/90 leading-relaxed shadow-sm animate-in fade-in slide-in-from-top-1 duration-200">
                        <div className="flex items-center gap-2 mb-0.5">
                            <div className="w-1 h-1 rounded-full bg-red-500 animate-pulse" />
                            <span className="font-bold uppercase tracking-tight">Trip Error</span>
                        </div>
                        {error}
                    </div>
                )}

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
                                                <div className="rounded-xl bg-neutral-900/80 p-3 text-xs border border-white/5 shadow-sm">
                                                    <div className="flex items-center justify-between">
                                                        <div className="flex flex-col flex-1 min-w-0">
                                                            <div className="flex items-center gap-2 mb-1">
                                                                <div className="w-1.5 h-1.5 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]" />
                                                                <span className="text-[11px] font-bold text-white uppercase tracking-tight">Route Overview</span>
                                                            </div>
                                                            <div className="text-[10px] text-neutral-300 truncate">
                                                                From <span className="font-medium text-white">{trip.origin.nearest_stop.name}</span> to{' '}
                                                                <span className="font-medium text-white">{trip.destination.nearest_stop.name}</span>
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

                                                    {!isWalkReasonable(trip.origin.distance_m) && !isWalkReasonable(trip.destination.distance_m) && (
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
                                                                <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-neutral-800 text-[11px]">
                                                                    🚶
                                                                </span>
                                                                <div className="font-bold text-white text-[11px]">Walk to stop</div>
                                                            </div>
                                                            <span className="rounded-full bg-neutral-950/80 px-2 py-1 text-[10px] text-neutral-300 font-medium">
                                                                {originWalkMin != null ? formatMinutesLabel(originWalkMin) : ''}
                                                            </span>
                                                        </div>
                                                        <div className="mt-1.5 text-neutral-300 text-[10px] leading-relaxed">
                                                            Walk from your location to{' '}
                                                            <span className="font-medium text-white">{trip.origin.nearest_stop.name}</span>.
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
                                                                        const hasRealtimeWait = !!waitLabel;

                                                                        return hasRealtimeWait ? (
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
                                                                            <p className="text-[10px] text-neutral-500">
                                                                                Bus arrives at this stop in {waitLabel}.
                                                                            </p>
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
                                                {shouldShowDestWalk && (
                                                    <div className="rounded-xl bg-neutral-900/80 p-3 text-xs border border-white/5">
                                                        <div className="flex items-center justify-between">
                                                            <div className="flex items-center gap-2">
                                                                <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-neutral-800 text-[11px]">
                                                                    🚶
                                                                </span>
                                                                <div className="font-bold text-white text-[11px]">Walk to destination</div>
                                                            </div>
                                                            <span className="rounded-full bg-neutral-950/80 px-2 py-1 text-[10px] text-neutral-300 font-medium">
                                                                {destWalkMin != null ? formatMinutesLabel(destWalkMin) : ''}
                                                            </span>
                                                        </div>
                                                        <div className="mt-1.5 text-neutral-300 text-[10px] leading-relaxed">
                                                            From{' '}
                                                            <span className="font-medium text-white">{trip.destination.nearest_stop.name}</span>{' '}
                                                            walk to your destination.
                                                        </div>
                                                        <div className="mt-1 text-[9px] text-neutral-500 font-medium tracking-tight">
                                                            ~{Math.round(destWalkM)} m
                                                        </div>
                                                    </div>
                                                )}

                                                <div className="text-[10px] text-neutral-500 text-center pt-2 pb-1 border-t border-white/5 mx-2">
                                                    {hasRealtimeData(trip) ? (
                                                        <div className="flex flex-col gap-0.5">
                                                            <div className="flex items-center justify-center gap-1.5">
                                                                {isLiveUpdating && (
                                                                    <div className="w-1 h-1 rounded-full bg-green-500 animate-pulse" />
                                                                )}
                                                                <span>{updatedLabel}</span>
                                                            </div>
                                                            {isLiveUpdating && (
                                                                <span className="text-[9px] opacity-70">
                                                                    Live tracking every {POLL_INTERVAL_MS / 1000}s
                                                                </span>
                                                            )}
                                                        </div>
                                                    ) : (
                                                        <span className="italic opacity-70">No real-time data for this route</span>
                                                    )}
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
