import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Search, ChevronRight } from "lucide-react";
import clsx from "clsx";

interface System {
    id: number;
    name: string;
}

interface SystemSelectModalProps {
    onSelect: (system: System) => void;
    isOpen: boolean;
}

export const SystemSelectModal = ({ onSelect, isOpen }: SystemSelectModalProps) => {
    const [systems, setSystems] = useState<System[]>([]);
    const [loading, setLoading] = useState(false);
    const [search, setSearch] = useState("");
    const [selectedId, setSelectedId] = useState<number | null>(null);

    useEffect(() => {
        if (isOpen && systems.length === 0) {
            setLoading(true);
            // Fetch from backend
            fetch("http://localhost:8000/systems")
                .then(res => res.json())
                .then(data => setSystems(data))
                .catch(err => console.error("Failed to fetch systems", err))
                .finally(() => setLoading(false));
        }
    }, [isOpen, systems.length]);

    const filteredSystems = systems.filter(s =>
        s.name.toLowerCase().includes(search.toLowerCase()) && s.id !== 831 // Exclude Harvard from list as it's pinned
    );

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
                        <h2 className="text-xl font-semibold text-white mb-1">Choose your shuttle system</h2>
                        <p className="text-sm text-neutral-400">Select the transit system you want to track.</p>
                    </div>

                    {/* Content */}
                    <div className="p-6 overflow-y-auto space-y-6">

                        {/* Primary Option: Harvard */}
                        <div>
                            <button
                                onClick={() => onSelect({ id: 831, name: "Harvard Shuttles" })}
                                className="w-full bg-crimson hover:bg-[#8a1523] text-white p-4 rounded-xl flex items-center justify-between group transition-all transform active:scale-[0.98]"
                            >
                                <div className="flex flex-col items-start">
                                    <span className="font-bold text-lg">Harvard Shuttles</span>
                                    <span className="text-xs text-red-200">Recommended</span>
                                </div>
                                <ChevronRight className="text-red-200 group-hover:translate-x-1 transition-transform" />
                            </button>
                        </div>

                        {/* Other Systems */}
                        <div className="space-y-3">
                            <h3 className="text-xs font-medium text-neutral-500 uppercase tracking-wider">Other Systems</h3>

                            {/* Search */}
                            <div className="relative">
                                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500 w-4 h-4" />
                                <input
                                    type="text"
                                    placeholder="Search systems..."
                                    className="w-full bg-neutral-800 border-none rounded-lg pl-9 pr-4 py-2.5 text-sm text-white placeholder:text-neutral-500 focus:ring-1 focus:ring-neutral-600 outline-none"
                                    value={search}
                                    onChange={e => setSearch(e.target.value)}
                                />
                            </div>

                            {/* List */}
                            <div className="space-y-1.5 min-h-[100px]">
                                {loading ? (
                                    <div className="flex items-center justify-center py-8 text-neutral-500 text-sm">Loading systems...</div>
                                ) : (
                                    filteredSystems.map(sys => (
                                        <button
                                            key={sys.id}
                                            onClick={() => setSelectedId(sys.id)}
                                            className={clsx(
                                                "w-full text-left px-4 py-3 rounded-lg text-sm transition-colors flex items-center justify-between",
                                                selectedId === sys.id
                                                    ? "bg-neutral-800 text-white font-medium ring-1 ring-neutral-700"
                                                    : "text-neutral-300 hover:bg-neutral-800/50 hover:text-white"
                                            )}
                                        >
                                            <span>{sys.name}</span>
                                            {selectedId === sys.id && (
                                                <button
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        onSelect(sys);
                                                    }}
                                                    className="text-xs bg-neutral-700 hover:bg-neutral-600 text-white px-3 py-1.5 rounded-md transition-colors"
                                                >
                                                    Select
                                                </button>
                                            )}
                                        </button>
                                    ))
                                )}
                                {!loading && filteredSystems.length === 0 && (
                                    <div className="text-center py-4 text-neutral-500 text-sm">No other systems found.</div>
                                )}
                            </div>
                        </div>
                    </div>
                </motion.div>
            </motion.div>
        </AnimatePresence>
    );
};
