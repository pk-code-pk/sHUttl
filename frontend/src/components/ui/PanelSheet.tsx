/**
 * The floating panel: a draggable bottom sheet on mobile, a static card on
 * desktop.
 *
 * What was wrong before, and what each fix addresses:
 *
 *   The sheet listened for `onPanEnd` on a ~30px grab handle. That fires after
 *   the finger lifts, so nothing moved during the gesture — it jumped to a
 *   position on release. It looked like a drag and was not one. The sheet now
 *   drags on the y axis, so it tracks the finger.
 *
 *   Only the handle was draggable; the list below it, most of the sheet,
 *   ignored the gesture. The whole surface drags now, with the content
 *   deferring when it has somewhere to scroll.
 *
 *   A flat 30px threshold decided everything, so a slow nudge and a fast flick
 *   did the same thing. Release now considers velocity: a flick carries to the
 *   next position, a slow drag settles at the nearest.
 *
 *   Content scroll and sheet drag were unrelated. Dragging is handed to the
 *   list while it is scrolled away from its top, so the same downward gesture
 *   scrolls back up first and only then moves the sheet.
 *
 *   Positions were four `dvh` strings, one of which fired when the itinerary
 *   collapsed — which is why the sheet sometimes moved on its own. They are
 *   now three declared fractions and nothing else touches them.
 *
 * Built on Motion directly rather than on a sheet library. vaul is
 * unmaintained (its README says so; last release 600+ days ago), and
 * react-modal-sheet is built around modal sheets: it forces an inline z-index
 * of 9999, its root swallows pointer events across the whole viewport, and it
 * resolves `initialSnap` before the sheet has been measured — so the sheet
 * opened fully expanded whatever was asked for. An always-visible
 * three-position sheet fought it on all three counts.
 */

import { motion, useMotionValue, animate, type PanInfo } from 'motion/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from './styles';
import {
    SNAP_DEFAULT,
    SNAP_EXPANDED,
    SNAP_FRACTIONS,
    SNAP_MINIMISED,
} from './sheetSnaps';

// Past this speed the gesture is a flick: it carries to the next position
// rather than settling at whichever is nearest. px/s.
const FLICK_VELOCITY = 500;

const SPRING = { type: 'spring', stiffness: 300, damping: 32, mass: 0.8 } as const;

interface PanelSheetProps {
    isMobile: boolean;
    snap: number;
    onSnap: (index: number) => void;
    className?: string;
    children: ReactNode;
}

export const PanelSheet = ({
    isMobile,
    snap,
    onSnap,
    className,
    children,
}: PanelSheetProps) => {
    const [viewport, setViewport] = useState(() =>
        typeof window === 'undefined' ? 0 : window.innerHeight,
    );
    // Whether the inner list has been scrolled away from its top, which is what
    // decides between scrolling the content and dragging the sheet.
    const [scrolled, setScrolled] = useState(false);
    const y = useMotionValue(0);
    const snapRef = useRef(snap);
    snapRef.current = snap;

    useEffect(() => {
        const onResize = () => setViewport(window.innerHeight);
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);

    // Sheet top for each position, in px from the top of the viewport.
    const offsets = SNAP_FRACTIONS.map((f) => Math.round(viewport * (1 - f)));

    // Follow the snap index whenever it changes from outside — planning a trip
    // pulls the sheet back up, for instance.
    useEffect(() => {
        if (!isMobile || !viewport) return;
        const target = offsets[snap] ?? offsets[SNAP_DEFAULT];
        animate(y, target, SPRING);
        // offsets is derived from viewport; listing it would re-run this on
        // every render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [snap, isMobile, viewport, y]);

    const handleDragEnd = (_: unknown, info: PanInfo) => {
        const current = y.get();
        const velocity = info.velocity.y;
        const from = snapRef.current;

        let target: number;
        if (Math.abs(velocity) > FLICK_VELOCITY) {
            // A flick moves one position in the direction of travel, rather
            // than to wherever the finger happened to stop.
            target = velocity > 0
                ? Math.min(from + 1, SNAP_FRACTIONS.length - 1)
                : Math.max(from - 1, 0);
        } else {
            // Otherwise settle at whichever position is nearest.
            target = offsets.reduce(
                (best, offset, i) =>
                    Math.abs(offset - current) < Math.abs(offsets[best] - current) ? i : best,
                from,
            );
        }

        animate(y, offsets[target], SPRING);
        if (target !== from) onSnap(target);
    };

    if (!isMobile) {
        // Desktop has no gesture: the panel is a card beside the map, so a drag
        // would lead nowhere.
        return (
            <div
                className={cn(
                    'pointer-events-auto flex max-h-[85vh] flex-col rounded-xl',
                    'bg-neutral-900/95 backdrop-blur-md',
                    'border border-white/5 shadow-xl',
                    className,
                )}
            >
                <div className="flex min-h-0 flex-col px-4 py-4">{children}</div>
            </div>
        );
    }

    return (
        <motion.div
            className={cn(
                'pointer-events-auto fixed inset-x-0 top-0 z-30 flex h-[100dvh] flex-col',
                'rounded-t-3xl border-t border-white/10',
                'bg-neutral-900/95 backdrop-blur-xl',
                'shadow-[0_-8px_30px_rgba(0,0,0,0.5)]',
                className,
            )}
            style={{ y }}
            drag="y"
            // Bounded by the tallest and shortest positions, with a little give
            // at each end so the limits feel like limits rather than walls.
            dragConstraints={{
                top: offsets[SNAP_EXPANDED],
                bottom: offsets[SNAP_MINIMISED],
            }}
            dragElastic={0.06}
            dragMomentum={false}
            // The list owns the gesture once it has somewhere to scroll back
            // to; the sheet owns it otherwise.
            dragListener={!scrolled}
            onDragEnd={handleDragEnd}
        >
            {/* The grab area is deliberately taller than the bar inside it: it
                is a thumb target, and the old 30px strip was easy to miss.
                Dragging works anywhere on the sheet, so this is an affordance
                rather than the only handle. */}
            <div className="w-full shrink-0 cursor-grab py-5 active:cursor-grabbing">
                <div className="mx-auto h-1.5 w-12 rounded-full bg-neutral-600/50" />
            </div>

            <div
                onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 1)}
                className={cn(
                    'flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain touch-pan-y',
                    'px-4 pb-[env(safe-area-inset-bottom,16px)] pt-1',
                )}
            >
                {children}
            </div>
        </motion.div>
    );
};
