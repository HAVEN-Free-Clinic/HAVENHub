// src/modules/recruitment/services/portal-status.ts
import { prisma } from "@/platform/db";
import type { ApplicantIdentity } from "./portal-auth";

export type ApplicantStatusView = {
  slug: string;
  cycleTitle: string;
  state: "DRAFT" | "SUBMITTED" | "INTERVIEW" | "ACCEPTED" | "ONBOARDING" | "NOT_SELECTED" | "WAITLISTED";
  headline: string;
  detail: string | null;
  canContinue: boolean;
};

/** Per-application status for the portal. Final outcomes are shown only after
 *  release: an accept via Acceptance.emailedAt, a not-selected/waitlist via
 *  the cycle's decisionsReleasedAt. Internal evaluations are never read. */
export async function getApplicantStatus(identity: ApplicantIdentity): Promise<ApplicantStatusView[]> {
  const applicants = await prisma.applicant.findMany({
    where: { OR: [{ emailLower: identity.email }, ...(identity.personId ? [{ applicantPersonId: identity.personId }] : [])] },
    include: {
      cycle: { select: { publicSlug: true, title: true, decisionsReleasedAt: true } },
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

  const views: ApplicantStatusView[] = [];
  for (const a of applicants) {
    const app = a.applications[0];
    if (!app) continue;
    const base = { slug: a.cycle.publicSlug, cycleTitle: a.cycle.title };
    if (app.status === "DRAFT") {
      views.push({ ...base, state: "DRAFT", headline: "Draft", detail: "Continue your application", canContinue: true });
      continue;
    }
    const released = a.cycle.decisionsReleasedAt != null;
    const emailedAcc = app.acceptances.find((acc) => acc.emailedAt != null);
    const onboardingAcc = app.acceptances.find((acc) => acc.contract != null);
    const scheduledInterview = app.interviews.find((iv) => iv.scheduledAt != null);
    const waitlisted = released && app.interviews.some((iv) => iv.decision === "WAITLIST");

    if (onboardingAcc?.contract) {
      const step = onboardingAcc.contract.status === "PROMOTED" ? "Complete" : onboardingAcc.contract.status === "SUBMITTED" ? "Form submitted" : "Form sent to you";
      views.push({ ...base, state: "ONBOARDING", headline: "Onboarding in progress", detail: step, canContinue: false });
    } else if (emailedAcc) {
      views.push({ ...base, state: "ACCEPTED", headline: `Accepted to ${deptName.get(emailedAcc.departmentCode) ?? emailedAcc.departmentCode}`, detail: null, canContinue: false });
    } else if (released && waitlisted) {
      views.push({ ...base, state: "WAITLISTED", headline: "Waitlisted", detail: "We will be in touch if a spot opens.", canContinue: false });
    } else if (released) {
      views.push({ ...base, state: "NOT_SELECTED", headline: "Not selected this cycle", detail: "Thank you for applying.", canContinue: false });
    } else if (scheduledInterview?.scheduledAt) {
      const when = scheduledInterview.scheduledAt.toLocaleString("en-US", { dateStyle: "long", timeStyle: "short" });
      views.push({ ...base, state: "INTERVIEW", headline: "Interview scheduled", detail: scheduledInterview.zoomLink ? `${when} (join link in your email)` : when, canContinue: false });
    } else {
      views.push({ ...base, state: "SUBMITTED", headline: "Submitted", detail: "Under review", canContinue: false });
    }
  }
  return views;
}

export type ApplicantAppRow = { slug: string; cycleTitle: string; status: "DRAFT" | "SUBMITTED" };

export async function listApplicantApplications(identity: ApplicantIdentity): Promise<ApplicantAppRow[]> {
  const applicants = await prisma.applicant.findMany({
    where: { OR: [{ emailLower: identity.email }, ...(identity.personId ? [{ applicantPersonId: identity.personId }] : [])] },
    include: { cycle: { select: { publicSlug: true, title: true } }, applications: { select: { status: true } } },
    orderBy: { createdAt: "desc" },
  });
  const rows: ApplicantAppRow[] = [];
  for (const a of applicants) {
    const app = a.applications[0];
    if (!app) continue;
    rows.push({ slug: a.cycle.publicSlug, cycleTitle: a.cycle.title, status: app.status as "DRAFT" | "SUBMITTED" });
  }
  return rows;
}
