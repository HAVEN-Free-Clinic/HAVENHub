"use client";

import { useActionState, useState } from "react";
import { SectionHeader } from "@/platform/ui/section-header";
import { Badge } from "@/platform/ui/badge";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { Checkbox } from "@/platform/ui/checkbox";
import { Input } from "@/platform/ui/input";
import { Button } from "@/platform/ui/button";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { Alert } from "@/platform/ui/alert";
import { BulkResultAlert, downloadCsv } from "@/modules/volunteers/components/offboarding-shared";
import type { TransitionRow, TransitionView } from "@/modules/volunteers/services/transition";
// Type-only, so the server module is erased at compile time and never bundled.
import type { BulkResult } from "@/modules/volunteers/services/transition-actions";
// Value import, so it MUST come from the dependency-free limits module.
import { MAX_BULK_OFFBOARD } from "@/modules/volunteers/transition-limits";

type BulkAction = (prev: BulkResult | null, formData: FormData) => Promise<BulkResult | null>;

const BUCKET_LABELS = {
  NOT_RETURNING: "Not returning",
  PENDING: "Pending a decision",
  RETURNING: "Returning",
} as const;

const BUCKET_ORDER = ["NOT_RETURNING", "PENDING", "RETURNING"] as const;

const BUCKET_HINTS = {
  NOT_RETURNING: "No place next term and no application in flight.",
  PENDING: "Applied for next term and awaiting a decision. Checked only if you check them.",
  RETURNING: "Already holds a place next term. Nothing to do.",
} as const;

/**
 * The term transition report: who on the current roster is coming back, with
 * bulk flag, bulk offboard, and the Teams removal-list export.
 *
 * Client component because the whole tab is one selection. The bulk actions are
 * server actions that RETURN their result, rendered through useActionState, so
 * per-person skip reasons survive without a redirect and the selection is not
 * lost.
 */
