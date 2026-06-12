import { cx } from "./button";

type Size = "sm" | "md" | "lg";

const sizeClasses: Record<Size, string> = {
  sm: "h-4 w-4",
  md: "h-5 w-5",
  lg: "h-6 w-6",
};

type SpinnerProps = {
  /** Visual size. Defaults to "md". */
  size?: Size;
  /** Extra classes (e.g. to override color via text-*). */
  className?: string;
};

/**
 * Branded loading spinner. Purely decorative (aria-hidden) -- give the
 * surrounding element status semantics (button text, or PageLoading's
 * role="status"). Inherits color from `currentColor`, so set text color on a
 * parent or via `className`. Honors prefers-reduced-motion.
 */
export function Spinner({ size = "md", className }: SpinnerProps) {
  return (
    <svg
      aria-hidden={true}
      className={cx("animate-spin motion-reduce:animate-none", sizeClasses[size], className)}
      viewBox="0 0 24 24"
      fill="none"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-90"
        fill="currentColor"
        d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z"
      />
    </svg>
  );
}
