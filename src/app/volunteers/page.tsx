import { requirePermission } from "@/platform/auth/session";
import { can } from "@/platform/rbac/engine";
import { PageHeader } from "@/platform/ui/page-header";
import { Badge } from "@/platform/ui/badge";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { Alert } from "@/platform/ui/alert";
import {
  departmentCompliance,
  verifyCertificate,
  ComplianceForbiddenError,
} from "@/modules/volunteers/services/compliance";
import type { ComplianceStatus } from "@/platform/compliance/rules";
import { certExpiresAt } from "@/platform/compliance/rules";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

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
  UNKNOWN_DATE: "Date Unknown",
  NO_CERTIFICATE: "No Certificate",
};

type Tone = "default" | "success" | "warning" | "critical";

const STATUS_TONE: Record<ComplianceStatus, Tone> = {
  COMPLIANT: "success",
  EXPIRING_SOON: "warning",
  EXPIRED: "critical",
  UNKNOWN_DATE: "default",
  NO_CERTIFICATE: "default",
};

// ---------------------------------------------------------------------------
// Date formatting (UTC)
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
  const viewer = await requirePermission("volunteers.view");
  const sp = await searchParams;
  const errorMessage = sp.error ? decodeURIComponent(sp.error) : null;

  const departments = await departmentCompliance(viewer.personId);

  // Server action: verify a certificate.
  // The service enforces scope (mutation scope matches read scope), so a
  // ComplianceForbiddenError here means the actor crafted an out-of-scope certId.
  async function verifyAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("volunteers.view");
    const certId = formData.get("certId") as string;
    if (!certId) return;
    try {
      await verifyCertificate(actor.personId, certId);
    } catch (err) {
      if (err instanceof ComplianceForbiddenError) {
        redirect(
          `/volunteers?error=${encodeURIComponent(err.message)}`
        );
      }
      throw err;
    }
    revalidatePath("/volunteers");
  }

  // Empty state: viewer has no director memberships
  if (departments.length === 0) {
    // Check if viewer has manage_compliance so we can show a pointer
    const isManager = await can(viewer.personId, "volunteers.manage_compliance");
    return (
      <div>
        <PageHeader
          title="Compliance"
          description="Department HIPAA compliance tracking"
        />
        <div className="mt-12 flex flex-col items-center justify-center gap-3 text-center text-sm text-slate-500">
          <p>You are not listed as a director of any department this term.</p>
          {isManager && (
            <p className="text-slate-400 text-xs">
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
        description="HIPAA compliance status for your departments"
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
          if (counts.UNKNOWN_DATE > 0)
            chips.push({ label: "date unknown", count: counts.UNKNOWN_DATE, tone: "default" });
          if (counts.NO_CERTIFICATE > 0)
            chips.push({ label: "no certificate", count: counts.NO_CERTIFICATE, tone: "default" });

          return (
            <section key={department.id}>
              <div className="mb-3 flex flex-wrap items-baseline gap-3">
                <h2 className="text-base font-semibold">
                  {department.code} · {department.name}
                </h2>
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
                    <TH>Overall</TH>
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
                          {m.kind === "VOLUNTEER" ? (
                            <Badge
                              tone={m.trainingState === "COMPLETE" ? "success" : "default"}
                            >
                              {m.trainingState === "COMPLETE" ? "Complete" : "Pending"}
                            </Badge>
                          ) : (
                            <span className="text-slate-400">-</span>
                          )}
                        </TD>
                        <TD>
                          {m.kind === "VOLUNTEER" ? (
                            <Badge
                              tone={
                                m.overallClearance === "CLEARED" ? "success" : "critical"
                              }
                            >
                              {m.overallClearance === "CLEARED" ? "Cleared" : "Not Cleared"}
                            </Badge>
                          ) : (
                            <span className="text-slate-400">-</span>
                          )}
                        </TD>
                        <TD className="text-slate-600 tabular-nums">
                          {fmtDate(m.cert?.completionDate)}
                        </TD>
                        <TD className="text-slate-600 tabular-nums">
                          {fmtDate(expiresAt)}
                        </TD>
                        <TD className="text-slate-600 text-xs">
                          {m.cert?.verifiedAt ? (
                            <span>
                              {m.verifiedByName} {fmtDate(m.cert.verifiedAt)}
                            </span>
                          ) : (
                            "-"
                          )}
                        </TD>
                        <TD>
                          <div className="flex items-center gap-2">
                            {m.cert && (
                              <a
                                href={`/my-info/certificate/${m.cert.id}`}
                                className="text-xs text-brand underline underline-offset-2 hover:opacity-75"
                                target="_blank"
                                rel="noreferrer"
                              >
                                Download
                              </a>
                            )}
                            {m.cert && (
                              <form action={verifyAction}>
                                <input type="hidden" name="certId" value={m.cert.id} />
                                <ConfirmButton label="Verify" confirmLabel="Confirm?" />
                              </form>
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
