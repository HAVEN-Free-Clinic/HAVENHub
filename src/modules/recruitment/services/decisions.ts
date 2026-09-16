import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { queueEmail } from "@/platform/email/send";
import { recordAudit } from "@/platform/audit";
import { findAcceptanceConflicts } from "../engine/conflicts";
import { joinCodes, joinNames, MAX_APPOINTED_DEPARTMENTS } from "../engine/dual-appointments";
import { rosterDecision } from "../engine/decision-summary";
import { resolveCycleEmail, renderResolvedEmail, type EmailSources } from "../email/render";
import { RecruitmentAuthError, AcceptanceError } from "./review";
import { approvedDualAppointmentPairs } from "./dual-appointments";
import { applicantFirstName } from "@/platform/person-name";

export type Conflict = {
  applicationId: string;
  applicantName: string;
  departments: string[];
  /** Where the application is routed, when it is routed at all. */
  routedDepartmentCode: string | null;
  /** A volunteer application accepted by no more departments than the cap allows
   *  can be settled by approving the extra ones as dual appointments instead of
   *  revoking them. */
  canBecomeDualAppointment: boolean;
};

export async function listConflicts(cycleId: string): Promise<Conflict[]> {
  const [acceptances, approved] = await Promise.all([
    prisma.acceptance.findMany({
      where: { application: { cycleId } },
      include: {
        application: {
          select: {
            routedDepartmentCode: true,
            cycle: { select: { track: true } },
            applicant: { select: { firstName: true, lastName: true, preferredFirstName: true } },
          },
        },
      },
      orderBy: { createdAt: "asc" },
    }),
    approvedDualAppointmentPairs({ cycleId }),
  ]);
  const conflictIds = findAcceptanceConflicts(
    acceptances.map((a) => ({ applicationId: a.applicationId, departmentCode: a.departmentCode })),
    approved,
  );
  const byApp = new Map<string, Conflict>();
  for (const a of acceptances) {
    if (!conflictIds.has(a.applicationId)) continue;
    const existing = byApp.get(a.applicationId);
    if (existing) {
      existing.departments.push(a.departmentCode);
    } else {
      byApp.set(a.applicationId, {
        applicationId: a.applicationId,
        applicantName: `${a.application.applicant.firstName} ${a.application.applicant.lastName}`,
        departments: [a.departmentCode],
        routedDepartmentCode: a.application.routedDepartmentCode,
        canBecomeDualAppointment: a.application.cycle.track === "VOLUNTEER",
      });
    }
  }
  return [...byApp.values()].map((c) => ({
    ...c,
    canBecomeDualAppointment: c.canBecomeDualAppointment && new Set(c.departments).size <= MAX_APPOINTED_DEPARTMENTS,
  }));
}

export async function releaseSummary(cycleId: string): Promise<{
  acceptedApplications: number;
  conflictedApplications: number;
  unnotified: number;
  emailed: number;
  /** Accepted applications that hold an approved dual appointment. */
  dualAppointments: number;
}> {
  // Same WITHDRAWN exclusion releaseDecisions applies to the rows it actually
  // emails. Without it the summary counted acceptances Release will never send:
  // a withdrawn applicant's acceptance sat in "Unnotified" (and in "Conflicts to
  // resolve") permanently, so pressing Release left a non-zero counter that no
  // action could ever clear, and SRR could not tell a real outstanding decision
  // from a phantom (audit 14, REC-3).
  //
  // Application.status is non-nullable, so `not` drops no rows unexpectedly here
  // -- the same reasoning releaseDecisions records at its own filter.
  const [acceptances, approved] = await Promise.all([
    prisma.acceptance.findMany({
      where: { application: { cycleId, status: { not: "WITHDRAWN" } } },
    }),
    approvedDualAppointmentPairs({ cycleId }),
  ]);
  const conflictIds = findAcceptanceConflicts(
    acceptances.map((a) => ({ applicationId: a.applicationId, departmentCode: a.departmentCode })),
    approved,
  );
  const acceptedApplications = new Set(acceptances.map((a) => a.applicationId)).size;
  // Counted by application, like the send: Release emails an applicant once,
  // naming every department, so a dual appointment is one email, not two.
  const unnotified = new Set<string>();
  const emailed = new Set<string>();
  for (const a of acceptances) {
    if (a.emailedAt) { emailed.add(a.applicationId); continue; }
    if (!conflictIds.has(a.applicationId)) unnotified.add(a.applicationId);
  }
  const accepted = new Set(acceptances.map((a) => `${a.applicationId}:${a.departmentCode}`));
  const dualAppointments = new Set(
    approved.filter((d) => accepted.has(`${d.applicationId}:${d.departmentCode}`)).map((d) => d.applicationId),
  ).size;
  return {
    acceptedApplications,
    conflictedApplications: conflictIds.size,
    unnotified: unnotified.size,
    emailed: emailed.size,
    dualAppointments,
  };
}

