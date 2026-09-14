import { nextDirection, parseSort, type Sort, type SortDirection } from "@/platform/lists/sort";
import { APPLICATION_STAGE_ORDER, applicationStage } from "./application-stage";
import { ROSTER_DECISION_ORDER, rosterDecision, type Decision } from "./decision-summary";
import { aiScoreGap } from "./ai-review";
import { scoreAverage } from "./scoring";
import { applicantTypeLabel, type ApplicantType } from "./visibility";

export const APPLICANT_SORT_KEYS = [
  "name",
  "email",
  "type",
  "score",
  "ai",
  "gap",
  "stage",
  "ranked",
  "decision",
] as const;

export type ApplicantSortKey = (typeof APPLICANT_SORT_KEYS)[number];
export type { SortDirection };
export type ApplicantSort = Sort<ApplicantSortKey>;

/** The narrow shape the comparator needs. ReviewApplication satisfies this
 *  structurally, which keeps this module free of Prisma types and testable with
 *  plain object literals. */
export type SortableApplicant = {
  applicant: { firstName: string; lastName: string; email: string };
  applicantType: ApplicantType;
  committeeScores: { score: number }[];
  /** The AI reviewer's band and rank. Present only for a viewer allowed to read
   *  AI reviews (services/ai-review.ts); for anyone else the AI columns sort as
   *  empty, so a hand-edited ?sort=gap reveals nothing. */
  aiReview?: { score: number; rank: number } | null;
  routedDepartmentCode: string | null;
  returnedToRoutingAt?: Date | null;
  decision: Decision;
  interviews: { decision: Decision }[];
  acceptances: { departmentCode: string }[];
  departmentChoices: string[];
};

/** Direction a column opens in on first click. Committee avg opens descending
 *  because the reason to sort it is almost always "who scored highest". */
export const DEFAULT_SORT_DIRECTION: Record<ApplicantSortKey, SortDirection> = {
  name: "asc",
  email: "asc",
  type: "asc",
  score: "desc",
  // Strongest first, and the biggest disagreement first: both are asked to find
  // the top of the list.
  ai: "desc",
  gap: "desc",
  stage: "asc",
  ranked: "asc",
  decision: "asc",
};

/** Reads the roster's sort query params. Returns null for anything unrecognised
 *  so a hand-edited URL falls back to the default order instead of erroring.
 *  The roster's own name for @/platform/lists/sort's parseSort, bound to this
 *  list's key set; kept so every call site and its tests read unchanged. */
export function parseApplicantSort(sort: string | undefined, dir: string | undefined): ApplicantSort | null {
  return parseSort(sort, dir, APPLICANT_SORT_KEYS);
}

/** Two-state toggle: re-clicking the active column flips it, a new column opens
 *  in that column's default direction. */
export function nextSortDirection(current: ApplicantSort | null, key: ApplicantSortKey): SortDirection {
  return nextDirection(current, key, DEFAULT_SORT_DIRECTION);
}

/** Text a column sorts on, for the columns that compare as text. */
function textFor(a: SortableApplicant, key: "name" | "email" | "type" | "ranked"): string {
  switch (key) {
    case "name":
      // Last name first: this is a people roster, so surname ordering is what
      // reviewers expect even though the cell renders "First Last".
      return `${a.applicant.lastName} ${a.applicant.firstName}`;
    case "email":
      return a.applicant.email;
    case "type":
      return applicantTypeLabel(a.applicantType);
    case "ranked":
      return a.departmentChoices.join(", ");
  }
}

/** Position of a row in its column's meaningful order, rather than its label's
 *  alphabetical order. */
function rankFor(a: SortableApplicant, key: "stage" | "decision"): number {
  if (key === "stage") {
    return APPLICATION_STAGE_ORDER.indexOf(
      applicationStage({
        scoreCount: a.committeeScores.length,
        routedDepartmentCode: a.routedDepartmentCode,
        returnedToRoutingAt: a.returnedToRoutingAt,
        applicationDecision: a.decision,
        interviews: a.interviews,
      }),
    );
  }
  return ROSTER_DECISION_ORDER.indexOf(
    rosterDecision({
      acceptances: a.acceptances,
      applicationDecision: a.decision,
      interviews: a.interviews,
    }).status,
  );
}

function averageFor(a: SortableApplicant): number | null {
  return scoreAverage(a.committeeScores.map((c) => c.score)).average;
}

/** One number that orders AI reviews: the band, then the run's rank within it
 *  (rank 1 strongest). Ranks never reach a million, so the band always wins. */
function aiStrengthFor(a: SortableApplicant): number | null {
  return a.aiReview ? a.aiReview.score * 1_000_000 - a.aiReview.rank : null;
}

/** How far the committee and the AI are apart, in either direction. */
function gapSizeFor(a: SortableApplicant): number | null {
  const gap = aiScoreGap(averageFor(a), a.aiReview?.score);
  return gap == null ? null : Math.abs(gap);
}

/** Sorts a copy of the roster. Array.prototype.sort is stable, so ties keep the
 *  order they arrived in, which is submittedAt desc from listApplicantsForReview. */
export function sortApplicants<T extends SortableApplicant>(apps: T[], sort: ApplicantSort): T[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...apps].sort((a, b) => {
    if (sort.key === "score" || sort.key === "ai" || sort.key === "gap") {
      const valueFor = sort.key === "score" ? averageFor : sort.key === "ai" ? aiStrengthFor : gapSizeFor;
      const av = valueFor(a);
      const bv = valueFor(b);
      // Unscored rows sink in both directions, so the column always answers the
      // question the reviewer clicked it to ask.
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return (av - bv) * sign;
    }
    if (sort.key === "stage" || sort.key === "decision") {
      return (rankFor(a, sort.key) - rankFor(b, sort.key)) * sign;
    }
    return textFor(a, sort.key).localeCompare(textFor(b, sort.key)) * sign;
  });
}
