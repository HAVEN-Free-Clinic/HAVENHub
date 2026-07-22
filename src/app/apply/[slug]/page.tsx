import { redirect } from "next/navigation";
import { prisma } from "@/platform/db";
import { auth } from "@/platform/auth/auth";
import { getRenewalContext, resolveRenewalPrefill } from "@/modules/recruitment/services/renewal";
import { getApplicantIdentity } from "@/modules/recruitment/services/portal-auth";
import { getDraft } from "@/modules/recruitment/services/drafts";
import { resolveAvailabilityOptions } from "@/modules/recruitment/templates/clinic-dates";
import type { ApplicantType } from "@/modules/recruitment/engine/visibility";
import { getSupportContact } from "@/platform/branding/support";
import { SupportLink } from "@/platform/branding/support-link";
import { PortalShell } from "../portal-shell";
import { PortalNotice } from "../portal-notice";
import { ApplyWizard } from "./apply-wizard";

export default async function ApplyPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ type?: string }> }) {
  const { slug } = await params;
  const { type } = await searchParams;
  const cycle = await prisma.recruitmentCycle.findUnique({
    where: { publicSlug: slug },
    include: {
      term: { select: { clinicDates: true } },
      sections: { where: { purpose: "APPLICATION" }, include: { fields: { orderBy: { order: "asc" } } }, orderBy: { order: "asc" } },
    },
  });

  const now = new Date();
  const open = cycle && cycle.status === "OPEN" && (!cycle.opensAt || cycle.opensAt <= now) && (!cycle.closesAt || cycle.closesAt >= now);

  // Unknown slug (no such cycle): send to the portal entrance rather than imply a
  // real-but-closed form exists. Signed out lands on the sign-in page; signed in
  // lands on the applications dashboard. A real cycle that is merely closed keeps
  // the friendly public notice below.
  if (!cycle) redirect("/apply");

  // The availability question's options come from the term's clinic calendar,
  // not from the stored snapshot. Everything below reads `sections`, not
  // `cycle.sections`, so the form and its validation see the same list.
  const sections = resolveAvailabilityOptions(cycle.sections, cycle.term.clinicDates);

  if (!open) {
    const support = await getSupportContact();
    return (
      <PortalShell>
        <PortalNotice tone="neutral" title="Applications are closed">
          <p>This recruitment form is not currently accepting submissions. It may reopen for the next cycle.</p>
          {support.email && (
            <p><SupportLink email={support.email}>{support.label}</SupportLink></p>
          )}
        </PortalNotice>
      </PortalShell>
    );
  }

  const identity = await getApplicantIdentity();
  if (!identity) redirect(`/apply?next=${encodeURIComponent(`/apply/${slug}`)}`);
  const draft = await getDraft(slug, identity);
  if (draft?.status === "SUBMITTED") {
    return (
      <PortalShell>
        <PortalNotice tone="success" title="Application submitted">
          <p>You have already submitted this application. We will be in touch by email.</p>
        </PortalNotice>
      </PortalShell>
    );
  }

  const subcommittees = await prisma.subcommittee.findMany({
    where: { isActive: true },
    select: { id: true, name: true },
    orderBy: [{ order: "asc" }, { name: "asc" }],
  });

  const def = {
    slug: cycle.publicSlug,
    title: cycle.title,
    track: cycle.track,
    acceptsRenewals: cycle.acceptsRenewals,
    departments: cycle.departments,
    subcommittees,
    sections: sections.map((s) => ({
      id: s.id, title: s.title, description: s.description, appliesTo: s.appliesTo, departmentCode: s.departmentCode,
      fields: s.fields.map((f) => ({ key: f.key, label: f.label, helpText: f.helpText, type: f.type, required: f.required, options: (f.options as { value: string; label: string }[] | null) ?? null, validation: (f.validation as Record<string, unknown> | null) ?? null, visibleWhen: f.visibleWhen ?? null })),
    })),
  };

  const session = await auth();
  let signedIn = false;
  let signedInName: string | null = null;
  let eligible = false;
  let currentDepartments: string[] = [];
  let prefill: { values: Record<string, string>; lockedKeys: string[] } | undefined;
  let isReturning = false;
  if (session?.personId) {
    signedIn = true;
    signedInName = session.user?.name ?? null;
    const ctx = await getRenewalContext(session.personId, session.user?.email ?? null, cycle.track);
    currentDepartments = ctx.currentDepartments.filter((d) => cycle.departments.includes(d));
    // Renewal needs a current department offered by this cycle. Transfer only
    // needs an active membership in the track (their department may be elsewhere).
    eligible = ctx.eligible && currentDepartments.length > 0;
    isReturning = ctx.eligible;
    const fields = sections.flatMap((s) => s.fields).map((f) => ({ key: f.key, type: f.type }));
    prefill = resolveRenewalPrefill(fields, ctx);
  }
  const initialApplicantType: ApplicantType = type === "renewal" ? "RENEWAL" : type === "transfer" ? "TRANSFER" : "NEW";

  return (
    <PortalShell width="wide">
      <ApplyWizard def={def} signedIn={signedIn} signedInName={signedInName} eligible={eligible} isReturning={isReturning} prefill={prefill} currentDepartments={currentDepartments} initialApplicantType={initialApplicantType} initialAnswers={draft?.answers ?? {}} initialApplicantTypeFromDraft={draft?.applicantType} initialRenewalDepartment={draft?.renewalDepartment ?? null} />
    </PortalShell>
  );
}
