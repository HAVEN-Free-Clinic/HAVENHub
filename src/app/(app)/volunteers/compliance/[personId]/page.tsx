/**
 * Per-person member profile: who they are, and their full clearance detail.
 *
 * Reached from the master compliance list, from a director's own /volunteers
 * roster, and from every name on the schedule. That last route is why the gate
 * moved: it used to require volunteers.manage_compliance, which meant a director
 * standing in clinic could see that one of their volunteers was not cleared but
 * had no way to find out WHY. It is now scoped -- compliance managers and admins
 * reach everyone, a director reaches the ACTIVE members of the departments they
 * direct or manage by delegation, and nobody else reaches anyone. See
 * platform/member-profile for that rule.
 *
 * The identity half is a deliberate subset of /admin/people: enough to contact
 * someone and know what they can do on a shift, and none of the record-keeping
 * or incident material. The cert actions stay on the manager permission, so a
 * director reads the same page without the ability to set a date or verify.
 */

import type { ReactNode } from "react";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { requirePermission, requirePersonSession } from "@/platform/auth/session";
import { PageHeader } from "@/platform/ui/page-header";
import { SectionHeader } from "@/platform/ui/section-header";
import { Badge } from "@/platform/ui/badge";
import { Card } from "@/platform/ui/card";
import { PersonPhoto } from "@/platform/ui/person-photo";
import { can } from "@/platform/rbac/engine";
import { canViewMemberProfile } from "@/platform/member-profile";
import { getActiveTerm } from "@/platform/terms/active-term";
import { languageLabel } from "@/platform/languages";
import { getOnboardingStatus } from "@/modules/onboarding/services/onboarding";
import { listMyCertificates } from "@/modules/my-info/services/my-info";
import { getMyEhsStatus } from "@/platform/ehs/services/my-ehs";
import { getMyCourses } from "@/modules/learning/services/enrollment";
import { effectiveComplianceStatus, certExpiresAt } from "@/platform/compliance/rules";
import {
  ClearanceCard,
  certRequirement,
  taskRequirement,
} from "@/modules/my-info/components/clearance-card";
import { EhsPanel } from "@/modules/my-info/components/ehs-panel";
import { markEhsComplete, unmarkEhsComplete } from "@/platform/ehs/services/completion";
import { CertificateViewer } from "@/modules/my-info/components/certificate-viewer";
import {
  setCompletionDateAsManager,
  verifyCertificate,
  ComplianceForbiddenError,
  CertificateNotFoundError,
} from "@/modules/volunteers/services/compliance";
import { getMemberProfileBasics } from "@/modules/volunteers/services/member-profile";
import { CompletionDateError } from "@/platform/compliance/completion-date";
import { CalendarDate } from "@/platform/dates/display";

type PageProps = { params: Promise<{ personId: string }> };

/** One label/value row of the identity card. Renders "Not set" rather than nothing,
 *  so a director can tell a missing phone number from a field that does not exist. */
function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0 break-words [overflow-wrap:anywhere]">
      <dt className="text-xs text-subtle-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm text-foreground">
        {value || <span className="text-subtle-foreground">Not set</span>}
      </dd>
    </div>
  );
}

