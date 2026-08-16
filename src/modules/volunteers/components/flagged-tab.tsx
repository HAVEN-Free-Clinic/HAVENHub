"use client";

import { useActionState, useState } from "react";
import { SectionHeader } from "@/platform/ui/section-header";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { Button } from "@/platform/ui/button";
import { Alert } from "@/platform/ui/alert";
import { Checkbox } from "@/platform/ui/checkbox";
import { formatDateOnly } from "@/platform/dates";
import { useTimeZone } from "@/platform/dates/client";
import { BulkResultAlert, downloadCsv } from "@/modules/volunteers/components/offboarding-shared";
import type { FlaggedRow } from "@/modules/volunteers/services/offboarding";
// Type-only, so the server module is erased at compile time and never bundled.
import type { BulkResult } from "@/modules/volunteers/services/transition-actions";
// Value import, so it MUST come from the dependency-free limits module.
import { MAX_BULK_OFFBOARD } from "@/modules/volunteers/transition-limits";

type BulkAction = (prev: BulkResult | null, formData: FormData) => Promise<BulkResult | null>;

/**
 * The clinic-wide queue of people flagged for offboarding in the ACTIVE term.
 *
 * Renders only for volunteers.manage_offboarding holders (the page gates it on
 * offboardingView returning a non-null flagged list), which is why the export
 * button needs no further permission prop.
 *
 * Client component so the bulk offboard can carry a selection. The per-person
 * Unflag and Offboard controls are unchanged plain forms bound to the page's
 * server actions.
 */
export function FlaggedTab({
  flagged,
  unflagAction,
  executeOffboardAction,
  bulkOffboardAction,
}: {
  flagged: FlaggedRow[];
  unflagAction: (formData: FormData) => Promise<void>;
  executeOffboardAction: (formData: FormData) => Promise<void>;
  bulkOffboardAction: BulkAction;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [exportError, setExportError] = useState<string | null>(null);
  const [offboardResult, offboardFormAction] = useActionState(bulkOffboardAction, null);
  const zone = useTimeZone();

  function toggle(personId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(personId)) next.delete(personId);
      else next.add(personId);
      return next;
    });
  }

  async function exportOffboardedCsv() {
    setExportError(null);
    try {
      await downloadCsv({ scope: "offboarded-term" });
    } catch {
      setExportError("Export failed. Refresh and try again.");
    }
  }

  // Derived from the rows actually on the page, not raw state: revalidatePath
  // re-renders this component with fresh props but never remounts it, so the
  // `selected` Set survives a successful bulk offboard even though the people
  // in it just dropped out of `flagged` (executeOffboard deletes the flag).
  // Submitting the stale ids would rerun executeOffboard on already-offboarded
  // people. Filtering against the live rows here means the button label, the
  // cap check, and the hidden inputs all agree with what is actually still
  // in the queue.
  const selectedIds = flagged.filter((f) => selected.has(f.person.id)).map((f) => f.person.id);
  const overCap = selectedIds.length > MAX_BULK_OFFBOARD;
  const allSelected = flagged.length > 0 && flagged.every((f) => selected.has(f.person.id));

  return (
    // mt-8 matches DepartmentTab's top spacing: both tabs' content sits directly
    // under the shared TabRow now, so their top margins must agree (was mt-12
    // pre-tabs, when this section stacked below the department cards instead).
    <section className="mt-8">
      <SectionHeader level="title" className="mb-3">Flagged for offboarding</SectionHeader>

      <div className="mb-4 flex flex-wrap items-center gap-3">
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

        <Button type="button" variant="outline" onClick={exportOffboardedCsv}>
          Export offboarded-this-term CSV
        </Button>
      </div>

      {overCap && (
        <Alert tone="warning" className="mb-4">
          Offboarding runs up to {MAX_BULK_OFFBOARD} people at a time. Deselect{" "}
          {selectedIds.length - MAX_BULK_OFFBOARD} to continue.
        </Alert>
      )}

      {exportError && <Alert tone="error" className="mb-4">{exportError}</Alert>}

      <BulkResultAlert verb="offboarded" result={offboardResult} className="mb-4" />

      <Table>
        <THead>
          <TR>
            <TH>
              <Checkbox
                checked={allSelected}
                onChange={(e) =>
                  setSelected(e.target.checked ? new Set(flagged.map((f) => f.person.id)) : new Set())
                }
                aria-label="Select all flagged people"
              />
              <span className="sr-only">Select</span>
            </TH>
            <TH>Name</TH>
            <TH>Departments</TH>
            <TH>Flagged by</TH>
            <TH>Flagged date</TH>
            <TH>Note</TH>
            <TH><span className="sr-only">Actions</span></TH>
          </TR>
        </THead>
        <tbody>
          {flagged.length === 0 ? (
            <TR>
              <TD colSpan={7} className="text-center text-subtle-foreground text-sm py-6">
                No one is flagged.
              </TD>
            </TR>
          ) : (
            flagged.map(({ flag, person, flaggedByName, departmentNames }) => (
              <TR key={flag.id}>
                <TD>
                  <Checkbox
                    checked={selected.has(person.id)}
                    onChange={() => toggle(person.id)}
                    aria-label={`Select ${person.name}`}
                  />
                </TD>
                <TD className="font-medium">{person.name}</TD>
                <TD className="text-foreground-soft text-sm">
                  {departmentNames.join(", ") || "-"}
                </TD>
                <TD className="text-foreground-soft text-sm">{flaggedByName ?? "-"}</TD>
                <TD className="text-foreground-soft tabular-nums text-sm">
                  {formatDateOnly(flag.createdAt, zone)}
                </TD>
                <TD className="text-muted-foreground text-sm">{flag.note ?? "-"}</TD>
                <TD>
                  <div className="flex items-center gap-2">
                    <form action={unflagAction}>
                      <input type="hidden" name="personId" value={person.id} />
                      {/* Tells unflagAction which tab to redirect back to on error. */}
                      <input type="hidden" name="tab" value="flagged" />
                      <ConfirmButton label="Unflag" confirmLabel="Confirm?" />
                    </form>
                    <form action={executeOffboardAction}>
                      <input type="hidden" name="personId" value={person.id} />
                      <ConfirmButton
                        label="Offboard"
                        confirmLabel={`Offboard ${person.name}? This removes all their active memberships.`}
                      />
                    </form>
                  </div>
                </TD>
              </TR>
            ))
          )}
        </tbody>
      </Table>
    </section>
  );
}
