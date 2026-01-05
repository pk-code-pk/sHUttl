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
        <div className="relative w-full h-screen overflow-hidden">
            {/* Background Map - fills entire screen */}
            <div className="absolute inset-0 z-0">
                <MapShell systemId={system?.id ?? null} trip={trip} userLocation={userLocation} />
            </div>

            {/* 
              UI Overlay Container 
              - pointer-events-none allows clicks to pass through to map
              - On mobile: fixed bottom-0 for bottom sheet
              - On desktop: relative flex layout for side panel
            */}
            <div className="
                pointer-events-none
                fixed inset-x-0 bottom-0 z-20 
                /* Mobile: Full edge-to-edge width */
                w-full
                
                /* Desktop: reset positioning */
                md:static md:inset-auto md:h-full md:w-full
                flex flex-col md:flex-row md:items-start md:p-6
            ">
                {/* 
                  Trip Planner Panel Container 
                  - pointer-events-auto re-enables clicks for the panel itself
                  - Mobile: w-full
                  - Desktop: w-[400px]
                */}
                <div className="
                    w-full md:w-[400px]
                    flex justify-center md:block
                ">
                    <TripPlannerPanel
                        className="w-full"
                        system={system}
                        onChangeSystem={onChangeSystem}
                        trip={trip}
                        onTripChange={onTripChange}
                        onUserLocationChange={setUserLocation}
                    />
                </div>

                {/* Developer Footer - hidden on mobile bottom sheet mode to save space, visible on desktop */}
                <div className="hidden md:block fixed bottom-2 left-1/2 -translate-x-1/2 pointer-events-none">
                    <p className="pointer-events-auto bg-black/40 backdrop-blur-sm px-2 py-1 rounded text-[10px] text-white/50 font-medium">
                        Developed by Keyan K
                    </p>
                </div>
            </div>
        </div>
    );
};
