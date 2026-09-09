"use client";

import { useRef, useState } from "react";

/**
 * The selection model behind every bulk action bar in the app.
 *
 * Five surfaces let an operator tick rows and act on them at once, and they had
 * three independent implementations between them. Only the recruitment
 * onboarding table had the two things that make a long list workable: a
 * shift-click range, and a header checkbox that shows a PARTIAL selection
 * rather than reading as "none". The offboarding tabs, where the stakes are
 * highest and the cohorts are largest, had neither -- selecting twenty people
 * to offboard was twenty individual clicks, and the header box looked identical
 * whether one row was ticked or none.
 *
 * ## The selection is always scoped to what is on screen
 *
 * `ids` is the state Set intersected with the rows currently passed in, in the
 * order they are rendered. That is not a tidy-up; it is load-bearing in two
 * places:
 *
 * - **Filtering.** A row filtered out of view is deselected, so a bulk action
 *   can never touch a row the operator cannot see.
 * - **After the action runs.** `revalidatePath` re-renders these components
 *   with fresh props but never remounts them, so the raw Set survives a
 *   successful bulk offboard even though the people in it just dropped out of
 *   the rows. Submitting those stale ids would rerun the action on people it
 *   has already processed.
 *
 * Reading `ids` rather than the raw Set means the header count, the button
 * labels, any cap check and the hidden form inputs cannot disagree about what
 * is selected.
 *
 * ## The anchor is captured before the ref moves
 *
 * `setSelected` only schedules its updater; React does not run it until after
 * the handler returns. Reading `anchorRef.current` from inside the updater
 * would therefore see the reassignment at the bottom of `toggle` rather than
 * the anchor the click started from, and every shift-click would extend from
 * itself. It is read into a local first.
 */
export function useBulkSelection<T>({
  rows,
  idOf,
  selectable,
  initial,
}: {
  /** In RENDER order. A shift-range walks this, so a caller that renders rows
   *  in buckets should pass the buckets flattened in the order shown. */
  rows: readonly T[];
  idOf: (row: T) => string;
  /** Rows that cannot be acted on. They are never selected and never counted. */
  selectable?: (row: T) => boolean;
  /** Mount-time preselection, e.g. everyone already known not to be returning. */
  initial?: (row: T) => boolean;
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(initial ? rows.filter(initial).map(idOf) : []),
  );
  // Where a shift-click range extends FROM, in the visible order.
  const anchorRef = useRef<string | null>(null);

  // Recomputed every render rather than memoised: `idOf` and `selectable` are
  // written inline at every call site, so their identity changes each render
  // and a useMemo on them would recompute anyway while costing a dep array that
  // can silently go stale.
  const selectableIds = (selectable ? rows.filter(selectable) : rows).map(idOf);
  const ids = selectableIds.filter((id) => selected.has(id));

  const allSelected = selectableIds.length > 0 && ids.length === selectableIds.length;

  function toggle(id: string, shiftKey = false) {
    const anchor = anchorRef.current;
    setSelected((prev) => {
      const next = new Set(prev);
      // A shift-click extends across the visible order and only ever ADDS, so
      // dragging back over a range does not punch holes in it.
      if (shiftKey && anchor !== null) {
        const from = selectableIds.indexOf(anchor);
        const to = selectableIds.indexOf(id);
        if (from !== -1 && to !== -1) {
          for (const between of selectableIds.slice(Math.min(from, to), Math.max(from, to) + 1)) {
            next.add(between);
          }
          return next;
        }
      }
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    anchorRef.current = id;
  }

  /** For a per-group header box. Pass the group's ids and the box's new state. */
  function setMany(groupIds: readonly string[], on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of groupIds) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
    anchorRef.current = null;
  }

  function toggleAll() {
    setMany(selectableIds, !allSelected);
  }

  return {
    /** Selected ids, scoped to the rows on screen, in render order. */
    ids,
    /** Whether one row's box is ticked. */
    has: (id: string) => selected.has(id),
    toggle,
    setMany,
    toggleAll,
    allSelected,
    /** Some but not all: what a header checkbox shows as indeterminate. */
    someSelected: ids.length > 0 && !allSelected,
    /** True only for the ids passed in, for a per-group header box. */
    allOf: (groupIds: readonly string[]) =>
      groupIds.length > 0 && groupIds.every((id) => selected.has(id)),
    someOf: (groupIds: readonly string[]) => {
      const on = groupIds.filter((id) => selected.has(id)).length;
      return on > 0 && on < groupIds.length;
    },
    clear: () => setSelected(new Set()),
  };
}
