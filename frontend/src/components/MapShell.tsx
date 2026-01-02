import clsx from "clsx";

interface MapShellProps {
    className?: string;
    systemId: number | null;
}

export const MapShell = ({ className, systemId }: MapShellProps) => {
    // Placeholder for future map logic using systemId
    if (systemId) {
        console.log("MapShell: Active system ID:", systemId);
    }

    return (
        <div className={clsx("relative w-full h-full bg-neutral-900 overflow-hidden", className)}>
            {/* Placeholder map pattern */}
            <div className="absolute inset-0 opacity-10"
                style={{
                    backgroundImage: "radial-gradient(#404040 1px, transparent 1px)",
                    backgroundSize: "20px 20px"
                }}
            />
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <p className="text-neutral-500 font-medium">Map loading...</p>
            </div>
        </div>
    );
};
