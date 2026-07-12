/**
 * Per-person compliance view: full clearance detail for one member, reachable from
 * the master compliance list. Gated by volunteers.manage_compliance (compliance
 * managers, not only admins). Read model mirrors /my-info, but the cert actions are
 * the manager set-date/verify (not self-service upload).
 */

import { notFound } from "next/navigation";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/platform/auth/session";
import { prisma } from "@/platform/db";
import { PageHeader } from "@/platform/ui/page-header";
import { SectionHeader } from "@/platform/ui/section-header";
import { Badge } from "@/platform/ui/badge";
import { can } from "@/platform/rbac/engine";
import { getActiveTerm } from "@/platform/terms/active-term";
import { getOnboardingStatus } from "@/modules/onboarding/services/onboarding";
import { listMyCertificates } from "@/modules/my-info/services/my-info";
import { getMyEhsStatus } from "@/platform/ehs/services/my-ehs";
import { getMyCourses } from "@/modules/learning/services/enrollment";
import { complianceStatus, certExpiresAt } from "@/platform/compliance/rules";
import {
  ClearanceCard,
  certRequirement,
  taskRequirement,
} from "@/modules/my-info/components/clearance-card";
import { EhsPanel } from "@/modules/my-info/components/ehs-panel";
import { CertificateViewer } from "@/modules/my-info/components/certificate-viewer";
import {
  setCompletionDateAsManager,
  verifyCertificate,
  ComplianceForbiddenError,
  CertificateNotFoundError,
} from "@/modules/volunteers/services/compliance";
import { CompletionDateError } from "@/platform/compliance/completion-date";
import { fmtDate } from "@/platform/dates";

type PageProps = { params: Promise<{ personId: string }> };

export default async function PersonCompliancePage({ params }: PageProps) {
  const viewer = await requirePermission("volunteers.manage_compliance");
  const { personId } = await params;

  const person = await prisma.person.findUnique({
    where: { id: personId },
    select: { id: true, name: true, netId: true },
  });
  if (!person) notFound();

  const activeTerm = await getActiveTerm();
  const [onboarding, certificates, ehsItems, courses] = await Promise.all([
    getOnboardingStatus(personId),
    listMyCertificates(personId),
    getMyEhsStatus(personId),
    getMyCourses(personId),
  ]);

  const newestCert = certificates[0] ?? null;
  const status = complianceStatus(newestCert, activeTerm?.endDate ?? null);

  // Drive the checklist from the same source as /my-info: onboarding tasks, with the
  // HIPAA row rendered from the live compliance status.
  const requirements = onboarding.tasks
    .filter((t) => t.state !== "NOT_REQUIRED")
    .map((t) => (t.key === "hipaa" ? certRequirement(status) : taskRequirement(t.label, t.state)));

  const isAdmin = await can(viewer.personId, "admin.access");

  async function setDateAction(certId: string, dateIso: string): Promise<{ error?: string }> {
    "use server";
    const actor = await requirePermission("volunteers.manage_compliance");
    try {
      await setCompletionDateAsManager(actor.personId, certId, dateIso);
    } catch (err) {
      if (err instanceof CompletionDateError) return { error: err.reason };
      if (err instanceof ComplianceForbiddenError) return { error: err.message };
      if (err instanceof CertificateNotFoundError) return { error: "Certificate not found." };
      throw err;
    }
    revalidatePath(`/volunteers/compliance/${personId}`);
    return {};
  }

  async function verifyAction(certId: string): Promise<{ error?: string }> {
    "use server";
    const actor = await requirePermission("volunteers.manage_compliance");
    try {
      await verifyCertificate(actor.personId, certId);
    } catch (err) {
      if (err instanceof ComplianceForbiddenError) return { error: err.message };
      if (err instanceof CertificateNotFoundError) return { error: "Certificate not found." };
      throw err;
    }
    revalidatePath(`/volunteers/compliance/${personId}`);
    return {};
  }

  const certReq = certRequirement(status);
  const expiresAt = newestCert?.completionDate ? certExpiresAt(newestCert.completionDate) : null;

  return (
    <div>
      <div className="mb-2">
        <Link href="/volunteers/master" className="text-sm text-brand-fg hover:opacity-75">
          Back to master compliance
        </Link>
      </div>
      <PageHeader
        title={person.name}
        description={person.netId ? `NetID ${person.netId}` : "Compliance and clearance detail"}
      />

      <div className="mt-8 space-y-10">
        <section>
          <SectionHeader className="mb-4">Clearance</SectionHeader>
          <ClearanceCard
            requirements={requirements}
            cleared={onboarding.cleared}
            termName={activeTerm?.name ?? null}
          />
        </section>

        <section>
          <SectionHeader className="mb-4">HIPAA certificate</SectionHeader>
          {newestCert ? (
            <div className="flex flex-wrap items-center gap-4">
              <Badge tone={certReq.tone}>{certReq.statusLabel}</Badge>
              <span className="text-sm text-foreground-soft tabular-nums">
                Completed {fmtDate(newestCert.completionDate)} &middot; Expires {fmtDate(expiresAt)}
              </span>
              <CertificateViewer
                certId={newestCert.id}
                fileName={newestCert.fileName}
                ownerName={person.name}
                completionDate={newestCert.completionDate}
                canEditDate
                canEditExistingDate={isAdmin}
                onSetDate={setDateAction.bind(null, newestCert.id)}
                canVerify
                verified={Boolean(newestCert.verifiedAt)}
                onVerify={verifyAction.bind(null, newestCert.id)}
              />
            </div>
          ) : (
            <p className="text-sm text-foreground-soft">No certificate on file.</p>
          )}
        </section>

        <section>
          <SectionHeader className="mb-4">EHS training</SectionHeader>
          <EhsPanel items={ehsItems} />
        </section>

        <section>
          <SectionHeader className="mb-4">Learning</SectionHeader>
          {courses.length === 0 ? (
            <p className="text-sm text-foreground-soft">No courses assigned.</p>
          ) : (
            <ul className="divide-y divide-border-subtle rounded-lg border border-border">
              {courses.map((c) => (
                <li key={c.id} className="flex items-center justify-between px-4 py-3">
                  <span className="text-sm font-medium text-foreground">{c.title}</span>
                  <Badge
                    tone={
                      c.status === "COMPLETE" ? "success" : c.status === "IN_PROGRESS" ? "warning" : "default"
                    }
                  >
                    {c.status === "COMPLETE"
                      ? "Complete"
                      : c.status === "IN_PROGRESS"
                        ? "In progress"
                        : "Not started"}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
