import type { ApplicantType, Prisma } from "@prisma/client";
import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { recordAudit } from "@/platform/audit";
import { AcceptanceError, RecruitmentAuthError } from "./review";
import { InterviewError } from "./interviews";
import { decideWithoutInterview } from "./interview-decisions";
import { rankedDirectorDepartments } from "../engine/interview-mode";
import { isOwnApplication } from "../engine/own-application";
import { reviewerIdentity } from "./own-application";
import {
  attendedInfoSession,
  infoSessionPhase,
  infoSessionStatus,
  type InfoSessionAttendance,
  type InfoSessionPhase,
  type InfoSessionStatus,
} from "../engine/info-session";

/**
 * Who attended the cycle's info sessions, read once for the whole cycle.
 *
 * One query over every INFO_SESSION event's check-ins, matched the two ways
 * attendance-events.ts records an attendee: a linked Person id, or a walk-up's
 * lowercased email. A linked row also contributes its person's contact email,
 * so a walk-up linked later still matches an applicant whose own record has no
 * Person link.
 */
export async function cycleInfoSessions(
  cycleId: string,
  now: Date = new Date(),
): Promise<{ phase: InfoSessionPhase; lastEndsAt: Date | null; attendance: InfoSessionAttendance }> {
  const [events, rows] = await Promise.all([
    prisma.attendanceEvent.findMany({
      where: { cycleId, kind: "INFO_SESSION" },
      select: { startsAt: true, endsAt: true },
    }),
    prisma.eventAttendance.findMany({
      where: { event: { cycleId, kind: "INFO_SESSION" } },
      select: { personId: true, attendeeEmail: true, person: { select: { contactEmail: true, netId: true } } },
    }),
  ]);
  const { phase, lastEndsAt } = infoSessionPhase(events, now);
  const personIds = new Set<string>();
  const emails = new Set<string>();
  const netIds = new Set<string>();
  for (const r of rows) {
    if (r.personId) personIds.add(r.personId);
    if (r.attendeeEmail) {
      const e = r.attendeeEmail.toLowerCase();
      emails.add(e);
      // A walk-up recorded under their NetID-form address carries the NetID.
      const m = /^([a-z0-9]+)@yale\.edu$/.exec(e);
      if (m) netIds.add(m[1]);
    }
    if (r.person?.contactEmail) emails.add(r.person.contactEmail.toLowerCase());
    if (r.person?.netId) netIds.add(r.person.netId.toLowerCase());
  }
  return { phase, lastEndsAt, attendance: { personIds, emails, netIds } };
}

type FlagInput = {
  id: string;
  applicantType: ApplicantType;
  applicant: { applicantPersonId: string | null; emailLower: string; netId?: string | null };
};

/** Every given application's info-session status in two queries, for a roster
 *  page. The map is empty on a cycle with no info sessions. */
export async function infoSessionStatuses(
  cycleId: string,
  apps: FlagInput[],
  now: Date = new Date(),
): Promise<{ phase: InfoSessionPhase; lastEndsAt: Date | null; byApplicationId: Map<string, InfoSessionStatus> }> {
  const { phase, lastEndsAt, attendance } = await cycleInfoSessions(cycleId, now);
  const byApplicationId = new Map<string, InfoSessionStatus>();
  for (const a of apps) {
    const status = infoSessionStatus({ phase, attended: attendedInfoSession(a.applicant, attendance), applicantType: a.applicantType });
    if (status) byApplicationId.set(a.id, status);
  }
  return { phase, lastEndsAt, byApplicationId };
}

/**
 * The cycle's applications the bulk reject looks at. Exported, and accepting an
 * extra filter, so a later per-cycle lockout (or any other narrowing) can be
 * ANDed in without rewriting the send.
 */
export function flaggedRejectScope(cycleId: string, extra?: Prisma.ApplicationWhereInput): Prisma.ApplicationWhereInput {
  return { AND: [{ cycleId, status: { in: ["SUBMITTED", "WITHDRAWN"] } }, ...(extra ? [extra] : [])] };
}

