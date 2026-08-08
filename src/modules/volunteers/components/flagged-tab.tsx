import { SectionHeader } from "@/platform/ui/section-header";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { DateOnly } from "@/platform/dates/display";
import type { FlaggedRow } from "@/modules/volunteers/services/offboarding";

/**
 * The clinic-wide queue of people flagged for offboarding in the ACTIVE term,
 * with the per-person Unflag and Offboard controls.
 *
 * Lifted out of page.tsx unchanged when the page became tabbed.
 */
export function FlaggedTab({
  flagged,
  unflagAction,
  executeOffboardAction,
}: {
  flagged: FlaggedRow[];
  unflagAction: (formData: FormData) => Promise<void>;
  executeOffboardAction: (formData: FormData) => Promise<void>;
}) {
  return (
    <section className="mt-8">
      <SectionHeader level="title" className="mb-3">Flagged for offboarding</SectionHeader>

      <Table>
        <THead>
          <TR>
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
              <TD colSpan={6} className="text-center text-subtle-foreground text-sm py-6">
                No one is flagged.
              </TD>
            </TR>
          ) : (
            flagged.map(({ flag, person, flaggedByName, departmentNames }) => (
              <TR key={flag.id}>
                <TD className="font-medium">{person.name}</TD>
                <TD className="text-foreground-soft text-sm">
                  {departmentNames.join(", ") || "-"}
                </TD>
                <TD className="text-foreground-soft text-sm">{flaggedByName ?? "-"}</TD>
                <TD className="text-foreground-soft tabular-nums text-sm">
                  <DateOnly value={flag.createdAt} />
                </TD>
                <TD className="text-muted-foreground text-sm">{flag.note ?? "-"}</TD>
                <TD>
                  <div className="flex items-center gap-2">
                    <form action={unflagAction}>
                      <input type="hidden" name="personId" value={person.id} />
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
