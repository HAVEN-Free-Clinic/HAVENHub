"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { Badge } from "@/platform/ui/badge";
import { Checkbox } from "@/platform/ui/checkbox";
import { Input } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { SubmitButton } from "@/platform/ui/submit-button";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import {
  filterRows, isEligible, isSelectable,
  type OnboardingFilters, type OnboardingRow, type OnboardingRowState,
} from "@/modules/recruitment/engine/onboarding-rows";

type Tone = "default" | "brand" | "success" | "warning" | "critical";

export const STATE_LABELS: Record<OnboardingRowState, { label: string; tone: Tone }> = {
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
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-56">
          <Input
            type="search"
            placeholder="Search name…"
            aria-label="Search applicants by name"
            value={filters.query}
            onChange={(e) => setFilters((f) => ({ ...f, query: e.target.value }))}
          />
        </div>
        <div className="w-44">
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
        <div className="w-40">
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
      </div>

      <Table>
        <THead>
          <tr>
            <TH className="w-10"><span className="sr-only">Select</span></TH>
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
                    <Link
                      className="ml-2 text-xs text-brand-fg hover:text-brand-hover"
                      href={`/recruitment/cycles/${cycleId}/onboarding/${r.contractId}`}
                    >
                      View
                    </Link>
                  )}
                  {/* Per-row withdraw, for dealing with one person without
                      disturbing the selection. It submits its own id under a
                      distinct name, so withdrawAction acts on this row alone
                      even when other rows are checked. Relies on the form's
                      default action (withdraw) rather than its own formAction,
                      so its name/value pair renders literally instead of being
                      overridden by React's action-identification bookkeeping. */}
                  {isEligible("withdraw", r.state) && (
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
            <TR>
              <TD colSpan={4} className="py-10 text-center text-subtle-foreground">
                {rows.length === 0 ? "No accepted applicants yet." : "No applicants match these filters."}
              </TD>
            </TR>
          )}
        </tbody>
      </Table>

      <div className="flex flex-wrap items-center gap-2">
        <SubmitButton size="sm" formAction={sendLinks} pendingLabel="Sending…" disabled>
          Send links (0)
        </SubmitButton>
        <SubmitButton size="sm" formAction={promote} pendingLabel="Promoting…" disabled>
          Promote (0)
        </SubmitButton>
        {/* Also relies on the form's default action (withdraw); see the per-row
            comment above for why this control has no formAction of its own. */}
        <ConfirmButton
          label="Withdraw (0)"
          size="sm"
          confirmLabel="Withdraw?"
          disabled
        />
      </div>
    </form>
  );
}
