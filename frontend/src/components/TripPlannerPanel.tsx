import { motion } from "framer-motion";
import { MapPin, Navigation, ArrowUpDown, Home } from "lucide-react";
import clsx from "clsx";

interface TripPlannerPanelProps {
    className?: string;
    onGo?: () => void;
}

export const TripPlannerPanel = ({ className, onGo }: TripPlannerPanelProps) => {
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
                {/* Header */}
                <h2 className="text-lg font-semibold text-white">Where to?</h2>

                {/* Inputs */}
                <div className="space-y-3 relative">

                    {/* Connector Line */}
                    <div className="absolute left-[1.15rem] top-8 bottom-8 w-0.5 bg-neutral-700/50 -z-10" />

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
                        className="bg-crimson hover:bg-red-700 text-white font-medium px-6 py-2 rounded-lg transition-colors shadow-lg shadow-crimson/20"
                    >
                        Go
                    </button>
                </div>
            </div>
        </motion.div>
    );
};
