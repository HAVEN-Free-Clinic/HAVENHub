import type { Acceptance, Application, CycleStatus, Prisma } from "@prisma/client";
import { prisma } from "@/platform/db";
import { invitedEmailsFor } from "./invites";
import { can } from "@/platform/rbac/engine";
import { manageableDepartmentIds } from "@/platform/departments";
import { recordAudit } from "@/platform/audit";

export class RecruitmentAuthError extends Error {
  constructor(message: string) { super(message); this.name = "RecruitmentAuthError"; }
}
export class AcceptanceError extends Error {
  constructor(message: string) { super(message); this.name = "AcceptanceError"; }
}

export type ReviewScope = { all: boolean; departmentCodes: string[] };

/** A reviewer's scope: SRR (review_all) sees everything; a director sees the
 *  departments they direct (active-term DIRECTOR memberships + one-hop delegation,
 *  via manageableDepartmentIds), mapped from ids to codes. */
export async function reviewScope(personId: string): Promise<ReviewScope> {
  const all = await can(personId, "recruitment.review_all");
  const deptIds = await manageableDepartmentIds(personId);
  let departmentCodes: string[] = [];
  if (deptIds.length > 0) {
    const depts = await prisma.department.findMany({ where: { id: { in: deptIds } }, select: { code: true } });
    departmentCodes = depts.map((d) => d.code);
  }
  return { all, departmentCodes };
}

/** The minimal application shape needed to decide viewer access. */
export type ViewableApplication = {
  departmentChoices: string[];
  routedDepartmentCode: string | null;
  cycle: { track: string };
};

/** May this viewer see one application's detail (and its uploaded files)?
 *  This is the single source of truth shared by the applicant detail page and
 *  the file-download route so the two can never drift. It encodes exactly the
 *  same track-aware model as listApplicantsForReview: SRR/review_all, cycle
 *  managers, and committee scorers see every application; a scope-director sees
 *  a VOLUNTEER application only when it was ROUTED to their department, and a
 *  DIRECTOR-track application when it RANKED their department (director-track
 *  cycles have no routing stage). Pass the viewer's already-resolved scope and
 *  permission flags so callers that need them for rendering don't re-query. */
export function canViewApplication(
  app: ViewableApplication,
  ctx: { scope: ReviewScope; managesCycles: boolean; canScore: boolean },
): boolean {
  if (ctx.scope.all || ctx.managesCycles || ctx.canScore) return true;
  const mine = new Set(ctx.scope.departmentCodes);
  if (app.cycle.track === "VOLUNTEER") {
    return app.routedDepartmentCode != null && mine.has(app.routedDepartmentCode);
  }
  return app.departmentChoices.some((d) => mine.has(d));
}

/** `canViewApplication` for a caller that has not already resolved the viewer's
 *  scope and permission flags. Written for a server action that has just changed
 *  the very field access depends on and needs to know where to land the actor:
 *  `returnToRouting` clears `routedDepartmentCode`, which is exactly what grants
 *  a scope-director sight of a VOLUNTEER application, so the actor can succeed at
 *  an action and lose the page they ran it from. Resolves the identical triple
 *  the detail page resolves, so the two can never disagree about who may look. */
export async function canViewerOpenApplication(
  app: ViewableApplication,
  viewerId: string,
): Promise<boolean> {
  const [scope, managesCycles, canScore] = await Promise.all([
    reviewScope(viewerId),
    can(viewerId, "recruitment.manage_cycles"),
    can(viewerId, "recruitment.score"),
  ]);
  return canViewApplication(app, { scope, managesCycles, canScore });
}

export type ReviewApplication = Application & {
  applicant: { firstName: string; lastName: string; email: string; applicantPersonId: string | null };
  /**
   * True when this applicant accepted an invite link for the cycle, i.e. they
   * were recruited selectively rather than applying through the open form. It
   * usually means the application arrived after the deadline, which changes how
   * a reviewer reads it, and is otherwise invisible on this screen.
   */
  invited: boolean;
  acceptances: Acceptance[];
  committeeScores: { score: number; scorerId: string }[];
  interviews: { decision: "PENDING" | "ACCEPT" | "REJECT" | "WAITLIST" }[];
};

/** Applications a viewer may review for a cycle. SRR/review_all (and cycle
 *  managers, and committee scorers) see all; a director sees only applications
 *  intersecting their department codes. */
