import { APPLICATION_STAGE_ORDER, applicationStage } from "./application-stage";
import { ROSTER_DECISION_ORDER, rosterDecision, type Decision } from "./decision-summary";
import { scoreAverage } from "./scoring";
import { applicantTypeLabel, type ApplicantType } from "./visibility";

export const APPLICANT_SORT_KEYS = [
  "name",
  "email",
  "type",
  "score",
  "stage",
  "ranked",
  "decision",
] as const;

export type ApplicantSortKey = (typeof APPLICANT_SORT_KEYS)[number];
export type SortDirection = "asc" | "desc";
export type ApplicantSort = { key: ApplicantSortKey; dir: SortDirection };

/** The narrow shape the comparator needs. ReviewApplication satisfies this
 *  structurally, which keeps this module free of Prisma types and testable with
 *  plain object literals. */
export type SortableApplicant = {
  applicant: { firstName: string; lastName: string; email: string };
  applicantType: ApplicantType;
  committeeScores: { score: number }[];
  routedDepartmentCode: string | null;
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
  stage: "asc",
  ranked: "asc",
  decision: "asc",
};

const SORT_KEYS = new Set<string>(APPLICANT_SORT_KEYS);

/** Reads the roster's sort query params. Returns null for anything unrecognised
 *  so a hand-edited URL falls back to the default order instead of erroring. */
export function parseApplicantSort(sort: string | undefined, dir: string | undefined): ApplicantSort | null {
  if (!sort || !SORT_KEYS.has(sort)) return null;
  if (dir !== "asc" && dir !== "desc") return null;
  return { key: sort as ApplicantSortKey, dir };
}

/** Two-state toggle: re-clicking the active column flips it, a new column opens
 *  in that column's default direction. */
export function nextSortDirection(current: ApplicantSort | null, key: ApplicantSortKey): SortDirection {
  if (current?.key === key) return current.dir === "asc" ? "desc" : "asc";
  return DEFAULT_SORT_DIRECTION[key];
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

/** Sorts a copy of the roster. Array.prototype.sort is stable, so ties keep the
 *  order they arrived in, which is submittedAt desc from listApplicantsForReview. */
export function sortApplicants<T extends SortableApplicant>(apps: T[], sort: ApplicantSort): T[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...apps].sort((a, b) => {
    if (sort.key === "score") {
      const av = averageFor(a);
      const bv = averageFor(b);
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
