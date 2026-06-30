import type { ReactNode } from "react";
import { cx } from "./cx";

type SectionHeaderLevel = "eyebrow" | "title";

const levelClasses: Record<SectionHeaderLevel, string> = {
  // Small uppercase label above a group (the dominant section style).
  eyebrow: "text-sm font-semibold uppercase tracking-wider text-muted-foreground",
  // Larger non-uppercase subsection heading.
  title: "text-base font-semibold text-foreground",
};

/**
 * Section heading beneath a page's PageHeader. `eyebrow` is the small uppercase
 * label; `title` is the larger non-uppercase subsection heading. Renders an h2
 * by default (or h3 if as="h3") and sets no outer spacing: pass margin (e.g. mb-4)
 * via className.
 */
export function SectionHeader({
  level = "eyebrow",
  as: Tag = "h2",
  className,
  children,
}: {
  level?: SectionHeaderLevel;
  as?: "h2" | "h3";
  className?: string;
  children: ReactNode;
}) {
  return <Tag className={cx(levelClasses[level], className)}>{children}</Tag>;
}
