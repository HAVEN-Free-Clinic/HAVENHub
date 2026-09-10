import Link from "next/link";
import type { TermOption } from "@/platform/terms/term-options";
import { cardClasses } from "./card";

function pillClasses(selected: boolean): string {
  return `rounded-lg border px-2.5 py-1 text-sm font-semibold ${
    selected ? "border-brand bg-brand-faint text-brand-fg" : "border-border text-foreground-soft hover:border-brand"
  }`;
}

/**
 * Term switcher: renders working-term options as links. The caller supplies
 * hrefForTerm so each page owns its own URL params. The "" (Global) option from
 * buildTermOptions is dropped here: a switcher always selects a concrete term.
 *
 * Archived terms fold into one "Past terms" disclosure. Every past term used to
 * be its own pill, so the builder and attending grid opened on a row of eight,
 * six of them "(archived)", wrapping to two lines above the work. The selected
 * term always keeps a pill, archived or not, so the row says what you are
 * looking at. A native <details>, so it needs no client JS and stays keyboard
 * operable.
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
  const shown = terms.filter((o) => !o.archived || o.value === selectedId);
  const past = terms.filter((o) => o.archived && o.value !== selectedId);
  const href = (o: TermOption) => hrefForTerm(o.value === liveTermId ? null : o.value);

  return (
    <nav aria-label="Working term" className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-semibold uppercase tracking-wider text-subtle-foreground">Term</span>
      {shown.map((o) => {
        const isSelected = o.value === selectedId;
        return (
          <Link
            key={o.value}
            href={href(o)}
            aria-current={isSelected ? "page" : undefined}
            className={pillClasses(isSelected)}
          >
            {o.label}
          </Link>
        );
      })}
      {past.length > 0 && (
        <details className="relative">
          <summary className={`${pillClasses(false)} cursor-pointer list-none [&::-webkit-details-marker]:hidden`}>
            Past terms ({past.length})
          </summary>
          <div className={`${cardClasses({ pad: false })} absolute left-0 z-20 mt-1 flex w-max flex-col gap-0.5 p-1.5`}>
            {past.map((o) => (
              <Link
                key={o.value}
                href={href(o)}
                className="rounded-md px-2.5 py-1 text-sm font-medium text-foreground-soft hover:bg-muted hover:text-foreground"
              >
                {/* Already under "Past terms", so the "(archived)" suffix is noise here. */}
                {o.label.replace(/ \(archived\)$/, "")}
              </Link>
            ))}
          </div>
        </details>
      )}
    </nav>
  );
}
