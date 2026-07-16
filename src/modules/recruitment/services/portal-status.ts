import { prisma } from "@/platform/db";
import type { ApplicantIdentity } from "./portal-auth";
import { isCycleOpen } from "./cycle-window";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { formatDateTime } from "@/platform/dates";

export type ApplicantStatusView = {
  slug: string;
  cycleTitle: string;
  state: "DRAFT" | "SUBMITTED" | "INTERVIEW" | "ACCEPTED" | "ONBOARDING" | "NOT_SELECTED" | "WAITLISTED";
  headline: string;
  detail: string | null;
  canContinue: boolean;
};

/** Per-application status for the portal. Final outcomes are shown only after
 *  release: an accept via Acceptance.emailedAt, a waitlist via a per-application
 *  WAITLIST interview decision, and a not-selected via the cycle's
 *  decisionsReleasedAt gated on the application having been submitted at/before
 *  that release. Internal evaluations are never read. */
export async function getApplicantStatus(identity: ApplicantIdentity): Promise<ApplicantStatusView[]> {
  const applicants = await prisma.applicant.findMany({
    where: { OR: [{ emailLower: identity.email }, ...(identity.personId ? [{ applicantPersonId: identity.personId }] : [])] },
    include: {
      cycle: { select: { publicSlug: true, title: true, decisionsReleasedAt: true, status: true, opensAt: true, closesAt: true } },
      applications: {
        include: {
          acceptances: { select: { departmentCode: true, emailedAt: true, contract: { select: { status: true } } } },
          interviews: { select: { scheduledAt: true, zoomLink: true, decision: true } },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  // Department code -> name, for the accepted-to headline.
  const codes = new Set<string>();
  for (const a of applicants) for (const app of a.applications) for (const acc of app.acceptances) codes.add(acc.departmentCode);
  const depts = codes.size ? await prisma.department.findMany({ where: { code: { in: [...codes] } }, select: { code: true, name: true } }) : [];
  const deptName = new Map(depts.map((d) => [d.code, d.name]));

  const now = new Date();
  const views: ApplicantStatusView[] = [];
  for (const a of applicants) {
    const app = a.applications[0];
    if (!app) continue;
    const base = { slug: a.cycle.publicSlug, cycleTitle: a.cycle.title };
    if (app.status === "DRAFT") {
      // A draft is only continuable while its cycle is still accepting
      // applications. Once the cycle closes, the destination form rejects the
      // submission, so do not offer a dead "Continue" link here.
      views.push(isCycleOpen(a.cycle, now)
        ? { ...base, state: "DRAFT", headline: "Draft", detail: "Continue your application", canContinue: true }
        : { ...base, state: "DRAFT", headline: "Applications closed", detail: "This cycle is no longer accepting applications.", canContinue: false });
      continue;
    }
    const releasedAt = a.cycle.decisionsReleasedAt;
    const released = releasedAt != null;
    // NOT_SELECTED must hang on a per-application signal, not merely the
    // cycle-level release stamp. Release is allowed on an OPEN cycle, is
    // repeatable/batched, and survives reopen, so an application submitted (or
    // newly created) after a release must not inherit a false definitive
    // rejection. The strongest correct per-application signal available is the
    // submission time: only an application submitted at/before the release was
    // in the pool that release decided on. Residual limitation: there is no
    // per-application decision timestamp on the volunteer not-selected path, so
    // an application submitted before release that reviewers simply never got to
    // still reads NOT_SELECTED, same as an intentional pass (pre-existing).
    const decidedForApp = releasedAt != null && app.submittedAt != null && app.submittedAt <= releasedAt;
    const emailedAcc = app.acceptances.find((acc) => acc.emailedAt != null);
    const onboardingAcc = app.acceptances.find((acc) => acc.contract != null);
    const scheduledInterview = app.interviews.find((iv) => iv.scheduledAt != null);
    const waitlisted = released && (app.interviews.some((iv) => iv.decision === "WAITLIST") || app.decision === "WAITLIST");

    if (onboardingAcc?.contract) {
      const step = onboardingAcc.contract.status === "PROMOTED" ? "Complete" : onboardingAcc.contract.status === "SUBMITTED" ? "Form submitted" : "Form sent to you";
      views.push({ ...base, state: "ONBOARDING", headline: "Onboarding in progress", detail: step, canContinue: false });
    } else if (emailedAcc) {
      views.push({ ...base, state: "ACCEPTED", headline: `Accepted to ${deptName.get(emailedAcc.departmentCode) ?? emailedAcc.departmentCode}`, detail: null, canContinue: false });
    } else if (released && waitlisted) {
      views.push({ ...base, state: "WAITLISTED", headline: "Waitlisted", detail: "We will be in touch if a spot opens.", canContinue: false });
    } else if (decidedForApp && app.acceptances.length === 0) {
      // Guard against the conflict case: if acceptance rows exist but none is emailed (pending resolution),
      // fall through to the neutral state rather than showing a false rejection.
      views.push({ ...base, state: "NOT_SELECTED", headline: "Not selected this cycle", detail: "Thank you for applying.", canContinue: false });
    } else if (scheduledInterview?.scheduledAt) {
      const zone = await getDisplayTimeZone();
      const when = formatDateTime(scheduledInterview.scheduledAt, zone, { dateStyle: "long", timeStyle: "short" });
      views.push({ ...base, state: "INTERVIEW", headline: "Interview scheduled", detail: scheduledInterview.zoomLink ? `${when} (join link in your email)` : when, canContinue: false });
    } else {
      views.push({ ...base, state: "SUBMITTED", headline: "Submitted", detail: "Under review", canContinue: false });
    }
  }
  return views;
}

