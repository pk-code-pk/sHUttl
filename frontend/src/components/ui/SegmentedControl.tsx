/**
 * The mode switch, as a segmented control with a sliding indicator.
 *
 * It was two buttons where the selected one turned crimson. That works, but it
 * tells you nothing while it happens: the fill jumps between them, so the
 * change reads as two separate events rather than one thing moving.
 *
 * The indicator is a single element shared between segments via Motion's
 * layout animation — `layoutId` means the same DOM node animates from one
 * segment's box to the other, so the movement is real rather than a
 * cross-fade. On a control this size that is the difference between "something
 * changed" and "I moved the switch".
 *
 * Spring rather than a duration: a switch that has been dragged by a thumb
 * should settle, and a spring's overshoot is what reads as physical. It is
 * tuned stiff and well-damped so it feels immediate rather than springy —
 * this gets tapped constantly and a bouncy control would wear thin fast.
 */

import { motion } from "motion/react";
import { cn } from "./styles";

export interface Segment<T extends string> {
    id: T;
    label: string;
}

interface SegmentedControlProps<T extends string> {
    segments: Segment<T>[];
    value: T;
    onChange: (id: T) => void;
    /** Distinguishes the indicator when more than one control is mounted. */
    layoutGroup?: string;
    className?: string;
}

export function SegmentedControl<T extends string>({
    segments,
    value,
    onChange,
    layoutGroup = "segmented",
    className,
}: SegmentedControlProps<T>) {
    return (
        <div
            role="tablist"
            className={cn(
                "relative flex gap-1 rounded-xl bg-neutral-800/40 p-1",
                "shadow-[inset_0_1px_2px_rgba(0,0,0,0.35)]",
                className,
            )}
        >
            {segments.map((s) => {
                const active = s.id === value;
                return (
                    <button
                        key={s.id}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        aria-pressed={active}
                        onClick={() => onChange(s.id)}
                        className={cn(
                            "relative flex-1 rounded-lg py-1.5 text-[11px] font-bold",
                            "transition-colors duration-150",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crimson/60",
                            active ? "text-white" : "text-neutral-400 hover:text-neutral-200",
                        )}
                    >
                        {active && (
                            <motion.span
                                layoutId={`${layoutGroup}-indicator`}
                                // Behind the label, and not catching clicks.
                                className="absolute inset-0 -z-10 rounded-lg bg-crimson shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]"
                                transition={{ type: "spring", stiffness: 420, damping: 34, mass: 0.7 }}
                            />
                        )}
                        {/* Sits above the indicator so the label is never
                            painted over mid-flight. */}
                        <span className="relative z-10">{s.label}</span>
                    </button>
                );
            })}
        </div>
    );
}