export default async function PersonCompliancePage({ params }: PageProps) {
  const viewer = await requirePersonSession();
  const { personId } = await params;

  // The scoped gate. /no-access rather than notFound(): the person exists, and
  // pretending otherwise would send a director hunting for a typo.
  if (!(await canViewMemberProfile(viewer.personId, personId))) redirect("/no-access");

  const person = await getMemberProfileBasics(personId);
  if (!person) notFound();

  const activeTerm = await getActiveTerm();
  const [onboarding, certificates, ehsItems, courses, isManager, isAdmin] = await Promise.all([
    getOnboardingStatus(personId),
    listMyCertificates(personId),
    getMyEhsStatus(personId),
    getMyCourses(personId),
    can(viewer.personId, "volunteers.manage_compliance"),
    can(viewer.personId, "admin.access"),
  ]);

  // The newest cert drives the DOCUMENT panel below (its date/file/expiry).
  const newestCert = certificates[0] ?? null;
  // The clearance ROW, however, uses the effective status (full history,
  // verified-fallback) so it matches the onboarding.cleared banner, same as
  // /my-info. complianceStatus(newest) made the row read PENDING_VERIFICATION
  // during an early renewal while the clearance beside it read cleared.
  const status = effectiveComplianceStatus(certificates, activeTerm?.endDate ?? null);

  // Drive the checklist from the same source as /my-info: onboarding tasks, with the
  // HIPAA row rendered from the live compliance status.
  // The HIPAA row points at the certificate section further down this page, the
  // one place a coordinator can act on it from here. The remaining rows have no
  // destination for a viewer looking at someone ELSE'S record -- /get-started is
  // the member's own -- so they stay inert rather than link somewhere useless.
  // See Requirement.href.
  const requirements = onboarding.tasks
    .filter((t) => t.state !== "NOT_REQUIRED")
    .map((t) =>
      t.key === "hipaa"
        ? certRequirement(status, "#hipaa-certificate")
        : taskRequirement(t.label, t.state)
    );

  // Both actions require manage_compliance regardless of who opened the page: a
  // server action is a public endpoint in its own right, and this page now
  // admits directors who may read the record but not amend it.
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

  // EHS completion, recordable right here. A coordinator opens this page to answer
  // "why am I not cleared?", and until now the answer ended in a second trip to the
  // /volunteers/ehs grid to find the same person again. Same permission and same
  // writes as that grid; the person is bound from the route, not from the form.
  async function toggleEhsAction(formData: FormData): Promise<void> {
    "use server";
    const actor = await requirePermission("volunteers.manage_compliance");
    const trainingId = String(formData.get("trainingId"));
    if (formData.get("complete") === "1") {
      await markEhsComplete(personId, trainingId, actor.personId);
    } else {
      await unmarkEhsComplete(personId, trainingId, actor.personId);
    }
    revalidatePath(`/volunteers/compliance/${personId}`);
    revalidatePath("/volunteers/ehs");
  }

  const certReq = certRequirement(status);
  const expiresAt = newestCert?.completionDate ? certExpiresAt(newestCert.completionDate) : null;
  // A director has no master view to go back to; send them to the roster they do
  // have. Both are one click either way, and a link to a page that bounces is
  // worse than a slightly less specific one.
  const backHref = isManager ? "/volunteers/master" : "/volunteers";
  const backLabel = isManager ? "Back to master compliance" : "Back to compliance";

  return (
    <div>
      <div className="mb-2">
        <Link href={backHref} className="text-sm text-brand-fg hover:opacity-75">
          {backLabel}
        </Link>
      </div>
      <PageHeader
        title={person.name}
        description={
          [
            person.netId ? `NetID ${person.netId}` : null,
            person.memberships.length > 0
              ? person.memberships
                  .map((m) => `${m.departmentCode}${m.kind === "DIRECTOR" ? " (director)" : ""}`)
                  .join(" · ")
              : "No active membership",
          ]
            .filter(Boolean)
            .join(" · ")
        }
        action={
          person.status === "ACTIVE" ? (
            <Badge tone="success">Active</Badge>
          ) : (
            <Badge tone="default">Offboarded</Badge>
          )
        }
      />

      <div className="mt-8 space-y-10">
        <section>
          <SectionHeader className="mb-4">Member details</SectionHeader>
          <Card>
            <div className="flex flex-wrap items-start gap-6">
              <PersonPhoto person={person} size={72} />
              <dl className="grid min-w-0 flex-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
                <InfoRow
                  label="Email"
                  value={
                    person.contactEmail ? (
                      <a href={`mailto:${person.contactEmail}`} className="text-brand-fg hover:underline">
                        {person.contactEmail}
                      </a>
                    ) : null
                  }
                />
                <InfoRow label="Phone" value={person.phone} />
                <InfoRow label="NetID" value={person.netId} />
                <InfoRow label="Pronouns" value={person.pronouns} />
                <InfoRow label="Yale affiliation" value={person.yaleAffiliation} />
                <InfoRow label="Class year" value={person.gradYear} />
                {person.staffTitle && <InfoRow label="Title" value={person.staffTitle} />}
                <InfoRow
                  label={person.termName ? `Departments (${person.termName})` : "Departments"}
                  value={
                    person.memberships.length > 0
                      ? person.memberships.map((m) => `${m.departmentCode} - ${m.departmentName}`).join(", ")
                      : null
                  }
                />
                <InfoRow
                  label="Clinical flags"
                  value={
                    person.licensedRN || person.verifiedLanguages.length > 0 ? (
                      <span className="flex flex-wrap gap-1.5">
                        {person.licensedRN && <Badge tone="brand">RN</Badge>}
                        {/* VERIFIED languages only. A self-reported claim is an
                            intake signal and must never read here as something a
                            director can staff a shift on. */}
                        {person.verifiedLanguages.map((code) => (
                          <Badge key={code} tone="brand" title={`Verified: ${languageLabel(code)}`}>
                            {languageLabel(code)}
                          </Badge>
                        ))}
                      </span>
                    ) : null
                  }
                />
              </dl>
            </div>
          </Card>
        </section>

        <section>
          <SectionHeader className="mb-4">Clearance</SectionHeader>
          <ClearanceCard
            requirements={requirements}
            cleared={onboarding.cleared}
            termName={activeTerm?.name ?? null}
          />
        </section>

        {/* Anchored: the clearance checklist above links here. scroll-mt clears
            the sticky app-shell bar. */}
        <section id="hipaa-certificate" className="scroll-mt-24">
          <SectionHeader className="mb-4">HIPAA certificate</SectionHeader>
          {newestCert ? (
            <div className="flex flex-wrap items-center gap-4">
              <Badge tone={certReq.tone}>{certReq.statusLabel}</Badge>
              <span className="text-sm text-foreground-soft tabular-nums">
                Completed <CalendarDate value={newestCert.completionDate} /> &middot; Expires <CalendarDate value={expiresAt} />
              </span>
              <CertificateViewer
                certId={newestCert.id}
                fileName={newestCert.fileName}
                ownerName={person.name}
                completionDate={newestCert.completionDate}
                canEditDate={isManager}
                canEditExistingDate={isAdmin}
                onSetDate={setDateAction.bind(null, newestCert.id)}
                canVerify={isManager}
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
          <EhsPanel
            items={ehsItems}
            manage={
              isManager ? { personName: person.name, toggleAction: toggleEhsAction } : undefined
            }
          />
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
