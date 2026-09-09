"use client";

import { useMemo, useRef, useState } from "react";
import { TextLink } from "@/platform/ui/text-link";
import { TD, TH, THead, TR, Table, TableEmpty } from "@/platform/ui/table";
import { Badge } from "@/platform/ui/badge";
import { Button } from "@/platform/ui/button";
import { Checkbox } from "@/platform/ui/checkbox";
import { Input } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { SubmitButton } from "@/platform/ui/submit-button";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { FormRow, ROW_WIDTH } from "@/platform/ui/form";
import { ListEmpty } from "@/platform/ui/list-empty";
import {
  countEligible, filterRows, isSelectable,
  type OnboardingFilters, type OnboardingRow, type OnboardingRowState,
} from "@/modules/recruitment/engine/onboarding-rows";

type Tone = "default" | "brand" | "success" | "warning" | "critical";

const STATE_LABELS: Record<OnboardingRowState, { label: string; tone: Tone }> = {
  NO_CONTRACT: { label: "No contract", tone: "default" },
  SENT: { label: "Sent", tone: "brand" },
  EXPIRED: { label: "Expired", tone: "critical" },
  SUBMITTED: { label: "Submitted", tone: "warning" },
  PROMOTED: { label: "Promoted", tone: "success" },
  CONFLICT: { label: "Conflict", tone: "warning" },
};

const STATUS_ORDER: OnboardingRowState[] = [
  "NO_CONTRACT", "SENT", "EXPIRED", "SUBMITTED", "PROMOTED", "CONFLICT",
];