export function TransitionTab({
  view,
  canExecute,
  bulkFlagAction,
  bulkOffboardAction,
}: {
  view: TransitionView;
  canExecute: boolean;
  bulkFlagAction: BulkAction;
  bulkOffboardAction: BulkAction;
}) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(view.rows.filter((r) => r.bucket === "NOT_RETURNING").map((r) => r.personId)),
  );
  const [exportError, setExportError] = useState<string | null>(null);
  const [flagResult, flagFormAction, flagPending] = useActionState(bulkFlagAction, null);
  const [offboardResult, offboardFormAction] = useActionState(bulkOffboardAction, null);

  if (!view.nextTerm) {
    return (
      <div className="mt-12 flex flex-col items-center justify-center gap-3 text-center text-sm text-muted-foreground">
        <p>No term is in planning, so there is no transition to report on yet.</p>
        <p>
          Create the next term in Admin, Terms, then carry the roster forward or run recruitment
          against it.
        </p>
      </div>
    );
  }

  function toggle(personId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(personId)) next.delete(personId);
      else next.add(personId);
      return next;
    });
  }

  function toggleBucket(rows: TransitionRow[], on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const row of rows) {
        if (!row.selectable) continue;
        if (on) next.add(row.personId);
        else next.delete(row.personId);
      }
      return next;
    });
  }

  async function exportCsv() {
    setExportError(null);
    try {
      await downloadCsv({ scope: "selection", personIds: selectedIds });
    } catch {
      setExportError("Export failed. Refresh and try again.");
    }
  }

  // Derived from the rows actually on the page, not raw state: revalidatePath
  // re-renders this component with fresh props but never remounts it, so the
  // `selected` Set survives a successful bulk offboard even though the people
  // in it just dropped out of view.rows. Submitting the stale ids would rerun
  // executeOffboard on already-offboarded people. Filtering against the live
  // rows here means the header count, the button labels, the cap check, and
  // the hidden inputs all agree with what is actually still selectable.
  const selectedIds = view.rows.filter((r) => r.selectable && selected.has(r.personId)).map((r) => r.personId);
  const overCap = selectedIds.length > MAX_BULK_OFFBOARD;

  return (
    <div className="mt-8 flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <SectionHeader level="title">
          {view.activeTerm?.code} to {view.nextTerm.code}
        </SectionHeader>
        <span className="text-sm text-muted-foreground">
          {view.rows.length} current members, {selectedIds.length} selected
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <form action={flagFormAction} className="flex flex-wrap items-center gap-2">
          {selectedIds.map((id) => (
            <input key={id} type="hidden" name="personId" value={id} />
          ))}
          <Input
            name="note"
            placeholder="Note applied to everyone selected (optional)"
            aria-label="Note applied to everyone selected (optional)"
            className="w-72 text-xs py-1"
          />
          <Button type="submit" disabled={flagPending || selectedIds.length === 0}>
            {flagPending ? "Flagging..." : `Flag ${selectedIds.length} for offboarding`}
          </Button>
        </form>

        {canExecute && (
          <form action={offboardFormAction} className="flex items-center gap-2">
            {selectedIds.map((id) => (
              <input key={id} type="hidden" name="personId" value={id} />
            ))}
            <ConfirmButton
              label={`Offboard ${selectedIds.length}`}
              confirmLabel={`Offboard ${selectedIds.length} people? This removes all their active memberships.`}
              disabled={selectedIds.length === 0 || overCap}
            />
          </form>
        )}

        {canExecute && (
          <Button type="button" variant="outline" onClick={exportCsv} disabled={selectedIds.length === 0}>
            Export emails CSV
          </Button>
        )}
      </div>

      {overCap && (
        <Alert tone="warning">
          Offboarding runs up to {MAX_BULK_OFFBOARD} people at a time. Deselect{" "}
          {selectedIds.length - MAX_BULK_OFFBOARD} to continue, or flag them all now and offboard in
          batches.
        </Alert>
      )}

      {exportError && <Alert tone="error">{exportError}</Alert>}
      <BulkResultAlert verb="flagged" result={flagResult} />
      <BulkResultAlert verb="offboarded" result={offboardResult} />

      {BUCKET_ORDER.map((bucket) => {
        const rows = view.rows.filter((r) => r.bucket === bucket);
        if (rows.length === 0) return null;
        const selectableRows = rows.filter((r) => r.selectable);
        const allSelected =
          selectableRows.length > 0 && selectableRows.every((r) => selected.has(r.personId));

        return (
          <section key={bucket}>
            <SectionHeader level="title" className="mb-1">
              {BUCKET_LABELS[bucket]} ({rows.length})
            </SectionHeader>
            <p className="mb-3 text-sm text-muted-foreground">{BUCKET_HINTS[bucket]}</p>

            <Table>
              <THead>
                <TR>
                  <TH>
                    {selectableRows.length > 0 ? (
                      <>
                        <Checkbox
                          checked={allSelected}
                          onChange={(e) => toggleBucket(rows, e.target.checked)}
                          aria-label={`Select all ${BUCKET_LABELS[bucket]}`}
                        />
                        <span className="sr-only">Select</span>
                      </>
                    ) : (
                      <span className="sr-only">Select</span>
                    )}
                  </TH>
                  <TH>Name</TH>
                  <TH>Departments</TH>
                  <TH>Role</TH>
                  <TH>Notes</TH>
                </TR>
              </THead>
              <tbody>
                {rows.map((row) => (
                  <TR key={row.personId}>
                    <TD>
                      {row.selectable ? (
                        <Checkbox
                          checked={selected.has(row.personId)}
                          onChange={() => toggle(row.personId)}
                          aria-label={`Select ${row.name}`}
                        />
                      ) : null}
                    </TD>
                    <TD className="font-medium">{row.name}</TD>
                    <TD className="text-foreground-soft text-sm">
                      {row.departments.map((d) => d.code).join(", ") || "-"}
                    </TD>
                    <TD>
                      <Badge tone={row.role === "DIRECTOR" ? "brand" : "default"}>
                        {row.role === "DIRECTOR" ? "Director" : "Volunteer"}
                      </Badge>
                    </TD>
                    <TD>
                      <div className="flex flex-wrap items-center gap-1">
                        {row.flagged && <Badge tone="warning">Flagged</Badge>}
                        {row.selfWithdrew && <Badge tone="warning">Self-withdrew</Badge>}
                        {row.hasDraftApplication && <Badge tone="default">Draft application</Badge>}
                        {row.withdrewApplication && <Badge tone="warning">Withdrew application</Badge>}
                      </div>
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </section>
        );
      })}
    </div>
  );
}
