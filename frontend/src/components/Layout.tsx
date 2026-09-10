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
    trip: TripResponse | null;
    onTripChange: (trip: TripResponse | null) => void;
}

export const Layout = ({ system, trip, onTripChange }: LayoutProps) => {
    const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
    // Route Next Bus Out has expanded, for the map to draw and frame. Lifted
    // here because the panel and the map are siblings.
    const [focusRouteId, setFocusRouteId] = useState<string | null>(null);

    return (
        <div className="fixed inset-0 md:relative md:w-full md:h-[100dvh] overflow-hidden bg-neutral-950 overscroll-none">
            {/* Background Map - fills entire screen */}
            <div className="absolute inset-0 z-0">
                <MapShell
                    systemId={system?.id ?? null}
                    trip={trip}
                    userLocation={userLocation}
                    focusRouteId={focusRouteId}
                />
            </div>

            {/* 
              UI Overlay Container 
              - pointer-events-none allows clicks to pass through to map
              - On mobile: fixed bottom-0 for bottom sheet
              - On desktop: relative flex layout for side panel
            */}
            <div className="
                pointer-events-none
                fixed inset-0 z-20 
                w-full
                
                /* Desktop: reset positioning */
                md:static md:inset-auto md:h-full md:w-full
                flex flex-col md:flex-row md:justify-start md:items-start md:p-6
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
                        trip={trip}
                        onTripChange={onTripChange}
                        onUserLocationChange={setUserLocation}
                        onFocusRouteChange={setFocusRouteId}
                    />
                </div>

                {/* Byline. Desktop only — the mobile sheet needs the room.

                    It used to be a chip, on its own dark ground with its own
                    corner radius, sitting a few pixels under the control row
                    and reading as a fourth button in it. A byline is the
                    quietest thing on the screen, so it is set as plain text
                    with no surface of its own. */}
                <div className="pointer-events-none fixed bottom-2 left-1/2 hidden -translate-x-1/2 md:block">
                    <p className="text-[10px] font-medium text-white/35">
                        Developed by Praneel Khiantani
                    </p>
                </div>
            </div>
        </div>
    );
};