export async function listApplicantsForReview(cycleId: string, viewerId: string): Promise<ReviewApplication[]> {
  const [scope, managesCycles, canScore] = await Promise.all([
    reviewScope(viewerId),
    can(viewerId, "recruitment.manage_cycles"),
    can(viewerId, "recruitment.score"),
  ]);
  const seeAll = scope.all || managesCycles || canScore;
  // One lookup for the whole cycle, not one per row: the marker is derived from
  // the invite claims rather than stored on Application, so it cannot drift when
  // an invite is withdrawn.
  const [rawApps, invitedEmails] = await Promise.all([
    prisma.application.findMany({
      where: { cycleId, status: "SUBMITTED" },
      include: {
        applicant: { select: { firstName: true, lastName: true, email: true, applicantPersonId: true } },
        acceptances: true,
        committeeScores: { select: { score: true, scorerId: true } },
        interviews: { select: { decision: true } },
      },
      orderBy: [{ submittedAt: "desc" }, { createdAt: "desc" }],
    }),
    invitedEmailsFor(cycleId),
  ]);
  const apps: ReviewApplication[] = rawApps.map((a) => ({
    ...a,
    invited: invitedEmails.has(a.applicant.email.trim().toLowerCase()),
  }));
  if (seeAll) return apps;
  const mine = new Set(scope.departmentCodes);
  const cycle = await prisma.recruitmentCycle.findUnique({ where: { id: cycleId }, select: { track: true } });
  // Volunteer cycles: committee ROUTING drives a director's queue. Director-track
  // cycles have no routing stage, so directors keep the ranked-choice view.
  if (cycle?.track === "VOLUNTEER") {
    return apps.filter((a) => a.routedDepartmentCode != null && mine.has(a.routedDepartmentCode));
  }
  return apps.filter((a) => a.departmentChoices.some((d) => mine.has(d)));
}

/**
 * Submitted applications in a VOLUNTEER cycle that no department can see yet.
 *
 * listApplicantsForReview scopes a department reviewer to applications ROUTED to
 * one of their departments, and a new applicant submits with routedDepartmentCode
 * null unless they renewed or picked an auto-route department first. Every fresh
 * application is therefore invisible to every department reviewer until the
 * committee routes it -- correct, but indistinguishable from "nobody applied"
 * when the list renders empty. QA read exactly that and concluded a cycle had no
 * applicants while one sat unrouted.
 *
 * Returns 0 for a reviewer who already sees everything, since for them an empty
 * list genuinely means no submissions.
 */
export async function awaitingRoutingCount(cycleId: string, viewerId: string): Promise<number> {
  const [scope, managesCycles, canScore, cycle] = await Promise.all([
    reviewScope(viewerId),
    can(viewerId, "recruitment.manage_cycles"),
    can(viewerId, "recruitment.score"),
    prisma.recruitmentCycle.findUnique({ where: { id: cycleId }, select: { track: true } }),
  ]);
  if (scope.all || managesCycles || canScore) return 0;
  if (cycle?.track !== "VOLUNTEER") return 0;
  return prisma.application.count({
    where: { cycleId, status: "SUBMITTED", routedDepartmentCode: null },
  });
}

export type WaitlistEntry = {
  applicationId: string;
  applicantName: string;
  applicantEmail: string;
  /** Volunteer track: the routed department (may be null in a malformed state).
   *  Director track: the waitlisted interview's department. */
  departmentCode: string | null;
  /** Set for a director-track (interview) waitlist; null for a volunteer-track
   *  (Application.decision) waitlist. Tells the promote action which decide
   *  function to call. */
  interviewId: string | null;
};

/** Applications/interviews left on WAITLIST for a cycle, one entry per waitlisted
 *  decision, scoped exactly like listApplicantsForReview. Volunteer-track waitlists
 *  live on Application.decision (departmentCode = routedDepartmentCode, no interview);
 *  director-track waitlists live on Interview.decision (one entry per waitlisted
 *  interview, carrying its department + id). SRR/review_all, cycle managers and
 *  committee scorers see all; a director sees only their departments' entries. */
