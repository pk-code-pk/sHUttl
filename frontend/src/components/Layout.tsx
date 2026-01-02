import { useState } from "react";
import { TripPlannerPanel } from "./TripPlannerPanel";
import { MapShell } from "./MapShell";
import type { TripResponse } from "./types";

interface System {
    id: number;
    name: string;
}

interface LayoutProps {
    system: System | null;
    onChangeSystem: () => void;
    trip: TripResponse | null;
    onTripChange: (trip: TripResponse | null) => void;
}

export const Layout = ({ system, onChangeSystem, trip, onTripChange }: LayoutProps) => {
    const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);

    return (
        <div className="relative w-full h-screen overflow-hidden flex flex-col">
            {/* Background Map */}
            <div className="absolute inset-0 z-0">
                <MapShell systemId={system?.id ?? null} trip={trip} userLocation={userLocation} />
            </div>

            {/* Foreground UI Layer - pointer-events-none so map is interactive */}
            <div className="relative z-10 pointer-events-none w-full h-full flex flex-col">
                {/* Top Section - still pointer-events-none */}
                <div className="p-4 md:p-6 flex flex-col md:flex-row md:items-start gap-4">
                    {/* Trip Planner Card - only this element intercepts events */}
                    <div className="pointer-events-auto w-full md:w-[400px]">
                        <TripPlannerPanel
                            onGo={() => console.log("Go clicked")}
                            system={system}
                            onChangeSystem={onChangeSystem}
                            trip={trip}
                            onTripChange={onTripChange}
                            onUserLocationChange={setUserLocation}
                        />
                    </div>
                </div>

                {/* Bottom spacer - no pointer events */}
                <div className="flex-1" />

                {/* Developer Footer - only this element intercepts events */}
                <div className="p-2 text-center pb-4 md:pb-2">
                    <p className="pointer-events-auto inline-block text-[10px] text-neutral-500/80 font-medium">Developed by Praneel Khiantani</p>
                </div>
            </div>
        </div>
    );
};
