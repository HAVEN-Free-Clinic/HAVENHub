import { prisma } from "@/platform/db";
import { deriveStage } from "@/platform/airtable/import/history/stages";
import { Prisma, type HistoricalOutcome, type HistoricalStage, type Track } from "@prisma/client";

/**
 * One row in a person's recruitment timeline, whichever era it came from.
 * Both eras are shaped identically on purpose (see deriveStage's doc comment
 * in stages.ts): a future cycle joins this list automatically, with no second
 * import and no code change here.
 */
export type HistoryEntry = {
  kind: "application" | "interest";
  era: "archive" | "live";
  cycleCode: string;
  cycleLabel: string;
  track: Track;
  departmentCodes: string[];
  resultDepartment: string | null;
  furthestStage: HistoricalStage | null;
  outcome: HistoricalOutcome | null;
  occurredAt: Date | null;
  href: string | null;
};

export type ApplicantHistory = {
  entries: HistoryEntry[];
  applicationCount: number;
  furthest: { stage: HistoricalStage; cycleLabel: string } | null;
};

const STAGE_ORDER: HistoricalStage[] = ["APPLIED", "ADVANCED", "FINAL_ROUND", "ACCEPTED", "ONBOARDED"];

/**
 * The one synthetic cycle identity for every archived interest-form
 * submission. HistoricalInterest carries no cycle/track of its own because
 * there is exactly one such source across the whole import (see
 * HISTORY_SOURCES's "INTEREST" entry in the import's sources.ts).
 */
const INTEREST_CYCLE = { code: "INTEREST", label: "Interest form", track: "VOLUNTEER" as Track };

type LiveApplication = Prisma.ApplicationGetPayload<{
  include: {
    interviews: true;
    acceptances: { include: { contract: true } };
    cycle: { include: { term: true } };
  };
}>;

export async function getApplicantHistory(q: {
  netId?: string | null;
  emails: string[];
  personId?: string | null;
  excludeApplicationId?: string;
}): Promise<ApplicantHistory> {
  const emailLowers = q.emails.map((e) => e.toLowerCase());

  const archiveOr: Prisma.HistoricalApplicantWhereInput[] = [
    { emails: { some: { email: { in: emailLowers } } } },
  ];
  if (q.netId) archiveOr.push({ netId: q.netId });
  if (q.personId) archiveOr.push({ personId: q.personId });

  const liveOr: Prisma.ApplicantWhereInput[] = [{ emailLower: { in: emailLowers } }];
  if (q.netId) liveOr.push({ netId: q.netId });
  if (q.personId) liveOr.push({ applicantPersonId: q.personId });

  const [archiveApplicants, liveApplicants] = await Promise.all([
    prisma.historicalApplicant.findMany({
      where: { OR: archiveOr },
      include: { applications: true, interests: true },
    }),
    prisma.applicant.findMany({
      where: { OR: liveOr },
      include: {
        applications: {
          // Scoped by status, like every other reviewer-facing query in this
          // module (listApplicantsForReview and listWaitlisted both use
          // status: "SUBMITTED"). This one was not, so an UNSUBMITTED draft in
          // any cycle became a history entry: stage "APPLIED", outcome
          // "NO_DECISION", dated off createdAt because submittedAt is null, and
          // counted in applicationCount. A reviewer opening a first-time
          // applicant read "2nd application" about someone who has applied once,
          // and the entry linked into a draft they never submitted (audit 14,
          // REC-3).
          //
          // WITHDRAWN stays: liveOutcome and liveEntry model it deliberately, and
          // a withdrawal IS part of an applicant's history. Only DRAFT is noise.
          where: {
            status: { in: ["SUBMITTED", "WITHDRAWN"] },
            ...(q.excludeApplicationId ? { id: { not: q.excludeApplicationId } } : {}),
          },
          include: {
            interviews: true,
            acceptances: { include: { contract: true } },
            cycle: { include: { term: true } },
          },
        },
      },
    }),
  ]);

  const archiveEntries: HistoryEntry[] = archiveApplicants.flatMap((applicant) => [
    ...applicant.applications.map((app): HistoryEntry => ({
      kind: "application",
      era: "archive",
      cycleCode: app.cycleCode,
      cycleLabel: app.cycleLabel,
      track: app.track,
      departmentCodes: app.departmentChoices,
      resultDepartment: app.resultDepartment,
      furthestStage: app.furthestStage,
      outcome: app.outcome,
      // Most archived rows carry a real submittedAt or decidedAt. A handful
      // of sources recorded neither; fall back to the applicant's own import
      // timestamp so the row still sorts somewhere sane instead of colliding
      // with every other undated row at "null".
      occurredAt: app.submittedAt ?? app.decidedAt ?? applicant.createdAt,
      href: null,
    })),
    ...applicant.interests.map((interest): HistoryEntry => ({
      kind: "interest",
      era: "archive",
      cycleCode: INTEREST_CYCLE.code,
      cycleLabel: INTEREST_CYCLE.label,
      track: INTEREST_CYCLE.track,
      departmentCodes: [],
      resultDepartment: null,
      furthestStage: null,
      outcome: null,
      occurredAt: interest.submittedAt,
      href: null,
    })),
  ]);

  const liveEntries: HistoryEntry[] = liveApplicants.flatMap((applicant) =>
    applicant.applications.map((app) => liveEntry(app))
  );

  const entries = [...archiveEntries, ...liveEntries].sort(byOccurredAtDesc);
  const applicationEntries = entries.filter((e) => e.kind === "application");

  return {
    entries,
    applicationCount: applicationEntries.length,
    furthest: computeFurthest(applicationEntries),
  };
}

