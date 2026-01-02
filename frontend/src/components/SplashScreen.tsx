import { useEffect } from "react";
import { motion, useAnimation } from "framer-motion";
import { Logo } from "./Logo";

interface SplashScreenProps {
    onDone: () => void;
}

export const SplashScreen = ({ onDone }: SplashScreenProps) => {
    const controls = useAnimation();

    useEffect(() => {
        const sequence = async () => {
            // 1. Entrance (Fade in + slide up + scale up)
            await controls.start("visible");

            // 2. Breath (Subtle scale up and down)
            await controls.start("breath");

            // 3. Exit delay
            setTimeout(onDone, 1600);
        };

        sequence();
    }, [controls, onDone]);

    return (
        <motion.div
            /* CENTERING LAYOUT: The following classes centering the content */
            className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-neutral-950"
            exit={{ opacity: 0 }}
            transition={{ duration: 1.0 }}
        >
            <div className="flex flex-col items-center gap-10 w-full max-w-[280px] px-8">
                {/* Animated Logo Container */}
                <motion.div
                    className="w-full"
                    initial="hidden"
                    animate={controls}
                    variants={{
                        hidden: { opacity: 0, y: 12, scale: 0.92 },
                        visible: {
                            opacity: 1,
                            y: 0,
                            scale: 1,
                            transition: { duration: 0.7, ease: "easeOut" }
                        },
                        breath: {
                            scale: [1, 1.02, 1],
                            transition: { duration: 1.5, ease: "easeInOut" }
                        }
                    }}
                >
                    <Logo className="w-full h-auto" />
                </motion.div>

                {/* Loading Bar Container */}
                <div className="w-32 h-1 bg-neutral-800 rounded-full overflow-hidden">
                    {/* Loading Bar Fill */}
                    <motion.div
                        className="h-full bg-[#A20101] rounded-full"
                        initial={{ width: "0%" }}
                        animate={{ width: "100%" }}
                        transition={{ duration: 1.2, ease: "easeInOut", delay: 0.2 }}
                    />
                </div>
            </div>
        </motion.div>
    );
};
