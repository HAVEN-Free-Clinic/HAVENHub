"use client";

import type { Tone } from "@/platform/ui/badge";
import { useMemo, useState } from "react";
import { TextLink } from "@/platform/ui/text-link";
import { TD, TH, THead, TR, Table, TableEmpty } from "@/platform/ui/table";
import { Badge } from "@/platform/ui/badge";
import { Button } from "@/platform/ui/button";
import { Checkbox } from "@/platform/ui/checkbox";
import { useBulkSelection } from "@/platform/ui/use-bulk-selection";
import { Input } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { SubmitButton } from "@/platform/ui/submit-button";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { FormRow } from "@/platform/ui/form";
import { FilterField } from "@/platform/ui/filter-bar";
import { ListEmpty } from "@/platform/ui/list-empty";
import {
  countEligible, filterRows, isSelectable,
  type OnboardingFilters, type OnboardingRow, type OnboardingRowState,
} from "@/modules/recruitment/engine/onboarding-rows";

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
  const departments = useMemo(
    () => [...new Set(rows.map((r) => r.departmentCode))].sort(),
    [rows],
  );
  const visible = useMemo(() => filterRows(rows, filters), [rows, filters]);

  // The visible rows, not `rows`: the hook scopes the selection to what it is
  // given, so filtering a row out of view deselects it and a bulk action can
  // never touch a row the operator cannot see.
  const selection = useBulkSelection({
    rows: visible,
    idOf: (r) => r.acceptanceId,
    selectable: (r) => isSelectable(r.state),
  });

  const selectedRows = visible.filter((r) => selection.has(r.acceptanceId) && isSelectable(r.state));

  const counts = {
    send: countEligible(selectedRows, "send"),
    promote: countEligible(selectedRows, "promote"),
    withdraw: countEligible(selectedRows, "withdraw"),
  };
  const submittedInSelection = selectedRows.filter((r) => r.state === "SUBMITTED").length;
  const selectableVisible = visible.filter((r) => isSelectable(r.state));

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
        {/* RowField, not a bare width wrapper: a visible label beside a control
            whose only name was an aria-label. Every aria-label here is KEPT --
            each visible label is a substring of it, so WCAG 2.5.3 holds and the
            existing locators still resolve. */}
        <FilterField label="Search" width="wide">
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
        </FilterField>
        <FilterField label="Status">
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
        </FilterField>
        <FilterField label="Department">
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
        </FilterField>
      </FormRow>

      <Table>
        <THead>
          <tr>
            <TH className="w-10">
              <Checkbox
                aria-label="Select all"
                checked={selection.allSelected}
                indeterminate={selection.someSelected}
                onChange={selection.toggleAll}
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
                      checked={selection.has(r.acceptanceId)}
                      onClick={(e) => selection.toggle(r.acceptanceId, e.shiftKey)}
                      onChange={() => {}}
                    />
                  )}
                </TD>
                <TD className="font-medium text-foreground">
                  {r.firstName} {r.lastName}
                  {r.customAnswers.length > 0 && (
                    // A dl whose rows were <div><span> held no dt or dd at all,
                    // so a screen reader in list mode announced a description
                    // list with nothing in it. Same look, real terms.
                    <dl className="mt-1 space-y-0.5 text-xs font-normal text-subtle-foreground">
                      {r.customAnswers.map((a) => (
                        <div key={a.label}>
                          <dt className="inline font-medium">{a.label}:</dt>{" "}
                          <dd className="inline">{a.value}</dd>
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
        {/* No formAction: this rides the form's default action (withdraw). A
            button with its own name/value pair cannot also carry a formAction --
            react-dom drops the submitter when it takes an action off it, so the
            name/value reaches nothing; `submit-button.guard.test.ts` fences the
            pairing repo-wide after it shipped once on /support/epic. name="bulkWithdraw" value="1" marks this
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
        {selection.ids.length > 0 && (
          <span className="text-xs text-subtle-foreground">
            {selection.ids.length} selected
          </span>
        )}
        {selection.ids.length > 0 && (
          <Button type="button" size="sm" variant="ghost" onClick={selection.clear}>
            Clear
          </Button>
        )}
      </div>
    </form>
  );
}
