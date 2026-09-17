"use client";

import { createContext, useContext, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Alert } from "@/platform/ui/alert";
import { Checkbox } from "@/platform/ui/checkbox";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { useBulkSelection } from "@/platform/ui/use-bulk-selection";
import type { BatchResult } from "@/modules/recruitment/services/routing";

/**
 * Ticking rows on the applicant roster, and deciding the ticked ones together.
 *
 * The roster is a server component and its rows are server-rendered JSX, so the
 * selection cannot live in a client component that owns the table. It lives in
 * this provider instead: the page wraps its <Table> in <RosterSelection> and
 * drops a <RosterRowCheckbox> into each row, the same way PendingDim already
 * wraps server-rendered tables from inside table.tsx. No row markup has to move
 * to the client for a row to become selectable.
 *
 * WHY THIS EXISTS. Recruitment was working an entire cohort one page load at a
 * time: reject everyone still awaiting a language assessment, then un-reject
 * and waitlist the ones who turned out to be worth holding for a later
 * assessment. The work is already batched on the speed-route board
 * (applyTierRoutes / applyTierRejects), but that board is ranked by committee
 * average and offers no way to act on "these particular people", which is what
 * the roster's filters produce.
 *
 * ## Three actions, because un-rejecting is the actual ask
 *
 * Reject is the one people expect; Reopen is the one that was missing. A lead
 * who has already rejected a cohort by hand needs to put some of them back,
 * and Waitlist is where they go: a hold that says "still being assessed"
 * rather than a decision.
 *
 * ## None of this emails anyone
 *
 * All three write Application.decision and nothing else. Acceptance and
 * rejection emails are separate, later, deliberate steps on the Decisions tab,
 * and the rejection step refuses to run until acceptances have been released
 * (sendRejections in services/decisions.ts). So every action here is
 * reversible until decisions go out, and the bar's copy says so rather than
 * leaving an operator to guess whether forty people just got an email.
 */

type SelectionValue = {
  has: (id: string) => boolean;
  toggle: (id: string, shiftKey: boolean) => void;
  toggleAll: () => void;
  allSelected: boolean;
  someSelected: boolean;
  selectable: (id: string) => boolean;
  anySelectable: boolean;
};

/**
 * One row the bar may act on, with what may be done to it.
 *
 * The flags are resolved on the server from the row the roster already has, so
 * a control is only ever offered for something the viewer can actually do:
 * Reject and Reopen need recruitment.review_all, Waitlist needs the applicant
 * routed to a department the viewer directs. They are an optimistic filter, not
 * the authority -- every service re-checks, and anything it refuses comes back
 * in the batch's `skipped` with its reason.
 */
export type RosterSelectableRow = {
  applicationId: string;
  /** For the per-row checkbox's accessible name. */
  name: string;
  canReject: boolean;
  canWaitlist: boolean;
  canReopen: boolean;
};

type BulkAction = (applicationIds: string[]) => Promise<BatchResult | { error: string }>;

// Tolerates having no provider, like ListPendingContext: a roster rendered for
// a viewer who cannot bulk-decide has no provider, and its checkboxes simply do
// not render rather than throwing.
const RosterSelectionContext = createContext<SelectionValue | null>(null);