/**
 * Claim every still-unemailed acceptance in `acceptances` (all on ONE
 * application) and queue one acceptance email naming the departments this send
 * claimed.
 *
 * One email, not one per acceptance: a dual appointment is two acceptances for
 * one person, and two near-identical congratulations a minute apart read like a
 * mistake. Each claim is the same `emailedAt: null` precondition as before, taken
 * inside the transaction, so a concurrent Release or waitlist promote can neither
 * re-send nor re-stamp; a department someone else's send already claimed is left
 * out of this email rather than repeated (audit3 L15).
 */
async function claimAndQueueAcceptanceEmail(input: {
  acceptances: Array<{ id: string; departmentCode: string }>;
  departmentName: (code: string) => string;
  sources: EmailSources;
  to: string;
  firstName: string;
  cycleTitle: string;
}): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const claimed: string[] = [];
    for (const acc of input.acceptances) {
      const res = await tx.acceptance.updateMany({ where: { id: acc.id, emailedAt: null }, data: { emailedAt: new Date() } });
      if (res.count === 1) claimed.push(acc.departmentCode);
    }
    if (claimed.length === 0) return false;
    const email = renderResolvedEmail(input.sources, {
      firstName: input.firstName,
      cycleTitle: input.cycleTitle,
      // Written out in the body, abbreviated in the subject.
      departmentName: joinNames(claimed.map(input.departmentName)),
      departmentCodes: joinCodes(claimed),
    });
    await queueEmail(tx, { to: input.to, subject: email.subject, html: email.html, template: "recruitment.acceptance" });
    return true;
  });
}

/** Render + queue the acceptance email for a single acceptance and atomically
 *  stamp emailedAt, using the SAME emailedAt: null claim as releaseDecisions so
 *  this path and a later Release never double-send. Used by the waitlist
 *  "promote to accept" flow to notify a promoted applicant immediately, without
 *  waiting for a separate release run. Skips (returns "conflicted") if the
 *  application now holds acceptances from more than one department without an
 *  approved dual appointment, mirroring releaseDecisions' conflict skip -- the
 *  conflict must be resolved (and the cycle released) before that applicant is
 *  emailed. An approved dual appointment's still-unemailed acceptance rides along
 *  in the same email. */
export async function sendAcceptanceEmail(
  applicationId: string,
  departmentCode: string,
): Promise<{ sent: boolean; reason?: "already_emailed" | "conflicted" | "not_found" | "withdrawn" | "cycle_archived" }> {
  const acc = await prisma.acceptance.findUnique({
    where: { applicationId_departmentCode: { applicationId, departmentCode } },
    include: { application: { include: { applicant: true, cycle: { select: { id: true, title: true, status: true } } } } },
  });
  if (!acc) return { sent: false, reason: "not_found" };
  // Same DRAFT/ARCHIVED gate releaseDecisions and createOrResendContract enforce.
  // Without it this path -- the waitlist promote, the one acceptance email that
  // does not go through Release -- happily emailed an offer for an archived cycle,
  // and the onboarding link that offer promises is hard-blocked on exactly that
  // status, so the applicant could never be onboarded (audit 14, REC-5).
  if (acc.application.cycle.status === "DRAFT" || acc.application.cycle.status === "ARCHIVED") {
    return { sent: false, reason: "cycle_archived" };
  }
  // Withdrawal never deletes the Acceptance (see services/withdraw.ts), so the
  // row alone does not mean the applicant is still in play. Reading the
  // application's status is the only thing standing between a withdrawn
  // applicant and a live offer email, and the emailedAt stamp that would follow
  // it can then only be cleared through revokeAcceptance.
  if (acc.application.status === "WITHDRAWN") return { sent: false, reason: "withdrawn" };
  if (acc.emailedAt) return { sent: false, reason: "already_emailed" };
  // Conflict = this application accepted by more departments than it may be
  // (the single-application case of findAcceptanceConflicts). Don't notify until
  // the conflict is resolved and the cycle released.
  const [appAcceptances, approved] = await Promise.all([
    prisma.acceptance.findMany({
      where: { applicationId },
      select: { id: true, departmentCode: true, emailedAt: true },
      orderBy: { createdAt: "asc" },
    }),
    approvedDualAppointmentPairs({ applicationIds: [applicationId] }),
  ]);
  const conflicted = findAcceptanceConflicts(
    appAcceptances.map((a) => ({ applicationId, departmentCode: a.departmentCode })),
    approved,
  ).has(applicationId);
  if (conflicted) return { sent: false, reason: "conflicted" };

  const unsent = appAcceptances.filter((a) => a.emailedAt == null);
  const depts = await prisma.department.findMany({
    where: { code: { in: unsent.map((a) => a.departmentCode) } },
    select: { code: true, name: true },
  });
  const deptName = new Map(depts.map((d) => [d.code, d.name]));
  const sources = await resolveCycleEmail(acc.application.cycle.id, "recruitment.acceptance");
  const sent = await claimAndQueueAcceptanceEmail({
    acceptances: unsent,
    departmentName: (code) => deptName.get(code) ?? code,
    sources,
    to: acc.application.applicant.email,
    firstName: applicantFirstName(acc.application.applicant) || "there",
    cycleTitle: acc.application.cycle.title,
  });
  return sent ? { sent: true } : { sent: false, reason: "already_emailed" };
}

