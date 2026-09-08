import type { ReactNode } from "react";
import { FilterBar, FilterField } from "@/platform/ui/filter-bar";
import { Input } from "@/platform/ui/input";

/**
 * "Search a person, then do something with them", the admin module's most
 * repeated control.
 *
 * It exists on the term roster (search, then add to a department with a role)
 * and on the roles page (search, then assign a role for a term). The two were
 * built separately and had drifted on every surface decision: one wrapped its
 * results in a `Card pad={false}` and the other in a hand-rolled
 * `rounded-xl border` div, so the same three-part control read as a standalone
 * card on one page and a subordinate sub-panel a click later. The search rows
 * differed too, at `w-72` and `w-64`, with two different Clear treatments.
 *
 * ## The results region is a compact surface, not a Card
 *
 * Deliberate, and it changes the term roster slightly. This panel is always
 * subordinate to the search box directly above it, and on the roles page it
 * already sits INSIDE a Card, so making it a Card there would nest one card in
 * another. The house style puts a compact surface at `rounded-xl`, which is
 * what the roles page already used; the term roster moves to it.
 *
 * The per-row form is the caller's: adding to a department and assigning a role
 * for a term take different inputs, and that is the part that should differ.
 */
export function PersonSearchPanel({
  action,
  paramName,
  label,
  placeholder = "Name or netID...",
  query,
  clearHref,
  results,
  resultsHint,
  renderRowForm,
}: {
  /** NavForm target. Omit to submit to the current pathname. */
  action?: string;
  /** Query-string parameter this search owns (e.g. "addq", "assignq"). */
  paramName: string;
  label: string;
  placeholder?: string;
  query: string | undefined;
  /** Where Clear goes: this page with the search dropped. */
  clearHref: string;
  results: { id: string; name: string; netId: string | null }[];
  /** Appended after the result count, e.g. "select department and role, then Add". */
  resultsHint?: string;
  renderRowForm: (person: { id: string; name: string; netId: string | null }) => ReactNode;
}) {
  const searched = Boolean(query && query.trim());

  return (
    <>
      <FilterBar
        action={action}
        submitLabel="Search"
        clearHref={query ? clearHref : undefined}
      >
        <FilterField label={label} width="grow">
          <Input type="search" name={paramName} defaultValue={query ?? ""} placeholder={placeholder} />
        </FilterField>
      </FilterBar>

      {searched && (
        <div className="overflow-hidden rounded-xl border border-border-subtle">
          <div className="border-b border-border-subtle px-4 py-3">
            <p className="text-sm font-medium text-foreground-soft">
              {results.length === 0
                ? `No results for "${query}"`
                : `${results.length} result(s) for "${query}"${resultsHint ? ` · ${resultsHint}` : ""}`}
            </p>
          </div>
          {results.length > 0 && (
            <div className="divide-y divide-border-subtle">
              {results.map((person) => (
                <div key={person.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-[12rem]">
                    <p className="text-sm font-medium text-foreground">{person.name}</p>
                    {person.netId && (
                      <p className="text-xs text-subtle-foreground">{person.netId}</p>
                    )}
                  </div>
                  {renderRowForm(person)}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}
