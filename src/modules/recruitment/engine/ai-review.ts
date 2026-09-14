/**
 * Pure helpers for the AI reviewer's advisory scores (the AiReview model).
 *
 * No Prisma and no I/O, so the roster, the applicant page, the speed-route board
 * and the importer share one reading of what a row means, and each rule tests
 * with plain object literals.
 *
 * An AI score is a rank band, not an absolute 1-5: the run ranks every
 * applicant and hands out 5s and 4s by how many the cycle can accept. A
 * committee average and an AI score are therefore comparable in direction, not
 * decimal for decimal, and the gap helpers below are for finding where the two
 * disagree, never for averaging them.
 */

export const AI_REVIEW_FLAGS = [
  "dept_eligibility",
  "licensed_professional",
  "wrong_org",
  "generic_template",
  "dept_mismatch",
  "no_resume_content",
  "needs_human_read",
  "overcommitted",
] as const;

export type AiReviewFlag = (typeof AI_REVIEW_FLAGS)[number];

/** What each flag means to a reviewer. A Record, so a new flag cannot reach the
 *  screen as its raw snake_case key. */
export const AI_REVIEW_FLAG_LABELS: Record<AiReviewFlag, string> = {
  dept_eligibility: "Not eligible for first choice",
  licensed_professional: "Licensed professional",
  wrong_org: "Letter names another organization",
  generic_template: "Template letter",
  dept_mismatch: "Letter asks for another department",
  no_resume_content: "Empty or name-only uploads",
  needs_human_read: "Needs a human read",
  overcommitted: "Availability in doubt",
};

/** Flags that say the score itself may be unreliable, so a person should read
 *  the application before leaning on it. The rest describe the applicant. */
export const AI_REVIEW_ATTENTION_FLAGS: ReadonlySet<AiReviewFlag> = new Set<AiReviewFlag>([
  "wrong_org",
  "generic_template",
  "dept_mismatch",
  "no_resume_content",
  "needs_human_read",
]);

export function isAiReviewFlag(value: string): value is AiReviewFlag {
  return (AI_REVIEW_FLAGS as readonly string[]).includes(value);
}

export function aiReviewFlagLabel(flag: string): string {
  return isAiReviewFlag(flag) ? AI_REVIEW_FLAG_LABELS[flag] : flag;
}

export type AiDimensionKey = "engagement" | "skills" | "effort" | "reliability";

export const AI_DIMENSIONS: readonly { key: AiDimensionKey; label: string; hint: string }[] = [
  { key: "engagement", label: "Safety-net engagement", hint: "Work with under-resourced or safety-net populations" },
  { key: "skills", label: "Skills", hint: "Skills and experience for the department they fit best" },
  { key: "effort", label: "Application effort", hint: "Substance and specificity of the application" },
  { key: "reliability", label: "Availability", hint: "Dates offered and stated commitment" },
];

/**
 * Where the AI would send this applicant, when that is not where they are
 * headed now.
 *
 * "Now" is the routed department once there is one, and the first choice
 * before that. Comparing against the choice recorded at scoring time would keep
 * suggesting a move the lead has already made, so the suggestion disappears as
 * soon as the application is routed to the best-fit department.
 */
export function aiRerouteSuggestion(input: {
  bestFitDepartmentCode: string | null;
  routedDepartmentCode: string | null;
  departmentChoices: string[];
}): { from: string | null; to: string } | null {
  const to = input.bestFitDepartmentCode;
  if (!to) return null;
  const from = input.routedDepartmentCode ?? input.departmentChoices[0] ?? null;
  return from === to ? null : { from, to };
}

/** Committee average minus AI score. Positive when the committee rates the
 *  applicant higher. Null when either side is missing. */
export function aiScoreGap(committeeAverage: number | null, aiScore: number | null | undefined): number | null {
  if (committeeAverage == null || aiScore == null) return null;
  return committeeAverage - aiScore;
}

/** "+1.5", "-2.0", "0.0". Always signed, so the direction reads at a glance. */
export function formatAiGap(gap: number): string {
  const rounded = Math.round(gap * 10) / 10;
  if (rounded === 0) return "0.0";
  return `${rounded > 0 ? "+" : "-"}${Math.abs(rounded).toFixed(1)}`;
}

/** How far apart the committee and the AI must be, in points, to count as a
 *  disagreement worth a second look. */
export const AI_DISAGREEMENT_THRESHOLD = 2;

export const AI_ROSTER_FILTERS = ["reroute", "disagree", "flagged", "missing"] as const;
export type AiRosterFilter = (typeof AI_ROSTER_FILTERS)[number];

export const AI_ROSTER_FILTER_LABELS: Record<AiRosterFilter, string> = {
  reroute: "Suggests re-routing",
  disagree: `Committee and AI ${AI_DISAGREEMENT_THRESHOLD}+ apart`,
  flagged: "Needs a closer look",
  missing: "No AI review",
};

export function parseAiRosterFilter(value: string | undefined | null): AiRosterFilter | null {
  return value && (AI_ROSTER_FILTERS as readonly string[]).includes(value) ? (value as AiRosterFilter) : null;
}

export type AiRosterRow = {
  aiReview: { score: number; bestFitDepartmentCode: string | null; flags: string[] } | null;
  committeeAverage: number | null;
  routedDepartmentCode: string | null;
  departmentChoices: string[];
};

