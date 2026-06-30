import type { ComponentProps } from "react";
import { cx } from "./cx";

type Variant = "primary" | "outline" | "danger" | "ghost";
type Size = "sm" | "md";

const variantClasses: Record<Variant, string> = {
  primary:
    "bg-brand text-white hover:bg-brand-hover",
  outline:
    "border border-border-strong text-foreground-soft hover:bg-muted",
  danger:
    "bg-critical text-white hover:bg-red-700",
  ghost:
    "text-muted-foreground hover:text-foreground",
};

const sizeClasses: Record<Size, string> = {
  md: "px-4 py-2",
  sm: "px-3 py-1.5",
};

export function buttonClasses(
  variant: Variant = "primary",
  size: Size = "md",
  extra?: string,
): string {
  return cx(
    "inline-flex items-center justify-center rounded-lg text-sm font-medium transition-colors",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
    "disabled:opacity-50 disabled:cursor-not-allowed",
    variantClasses[variant],
    sizeClasses[size],
    extra,
  );
}

type ButtonProps = ComponentProps<"button"> & {
  variant?: Variant;
  size?: Size;
};

export function Button({
  variant = "primary",
  size = "md",
  className,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      className={buttonClasses(variant, size, className)}
    />
  );
}
