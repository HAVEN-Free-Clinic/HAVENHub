import { redirect } from "next/navigation";
import { requirePermission, requirePersonSession } from "@/platform/auth/session";
import { can } from "@/platform/rbac/engine";
import { PageHeader } from "@/platform/ui/page-header";
import { SectionHeader } from "@/platform/ui/section-header";
import { Badge } from "@/platform/ui/badge";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { Alert } from "@/platform/ui/alert";
import { CertificateViewer } from "@/modules/my-info/components/certificate-viewer";
import {
  departmentCompliance,
  verifyCertificate,
  ComplianceForbiddenError,
  setCompletionDateAsManager,
  CertificateNotFoundError,
} from "@/modules/volunteers/services/compliance";
import { CompletionDateError } from "@/platform/compliance/completion-date";
import type { ComplianceStatus } from "@/platform/compliance/rules";
import { certExpiresAt } from "@/platform/compliance/rules";
import { CalendarDate, DateOnly } from "@/platform/dates/display";
import { revalidatePath } from "next/cache";
import type { OnboardingTaskKey, OnboardingTaskState } from "@/modules/onboarding/engine/status";

// requireModuleAccess("volunteers") is already enforced by the layout.
// We additionally require the same permission here in the server action for defense in depth.

type PageProps = {
  searchParams: Promise<{ error?: string }>;
};

// ---------------------------------------------------------------------------
// Status badge helper
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<ComplianceStatus, string> = {
  COMPLIANT: "Compliant",
  EXPIRING_SOON: "Expiring Soon",
  EXPIRED: "Expired",
  PENDING_VERIFICATION: "Needs verification",
  UNKNOWN_DATE: "Date Unknown",
  NO_CERTIFICATE: "No Certificate",
};

type Tone = "default" | "success" | "warning" | "critical";

const STATUS_TONE: Record<ComplianceStatus, Tone> = {
  COMPLIANT: "success",
  EXPIRING_SOON: "warning",
  EXPIRED: "critical",
  PENDING_VERIFICATION: "warning",
  UNKNOWN_DATE: "default",
  NO_CERTIFICATE: "default",
};

// Clearance task display (EHS column).
function taskState(
  clearance: { tasks: { key: OnboardingTaskKey; state: OnboardingTaskState }[] },
  key: OnboardingTaskKey
): OnboardingTaskState | null {
  return clearance.tasks.find((t) => t.key === key)?.state ?? null;
}

const TASK_STATE_LABEL: Record<OnboardingTaskState, string> = {
  COMPLETE: "Complete",
  IN_PROGRESS: "In progress",
  INCOMPLETE: "Incomplete",
  NOT_REQUIRED: "Not required",
};

const TASK_STATE_TONE: Record<OnboardingTaskState, Tone> = {
  COMPLETE: "success",
  IN_PROGRESS: "warning",
  INCOMPLETE: "critical",
  NOT_REQUIRED: "default",
};

// ---------------------------------------------------------------------------
// Count chips helper
// ---------------------------------------------------------------------------

type CountChipProps = {
  label: string;
  count: number;
  tone: Tone;
};

function CountChip({ label, count, tone }: CountChipProps) {
  return <Badge tone={tone}>{`${count} ${label}`}</Badge>;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function VolunteersPage({ searchParams }: PageProps) {
  // The volunteers layout admits Spanish-review reviewers via the module's
  // additionalAccessPermissions (volunteers.verify_spanish), so the nav tile
  // routes them to /volunteers -- this compliance page. But it requires
  // volunteers.view, which a review-only reviewer does not hold. Send them to
  // their one page instead of bouncing to /no-access, so the module tile leads
  // somewhere. Everyone else still hits the volunteers.view gate below.
  const session = await requirePersonSession();
  if (
    !(await can(session.personId, "volunteers.view")) &&
    (await can(session.personId, "volunteers.verify_spanish"))
  ) {
    redirect("/volunteers/spanish-review");
  }

  const viewer = await requirePermission("volunteers.view");
  const sp = await searchParams;
  const errorMessage = sp.error ? decodeURIComponent(sp.error) : null;

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

      {errorMessage && (
        <Alert tone="error" className="mt-4">
          {errorMessage}
        </Alert>
      )}

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
                    <TH>Status</TH>
                    <TH>Training</TH>
                    <TH>EHS</TH>
                    <TH>Cleared</TH>
                    <TH>Completed</TH>
                    <TH>Expires</TH>
                    <TH>Verified</TH>
                    <TH><span className="sr-only">Actions</span></TH>
                  </TR>
                </THead>
                <tbody>
                  {members.map((m) => {
                    const expiresAt = m.cert?.completionDate
                      ? certExpiresAt(m.cert.completionDate)
                      : null;
                    const ehsState = taskState(m.clearance, "ehs");

                    return (
                      <TR key={m.person.id}>
                        <TD className="font-medium">{m.person.name}</TD>
                        <TD>
                          <Badge tone={m.kind === "DIRECTOR" ? "brand" : "default"}>
                            {m.kind === "DIRECTOR" ? "Director" : "Volunteer"}
                          </Badge>
                        </TD>
                        <TD>
                          <Badge tone={STATUS_TONE[m.status]}>
                            {STATUS_LABEL[m.status]}
                          </Badge>
                        </TD>
                        <TD>
                          {m.kind === "VOLUNTEER" && m.clearance.tasks.some((t) => t.key === "training") ? (
                            <Badge
                              tone={m.trainingState === "COMPLETE" ? "success" : "default"}
                            >
                              {m.trainingState === "COMPLETE" ? "Complete" : "Pending"}
                            </Badge>
                          ) : (
                            // No designated volunteer training this term -> not required,
                            // so show "-" rather than a misleading "Pending".
                            <span className="text-subtle-foreground">-</span>
                          )}
                        </TD>
                        <TD>
                          {ehsState ? (
                            <Badge tone={TASK_STATE_TONE[ehsState]}>{TASK_STATE_LABEL[ehsState]}</Badge>
                          ) : (
                            <span className="text-subtle-foreground">-</span>
                          )}
                        </TD>
                        <TD>
                          <Badge tone={m.clearance.cleared ? "success" : "critical"}>
                            {m.clearance.cleared ? "Cleared" : "Not cleared"}
                          </Badge>
                        </TD>
                        <TD className="text-foreground-soft tabular-nums">
                          <CalendarDate value={m.cert?.completionDate} />
                        </TD>
                        <TD className="text-foreground-soft tabular-nums">
                          <CalendarDate value={expiresAt} />
                        </TD>
                        <TD className="text-foreground-soft text-xs">
                          {m.cert?.verifiedAt ? (
                            <span>
                              {m.verifiedByName} <DateOnly value={m.cert.verifiedAt} />
                            </span>
                          ) : (
                            "-"
                          )}
                        </TD>
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
                    );
                  })}
                </tbody>
              </Table>
            </section>
          );
        })}
      </div>
    </div>
  );
}
