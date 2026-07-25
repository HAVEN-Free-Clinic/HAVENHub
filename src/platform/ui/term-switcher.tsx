import Link from "next/link";
import type { TermOption } from "@/platform/terms/term-options";

/**
 * Term switcher: renders working-term options as links. The caller supplies
 * hrefForTerm so each page owns its own URL params. The "" (Global) option from
 * buildTermOptions is dropped here: a switcher always selects a concrete term.
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
