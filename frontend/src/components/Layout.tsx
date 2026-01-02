import { TripPlannerPanel } from "./TripPlannerPanel";
import { MapShell } from "./MapShell";

interface System {
    id: number;
    name: string;
}

interface LayoutProps {
    system: System | null;
    onChangeSystem: () => void;
}

export const Layout = ({ system, onChangeSystem }: LayoutProps) => {
    return (
        <div className="relative w-full h-screen overflow-hidden flex flex-col">
            {/* Background Map */}
            <div className="absolute inset-0 z-0">
                <MapShell systemId={system?.id ?? null} />
            </div>

            {/* Foreground UI Layer */}
            <div className="relative z-10 pointer-events-none w-full h-full flex flex-col">
                {/* Top Section */}
                <div className="p-4 md:p-6 flex flex-col md:flex-row md:items-start gap-4 pointer-events-auto">
                    {/* Trip Planner Card */}
                    <div className="w-full md:w-[400px]">
                        <TripPlannerPanel
                            onGo={() => console.log("Go clicked")}
                            system={system}
                            onChangeSystem={onChangeSystem}
                        />
                    </div>
                </div>

                {/* Bottom spacer / interactive area for future sheets */}
                <div className="flex-1" />

                {/* Developer Footer */}
                <div className="p-2 text-center pointer-events-auto pb-4 md:pb-2">
                    <p className="text-[10px] text-neutral-500/80 font-medium">Developed by Praneel Khiantani</p>
                </div>
            </div>
        </div>
    );
};

