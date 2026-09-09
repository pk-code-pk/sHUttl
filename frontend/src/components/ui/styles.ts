/**
 * Button variants and the class-merge helper.
 *
 * Separate from Button.tsx because react-refresh only works when a module
 * exports components alone; MapShell also needs the recipe directly, to style
 * a Leaflet control that cannot be a Button element.
 *
 * Two decisions here are what keep these from reading as default
 * component-library buttons:
 *
 * Weight, not colour, marks hierarchy. Crimson belongs to the primary action
 * and to selection; secondary and ghost stay on the grey ramp. On a dark map
 * interface a second accent would compete with the nine route colours already
 * on screen.
 *
 * Buttons press rather than lift. These sit on a panel floating over a map, so
 * a hover-lift with a drop shadow reads as a card peeling off the sheet.
 * Instead the surface brightens on hover and scales down a hair on press — the
 * response a hardware key gives, and it behaves the same under a finger as
 * under a cursor, which matters because most use of this app is on a phone.
 */

import { cva, type VariantProps } from "class-variance-authority";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export const cn = (...parts: (string | undefined | null | false)[]) =>
    twMerge(clsx(parts));

export const buttonVariants = cva(
    [
        "relative inline-flex items-center justify-center gap-1.5",
        "font-bold leading-none whitespace-nowrap select-none",
        "transition-[background-color,border-color,color,transform,opacity] duration-150 ease-out",
        "active:scale-[0.97]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crimson/60 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-900",
        "disabled:pointer-events-none disabled:opacity-40",
    ],
    {
        variants: {
            variant: {
                // The deep tone, not the bright one: on a dark map a
                // full-strength red fill is the brightest thing on screen and
                // pulls the eye off the routes. Hover lifts one step to the
                // mid-tone, so the change is felt without becoming loud.
                primary: [
                    "bg-crimson text-white hover:bg-crimson-mid",
                    // A hairline along the top edge reads as a lit edge on a
                    // raised key rather than a border.
                    "shadow-[inset_0_1px_0_rgba(255,255,255,0.14)]",
                ],
                secondary: [
                    "bg-neutral-800 text-neutral-200 hover:bg-neutral-700 hover:text-white",
                    "shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]",
                ],
                ghost: "bg-transparent text-neutral-400 hover:bg-white/5 hover:text-white",
                // Floats over the map, so it carries its own ground.
                overlay: [
                    "bg-neutral-900/85 text-neutral-200 backdrop-blur-md",
                    "border border-white/10",
                    "hover:bg-neutral-800/90 hover:text-white hover:border-white/20",
                ],
                // A chosen option — the other thing crimson means here.
                // White label, not crimson-on-crimson: a tinted label on a
                // tinted fill is the lowest-contrast text in the app, and this
                // variant marks the thing currently switched on.
                // A tinted fill of the deep tone with a mid-tone border: the
                // border is what marks it as on, so the fill can stay quiet.
                selected: [
                    "bg-crimson-deep/50 text-white backdrop-blur-md",
                    "border border-crimson-mid/70 hover:bg-crimson-deep/65",
                ],
            },
            size: {
                sm: "h-7 rounded-lg px-2.5 text-[10px]",
                md: "h-9 rounded-xl px-3.5 text-[11px]",
                lg: "h-11 rounded-xl px-4 text-[13px]",
                icon: "h-9 w-9 rounded-full",
                iconSm: "h-7 w-7 rounded-full",
            },
            block: { true: "w-full", false: "" },
        },
        defaultVariants: { variant: "secondary", size: "md", block: false },
    },
);

export type ButtonVariantProps = VariantProps<typeof buttonVariants>;
