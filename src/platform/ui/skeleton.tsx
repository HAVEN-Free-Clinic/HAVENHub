import { cx } from "./cx";

type SkeletonProps = {
  /** Extra classes for size/shape (e.g. "h-9 w-72 rounded-2xl"). */
  className?: string;
};

/**
 * A single shimmering placeholder block. Purely decorative (aria-hidden) -- give
 * the surrounding container status semantics (role="status" + aria-label), as
 * DashboardSkeleton does. Honors prefers-reduced-motion. Compose several to
 * mirror a real layout so content swaps in without shifting.
 */
export function Skeleton({ className }: SkeletonProps) {
  return (
    <div
      aria-hidden={true}
      className={cx("animate-pulse rounded-md bg-muted-strong/80 motion-reduce:animate-none", className)}
    />
  );
}