export function RosterSelection({
  rows,
  onBulkReject,
  onBulkWaitlist,
  onBulkReopen,
  children,
}: {
  /** The rows ON SCREEN, in render order. A shift-click range walks this, and
   *  the hook scopes the selection to it, so filtering or paging away from a
   *  ticked row deselects it and it can never be decided unseen. */
  rows: RosterSelectableRow[];
  onBulkReject: BulkAction;
  onBulkWaitlist: BulkAction;
  onBulkReopen: BulkAction;
  children: ReactNode;
}) {
  const router = useRouter();
  const actionable = (r: RosterSelectableRow) => r.canReject || r.canWaitlist || r.canReopen;
  const selection = useBulkSelection({ rows, idOf: (r) => r.applicationId, selectable: actionable });
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, startBusy] = useTransition();

  const selectableIds = new Set(rows.filter(actionable).map((r) => r.applicationId));
  const selected = new Set(selection.ids);
  const selectedRows = rows.filter((r) => selected.has(r.applicationId));

  // Per action, only the ticked rows that action can actually touch. A mixed
  // selection is the normal case (some rejected, some undecided), so each
  // button counts and submits its own subset rather than refusing the lot.
  const forReject = selectedRows.filter((r) => r.canReject).map((r) => r.applicationId);
  const forWaitlist = selectedRows.filter((r) => r.canWaitlist).map((r) => r.applicationId);
  const forReopen = selectedRows.filter((r) => r.canReopen).map((r) => r.applicationId);

  const value: SelectionValue = {
    has: selection.has,
    toggle: selection.toggle,
    toggleAll: selection.toggleAll,
    allSelected: selection.allSelected,
    someSelected: selection.someSelected,
    selectable: (id) => selectableIds.has(id),
    anySelectable: selectableIds.size > 0,
  };

  function run(ids: string[], action: BulkAction, verb: string) {
    setError(null);
    setNote(null);
    if (ids.length === 0) return;
    startBusy(async () => {
      const res = await action(ids);
      if ("error" in res) {
        setError(res.error);
        return;
      }
      // Applicants who ticked a dual-role box are passed to that department
      // rather than rejected (planDualFallback), so they are counted apart:
      // reporting them as rejected would be wrong on the one row where the
      // operator most needs to know the applicant is still in play.
      const passed = res.passedToDual ?? 0;
      const parts = [`${verb} ${res.applied - passed}`];
      if (passed > 0) parts.push(`passed ${passed} to a dual-role department`);
      if (res.skipped.length > 0) parts.push(`skipped ${res.skipped.length}`);
      setNote(`${parts.join(", ")}. No email has been sent.`);
      // The decided rows stay on the roster with a new decision, so the table
      // has to re-render for the operator to see what changed.
      router.refresh();
    });
  }

  return (
    <RosterSelectionContext.Provider value={value}>
      {value.anySelectable && (
        <div className="space-y-2">
          {error && <Alert tone="error">{error}</Alert>}
          {note && <Alert tone="success">{note}</Alert>}
          <div className="flex flex-wrap items-center gap-2">
            <ConfirmButton
              label={forReject.length === 0 ? "Reject selected" : `Reject ${forReject.length}`}
              confirmLabel={`Reject ${forReject.length} ${forReject.length === 1 ? "applicant" : "applicants"}?`}
              size="sm"
              disabled={busy || forReject.length === 0}
              busy={busy}
              onConfirm={() => run(forReject, onBulkReject, "Rejected")}
            />
            <ConfirmButton
              label={forWaitlist.length === 0 ? "Waitlist selected" : `Waitlist ${forWaitlist.length}`}
              confirmLabel={`Waitlist ${forWaitlist.length} ${forWaitlist.length === 1 ? "applicant" : "applicants"}?`}
              size="sm"
              disabled={busy || forWaitlist.length === 0}
              busy={busy}
              onConfirm={() => run(forWaitlist, onBulkWaitlist, "Waitlisted")}
            />
            <ConfirmButton
              label={forReopen.length === 0 ? "Reopen selected" : `Reopen ${forReopen.length}`}
              confirmLabel={`Reopen ${forReopen.length} ${forReopen.length === 1 ? "decision" : "decisions"}?`}
              size="sm"
              disabled={busy || forReopen.length === 0}
              busy={busy}
              onConfirm={() => run(forReopen, onBulkReopen, "Reopened")}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {selected.size === 0
              ? "Tick rows to decide several at once. Shift-click selects a range."
              : "Records the decision only, and stays reversible: acceptance and rejection emails are sent later from the Decisions tab. Reopen puts a rejected applicant back to undecided. Waitlisting needs the applicant routed to a department first."}
          </p>
        </div>
      )}
      {children}
    </RosterSelectionContext.Provider>
  );
}

/** The header box: ticks every actionable row on this page of the roster. */
export function RosterSelectAll() {
  const selection = useContext(RosterSelectionContext);
  if (!selection) return null;
  return (
    <>
      <Checkbox
        checked={selection.allSelected}
        indeterminate={selection.someSelected}
        onChange={selection.toggleAll}
        aria-label="Select every applicant on this page"
      />
      <span className="sr-only">Select</span>
    </>
  );
}

/** One row's box. Renders nothing for a row no bulk action may touch, so the
 *  cell reads as unavailable rather than as an unticked option. */
export function RosterRowCheckbox({ applicationId, name }: { applicationId: string; name: string }) {
  const selection = useContext(RosterSelectionContext);
  if (!selection || !selection.selectable(applicationId)) return null;
  return (
    <Checkbox
      checked={selection.has(applicationId)}
      // onClick, not onChange: a change event carries no shiftKey, and the
      // range is what makes a long roster quick to select.
      onClick={(e) => selection.toggle(applicationId, e.shiftKey)}
      onChange={() => {}}
      aria-label={`Select ${name}`}
    />
  );
}