export function OnboardingTable({
  rows, cycleId, sendLinks, promote, withdraw,
}: {
  rows: OnboardingRow[];
  cycleId: string;
  sendLinks: (formData: FormData) => void | Promise<void>;
  promote: (formData: FormData) => void | Promise<void>;
  withdraw: (formData: FormData) => void | Promise<void>;
}) {
  const [filters, setFilters] = useState<OnboardingFilters>({
    query: "", status: "ALL", dept: "ALL",
  });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  // Anchor for shift-click ranges, in visible order.
  const anchorRef = useRef<string | null>(null);

  const departments = useMemo(
    () => [...new Set(rows.map((r) => r.departmentCode))].sort(),
    [rows],
  );
  const visible = useMemo(() => filterRows(rows, filters), [rows, filters]);

  const selectableVisible = useMemo(() => visible.filter((r) => isSelectable(r.state)), [visible]);

  // The selection is always scoped to what is on screen. Filtering something out
  // deselects it, so a bulk action can never touch a row the operator cannot see.
  const effectiveSelected = useMemo(() => {
    const visibleIds = new Set(selectableVisible.map((r) => r.acceptanceId));
    return new Set([...selected].filter((id) => visibleIds.has(id)));
  }, [selected, selectableVisible]);

  const selectedRows = useMemo(
    () => selectableVisible.filter((r) => effectiveSelected.has(r.acceptanceId)),
    [selectableVisible, effectiveSelected],
  );

  const counts = {
    send: countEligible(selectedRows, "send"),
    promote: countEligible(selectedRows, "promote"),
    withdraw: countEligible(selectedRows, "withdraw"),
  };
  const submittedInSelection = selectedRows.filter((r) => r.state === "SUBMITTED").length;
  const allVisibleSelected =
    selectableVisible.length > 0 && effectiveSelected.size === selectableVisible.length;

  // The indeterminate wiring moved into Checkbox, so all three bulk-selection
  // tables get it from one place rather than this being the only one that
  // remembered.

  function toggleAll() {
    setSelected(allVisibleSelected ? new Set() : new Set(selectableVisible.map((r) => r.acceptanceId)));
    anchorRef.current = null;
  }

  function toggleRow(acceptanceId: string, shiftKey: boolean) {
    // Captured here, before the ref is reassigned below: setSelected only
    // schedules the updater, which React does not run until after this
    // function returns, so reading anchorRef.current from inside the updater
    // would see the reassignment rather than the anchor this click started from.
    const anchor = anchorRef.current;
    setSelected((prev) => {
      const next = new Set(prev);
      // Shift-click extends from the anchor across the visible order, selecting
      // the whole span rather than toggling each member.
      if (shiftKey && anchor !== null) {
        const ids = selectableVisible.map((r) => r.acceptanceId);
        const from = ids.indexOf(anchor);
        const to = ids.indexOf(acceptanceId);
        if (from !== -1 && to !== -1) {
          for (const id of ids.slice(Math.min(from, to), Math.max(from, to) + 1)) next.add(id);
          return next;
        }
      }
      if (next.has(acceptanceId)) next.delete(acceptanceId);
      else next.add(acceptanceId);
      return next;
    });
    anchorRef.current = acceptanceId;
  }

  return (
    // The form's default action is withdraw, since both the per-row and the bulk
    // Withdraw controls use it. React encodes which action a submit control
    // invokes by writing its own "name" attribute onto any button whose
    // formAction overrides the form's default, which would swallow the
    // onlyAcceptanceId field this per-row button relies on (React warns:
    // "Cannot specify a 'name' prop for a button that specifies a function as a
    // formAction"). Leaving the per-row Withdraw button on the form's default
    // action (no formAction override) keeps its name/value pair literal, so
    // sendLinks and promote are the only controls that need formAction.
    <form className="space-y-3" action={withdraw}>
      <FormRow>
        <div className={ROW_WIDTH.wide}>
          <Input
            type="search"
            placeholder="Search name…"
            aria-label="Search applicants by name"
            value={filters.query}
            onChange={(e) => setFilters((f) => ({ ...f, query: e.target.value }))}
            // This is a text input inside a <form>, so pressing Enter here triggers
            // HTML implicit submission, which activates the form's first submit
            // button in tree order -- Send links. An operator narrowing a wide
            // selection with the search box and then hitting Enter out of habit
            // would otherwise email onboarding links to everyone checked, with no
            // confirmation. There is nothing for this field to submit to, so Enter
            // is simply swallowed here.
            onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }}
          />
        </div>
        <div className={ROW_WIDTH.control}>
          <Select
            aria-label="Filter by status"
            value={filters.status}
            onChange={(e) =>
              setFilters((f) => ({ ...f, status: e.target.value as OnboardingFilters["status"] }))
            }
          >
            <option value="ALL">All statuses</option>
            {STATUS_ORDER.map((s) => (
              <option key={s} value={s}>{STATE_LABELS[s].label}</option>
            ))}
          </Select>
        </div>
        <div className={ROW_WIDTH.control}>
          <Select
            aria-label="Filter by department"
            value={filters.dept}
            onChange={(e) => setFilters((f) => ({ ...f, dept: e.target.value }))}
          >
            <option value="ALL">All departments</option>
            {departments.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </Select>
        </div>
      </FormRow>

      <Table>
        <THead>
          <tr>
            <TH className="w-10">
              <Checkbox
                aria-label="Select all"
                checked={allVisibleSelected}
                indeterminate={effectiveSelected.size > 0 && !allVisibleSelected}
                onChange={toggleAll}
                disabled={selectableVisible.length === 0}
              />
            </TH>
            <TH>Applicant</TH>
            <TH>Dept</TH>
            <TH>Status</TH>
          </tr>
        </THead>
        <tbody>
          {visible.map((r) => {
            const s = STATE_LABELS[r.state];
            return (
              <TR key={r.acceptanceId}>
                <TD>
                  {isSelectable(r.state) && (
                    <Checkbox
                      name="acceptanceId"
                      value={r.acceptanceId}
                      aria-label={`Select ${r.firstName} ${r.lastName}`}
                      checked={effectiveSelected.has(r.acceptanceId)}
                      onClick={(e) => toggleRow(r.acceptanceId, e.shiftKey)}
                      onChange={() => {}}
                    />
                  )}
                </TD>
                <TD className="font-medium text-foreground">
                  {r.firstName} {r.lastName}
                  {r.customAnswers.length > 0 && (
                    <dl className="mt-1 space-y-0.5 text-xs font-normal text-subtle-foreground">
                      {r.customAnswers.map((a) => (
                        <div key={a.label}>
                          <span className="font-medium">{a.label}:</span> {a.value}
                        </div>
                      ))}
                    </dl>
                  )}
                </TD>
                <TD className="text-foreground-soft">{r.departmentCode}</TD>
                <TD>
                  <Badge tone={s.tone}>{s.label}</Badge>
                  {r.onRoster && <span className="ml-2 text-xs text-subtle-foreground">on roster</span>}
                  {r.contractId && (r.state === "SUBMITTED" || r.state === "PROMOTED") && (
                    <TextLink
                      href={`/recruitment/cycles/${cycleId}/onboarding/${r.contractId}`}
                      size="xs"
                      className="ml-2"
                    >
                      View
                    </TextLink>
                  )}
                  {/* Per-row withdraw, for dealing with one person without
                      disturbing the selection. It submits its own id under a
                      distinct name, so withdrawAction acts on this row alone
                      even when other rows are checked. Relies on the form's
                      default action (withdraw) rather than its own formAction,
                      so its name/value pair renders literally instead of being
                      overridden by React's action-identification bookkeeping. */}
                  {/* Deliberately NOT isEligible("withdraw", r.state): CONFLICT is
                      not (and must not become) an eligible withdraw state, since
                      isSelectable derives from that same table and a conflicted
                      row must never render a checkbox or enter bulk selection.
                      But a second department can accept an applicant who already
                      has a live contract, producing a CONFLICT row that still
                      carries one -- and revokeAcceptance refuses to touch it
                      until that contract is withdrawn "on the Onboarding page",
                      which is exactly here. Gate on the contract's existence
                      directly so that row keeps a way out. withdrawAction already
                      accepts any selected acceptance whose contract is
                      non-PROMOTED, so no server change is needed. */}
                  {r.contractId != null && r.state !== "PROMOTED" && (
                    <ConfirmButton
                      label="Withdraw"
                      size="sm"
                      className="ml-2 inline-flex align-middle"
                      name="onlyAcceptanceId"
                      value={r.acceptanceId}
                      confirmLabel={`Withdraw${r.state === "SUBMITTED" ? " (deletes the submitted contract + signatures)" : ""}?`}
                    />
                  )}
                </TD>
              </TR>
            );
          })}
          {visible.length === 0 && (
            <TableEmpty colSpan={4}>
              {/* This table got the branch right before ListEmpty existed; it
                  now shares the wording so the app says one thing. */}
              <ListEmpty filtered={rows.length > 0} noun="accepted applicants" />
            </TableEmpty>
          )}
        </tbody>
      </Table>

      <div className="flex flex-wrap items-center gap-2">
        <SubmitButton size="sm" formAction={sendLinks} pendingLabel="Sending…" disabled={counts.send === 0}>
          Send links ({counts.send})
        </SubmitButton>
        <SubmitButton size="sm" formAction={promote} pendingLabel="Promoting…" disabled={counts.promote === 0}>
          Promote ({counts.promote})
        </SubmitButton>
        {/* No formAction: this rides the form's default action (withdraw). See the
            per-row comment above for why a button with its own name/value pair
            cannot also carry a formAction. name="bulkWithdraw" value="1" marks this
            as a deliberate bulk-withdraw click; withdrawAction refuses any
            submission carrying neither this marker nor onlyAcceptanceId, so a
            future submit button added to this form without its own formAction is
            refused instead of silently deleting the whole selection. selectedIds
            still checks onlyAcceptanceId first, so a per-row click keeps winning
            outright even though both names could technically be present. */}
        <ConfirmButton
          label={`Withdraw (${counts.withdraw})`}
          size="sm"
          name="bulkWithdraw"
          value="1"
          disabled={counts.withdraw === 0}
          confirmLabel={
            submittedInSelection > 0
              ? `Withdraw ${counts.withdraw}? Deletes ${submittedInSelection} submitted contract(s) + signatures`
              : `Withdraw ${counts.withdraw}?`
          }
        />
        {effectiveSelected.size > 0 && (
          <span className="text-xs text-subtle-foreground">
            {effectiveSelected.size} selected
          </span>
        )}
        {effectiveSelected.size > 0 && (
          <Button type="button" size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        )}
      </div>
    </form>
  );
}