async function loadFlagged(cycleId: string, now: Date, extra?: Prisma.ApplicationWhereInput) {
  const [{ phase, lastEndsAt, attendance }, cycle] = await Promise.all([
    cycleInfoSessions(cycleId, now),
    prisma.recruitmentCycle.findUnique({ where: { id: cycleId }, select: { track: true, status: true, departments: true } }),
  ]);
  if (!cycle || phase !== "ENDED") return { cycle, phase, lastEndsAt, flagged: [] };
  const apps = await prisma.application.findMany({
    where: flaggedRejectScope(cycleId, extra),
    select: {
      id: true,
      status: true,
      applicantType: true,
      departmentChoices: true,
      renewalDepartment: true,
      applicant: { select: { firstName: true, lastName: true, applicantPersonId: true, emailLower: true, netId: true } },
      acceptances: { select: { departmentCode: true } },
      interviews: { select: { departmentCode: true, decision: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  const flagged = apps.filter(
    (a) => infoSessionStatus({ phase, attended: attendedInfoSession(a.applicant, attendance), applicantType: a.applicantType }) === "FLAGGED",
  );
  return { cycle, phase, lastEndsAt, flagged };
}

export type FlaggedSummary = {
  phase: InfoSessionPhase;
  lastEndsAt: Date | null;
  /** Submitted applications flagged for missing every info session. */
  flagged: number;
  /** Of those, how many the bulk reject would act on: no acceptance anywhere,
   *  and at least one ranked department not yet rejected. */
  rejectable: number;
};

export async function flaggedNoInfoSessionSummary(cycleId: string, now: Date = new Date()): Promise<FlaggedSummary> {
  const { cycle, phase, lastEndsAt, flagged } = await loadFlagged(cycleId, now);
  const submitted = flagged.filter((a) => a.status === "SUBMITTED");
  const rejectable = cycle
    ? submitted.filter(
        (a) =>
          a.acceptances.length === 0 &&
          rankedDirectorDepartments(a, cycle.departments).some(
            (d) => a.interviews.find((iv) => iv.departmentCode === d)?.decision !== "REJECT",
          ),
      ).length
    : 0;
  return { phase, lastEndsAt, flagged: submitted.length, rejectable };
}

export type FlaggedRejectResult = {
  /** Applications now rejected by every department they ranked. */
  rejected: number;
  /** Applications left (wholly or partly) as they were, and why. */
  skipped: { applicationId: string; name: string; reason: string }[];
};

/**
 * Reject every flagged applicant without an interview: REJECT, through
 * decideWithoutInterview, for each department they ranked. Going through that
 * path keeps every guard (scope, separation of duties, emailed acceptances) and
 * keeps the outcome confidential until Release; the rejection email is still
 * SRR's separate send.
 *
 * Director cycles only, review_all only, and only once the last info session
 * has ended (before that, a missing check-in just means "not yet").
 *
 * Never overrides a decision someone made: an applicant accepted anywhere is
 * skipped whole, and a department that already waitlisted them or has an
 * interview under way is left alone and reported.
 */
export async function rejectFlaggedNoInfoSession(
  cycleId: string,
  actorId: string,
  opts: { now?: Date; where?: Prisma.ApplicationWhereInput } = {},
): Promise<FlaggedRejectResult> {
  if (!(await can(actorId, "recruitment.review_all"))) {
    throw new RecruitmentAuthError("Only SRR can reject flagged applicants.");
  }
  const { cycle, phase, flagged } = await loadFlagged(cycleId, opts.now ?? new Date(), opts.where);
  if (!cycle) throw new AcceptanceError("Cycle not found.");
  if (cycle.track !== "DIRECTOR") throw new InterviewError("Rejecting flagged applicants without an interview applies to director cycles.");
  if (cycle.status === "DRAFT" || cycle.status === "ARCHIVED") {
    throw new AcceptanceError("Flagged applicants can only be rejected on an open or closed cycle.");
  }
  if (phase === "NONE") throw new AcceptanceError("This cycle has no info sessions, so nobody is flagged.");
  if (phase !== "ENDED") throw new AcceptanceError("Wait until the last info session has ended.");

  // Matched like committee scoring: link, NetID, or a known address.
  const me = await reviewerIdentity(actorId);
  let rejected = 0;
  const skipped: FlaggedRejectResult["skipped"] = [];
  for (const a of flagged) {
    const name = `${a.applicant.firstName} ${a.applicant.lastName}`.trim();
    const skip = (reason: string) => skipped.push({ applicationId: a.id, name, reason });
    if (a.status === "WITHDRAWN") { skip("Withdrew their application."); continue; }
    if (isOwnApplication(a.applicant, me)) { skip("Your own application."); continue; }
    if (a.acceptances.length > 0) { skip(`Accepted by ${a.acceptances.map((x) => x.departmentCode).join(", ")}.`); continue; }

    const notDone: string[] = [];
    for (const dept of rankedDirectorDepartments(a, cycle.departments)) {
      const existing = a.interviews.find((iv) => iv.departmentCode === dept);
      if (existing?.decision === "REJECT") continue;
      if (existing && existing.decision !== "PENDING") {
        notDone.push(`${dept} already decided (${existing.decision.toLowerCase()})`);
        continue;
      }
      try {
        await decideWithoutInterview(a.id, dept, "REJECT", actorId, "No info session attended.");
      } catch (err) {
        if (err instanceof InterviewError || err instanceof RecruitmentAuthError || err instanceof AcceptanceError) {
          notDone.push(`${dept}: ${err.message}`);
          continue;
        }
        throw err;
      }
    }
    if (notDone.length > 0) skip(notDone.join("; "));
    else rejected += 1;
  }

  await recordAudit({
    actorPersonId: actorId,
    action: "recruitment.reject_flagged_no_info_session",
    entityType: "RecruitmentCycle",
    entityId: cycleId,
    after: { rejected, skipped: skipped.length },
  });
  return { rejected, skipped };
}
