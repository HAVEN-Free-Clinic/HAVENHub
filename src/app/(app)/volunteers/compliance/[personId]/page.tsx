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

import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePermission, requirePersonSession } from "@/platform/auth/session";
import { PageHeader } from "@/platform/ui/page-header";
import { SectionHeader } from "@/platform/ui/section-header";
import { DescriptionList, DetailRow } from "@/platform/ui/description-list";
import { Badge } from "@/platform/ui/badge";
import { Card } from "@/platform/ui/card";
import { PersonPhoto } from "@/platform/ui/person-photo";
import { can } from "@/platform/rbac/engine";
import { canViewMemberProfile } from "@/platform/member-profile";
import { getActiveTerm } from "@/platform/terms/active-term";
import {
  SPANISH,
  formatSpanishScore,
  languageLabel,
  spanishProficiencyLabel,
  spanishScoreTone,
} from "@/platform/languages";
import { latestSpanishAssessment } from "@/platform/languages/spanish-assessments";
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
import { EmptyState } from "@/platform/ui/empty-state";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { hubTrail } from "@/platform/ui/breadcrumb-trail";

type PageProps = { params: Promise<{ personId: string }> };

export default async function PersonCompliancePage({ params }: PageProps) {
  const viewer = await requirePersonSession();
  const { personId } = await params;

  // The scoped gate. /no-access rather than notFound(): the person exists, and
  // pretending otherwise would send a director hunting for a typo.
  if (!(await canViewMemberProfile(viewer.personId, personId))) redirect("/no-access");

  const person = await getMemberProfileBasics(personId);
  if (!person) notFound();

  // The most recent INTP Spanish assessment, for the score badge beside a
  // verified Spanish flag. Ordered on termRank inside the service, not on the
  // term label: sorting "Summer 2012" against "Fall 2026" as text put the oldest
  // assessment first, so the badge a director staffs a shift on could be years
  // out of date. Internal to staff; this page is director-gated and the score
  // appears nowhere on /my-info.
  const spanishAssessment = await latestSpanishAssessment(personId);

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
        ? certRequirement(status, "staff", "#hipaa-certificate")
        : taskRequirement(t.label, t.state, "staff")
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

  const certReq = certRequirement(status, "staff");
  const expiresAt = newestCert?.completionDate ? certExpiresAt(newestCert.completionDate) : null;
  // A director has no master view to go back to; send them to the roster they do
  // have. Both are one click either way, and a link to a page that bounces is
  // worse than a slightly less specific one.

  return (
    <div>
      {/* A hand-built trail rather than SetBreadcrumbLeaf: a manager came from
          the master roster and a non-manager from the compliance page, and the
          registry-derived crumb would send both to the latter. */}
      <SetBreadcrumb
        trail={hubTrail(
          { label: "Volunteers", href: "/volunteers" },
          ...(isManager ? [{ label: "Master compliance", href: "/volunteers/master" }] : []),
          { label: person.name },
        )}
      />
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
        status={
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
              <DescriptionList columns={3} className="flex-1">
                <DetailRow label="Email" empty="Not set">
                  {person.contactEmail && (
                    <a href={`mailto:${person.contactEmail}`} className="text-brand-fg hover:underline">
                      {person.contactEmail}
                    </a>
                  )}
                </DetailRow>
                <DetailRow label="Phone" empty="Not set">{person.phone}</DetailRow>
                <DetailRow label="NetID" empty="Not set">{person.netId}</DetailRow>
                <DetailRow label="Pronouns" empty="Not set">{person.pronouns}</DetailRow>
                <DetailRow label="Yale affiliation" empty="Not set">{person.yaleAffiliation}</DetailRow>
                <DetailRow label="Class year" empty="Not set">{person.gradYear}</DetailRow>
                {person.staffTitle && <DetailRow label="Title">{person.staffTitle}</DetailRow>}
                <DetailRow
                  label={person.termName ? `Departments (${person.termName})` : "Departments"}
                  empty="None this term"
                >
                  {person.memberships
                    .map((m) => `${m.departmentCode} - ${m.departmentName}`)
                    .join(", ")}
                </DetailRow>
                <DetailRow label="Clinical flags" empty="None recorded">
                  {(person.licensedRN || person.verifiedLanguages.length > 0) && (
                    <span className="flex flex-wrap gap-1.5">
                      {person.licensedRN && <Badge tone="brand">RN</Badge>}
                      {/* VERIFIED languages only. A self-reported claim is an
                          intake signal and must never read here as something a
                          director can staff a shift on. */}
                      {person.verifiedLanguages.map((code) => (
                        <span key={code} className="inline-flex items-center gap-1">
                          <Badge tone="brand" title={`Verified: ${languageLabel(code)}`}>
                            {languageLabel(code)}
                          </Badge>
                          {code === SPANISH && spanishAssessment?.score != null && (
                            <Badge
                              tone={spanishScoreTone(spanishAssessment.score)}
                              title={`INTP assessment ${formatSpanishScore(spanishAssessment.score, spanishAssessment.modifier)} (${spanishProficiencyLabel(spanishAssessment.score)}), ${spanishAssessment.term}`}
                            >
                              {formatSpanishScore(spanishAssessment.score, spanishAssessment.modifier)}
                            </Badge>
                          )}
                        </span>
                      ))}
                    </span>
                  )}
                </DetailRow>
              </DescriptionList>
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
            <EmptyState inline>No certificate on file.</EmptyState>
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
            <EmptyState inline>No courses assigned.</EmptyState>
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
