/**
 * Service notices: stop closures, schedule changes, holiday service.
 *
 * Harvard publishes these through its tracker, and the Longwood Collective
 * through Passio (only the ones about the M2 are kept, server-side). They
 * matter most on exactly the days a rider would not think to look, so they
 * are surfaced on the map rather than in a tab of their own: a small pill
 * that appears only while there is something to say, crimson until every
 * notice in it has been opened once. Tapping it lists them.
 *
 * Which notices have been read is remembered per device in localStorage, a
 * convenience only: with storage blocked every notice simply reads as new.
 */

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { Megaphone, X } from 'lucide-react';
import { API_BASE_URL } from '@/config';
import { tapHaptic } from '@/lib/nativeHaptics';
import { buttonVariants, cn } from './ui/styles';

export interface Notice {
    id: string;
    title: string;
    body: string;
    when: string | null;
    routes: string[];
    source: string;
}

const SEEN_KEY = 'shuttl.notices.seen';
const REFRESH_MS = 5 * 60 * 1000;

function readSeen(): Set<string> {
    try {
        return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]') as string[]);
    } catch {
        return new Set();
    }
}

function writeSeen(ids: string[]) {
    try {
        localStorage.setItem(SEEN_KEY, JSON.stringify(ids));
    } catch {
        // Storage blocked: notices just read as new next time.
    }
}

interface NoticesPillProps {
    systemId: number | null;
    /** Told how many notices are showing, so neighbours can make room. */
    onCountChange?: (count: number) => void;
    className?: string;
}

export const NoticesPill = ({ systemId, onCountChange, className }: NoticesPillProps) => {
    const [notices, setNotices] = useState<Notice[]>([]);
    const [seen, setSeen] = useState<Set<string>>(() => readSeen());
    const [open, setOpen] = useState(false);

    useEffect(() => {
        if (!systemId) return;
        let cancelled = false;
        const load = () =>
            fetch(`${API_BASE_URL}/notices`)
                .then((r) => (r.ok ? r.json() : { notices: [] }))
                .then((d: { notices?: Notice[] }) => {
                    if (!cancelled) setNotices(Array.isArray(d.notices) ? d.notices : []);
                })
                .catch(() => undefined);
        void load();
        const id = setInterval(load, REFRESH_MS);
        return () => { cancelled = true; clearInterval(id); };
    }, [systemId]);

    useEffect(() => { onCountChange?.(notices.length); }, [notices.length, onCountChange]);

    const unread = useMemo(() => notices.filter((n) => !seen.has(n.id)).length, [notices, seen]);

    const openList = () => {
        tapHaptic();
        setOpen(true);
        // Only ids still current are kept, so the stored list cannot grow forever.
        const ids = notices.map((n) => n.id);
        writeSeen(ids);
        setSeen(new Set(ids));
    };

    if (notices.length === 0) return null;

    return (
        <>
            <button
                type="button"
                onClick={openList}
                aria-label={`${notices.length} service ${notices.length === 1 ? 'notice' : 'notices'}${unread ? `, ${unread} new` : ''}`}
                className={cn(
                    'pointer-events-auto flex h-8 items-center gap-1.5 rounded-full border px-3 text-[11px] font-semibold leading-none backdrop-blur-sm transition-colors',
                    unread
                        ? 'border-crimson-mid/50 bg-crimson-deep/80 text-white'
                        : 'border-white/10 bg-neutral-900/85 text-neutral-300',
                    className,
                )}
            >
                <Megaphone size={12} />
                {notices.length === 1 ? '1 notice' : `${notices.length} notices`}
                {unread > 0 && <span className="h-1.5 w-1.5 rounded-full bg-white" aria-hidden />}
            </button>

            {createPortal(
                <AnimatePresence>
                    {open && (
                        <motion.div
                            key="notices"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.15 }}
                            className="fixed inset-0 z-[2000] flex items-end justify-center bg-black/60 p-3 pb-[calc(env(safe-area-inset-bottom,0px)+12px)] pt-[calc(var(--safe-top,0px)+12px)] md:items-center"
                            onClick={() => setOpen(false)}
                        >
                            <motion.div
                                role="dialog"
                                aria-modal="true"
                                aria-label="Service notices"
                                initial={{ y: 24, opacity: 0 }}
                                animate={{ y: 0, opacity: 1 }}
                                exit={{ y: 24, opacity: 0 }}
                                transition={{ duration: 0.2, ease: 'circOut' }}
                                onClick={(e) => e.stopPropagation()}
                                className="flex max-h-[80vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-white/10 bg-neutral-900 shadow-2xl"
                            >
                                <div className="flex shrink-0 items-center justify-between border-b border-white/5 px-4 py-3">
                                    <p className="text-[13px] font-semibold text-white">Service notices</p>
                                    <button
                                        type="button"
                                        onClick={() => setOpen(false)}
                                        aria-label="Close notices"
                                        className={buttonVariants({ variant: 'ghost', size: 'iconSm' })}
                                    >
                                        <X size={14} />
                                    </button>
                                </div>
                                <ul className="custom-scrollbar flex-1 space-y-2 overflow-y-auto overscroll-contain p-3">
                                    {notices.map((n) => (
                                        <li key={n.id} className="rounded-xl bg-neutral-800/50 px-3 py-2.5">
                                            <p className="text-[12px] font-semibold leading-snug text-white">{n.title}</p>
                                            <div className="mt-1 flex flex-wrap items-center gap-1">
                                                {n.routes.length >= 6 ? (
                                                    <span className="rounded-md bg-white/10 px-1.5 py-0.5 text-[9px] font-bold text-neutral-200">
                                                        All routes
                                                    </span>
                                                ) : (
                                                    n.routes.map((r) => (
                                                        <span key={r} className="rounded-md bg-white/10 px-1.5 py-0.5 text-[9px] font-bold text-neutral-200">
                                                            {r}
                                                        </span>
                                                    ))
                                                )}
                                                {n.when && <span className="text-[10px] text-neutral-400">{n.when}</span>}
                                            </div>
                                            {n.body && <p className="mt-1.5 text-[11px] leading-relaxed text-neutral-300">{n.body}</p>}
                                            <p className="mt-1.5 text-[9px] text-neutral-500">{n.source}</p>
                                        </li>
                                    ))}
                                </ul>
                            </motion.div>
                        </motion.div>
                    )}
                </AnimatePresence>,
                document.body,
            )}
        </>
    );
};