export function matchesAiRosterFilter(row: AiRosterRow, filter: AiRosterFilter): boolean {
  const review = row.aiReview;
  if (filter === "missing") return review == null;
  if (review == null) return false;
  switch (filter) {
    case "reroute":
      return aiRerouteSuggestion({
        bestFitDepartmentCode: review.bestFitDepartmentCode,
        routedDepartmentCode: row.routedDepartmentCode,
        departmentChoices: row.departmentChoices,
      }) != null;
    case "disagree": {
      const gap = aiScoreGap(row.committeeAverage, review.score);
      return gap != null && Math.abs(gap) >= AI_DISAGREEMENT_THRESHOLD;
    }
    case "flagged":
      return review.flags.some((f) => isAiReviewFlag(f) && AI_REVIEW_ATTENTION_FLAGS.has(f));
  }
}

/** One validated row of an import file, in the model's own field names. */
export type AiReviewImportRow = {
  applicationId: string;
  score: number;
  rank: number;
  merit: number;
  engagement: number;
  skills: number;
  effort: number;
  reliability: number;
  firstChoiceDepartmentCode: string | null;
  firstChoiceFit: number | null;
  bestFitDepartmentCode: string | null;
  justification: string;
  flags: AiReviewFlag[];
  overrideNote: string | null;
};

/**
 * Validate a scoring run's export. Accepts either an array of rows or an object
 * keyed by application id, each row in the run's own vocabulary: appId, score,
 * rank, merit, A/B/C/D, first_choice, first_choice_fit, best_fit_dept, why,
 * flags and an optional override_1. Anything else on a row (e.g. a precomputed
 * reroute) is ignored, since it is derived here from live routing instead.
 *
 * Collects every problem rather than stopping at the first, so one dry run
 * reports the whole file.
 */
export function parseAiReviewImport(raw: unknown): { rows: AiReviewImportRow[]; errors: string[] } {
  const errors: string[] = [];
  const rows: AiReviewImportRow[] = [];
  const entries: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? Object.values(raw as Record<string, unknown>)
      : [];
  if (!Array.isArray(raw) && (raw == null || typeof raw !== "object")) {
    return { rows, errors: ["The file must hold a list of rows or an object keyed by application id."] };
  }
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    const where = `row ${index + 1}`;
    if (entry == null || typeof entry !== "object") {
      errors.push(`${where}: not an object`);
      return;
    }
    const r = entry as Record<string, unknown>;
    const rowErrors: string[] = [];
    const id = typeof r.appId === "string" ? r.appId.trim() : "";
    if (!id) rowErrors.push("appId is missing");
    const label = id ? `${where} (${id})` : where;
    const int = (key: string, min: number, max: number, nullable = false): number | null => {
      const v = r[key];
      if (v == null && nullable) return null;
      if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
        rowErrors.push(`${key} must be a whole number from ${min} to ${max}${nullable ? " or null" : ""}`);
        return null;
      }
      return v;
    };
    const code = (key: string): string | null => {
      const v = r[key];
      if (v == null || v === "") return null;
      if (typeof v !== "string" || !/^[A-Z]{2,8}$/.test(v)) {
        rowErrors.push(`${key} must be a department code`);
        return null;
      }
      return v;
    };
    const score = int("score", 1, 5);
    const rank = int("rank", 1, Number.MAX_SAFE_INTEGER);
    const merit = int("merit", 0, Number.MAX_SAFE_INTEGER);
    const engagement = int("A", 0, 5);
    const skills = int("B", 0, 5);
    const effort = int("C", 0, 5);
    const reliability = int("D", 0, 5);
    const firstChoiceFit = int("first_choice_fit", 0, 5, true);
    const firstChoiceDepartmentCode = code("first_choice");
    const bestFitDepartmentCode = code("best_fit_dept");
    const justification = typeof r.why === "string" ? r.why.trim() : "";
    if (!justification) rowErrors.push("why is missing");
    const flags: AiReviewFlag[] = [];
    if (r.flags != null && !Array.isArray(r.flags)) rowErrors.push("flags must be a list");
    for (const f of Array.isArray(r.flags) ? r.flags : []) {
      if (typeof f === "string" && isAiReviewFlag(f)) {
        if (!flags.includes(f)) flags.push(f);
      } else {
        rowErrors.push(`unknown flag ${JSON.stringify(f)}`);
      }
    }
    const overrideNote = typeof r.override_1 === "string" && r.override_1.trim() ? r.override_1.trim() : null;
    if (id && seen.has(id)) rowErrors.push("appears more than once");
    if (id) seen.add(id);
    if (rowErrors.length > 0) {
      errors.push(`${label}: ${rowErrors.join("; ")}`);
      return;
    }
    rows.push({
      applicationId: id,
      score: score!,
      rank: rank!,
      merit: merit!,
      engagement: engagement!,
      skills: skills!,
      effort: effort!,
      reliability: reliability!,
      firstChoiceDepartmentCode,
      firstChoiceFit,
      bestFitDepartmentCode,
      justification,
      flags,
      overrideNote,
    });
  });
  if (entries.length === 0 && errors.length === 0) errors.push("The file holds no rows.");
  return { rows, errors };
}
