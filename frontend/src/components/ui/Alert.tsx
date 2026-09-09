/**
 * Alerts, as composable parts rather than one prop-driven block.
 *
 * The structure — icon, content, title, description, actions — is taken from
 * the shadcn/reui alert pattern, because separating them is what stops an
 * alert from being a paragraph with buttons under it: the icon anchors the
 * left edge, the title carries the consequence, and the description explains
 * it in a second, quieter line.
 *
 * Deliberately not the whole reference component. That one is seven variants
 * across four appearances with a compound-variant table longer than this
 * file, built on shadcn's --muted / --destructive / --primary token set, which
 * this project does not have. Copying it would mean importing a design system
 * to use one cell of it. These are the two kinds of alert the app actually
 * raises, on the app's own crimson and grey.
 */

import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './styles';

const alertVariants = cva(
    'flex w-full items-start gap-3 rounded-xl border p-3.5 text-left',
    {
        variants: {
            variant: {
                // Something is about to be lost. Deep crimson fill with a
                // mid-tone border, so it reads as serious without becoming the
                // brightest thing on a dark map.
                warning: [
                    'border-crimson-mid/50 bg-crimson-deep/35',
                    'shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]',
                ],
                // Something to know, carrying no consequence.
                info: 'border-white/10 bg-neutral-800/60',
            },
        },
        defaultVariants: { variant: 'info' },
    },
);

export type AlertProps = HTMLAttributes<HTMLDivElement> &
    VariantProps<typeof alertVariants> & { children?: ReactNode };

export const Alert = ({ variant, className, children, ...rest }: AlertProps) => (
    <div role="alert" className={cn(alertVariants({ variant }), className)} {...rest}>
        {children}
    </div>
);

/** Anchors the left edge. Sized and nudged to sit on the title's cap height
 * rather than its baseline, which is what keeps the row from looking loose. */
export const AlertIcon = ({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) => (
    <div className={cn('mt-0.5 shrink-0 text-crimson-light', className)} {...rest}>
        {children}
    </div>
);

export const AlertContent = ({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) => (
    <div className={cn('min-w-0 flex-1 space-y-1', className)} {...rest}>
        {children}
    </div>
);

export const AlertTitle = ({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) => (
    <div className={cn('text-[12px] font-bold leading-snug text-white', className)} {...rest}>
        {children}
    </div>
);

export const AlertDescription = ({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) => (
    <div className={cn('text-[11px] leading-relaxed text-neutral-400', className)} {...rest}>
        {children}
    </div>
);

/** Actions sit under the text, not beside it: at this width a button row
 * beside a description squeezes both. */
export const AlertActions = ({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) => (
    <div className={cn('flex gap-2 pt-1.5', className)} {...rest}>
        {children}
    </div>
);
