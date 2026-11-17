import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type LabelHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

/** shadcn/ui deseninde sade temel bilesenler (Radix gerektirmeyenler). Dokunma hedefi >= 44 px (min-h-11). */
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...p }, ref) {
  return <input ref={ref} className={cn("min-h-11 w-full rounded-md border border-border bg-surface-0 px-3 text-text-primary placeholder:text-text-secondary", className)} {...p} />;
});

export function Label({ className, ...p }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("mb-1 block text-sm font-medium text-text-primary", className)} {...p} />;
}

export function Button({ className, variant = "primary", ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" }) {
  return (
    <button
      className={cn(
        "inline-flex min-h-11 items-center justify-center rounded-md px-4 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60",
        variant === "primary" ? "bg-accent text-surface-0 hover:opacity-90" : "border border-border bg-surface-2 text-text-primary hover:bg-surface-1",
        className,
      )}
      {...p}
    />
  );
}
