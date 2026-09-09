import { redirect } from "next/navigation";
import { requirePermission, requirePersonSession } from "@/platform/auth/session";
import { can } from "@/platform/rbac/engine";
import { PageHeader } from "@/platform/ui/page-header";
import { SectionHeader } from "@/platform/ui/section-header";
import { Badge } from "@/platform/ui/badge";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import {
  ComplianceHeaderCells,
  ComplianceNameCell,
  ComplianceCells,
  asComplianceRow,
} from "@/modules/volunteers/components/compliance-cells";
import { CertificateViewer } from "@/modules/my-info/components/certificate-viewer";
import {
  departmentCompliance,
  verifyCertificate,
  ComplianceForbiddenError,
  setCompletionDateAsManager,
  CertificateNotFoundError,
} from "@/modules/volunteers/services/compliance";
import { CompletionDateError } from "@/platform/compliance/completion-date";
import type { StatusTone } from "@/platform/compliance/labels";
import { revalidatePath } from "next/cache";
import { VOLUNTEER_ENTRY_FALLBACKS } from "./module-entry";

// requireModuleAccess("volunteers") is already enforced by the layout.
// We additionally require the same permission here in the server action for defense in depth.

// ---------------------------------------------------------------------------
// Status badge helper
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Count chips helper
// ---------------------------------------------------------------------------

type CountChipProps = {
  label: string;
  count: number;
  tone: StatusTone;
};