export async function listWaitlisted(cycleId: string, viewerId: string): Promise<WaitlistEntry[]> {
  const [scope, managesCycles, canScore] = await Promise.all([
    reviewScope(viewerId),
    can(viewerId, "recruitment.manage_cycles"),
    can(viewerId, "recruitment.score"),
  ]);
  const seeAll = scope.all || managesCycles || canScore;
  const apps = await prisma.application.findMany({
    where: {
      cycleId,
      status: "SUBMITTED",
      OR: [{ decision: "WAITLIST" }, { interviews: { some: { decision: "WAITLIST" } } }],
    },
    include: {
      applicant: { select: { firstName: true, lastName: true, email: true } },
      interviews: { where: { decision: "WAITLIST" }, select: { id: true, departmentCode: true } },
    },
    orderBy: [{ submittedAt: "desc" }, { createdAt: "desc" }],
  });
  const entries: WaitlistEntry[] = [];
  for (const a of apps) {
    const base = {
      applicationId: a.id,
      applicantName: `${a.applicant.firstName} ${a.applicant.lastName}`,
      applicantEmail: a.applicant.email,
    };
    // Volunteer track: decided directly on the application (no interview).
    if (a.decision === "WAITLIST") {
      entries.push({ ...base, departmentCode: a.routedDepartmentCode, interviewId: null });
    }
    // Director track: one entry per waitlisted interview (already filtered above).
    for (const iv of a.interviews) {
      entries.push({ ...base, departmentCode: iv.departmentCode, interviewId: iv.id });
    }
  }
  if (seeAll) return entries;
  const mine = new Set(scope.departmentCodes);
  return entries.filter((e) => e.departmentCode != null && mine.has(e.departmentCode));
}

/** OPEN/CLOSED cycles a non-manager reviewer has something to review in,
 *  matching listApplicantsForReview's visibility semantics: SRR/review_all and
 *  cycle managers see every cycle with submitted applications; a committee
 *  scorer sees volunteer cycles with submitted applications; a scope-director
 *  sees volunteer cycles with an application ROUTED to their department, and
 *  director-track cycles with an application that RANKED their department. */
export async function listReviewableCycles(
  personId: string,
): Promise<{ id: string; title: string; track: string; status: string }[]> {
  const [scope, managesCycles, canScore] = await Promise.all([
    reviewScope(personId),
    can(personId, "recruitment.manage_cycles"),
    can(personId, "recruitment.score"),
  ]);
  const activeStatus = { in: ["OPEN", "CLOSED"] as CycleStatus[] };
  if (scope.all || managesCycles) {
    return prisma.recruitmentCycle.findMany({
      where: { status: activeStatus, applications: { some: { status: "SUBMITTED" } } },
      orderBy: [{ status: "asc" }, { title: "asc" }],
      select: { id: true, title: true, track: true, status: true },
    });
  }
  const or: Prisma.RecruitmentCycleWhereInput[] = [];
  if (canScore) or.push({ applications: { some: { status: "SUBMITTED" } } }); // committee scores both tracks
  if (scope.departmentCodes.length) {
    or.push({ track: "VOLUNTEER", applications: { some: { status: "SUBMITTED", routedDepartmentCode: { in: scope.departmentCodes } } } });
    or.push({ track: "DIRECTOR", applications: { some: { status: "SUBMITTED", departmentChoices: { hasSome: scope.departmentCodes } } } });
  }
  if (or.length === 0) return [];
  return prisma.recruitmentCycle.findMany({
    where: { status: activeStatus, OR: or },
    orderBy: [{ status: "asc" }, { title: "asc" }],
    select: { id: true, title: true, track: true, status: true },
  });
}

export async function listAcceptances(applicationId: string): Promise<Acceptance[]> {
  return prisma.acceptance.findMany({ where: { applicationId }, orderBy: { createdAt: "asc" } });
}

export async function revokeAcceptance(acceptanceId: string, actorId: string): Promise<void> {
  const acc = await prisma.acceptance.findUnique({
    where: { id: acceptanceId },
    include: { contract: { select: { id: true, status: true } } },
  });
  if (!acc) throw new AcceptanceError("Acceptance not found.");
  // OnboardingContract.acceptance is onDelete: Cascade, so deleting an acceptance
  // that already has a contract would silently destroy a submitted or promoted
  // onboarding record (signatures, DOB, HIPAA cert) and orphan its stored blob.
  // Tearing down the onboarding contract is the deliberate, separate teardown path
  // (mirrors the guard in interview-decisions.ts), so block the revoke here.
  if (acc.contract) {
    throw new AcceptanceError("This applicant has an onboarding contract. Withdraw it on the Onboarding page first, then revoke the acceptance.");
  }
  const scope = await reviewScope(actorId);
  const inScope = scope.all || scope.departmentCodes.includes(acc.departmentCode);
  if (!inScope) throw new RecruitmentAuthError("You can't revoke that acceptance.");
  if (acc.emailedAt && !scope.all) {
    throw new RecruitmentAuthError("This applicant was already notified; ask SRR to revoke.");
  }
  await prisma.acceptance.delete({ where: { id: acceptanceId } });
  await recordAudit({ actorPersonId: actorId, action: "recruitment.revoke", entityType: "Acceptance", entityId: acceptanceId, before: { applicationId: acc.applicationId, departmentCode: acc.departmentCode } });
}
