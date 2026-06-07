import { requirePermission } from "@/platform/auth/session";
import { PageHeader } from "@/platform/ui/page-header";
import { Badge } from "@/platform/ui/badge";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { Input } from "@/platform/ui/input";
import {
  offboardingView,
  flagForOffboarding,
  unflag,
  executeOffboard,
  OffboardForbiddenError,
  OffboardNotFoundError,
} from "@/modules/volunteers/services/offboarding";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

// The volunteers layout gates module access. Here we additionally require
// volunteers.view for the page render and use volunteers.manage_offboarding
// defense-in-depth in the execute action, matching /volunteers/page.tsx pattern.

type PageProps = {
  searchParams: Promise<{ error?: string }>;
};

// ---------------------------------------------------------------------------
// Date formatting (UTC) -- copied from /volunteers/page.tsx; not imported
// across pages to avoid coupling.
// ---------------------------------------------------------------------------

function fmtDate(d: Date | null | undefined): string {
  if (!d) return "-";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function OffboardingPage({ searchParams }: PageProps) {
  const viewer = await requirePermission("volunteers.view");
  const sp = await searchParams;
  const errorMessage = sp.error ? decodeURIComponent(sp.error) : null;

  const { departments, flagged } = await offboardingView(viewer.personId);

  // ---------------------------------------------------------------------------
  // Server actions
  // ---------------------------------------------------------------------------

  async function flagAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("volunteers.view");
    const personId = formData.get("personId") as string;
    const note = (formData.get("note") as string | null) || undefined;
    if (!personId) return;
    try {
      await flagForOffboarding(actor.personId, personId, note);
    } catch (err) {
      if (err instanceof OffboardForbiddenError) {
        redirect(`/volunteers/offboarding?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    revalidatePath("/volunteers/offboarding");
  }

  async function unflagAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("volunteers.view");
    const personId = formData.get("personId") as string;
    if (!personId) return;
    try {
      await unflag(actor.personId, personId);
    } catch (err) {
      if (err instanceof OffboardForbiddenError || err instanceof OffboardNotFoundError) {
        redirect(`/volunteers/offboarding?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    revalidatePath("/volunteers/offboarding");
  }

  async function executeOffboardAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("volunteers.manage_offboarding");
    const personId = formData.get("personId") as string;
    if (!personId) return;
    try {
      await executeOffboard(actor.personId, personId);
    } catch (err) {
      if (err instanceof OffboardForbiddenError) {
        redirect(`/volunteers/offboarding?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    revalidatePath("/volunteers/offboarding");
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div>
      <PageHeader
        title="Offboarding"
        description="Flag and process volunteer offboarding"
      />

      {errorMessage && (
        <p
          role="alert"
          className="mt-4 rounded-md border border-critical/20 bg-red-50 px-3 py-2 text-sm text-critical"
        >
          {errorMessage}
        </p>
      )}

      {/* Director section: one card per manageable department */}
      {departments.length === 0 ? (
        <div className="mt-12 flex flex-col items-center justify-center gap-3 text-center text-sm text-slate-500">
          <p>No departments to review.</p>
        </div>
      ) : (
        <div className="mt-8 flex flex-col gap-10">
          {departments.map(({ department, members }) => (
            <section key={department.id}>
              <h2 className="mb-3 text-base font-semibold">
                {department.code} &middot; {department.name}
              </h2>

              <Table>
                <THead>
                  <TR>
                    <TH>Name</TH>
                    <TH>Role</TH>
                    <TH>Status</TH>
                    <TH>Note</TH>
                    <TH></TH>
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
                      <TD className="text-slate-500 text-sm">
                        {m.flag?.note ?? "-"}
                      </TD>
                      <TD>
                        <div className="flex items-center gap-2">
                          {m.flag ? (
                            /* Unflag */
                            <form action={unflagAction}>
                              <input type="hidden" name="personId" value={m.person.id} />
                              <ConfirmButton label="Unflag" confirmLabel="Confirm?" />
                            </form>
                          ) : (
                            /* Flag with optional note */
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
      )}

      {/* Executor section: only shown when viewer has manage_offboarding */}
      {flagged !== null && (
        <section className="mt-12">
          <h2 className="mb-3 text-base font-semibold">Flagged for offboarding</h2>

          <Table>
            <THead>
              <TR>
                <TH>Name</TH>
                <TH>Departments</TH>
                <TH>Flagged by</TH>
                <TH>Flagged date</TH>
                <TH>Note</TH>
                <TH></TH>
              </TR>
            </THead>
            <tbody>
              {flagged.length === 0 ? (
                <TR>
                  <TD colSpan={6} className="text-center text-slate-400 text-sm py-6">
                    No one is flagged.
                  </TD>
                </TR>
              ) : (
                flagged.map(({ flag, person, flaggedByName, departmentNames }) => (
                  <TR key={flag.id}>
                    <TD className="font-medium">{person.name}</TD>
                    <TD className="text-slate-600 text-sm">
                      {departmentNames.join(", ") || "-"}
                    </TD>
                    <TD className="text-slate-600 text-sm">{flaggedByName ?? "-"}</TD>
                    <TD className="text-slate-600 tabular-nums text-sm">
                      {fmtDate(flag.createdAt)}
                    </TD>
                    <TD className="text-slate-500 text-sm">{flag.note ?? "-"}</TD>
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
      )}
    </div>
  );
}