/** Email every accepted, non-conflicted, un-emailed applicant once; stamp
 *  emailedAt. Idempotent. Conflicted applications are skipped (counted by
 *  distinct application). `sent` counts emails, which is applicants: an
 *  application with an approved dual appointment gets one email naming both
 *  departments. Requires review_all. */
export async function releaseDecisions(cycleId: string, actorId: string): Promise<{ sent: number; skippedConflicted: number }> {
  if (!(await can(actorId, "recruitment.review_all"))) throw new RecruitmentAuthError("Only SRR can release decisions.");
  const cycle = await prisma.recruitmentCycle.findUnique({ where: { id: cycleId } });
  if (!cycle) throw new AcceptanceError("Cycle not found.");
  if (cycle.status === "DRAFT" || cycle.status === "ARCHIVED") {
    throw new AcceptanceError("Decisions can only be released for an open or closed cycle.");
  }

  // Exclude withdrawn applicants. Their Acceptance row survives the withdrawal
  // by design (services/withdraw.ts never tears one down), so filtering on the
  // Acceptance alone would email a live offer to somebody who already declined,
  // and stamp emailedAt on the way out. Application.status is a non-nullable
  // enum with a default, so `not` cannot silently drop rows here.
  const acceptances = await prisma.acceptance.findMany({
    where: { application: { cycleId, status: { not: "WITHDRAWN" } } },
    include: { application: { include: { applicant: true } } },
    // Oldest first, so the department that accepted them first leads the email.
    orderBy: { createdAt: "asc" },
  });

  // Key the dept-name map off the acceptances actually being emailed, not just
  // cycle.departments (#100): setCycleDepartments allows removing a department that
  // still has applicants (it only warns), so an Acceptance.departmentCode can fall
  // outside cycle.departments -- and then the map missed and the applicant-facing
  // acceptance email interpolated the bare CODE instead of the department name.
  const deptCodes = [...new Set([...cycle.departments, ...acceptances.map((a) => a.departmentCode)])];
  const depts = await prisma.department.findMany({ where: { code: { in: deptCodes } }, select: { code: true, name: true } });
  const deptName = new Map(depts.map((d) => [d.code, d.name]));
  const approved = await approvedDualAppointmentPairs({ cycleId });
  const conflictIds = findAcceptanceConflicts(
    acceptances.map((a) => ({ applicationId: a.applicationId, departmentCode: a.departmentCode })),
    approved,
  );

  // Resolve the acceptance email sources once for the whole cycle.
  const acceptanceSources = await resolveCycleEmail(cycleId, "recruitment.acceptance");

  const skippedApps = new Set<string>();
  const unsentByApplication = new Map<string, typeof acceptances>();
  for (const acc of acceptances) {
    if (acc.emailedAt) continue;
    if (conflictIds.has(acc.applicationId)) { skippedApps.add(acc.applicationId); continue; }
    unsentByApplication.set(acc.applicationId, [...(unsentByApplication.get(acc.applicationId) ?? []), acc]);
  }

  let sent = 0;
  for (const group of unsentByApplication.values()) {
    const applicant = group[0].application.applicant;
    const claimedByThisRelease = await claimAndQueueAcceptanceEmail({
      acceptances: group,
      departmentName: (code) => deptName.get(code) ?? code,
      sources: acceptanceSources,
      to: applicant.email,
      firstName: applicantFirstName(applicant) || "there",
      cycleTitle: cycle.title,
    });
    if (claimedByThisRelease) sent += 1;
  }

  // Mark the cycle's decisions released so the applicant portal may surface
  // final outcomes (accepted via emailedAt, not-selected/waitlist via this stamp).
  await prisma.recruitmentCycle.update({ where: { id: cycleId }, data: { decisionsReleasedAt: new Date() } });

  await recordAudit({ actorPersonId: actorId, action: "recruitment.release", entityType: "RecruitmentCycle", entityId: cycleId, after: { sent, skippedConflicted: skippedApps.size } });
  return { sent, skippedConflicted: skippedApps.size };
}

