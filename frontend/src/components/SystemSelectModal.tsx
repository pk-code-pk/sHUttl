import { motion, AnimatePresence } from "framer-motion";
import { ChevronRight } from "lucide-react";

interface System {
    id: number;
    name: string;
}

interface SystemSelectModalProps {
    onSelect: (system: System) => void;
    isOpen: boolean;
}

export const SystemSelectModal = ({ onSelect, isOpen }: SystemSelectModalProps) => {
    // Harvard is the only system now. The picker used to list thousands of
    // universities, because the old data source was PassioGO's shared API.
    // Harvard left PassioGO in July 2026 and the tracker behind the current
    // feed serves Harvard alone, so there is nothing else to offer.
    if (!isOpen) return null;

    return (
        <AnimatePresence>
            <motion.div
                className="fixed inset-0 z-[60] flex items-center justify-center p-4"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
            >
                {/* Backdrop */}
                <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

                {/* Modal Card */}
                <motion.div
                    className="relative w-full max-w-md bg-neutral-900 border border-neutral-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[80vh]"
                    initial={{ opacity: 0, scale: 0.9, y: 10 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95, y: 8 }}
                    transition={{ duration: 0.2, ease: "easeOut" }}
                >
                    {/* Header */}
                    <div className="p-6 border-b border-neutral-800 bg-neutral-900 sticky top-0 z-10">
                        <h2 className="text-xl font-semibold text-white mb-1">Track Harvard shuttles</h2>
                        <p className="text-sm text-neutral-400">Live vehicle positions and trip planning across all nine routes.</p>
                    </div>

                    {/* Content - with mobile-friendly scroll */}
                    <div className="p-6 overflow-y-auto overscroll-contain touch-pan-y [-webkit-overflow-scrolling:touch] space-y-6">

                        {/* Primary Option: Harvard */}
                        <div>
                            <button
                                onClick={() => onSelect({ id: 831, name: "Harvard Shuttles" })}
                                className="w-full bg-[#A20202] hover:bg-[#8a0101] text-white p-4 rounded-xl flex items-center justify-between group transition-all transform active:scale-[0.98]"
                            >
                                <div className="flex flex-col items-start">
                                    <span className="font-bold text-lg">Harvard Shuttles</span>
                                    <span className="text-xs text-red-200">Live tracking</span>
                                </div>
                                <ChevronRight className="text-red-200 group-hover:translate-x-1 transition-transform" />
                            </button>
                        </div>

                    </div>
                </motion.div>
            </motion.div>
        </AnimatePresence>
    );
};
