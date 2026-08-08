import { SectionHeader } from "@/platform/ui/section-header";
import { Badge } from "@/platform/ui/badge";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { Input } from "@/platform/ui/input";
import type { DepartmentOffboarding } from "@/modules/volunteers/services/offboarding";

/**
 * One card per department the viewer manages, listing that department's ACTIVE
 * members in the ACTIVE term with a Flag or Unflag control.
 *
 * Lifted out of page.tsx unchanged when the page became tabbed. Server
 * component: the actions arrive as props and bind to plain forms.
 */
export function DepartmentTab({
  departments,
  flagAction,
  unflagAction,
}: {
  departments: DepartmentOffboarding[];
  flagAction: (formData: FormData) => Promise<void>;
  unflagAction: (formData: FormData) => Promise<void>;
}) {
  if (departments.length === 0) {
    return (
      <div className="mt-12 flex flex-col items-center justify-center gap-3 text-center text-sm text-muted-foreground">
        <p>No departments to review.</p>
      </div>
    );
  }

  return (
    <div className="mt-8 flex flex-col gap-10">
      {departments.map(({ department, members }) => (
        <section key={department.id}>
          <SectionHeader level="title" className="mb-3">
            {department.code} · {department.name}
          </SectionHeader>

          <Table>
            <THead>
              <TR>
                <TH>Name</TH>
                <TH>Role</TH>
                <TH>Status</TH>
                <TH>Note</TH>
                <TH><span className="sr-only">Actions</span></TH>
              </TR>
            </THead>
            <tbody>
              {members.map((m) => (
                <TR key={m.person.id}>
                  <TD className="font-medium">{m.person.name}</TD>
                  <TD>
                    <Badge tone={m.kind === "DIRECTOR" ? "brand" : "default"}>
                      {m.kind === "DIRECTOR" ? "Director" : "Volunteer"}
                    </Badge>
                  </TD>
                  <TD>
                    {m.flag ? (
                      <Badge tone="warning">Flagged</Badge>
                    ) : (
                      <Badge tone="default">Active</Badge>
                    )}
                  </TD>
                  <TD className="text-muted-foreground text-sm">{m.flag?.note ?? "-"}</TD>
                  <TD>
                    <div className="flex items-center gap-2">
                      {m.flag ? (
                        <form action={unflagAction}>
                          <input type="hidden" name="personId" value={m.person.id} />
                          <ConfirmButton label="Unflag" confirmLabel="Confirm?" />
                        </form>
                      ) : (
                        <form action={flagAction} className="flex items-center gap-2">
                          <input type="hidden" name="personId" value={m.person.id} />
                          <Input
                            name="note"
                            placeholder="Note (optional)"
                            aria-label="Note (optional)"
                            className="w-40 text-xs py-1"
                          />
                          <ConfirmButton label="Flag" confirmLabel="Confirm?" />
                        </form>
                      )}
                    </div>
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </section>
      ))}
    </div>
  );
}