/* ---------------------------------------------------------------------------
 * Rejections
 *
 * Acceptances and rejections are two separate, separately-triggered sends, not
 * two halves of one Release. Release is the moment the cycle's outcomes become
 * real (it stamps decisionsReleasedAt and the portal starts showing final
 * states); telling the people who were passed over is a distinct act SRR wants
 * to time, word, and check the count on by itself. Folding rejections into
 * Release would mean one irreversible click sends both, with no chance to read
 * the not-selected list first.
 *
 * The cohort starts from rosterDecision(), the same derivation the applicant
 * roster's Decision column uses, so what SRR reads on screen is what this
 * sends. It then narrows that further, because the badge and the send are not
 * the same question. rosterDecision reports REJECTED on `decisions.includes
 * ("REJECT")`: one REJECT is enough, even with another interview still PENDING.
 * That is right for a badge -- it reports the decision that exists -- but wrong
 * as a trigger, since a director-track applicant rejected by one department and
 * still awaiting another has not been turned down by the clinic and must not be
 * told they were. So the send additionally requires every interview to be
 * decided. A rejection is the one email here that cannot be taken back, so
 * where the two readings differ this takes the narrower one and sends nothing
 * until the outcome is settled.
 * ------------------------------------------------------------------------- */

/** One rejection-eligible application, with everything the send needs. */
type RejectionCandidate = {
  id: string;
  firstName: string;
  email: string;
  emailedAt: Date | null;
  /** The volunteer-track decision, re-asserted as a precondition on the claim. */
  decision: "PENDING" | "ACCEPT" | "REJECT" | "WAITLIST";
};

/** Load the cycle's rejected applications: no acceptance anywhere, no waitlist
 *  anywhere, at least one REJECT (all three from rosterDecision), and no
 *  interview still awaiting a decision. DRAFT applications were never submitted
 *  and WITHDRAWN applicants removed themselves, so neither is owed a rejection
 *  -- `status: "SUBMITTED"` excludes both. */
async function loadRejectionCandidates(cycleId: string): Promise<RejectionCandidate[]> {
  const apps = await prisma.application.findMany({
    where: { cycleId, status: "SUBMITTED" },
    select: {
      id: true,
      decision: true,
      rejectionEmailedAt: true,
      applicant: { select: { firstName: true, email: true } },
      acceptances: { select: { departmentCode: true } },
      interviews: { select: { decision: true } },
    },
  });
  return apps
    .filter(
      (a) =>
        rosterDecision({
          acceptances: a.acceptances,
          applicationDecision: a.decision,
          interviews: a.interviews,
        }).status === "REJECTED" &&
        // The narrowing described above. Only Interview.decision is checked:
        // on the director track it is where the real decision lives, and on the
        // volunteer track there are no interviews, so this is vacuously true and
        // Application.decision === "REJECT" alone carries the row. Application
        // .decision is deliberately NOT checked for PENDING -- on a director-track
        // application it is the unused slot and stays PENDING forever, so
        // requiring it to be decided would exclude every director rejection.
        !a.interviews.some((iv) => iv.decision === "PENDING"),
    )
    .map((a) => ({
      id: a.id,
      firstName: a.applicant.firstName,
      email: a.applicant.email,
      emailedAt: a.rejectionEmailedAt,
      decision: a.decision,
    }));
}

