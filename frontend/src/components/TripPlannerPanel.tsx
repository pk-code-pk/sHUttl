import { motion } from "framer-motion";
import { MapPin, Navigation, ArrowUpDown, Home } from "lucide-react";
import clsx from "clsx";
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
}

export const TripPlannerPanel = ({ className, onGo, system, onChangeSystem }: TripPlannerPanelProps) => {
    return (
        <motion.div
            className={clsx(
                "bg-neutral-900/90 backdrop-blur-md border border-white/5 shadow-xl rounded-xl overflow-hidden",
                className
            )}
            initial={{ y: -20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ delay: 0.5, duration: 0.5 }}
        >
            <div className="p-4 space-y-4">
                {/* Header with System Selector */}
                <div className="flex items-center justify-between">
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
                <div className="space-y-3 relative pt-1">

                    {/* Connector Line */}
                    <div className="absolute left-[1.15rem] top-9 bottom-4 w-0.5 bg-neutral-700/50 -z-10" />

                    {/* Origin */}
                    <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-neutral-800 flex items-center justify-center shrink-0 text-neutral-400">
                            <Navigation size={16} />
                        </div>
                        <div className="flex-1 relative">
                            <input
                                type="text"
                                placeholder="Current Location"
                                className="w-full bg-neutral-800/50 border border-transparent focus:border-crimson/50 rounded-lg px-3 py-2 text-sm text-white placeholder:text-neutral-500 outline-none transition-colors"
                            />
                        </div>
                    </div>

                    {/* Destination */}
                    <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-neutral-800 flex items-center justify-center shrink-0 text-crimson">
                            <MapPin size={16} />
                        </div>
                        <div className="flex-1">
                            <input
                                type="text"
                                placeholder="Where to?"
                                className="w-full bg-neutral-800 border border-transparent focus:border-crimson/50 rounded-lg px-3 py-2 text-sm text-white placeholder:text-neutral-500 outline-none transition-colors"
                                autoFocus
                            />
                        </div>
                    </div>
                </div>

                {/* Actions Row */}
                <div className="flex items-center gap-2 pt-2">
                    <button className="p-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-400 transition-colors" title="Swap locations">
                        <ArrowUpDown size={18} />
                    </button>
                    <button className="p-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-400 transition-colors flex items-center gap-2 px-3" title="Set Home">
                        <Home size={18} />
                        <span className="text-xs font-medium">Set Home</span>
                    </button>

                    <div className="flex-1" />

                    <button
                        onClick={onGo}
                        disabled={!system}
                        className={clsx(
                            "font-medium px-6 py-2 rounded-lg transition-all shadow-lg",
                            system
                                ? "bg-crimson hover:bg-[#8a1523] text-white shadow-crimson/20"
                                : "bg-neutral-800 text-neutral-500 cursor-not-allowed shadow-none"
                        )}
                    >
                        Go
                    </button>
                </div>
            </div>
        </motion.div>
    );
};
