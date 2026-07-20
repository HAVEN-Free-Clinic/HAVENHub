import Link from "next/link";
import type { TermOption } from "@/platform/terms/term-options";

/**
 * Term switcher for the schedule builder. Renders the working-term options as
 * links; the caller supplies hrefForTerm so the builder page owns URL params
 * (dept/view/etc.). The "" (Global) option from buildTermOptions is dropped
 * here: the builder always works on a concrete term (the live one by default).
 */
export function TermSwitcher({
  options,
  selectedId,
  liveTermId,
  hrefForTerm,
}: {
  options: TermOption[];
  selectedId: string;
  liveTermId: string | null;
  hrefForTerm: (termId: string | null) => string;
}) {
  const terms = options.filter((o) => o.value !== "");
  return (
    <nav aria-label="Working term" className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-semibold uppercase tracking-wider text-subtle-foreground">Term</span>
      {terms.map((o) => {
        const isSelected = o.value === selectedId;
        const isLive = o.value === liveTermId;
        return (
          <Link
            key={o.value}
            href={hrefForTerm(isLive ? null : o.value)}
            aria-current={isSelected ? "page" : undefined}
            className={`rounded-lg border px-2.5 py-1 text-sm font-semibold ${
              isSelected ? "border-brand bg-brand-faint text-brand-fg" : "border-border text-foreground-soft hover:border-brand"
            }`}
          >
            {o.label}
          </Link>
        );
      })}
    </nav>
  );
}
