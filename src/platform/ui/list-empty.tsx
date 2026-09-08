import { SearchX } from "lucide-react";
import { EmptyState } from "./empty-state";

/**
 * What an empty list says, and the one thing it must never say.
 *
 * Seven filtered lists told the user their data was gone. On /support/all an IT
 * manager who filters to Priority: High and matches nothing read "No requests
 * yet." on a queue holding hundreds of tickets -- a sentence asserting the
 * opposite of the truth, on the page where a lost ticket history is the most
 * alarming thing it could mean. /admin/people and /volunteers/master said "No X
 * found.", which is ambiguous between "your filter is too narrow" and "the
 * query failed", so people re-ran it or filed a bug instead of clearing a
 * filter.
 *
 * The two states are genuinely different and need different sentences:
 *
 * - **filtered**: rows exist, this search does not reach them. Say so, and say
 *   what to do about it. The SearchX icon carries the same meaning without
 *   being read.
 * - **empty**: there is nothing here at all. Say THAT, and never imply a filter
 *   the user has not set.
 *
 * Callers pass the same `filtered` boolean their Clear link already needs, so
 * the two cannot disagree: a list offering "Clear" while claiming to be empty
 * is the bug this exists to make impossible.
 *
 * A component list (RequestList, PeopleTable) receives rows from a filtered
 * parent and cannot know which state it is in, so it takes `filtered` as a prop
 * rather than guessing.
 */
export function ListEmpty({
  filtered,
  noun,
  emptyDescription,
  action,
}: {
  /** Whether any filter or search term is currently applied. */
  filtered: boolean;
  /** Plural noun for the things in this list, e.g. "requests", "people". */
  noun: string;
  /** Shown only in the true-empty state: what will make rows appear here. */
  emptyDescription?: string;
  /** Shown only in the true-empty state, e.g. a "Create one" button. */
  action?: React.ReactNode;
}) {
  if (filtered) {
    return (
      <EmptyState
        icon={SearchX}
        title={`No ${noun} match these filters`}
        description="Widen your search or clear a filter above."
      />
    );
  }
  return <EmptyState title={`No ${noun} yet`} description={emptyDescription} action={action} />;
}
