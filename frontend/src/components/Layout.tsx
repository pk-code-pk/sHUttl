import { TripPlannerPanel } from "./TripPlannerPanel";
import { MapShell } from "./MapShell";

export const Layout = () => {
    return (
        <div className="relative w-full h-screen overflow-hidden flex flex-col">
            {/* Background Map */}
            <div className="absolute inset-0 z-0">
                <MapShell />
            </div>

            {/* Foreground UI Layer */}
            <div className="relative z-10 pointer-events-none w-full h-full flex flex-col">
                {/* Top Section */}
                <div className="p-4 md:p-6 flex flex-col md:flex-row md:items-start gap-4 pointer-events-auto">
                    {/* Trip Planner Card */}
                    <div className="w-full md:w-[400px]">
                        <TripPlannerPanel onGo={() => console.log("Go clicked")} />
                    </div>
                </div>

                {/* Bottom spacer / interactive area for future sheets */}
                <div className="flex-1" />
            </div>
        </div>
    );
};