export type RejectionSummary = {
  /** Applications the roster shows as Rejected. */
  rejected: number;
  /** Of those, how many have not been emailed yet -- what Send would send. */
  unnotified: number;
  /** Of those, how many already have their rejection. */
  emailed: number;
  /** False until Release has run, which is the gate on sending at all. */
  released: boolean;
};

export async function rejectionSummary(cycleId: string): Promise<RejectionSummary> {
  const [candidates, cycle] = await Promise.all([
    loadRejectionCandidates(cycleId),
    prisma.recruitmentCycle.findUnique({ where: { id: cycleId }, select: { decisionsReleasedAt: true } }),
  ]);
  const emailed = candidates.filter((c) => c.emailedAt !== null).length;
  return {
    rejected: candidates.length,
    unnotified: candidates.length - emailed,
    emailed,
    released: cycle?.decisionsReleasedAt != null,
  };
}

/** Email every rejected, un-emailed applicant in the cycle once and stamp
 *  rejectionEmailedAt. Idempotent: a second run sends nothing. Requires
 *  review_all, the same permission Release requires. */
export async function sendRejections(cycleId: string, actorId: string): Promise<{ sent: number }> {
  if (!(await can(actorId, "recruitment.review_all"))) throw new RecruitmentAuthError("Only SRR can send rejections.");
  const cycle = await prisma.recruitmentCycle.findUnique({ where: { id: cycleId } });
  if (!cycle) throw new AcceptanceError("Cycle not found.");
  // Same status gate Release enforces: a DRAFT cycle has not started and an
  // ARCHIVED one is over, and neither should be mailing applicants.
  if (cycle.status === "DRAFT" || cycle.status === "ARCHIVED") {
    throw new AcceptanceError("Rejections can only be sent for an open or closed cycle.");
  }
  // Rejections come after Release, never before. Two reasons, both about the
  // applicant's experience: a rejection that lands before the acceptances go out
  // tells people the cycle is decided while the ones who got in still know
  // nothing, and the portal only reveals a final outcome once decisionsReleasedAt
  // is set (see portal-status.ts), so an early send would contradict a portal
  // still reading "Under review". Release is one click away, so this is an
  // ordering guard, not a dead end.
  if (cycle.decisionsReleasedAt == null) {
    throw new AcceptanceError("Release decisions before sending rejections, so accepted applicants hear first.");
  }

  const candidates = await loadRejectionCandidates(cycleId);
  // Resolve the sources once for the whole cycle, like releaseDecisions does.
  const sources = await resolveCycleEmail(cycleId, "recruitment.rejection");

  let sent = 0;
  for (const candidate of candidates) {
    if (candidate.emailedAt) continue;
    const email = renderResolvedEmail(sources, {
      firstName: candidate.firstName || "there",
      cycleTitle: cycle.title,
    });
    const claimedByThisRun = await prisma.$transaction(async (tx) => {
      // Re-read the acceptances inside the transaction before claiming. The
      // rosterDecision above ran on a read taken outside it, and the ACCEPT path
      // (interview-decisions.ts) mints the Acceptance row before it writes the
      // decision -- so an accept that commits in that gap is visible here as an
      // acceptance even though the decision we read still said REJECT. Without
      // this check that applicant would be told they were not selected.
      const accepted = await tx.acceptance.count({ where: { applicationId: candidate.id } });
      if (accepted > 0) return false;
      // Atomic claim, mirroring the emailedAt: null claim on Acceptance. Gating
      // on the decision and status we read closes the rest of the gap: a
      // concurrent reopen, waitlist, or withdrawal moves the row and this claim
      // matches nothing, so no email goes out on a decision that no longer holds.
      const claimed = await tx.application.updateMany({
        where: { id: candidate.id, rejectionEmailedAt: null, status: "SUBMITTED", decision: candidate.decision },
        data: { rejectionEmailedAt: new Date() },
      });
      if (claimed.count !== 1) return false;
      await queueEmail(tx, { to: candidate.email, subject: email.subject, html: email.html, template: "recruitment.rejection" });
      return true;
    });
    if (claimedByThisRun) sent += 1;
  }

  await recordAudit({ actorPersonId: actorId, action: "recruitment.send_rejections", entityType: "RecruitmentCycle", entityId: cycleId, after: { sent } });
  return { sent };
}