function CountChip({ label, count, tone }: CountChipProps) {
  return <Badge tone={tone}>{`${count} ${label}`}</Badge>;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function VolunteersPage() {
  // This page IS the module root, so it is where the dashboard tile, the
  // toolbar chip and the "Volunteers" breadcrumb all point -- and it requires
  // volunteers.view, which is only one of the five ways into this module.
  //
  // The module's additionalAccessPermissions admit four more personas
  // (registry.ts). Each of them was shown the tile, the chip and the crumb, and
  // each of them bounced to /no-access on clicking it; their working tabs were
  // reachable only from the dropdown, or once they were already inside.
  //
  // A redirect for ONE of the four (verify_spanish) was written here with the
  // comment "so the module tile leads somewhere", and never extended when the
  // other three were added. This is that list, completed.
  //
  // Ordered as the nav row is, so a viewer lands on the first tab they would
  // see rather than on whichever branch happened to be checked first. Each
  // destination's own gate is the one named here, so a persona cannot be sent
  // somewhere that bounces in turn:
  //
  //   /volunteers/directory  requireAnyPermission([view_directory,
  //                                                view_directory_own_dept])
  //   /volunteers/ehs        requireAnyPermission([view_compliance,
  //                                                manage_compliance])
  //   /volunteers/spanish-review  requirePermission(verify_spanish)
  const session = await requirePersonSession();
  if (!(await can(session.personId, "volunteers.view"))) {
    for (const [permission, href] of VOLUNTEER_ENTRY_FALLBACKS) {
      if (await can(session.personId, permission)) redirect(href);
    }
  }

  const viewer = await requirePermission("volunteers.view");

  const departments = await departmentCompliance(viewer.personId);

  // Server action: verify a certificate. certId is bound per-row. The service
  // requires manage_compliance or admin, so directors (volunteers.view only)
  // get a ComplianceForbiddenError surfaced in the viewer modal.
  async function verifyAction(certId: string): Promise<{ error?: string }> {
    "use server";
    const actor = await requirePermission("volunteers.view");
    try {
      await verifyCertificate(actor.personId, certId);
    } catch (err) {
      if (err instanceof ComplianceForbiddenError) return { error: err.message };
      if (err instanceof CertificateNotFoundError) return { error: "Certificate not found." };
      throw err;
    }
    revalidatePath("/volunteers");
    return {};
  }

  const isAdmin = await can(viewer.personId, "admin.access");
  const isManager = await can(viewer.personId, "volunteers.manage_compliance");

  async function setDateAction(certId: string, dateIso: string): Promise<{ error?: string }> {
    "use server";
    const actor = await requirePermission("volunteers.view");
    try {
      await setCompletionDateAsManager(actor.personId, certId, dateIso);
    } catch (err) {
      if (err instanceof CompletionDateError) return { error: err.reason };
      if (err instanceof ComplianceForbiddenError) return { error: err.message };
      if (err instanceof CertificateNotFoundError) return { error: "Certificate not found." };
      throw err;
    }
    revalidatePath("/volunteers");
    return {};
  }

  // Empty state: viewer has no director memberships
  if (departments.length === 0) {
    // Check if viewer has manage_compliance so we can show a pointer
    const isManager = await can(viewer.personId, "volunteers.manage_compliance");
    return (
      <div>
        <PageHeader
          title="Compliance"
          description="Department HIPAA compliance tracking."
        />
        <div className="mt-12 flex flex-col items-center justify-center gap-3 text-center text-sm text-muted-foreground">
          <p>You are not listed as a director of any department this term.</p>
          {isManager && (
            <p className="text-subtle-foreground text-xs">
              As a compliance manager you will have access to the master view once it is available.
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Compliance"
        description="Clearance status for your departments: HIPAA, training, learning, and EHS."
      />

      <div className="mt-8 flex flex-col gap-10">
        {departments.map(({ department, members, counts }) => {
          // Build chips: only show non-zero categories
          const chips: CountChipProps[] = [];
          if (counts.COMPLIANT > 0)
            chips.push({ label: "compliant", count: counts.COMPLIANT, tone: "success" });
          if (counts.EXPIRING_SOON > 0)
            chips.push({ label: "expiring", count: counts.EXPIRING_SOON, tone: "warning" });
          if (counts.EXPIRED > 0)
            chips.push({ label: "expired", count: counts.EXPIRED, tone: "critical" });
          if (counts.PENDING_VERIFICATION > 0)
            chips.push({ label: "needs verification", count: counts.PENDING_VERIFICATION, tone: "warning" });
          if (counts.UNKNOWN_DATE > 0)
            chips.push({ label: "date unknown", count: counts.UNKNOWN_DATE, tone: "default" });
          if (counts.NO_CERTIFICATE > 0)
            chips.push({ label: "no certificate", count: counts.NO_CERTIFICATE, tone: "default" });

          return (
            <section key={department.id}>
              <div className="mb-3 flex flex-wrap items-baseline gap-3">
                <SectionHeader level="title">
                  {department.code} · {department.name}
                </SectionHeader>
                <span className="flex flex-wrap gap-1.5">
                  {chips.map((c) => (
                    <CountChip key={c.label} {...c} />
                  ))}
                </span>
              </div>

              <Table>
                <THead>
                  <TR>
                    <TH>Name</TH>
                    <TH>Role</TH>
                    <ComplianceHeaderCells />
                    <TH><span className="sr-only">Actions</span></TH>
                  </TR>
                </THead>
                <tbody>
                  {members.map((m) => (
                    <TR key={m.person.id}>
                      {/* Name links through to the member profile: contact
                          details plus the reasons they are or are not cleared.
                          Every row here is by construction in a department the
                          viewer manages, which is exactly the profile page's
                          own scope, so no link on this table can bounce. */}
                      <ComplianceNameCell person={m.person} />
                      <TD>
                        <Badge tone={m.kind === "DIRECTOR" ? "brand" : "default"}>
                          {m.kind === "DIRECTOR" ? "Director" : "Volunteer"}
                        </Badge>
                      </TD>
                      <ComplianceCells row={asComplianceRow(m)} />
                      <TD>
                          <div className="flex items-center gap-2">
                            {m.cert && (
                              <CertificateViewer
                                certId={m.cert.id}
                                fileName={m.cert.fileName}
                                ownerName={m.person.name}
                                completionDate={m.cert.completionDate}
                                canEditDate={isAdmin}
                                canEditExistingDate={isAdmin}
                                onSetDate={setDateAction.bind(null, m.cert.id)}
                                canVerify={isManager || isAdmin}
                                verified={Boolean(m.cert.verifiedAt)}
                                onVerify={verifyAction.bind(null, m.cert.id)}
                              />
                            )}
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
    </div>
  );
}
