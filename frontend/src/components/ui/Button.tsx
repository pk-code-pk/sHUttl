import type { ButtonHTMLAttributes, ReactNode } from "react";
import { buttonVariants, cn, type ButtonVariantProps } from "./styles";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
    ButtonVariantProps & { children?: ReactNode };

/** The app's button. Variants and their rationale live in styles.ts. */
export const Button = ({ variant, size, block, className, children, ...rest }: ButtonProps) => (
    <button
        type="button"
        className={cn(buttonVariants({ variant, size, block }), className)}
        {...rest}
    >
        {children}
    </button>
);
