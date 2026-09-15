import type { ReactNode } from "react";
import { cx } from "./cx";

type SectionHeaderLevel = "group" | "eyebrow" | "title" | "card";

// Largest to smallest, so the ladder reads in the file.
const levelClasses: Record<SectionHeaderLevel, string> = {
  // The heading that OWNS several `title` sections: a term name on /schedule,
  // the attending band on the same page. Three pages reached this size by
  // passing `className="text-xl"` to a `title`, which is a caller overriding
  // the scale rather than a rung on it -- and a className fighting a
  // primitive's own class is emission-order roulette in a repo with no
  // tailwind-merge.
  group: "text-xl font-semibold text-foreground",
  // Small uppercase label above a group (the dominant section style).
  eyebrow: "text-sm font-semibold uppercase tracking-wider text-muted-foreground",
  // Larger non-uppercase subsection heading.
  title: "text-base font-semibold text-foreground",
  // The quieter heading INSIDE a card, where the card's own edge already marks
  // the group and a full-weight title would compete with the page's. Eight
  // admin panels had hand-rolled exactly this string; adding the level is what
  // let them stop.
  card: "text-sm font-semibold text-foreground-soft",
};

/**
 * Section heading beneath a page's PageHeader. `group` owns several `title`
 * sections; `eyebrow` is the small uppercase label; `title` is the larger
 * non-uppercase subsection heading; `card` is the quieter one used inside a
 * card. Renders an h2
 * by default (or h3/h4 via `as`) and sets no outer spacing: pass margin (e.g. mb-4)
 * via className. Use a lower `as` level when the header nests under another
 * heading so the document outline never skips or reverses a level.
 */
export function SectionHeader({
  level = "eyebrow",
  as: Tag = "h2",
  className,
  children,
}: {
  level?: SectionHeaderLevel;
  as?: "h2" | "h3" | "h4";
  className?: string;
  children: ReactNode;
}) {
  return <Tag className={cx(levelClasses[level], className)}>{children}</Tag>;
}
