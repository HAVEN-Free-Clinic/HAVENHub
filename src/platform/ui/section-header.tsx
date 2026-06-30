import type { ReactNode } from "react";

function cx(...parts: (string | undefined | false | null)[]): string {
  return parts.filter(Boolean).join(" ");
}

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
 * and sets no outer spacing: pass margin (e.g. mb-4) via className.
 */
export function SectionHeader({
  level = "eyebrow",
  className,
  children,
}: {
  level?: SectionHeaderLevel;
  className?: string;
  children: ReactNode;
}) {
  return <h2 className={cx(levelClasses[level], className)}>{children}</h2>;
}
