import { redirect } from "next/navigation";
import { prisma } from "@/platform/db";
import { auth } from "@/platform/auth/auth";
import { getRenewalContext, resolveRenewalPrefill, resolveReturningPersonId } from "@/modules/recruitment/services/renewal";
import { getApplicantIdentity } from "@/modules/recruitment/services/portal-auth";
import { returnerClearanceBlock } from "@/modules/recruitment/services/returner-clearance";
import { config } from "@/platform/config";
import { canSubmitToCycle } from "@/modules/recruitment/services/cycle-window";
import { isInvitedTo } from "@/modules/recruitment/services/invites";
import { getDraft } from "@/modules/recruitment/services/drafts";
import { loadHavenHistory } from "@/modules/recruitment/services/haven-history";
import { fieldDerivation } from "@/modules/recruitment/engine/haven-history";
import { resolveAvailabilityOptions } from "@/modules/recruitment/templates/clinic-dates";
import { openClinicDates } from "@/platform/attendings/open-clinic-date";
import { departmentChoiceOptions, resolveSectionTitle } from "@/modules/recruitment/templates/department-options";
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
      term: { select: { clinicDates: true, startDate: true } },
      sections: { where: { purpose: "APPLICATION" }, include: { fields: { orderBy: { order: "asc" } } }, orderBy: { order: "asc" } },
    },
  });

  const now = new Date();

  // Unknown slug (no such cycle): send to the portal entrance rather than imply a
  // real-but-closed form exists. Signed out lands on the sign-in page; signed in
  // lands on the applications dashboard. A real cycle that is merely closed keeps
  // the friendly public notice below.
  if (!cycle) redirect("/apply");

  // The availability question's options come from the term's clinic calendar,
  // not from the stored snapshot, and only from the dates the clinic is actually
  // open on. Everything below reads `sections`, not `cycle.sections`, so the form
  // and its validation see the same list.
  const sections = resolveAvailabilityOptions(
    cycle.sections,
    await openClinicDates({ id: cycle.termId, clinicDates: cycle.term.clinicDates }),
  );

  // Identity is resolved BEFORE the open check, because whether this cycle is
  // open depends on WHO is asking: an invited applicant may apply to a cycle
  // that is closed to everyone else.
  //
  // The sign-in redirect deliberately stays BELOW the closed notice. Resolving
  // identity early must not start demanding a login from a passer-by who opened
  // a closed form's link -- they should still get the friendly "applications are
  // closed" page, exactly as before, without being asked to sign in first.
  const identity = await getApplicantIdentity();
  const invited = identity ? await isInvitedTo(cycle.id, identity.email) : false;

  if (!canSubmitToCycle(cycle, now, { invited })) {
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

  if (!identity) redirect(`/apply?next=${encodeURIComponent(`/apply/${slug}`)}`);
  const draft = await getDraft(slug, identity);
  // Withdrawal is terminal for the applicant: only staff can reopen one. Without
  // this branch a WITHDRAWN row falls through to the wizard, prefilled with the
  // answers they withdrew, and every autosave and the final submit then fail --
  // they retype the whole form only to be told they already applied.
  if (draft?.status === "WITHDRAWN") {
    const support = await getSupportContact();
    return (
      <PortalShell>
        <PortalNotice tone="neutral" title="Application withdrawn">
          <p>You withdrew this application. It is no longer under consideration, and it cannot be reopened from here.</p>
          {support.email && (
            <p><SupportLink email={support.email}>{support.label}</SupportLink></p>
          )}
        </PortalNotice>
      </PortalShell>
    );
  }
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

  // Department picker names: resolved read-time, never stored on FormField.options
  // (the form builder never authors these -- the cycle's department list defines
  // them). A code with no matching row (an alias or a deleted department) keeps
  // the code as its own label via departmentChoiceOptions, so it stays submittable.
  // Reused below by resolveSectionTitle so a supplement section's "<CODE> department
  // questions" title swaps to the real name without a second Department query.
  const departmentRows = cycle.departments.length
    ? await prisma.department.findMany({ where: { code: { in: cycle.departments } }, select: { code: true, name: true } })
    : [];
  const departmentOptions = departmentChoiceOptions(cycle.departments, departmentRows);

  const def = {
    slug: cycle.publicSlug,
    title: cycle.title,
    track: cycle.track,
    acceptsRenewals: cycle.acceptsRenewals,
    departments: cycle.departments,
    subcommittees,
    sections: sections.map((s) => ({
      id: s.id, title: resolveSectionTitle(s, departmentRows), description: s.description, appliesTo: s.appliesTo, departmentCode: s.departmentCode,
      fields: s.fields.map((f) => ({ key: f.key, label: f.label, helpText: f.helpText, type: f.type, required: f.required, options: f.type === "DEPARTMENT_CHOICE" ? departmentOptions : ((f.options as { value: string; label: string }[] | null) ?? null), validation: (f.validation as Record<string, unknown> | null) ?? null, visibleWhen: f.visibleWhen ?? null })),
    })),
  };

  const session = await auth();
  // Two different questions, which used to share one flag.
  //
  // `signedIn` asks whether the portal already holds a verified sign-in, so it
  // decides only one thing: whether to offer the "sign in with Yale" gate. It used
  // to mean `session.personId`, which conflated being signed in with being
  // recognized as an active member -- so everyone else (an alum offboarded at the
  // term flip, a brand-new Yale applicant) who picked "Renewing" was shown a sign-in
  // button they had just used, with no way forward, because renewalGate fires on
  // !signedIn.
  const signedIn = Boolean(session?.personId || session?.applicantEmail);
  // `memberPersonId` asks whose membership history decides the returning branch, and
  // may find a record the session itself refused to carry (auth.ts declines to sign
  // in an OFFBOARDED Person, but offboarding leaves TermMembership untouched). It
  // grants nothing and is SSO-only; see resolveReturningPersonId.
  const memberPersonId = await resolveReturningPersonId(
    session?.personId,
    session?.applicantEmail ? { upn: session.applicantUpn, email: session.applicantEmail } : null,
  );
  // A current member must be fully cleared in this term before applying again,
  // whichever applicant type they would pick. submitApplication enforces the
  // same rule; this only explains it up front instead of at the final click.
  const clearanceBlock = await returnerClearanceBlock(memberPersonId);
  if (clearanceBlock) {
    const support = await getSupportContact();
    return (
      <PortalShell>
        <PortalNotice
          tone="neutral"
          title="Finish your clearance to apply"
          action={<a className="text-sm font-medium text-brand-fg underline underline-offset-4" href={`${config.APP_BASE_URL}/get-started`}>Go to your checklist in HAVEN Hub</a>}
        >
          <p>You are a current member for {clearanceBlock.termName}, and returning members must be fully cleared before they can apply again. Still to do:</p>
          <ul className="mx-auto mt-2 max-w-sm list-disc space-y-1 pl-5 text-left">
            {clearanceBlock.items.map((item) => <li key={item}>{item}</li>)}
          </ul>
          <p className="mt-2">Once these are done, come back to this page to apply.</p>
          {support.email && (
            <p><SupportLink email={support.email}>{support.label}</SupportLink></p>
          )}
        </PortalNotice>
      </PortalShell>
    );
  }
  let signedInName: string | null = null;
  let eligible = false;
  let currentDepartments: string[] = [];
  let prefill: { values: Record<string, string>; lockedKeys: string[] } | undefined;
  let isReturning = false;
  let termNotUp: { department: string; termUpOn: string }[] = [];
  if (memberPersonId) {
    // Resolve the renewal email from the portal identity (Person.contactEmail for a
    // magic-link member, whose session.user.email is always undefined), so the email
    // field prefills/locks correctly and the eligibility the wizard shows matches what
    // submitApplication will accept (#55).
    const ctx = await getRenewalContext(memberPersonId, session?.user?.email ?? identity.email, cycle.track, cycle.term.startDate);
    // Falls back to the matched record's name: an alum recognized through the claim
    // rather than the session may arrive without a display name on the Entra profile,
    // and "Signed in as" renders nothing at all without one.
    signedInName = session?.user?.name ?? ctx.name;
    // Renewal needs a current department offered by this cycle and, on a director
    // cycle, one whose one-year term is up (renewableDepartments). Transfer only
    // needs an active membership in the track (their department may be elsewhere).
    currentDepartments = ctx.renewableDepartments.filter((d) => cycle.departments.includes(d));
    termNotUp = ctx.termNotUp
      .filter((t) => cycle.departments.includes(t.department))
      .map((t) => ({ department: t.department, termUpOn: t.termUpOn.toISOString() }));
    eligible = ctx.eligible && currentDepartments.length > 0;
    isReturning = ctx.eligible;
    const fields = sections.flatMap((s) => s.fields).map((f) => ({ key: f.key, type: f.type }));
    prefill = resolveRenewalPrefill(fields, ctx);
  }
  // Questions answered from the HAVEN record (validation.derive). The wizard
  // derives the answer from this history for whichever applicant type is picked,
  // and submitApplication recomputes it from the same Person at submit. Loaded
  // only when the form has such a question and we know who is applying.
  const hasDerivedQuestion = sections.some((s) => s.fields.some((f) => fieldDerivation(f.validation) !== null));
  const havenHistory = memberPersonId && hasDerivedQuestion ? await loadHavenHistory(memberPersonId) : null;
  const initialApplicantType: ApplicantType = type === "renewal" ? "RENEWAL" : type === "transfer" ? "TRANSFER" : "NEW";

  return (
    <PortalShell width="wide">
      <ApplyWizard def={def} signedIn={signedIn} signedInName={signedInName} eligible={eligible} isReturning={isReturning} prefill={prefill} havenHistory={havenHistory} currentDepartments={currentDepartments} termNotUp={termNotUp} departmentOptions={departmentOptions} initialApplicantType={initialApplicantType} initialAnswers={draft?.answers ?? {}} initialApplicantTypeFromDraft={draft?.applicantType} initialRenewalDepartment={draft?.renewalDepartment ?? null} />
    </PortalShell>
  );
}
