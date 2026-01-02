import { useEffect, useMemo, useState } from 'react';
import { MapContainer, TileLayer, CircleMarker, Popup } from 'react-leaflet';
import type { LatLngExpression } from 'leaflet';
import { ShuttleMarker } from './ShuttleMarker';
import type { Stop, Vehicle } from './types';

interface MapShellProps {
    systemId: number | null;
}

const STOP_WHITE = "#FFFFFF";

export const MapShell = ({ systemId }: MapShellProps) => {
    const [stops, setStops] = useState<Stop[]>([]);
    const [vehicles, setVehicles] = useState<Vehicle[]>([]);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (!systemId) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setStops([]);
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setVehicles([]);
            return;
        }
        setLoading(true);
        fetch(`http://localhost:8000/stops?system_id=${systemId}`)
            .then((res) => res.json())
            .then((data) => setStops(data))
            .catch((err) => console.error("Failed to fetch stops", err))
            .finally(() => setLoading(false));
    }, [systemId]);

    // Poll vehicles every few seconds
    useEffect(() => {
        if (!systemId) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setVehicles([]);
            return;
        }

        let cancelled = false;

        const fetchVehicles = () => {
            fetch(`http://localhost:8000/vehicles?system_id=${systemId}`)
                .then((res) => res.json())
                .then((data) => {
                    if (!cancelled) setVehicles(data);
                })
                .catch(() => { });
        };

        fetchVehicles();
        const id = setInterval(fetchVehicles, 3000);

        return () => {
            cancelled = true;
            clearInterval(id);
        };
    }, [systemId]);

    // Compute center from stops, fallback to Harvard if none
    const center: LatLngExpression = useMemo(() => {
        if (stops.length === 0) {
            // Default: Harvard campus-ish
            return [42.3736, -71.1097];
        }
        const avgLat = stops.reduce((sum, s) => sum + s.lat, 0) / stops.length;
        const avgLng = stops.reduce((sum, s) => sum + s.lng, 0) / stops.length;
        return [avgLat, avgLng];
    }, [stops]);

    return (
        <div className="relative h-full w-full bg-neutral-900">
            {systemId ? (
                <MapContainer
                    key={systemId}
                    center={center}
                    zoom={15}
                    className="h-full w-full bg-neutral-900"
                    scrollWheelZoom={true}
                    zoomControl={false}
                >
                    {/* Stadia Dark Theme */}
                    <TileLayer
                        attribution='&copy; <a href="https://stadiamaps.com/">Stadia Maps</a>, &copy; <a href="https://openmaptiles.org/">OpenMapTiles</a> &copy; <a href="http://openstreetmap.org">OpenStreetMap</a> contributors'
                        url="https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png"
                        maxZoom={20}
                    />

                    {/* Stops: White Glowing Dots */}
                    {stops.map((stop) => (
                        <div key={stop.id}>
                            {/* Halo */}
                            <CircleMarker
                                center={[stop.lat, stop.lng]}
                                radius={8}
                                pathOptions={{
                                    stroke: false,
                                    fill: true,
                                    fillColor: STOP_WHITE,
                                    fillOpacity: 0.08,
                                    interactive: false,
                                    className: "stop-white-glow",
                                }}
                            />

                            {/* Core */}
                            <CircleMarker
                                center={[stop.lat, stop.lng]}
                                radius={2.5}
                                pathOptions={{
                                    stroke: true,
                                    color: "rgba(255,255,255,0.4)",
                                    weight: 1,
                                    opacity: 0.8,
                                    fill: true,
                                    fillColor: STOP_WHITE,
                                    fillOpacity: 1.0,
                                    className: "stop-white-glow",
                                }}
                            >
                                <Popup>
                                    <div className="text-sm text-neutral-800">
                                        <div className="font-semibold">{stop.name}</div>
                                        <div className="text-xs text-neutral-500">
                                            Stop ID: {stop.id}
                                        </div>
                                    </div>
                                </Popup>
                            </CircleMarker>
                        </div>
                    ))}

                    {/* Vehicles with Smooth Animation */}
                    {vehicles
                        .filter((v): v is Vehicle & { lat: number; lng: number } => v.lat !== null && v.lng !== null)
                        .map((v) => (
                            <ShuttleMarker key={v.id} v={v} durationMs={1200} />
                        ))}
                </MapContainer>
            ) : (
                <div className="flex h-full w-full items-center justify-center text-neutral-500">
                    <p>Select a system to view map</p>
                </div>
            )}

            {/* Status pill */}
            <div className="pointer-events-none absolute bottom-8 left-1/2 -translate-x-1/2 rounded-full bg-black/60 backdrop-blur-md px-4 py-1.5 text-xs text-neutral-300 z-[1000] border border-white/10 shadow-lg">
                {systemId
                    ? loading
                        ? 'Loading stops…'
                        : `${stops.length} stops • ${vehicles.length} vehicles`
                    : 'Select a system to begin'}
            </div>
        </div>
    );
};