function liveEntry(app: LiveApplication): HistoryEntry {
  // A withdrawal keeps its Acceptance row (services/withdraw.ts declares, it
  // never tears down), so acceptances alone would report a declined offer as
  // "Accepted" to the reviewer weighing a returning applicant. ONBOARDED is
  // left as-is: withdrawApplication refuses once a contract is PROMOTED, so a
  // withdrawn row cannot carry one.
  const withdrawn = app.status === "WITHDRAWN";
  const stage = deriveStage({
    advanced: app.interviews.length > 0,
    finalRound: app.interviews.length > 0,
    accepted: !withdrawn && app.acceptances.length > 0,
    onboarded: app.acceptances.some((a) => a.contract?.status === "PROMOTED"),
  });

  return {
    kind: "application",
    era: "live",
    cycleCode: `${app.cycle.track === "DIRECTOR" ? "D" : "V"}-${app.cycle.term.code}`,
    cycleLabel: app.cycle.title,
    track: app.cycle.track,
    departmentCodes: app.departmentChoices,
    resultDepartment: app.acceptances[0]?.departmentCode ?? app.routedDepartmentCode ?? null,
    furthestStage: stage,
    outcome: liveOutcome(app),
    occurredAt: app.submittedAt ?? app.createdAt,
    href: `/recruitment/cycles/${app.cycleId}/applicants/${app.id}`,
  };
}

/**
 * Director-track decisions live on Interview.decision (one per department);
 * volunteer-track (no interview) decisions live on Application.decision. An
 * Acceptance is the more authoritative "this happened" signal and wins over
 * either.
 *
 * The applicant's own withdrawal outranks all of it: it is the last thing that
 * happened to the application, and because the withdrawal deliberately leaves
 * the Acceptance in place, reading the acceptance first would render a declined
 * offer as "Accepted" on the applicant detail page, the history browser, and
 * the admin person profile.
 */
function liveOutcome(app: LiveApplication): HistoricalOutcome {
  if (app.status === "WITHDRAWN") return "WITHDRAWN";
  if (app.acceptances.length > 0) return "ACCEPTED";
  const decisions = app.interviews.length > 0 ? app.interviews.map((i) => i.decision) : [app.decision];
  if (decisions.includes("REJECT")) return "REJECTED";
  if (decisions.includes("WAITLIST")) return "WAITLISTED";
  return "NO_DECISION";
}

function computeFurthest(applicationEntries: HistoryEntry[]): { stage: HistoricalStage; cycleLabel: string } | null {
  if (applicationEntries.length === 0) return null;
  let best = applicationEntries[0];
  for (const entry of applicationEntries) {
    if (STAGE_ORDER.indexOf(entry.furthestStage!) > STAGE_ORDER.indexOf(best.furthestStage!)) best = entry;
  }
  return { stage: best.furthestStage!, cycleLabel: best.cycleLabel };
}

function byOccurredAtDesc(a: HistoryEntry, b: HistoryEntry): number {
  if (a.occurredAt === null && b.occurredAt === null) return 0;
  if (a.occurredAt === null) return 1;
  if (b.occurredAt === null) return -1;
  return b.occurredAt.getTime() - a.occurredAt.getTime();
}
