/**
 * A form's questions, as stored in Form.layout and snapshotted onto every
 * FormResponse.
 *
 * One JSON document rather than rows per question, on the model of the
 * onboarding contract (recruitment/contract/layout.ts): a form is edited as a
 * whole, saved as a whole, and frozen as a whole onto each response, and none
 * of that wants a join.
 *
 * Every read goes through parseFormLayout, so a malformed stored layout fails
 * loudly at the boundary instead of rendering half a form.
 */
import { z } from "zod";

export const QUESTION_TYPES = [
  "short_text",
  "long_text",
  "single_choice",
  "multi_choice",
  "rating",
  "section",
] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  short_text: "Short answer",
  long_text: "Paragraph",
  single_choice: "Multiple choice (pick one)",
  multi_choice: "Checkboxes (pick any)",
  rating: "Rating scale",
  section: "Section heading",
};

/** Show this question only when another one's answer matches. */
const conditionSchema = z.object({
  field: z.string().min(1),
  op: z.enum(["is", "isNot", "isAnyOf", "isAnswered"]),
  value: z.union([z.string(), z.array(z.string())]).optional(),
});
export type QuestionCondition = z.infer<typeof conditionSchema>;

const questionSchema = z.object({
  /** Stable key answers are stored under. Never changes once responses exist. */
  key: z.string().regex(/^[a-z0-9_]{1,64}$/),
  type: z.enum(QUESTION_TYPES),
  label: z.string().min(1).max(500),
  help: z.string().max(2000).optional(),
  required: z.boolean().optional(),
  /** single_choice / multi_choice only. */
  options: z.array(z.string().min(1).max(300)).max(50).optional(),
  /** multi_choice: add an "Other" option with a write-in. */
  allowOther: z.boolean().optional(),
  /** rating only. */
  scale: z
    .object({
      max: z.number().int().min(2).max(10),
      lowLabel: z.string().max(60).optional(),
      highLabel: z.string().max(60).optional(),
    })
    .optional(),
  visibleWhen: conditionSchema.optional(),
});
export type Question = z.infer<typeof questionSchema>;

const layoutSchema = z.object({
  questions: z.array(questionSchema).max(200),
});
export type FormLayout = z.infer<typeof layoutSchema>;

export const EMPTY_LAYOUT: FormLayout = { questions: [] };

export class FormLayoutError extends Error {
  problems: string[];
  constructor(problems: string[]) {
    super(`Invalid form: ${problems.join("; ")}`);
    this.name = "FormLayoutError";
    this.problems = problems;
  }
}

/**
 * Parses and cross-checks a layout. Beyond the shape: keys are unique, choice
 * questions have options, and a condition names an EARLIER answerable
 * question (a condition on a later or missing one could never be met while
 * filling top to bottom, and would hide its question forever).
 */
export function parseFormLayout(raw: unknown): FormLayout {
  const parsed = layoutSchema.safeParse(raw);
  if (!parsed.success) {
    throw new FormLayoutError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  }
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const q of parsed.data.questions) {
    if (seen.has(q.key)) problems.push(`Two questions share the key "${q.key}".`);
    if ((q.type === "single_choice" || q.type === "multi_choice") && (q.options?.length ?? 0) === 0) {
      problems.push(`"${q.label}" needs at least one option.`);
    }
    if (q.visibleWhen) {
      const target = parsed.data.questions.find((o) => o.key === q.visibleWhen!.field);
      if (!target || !seen.has(target.key) || target.type === "section") {
        problems.push(`"${q.label}" depends on a question that is not above it.`);
      }
    }
    seen.add(q.key);
  }
  if (problems.length > 0) throw new FormLayoutError(problems);
  return parsed.data;
}

/** A layout that is not trusted to be valid (an old snapshot), read leniently. */
export function readLayoutLenient(raw: unknown): FormLayout {
  const parsed = layoutSchema.safeParse(raw);
  return parsed.success ? parsed.data : EMPTY_LAYOUT;
}

export type Answers = Record<string, string | string[] | undefined>;

function asList(a: string | string[] | undefined): string[] {
  if (a === undefined) return [];
  return (Array.isArray(a) ? a : [a]).filter((v) => v.trim() !== "");
}

/** Same semantics as recruitment's isFieldVisible, so both builders agree. */
export function isQuestionVisible(q: Question, answers: Answers): boolean {
  const cond = q.visibleWhen;
  if (!cond) return true;
  const ans = asList(answers[cond.field]);
  switch (cond.op) {
    case "isAnswered":
      return ans.length > 0;
    case "is":
      return typeof cond.value === "string" && ans.includes(cond.value);
    case "isNot":
      return typeof cond.value === "string" && !ans.includes(cond.value);
    case "isAnyOf":
      return Array.isArray(cond.value) && cond.value.some((v) => ans.includes(v));
  }
}

export const OTHER_PREFIX = "Other: ";

/**
 * Checks submitted answers against the layout and returns the cleaned set:
 * hidden questions dropped (so a stale answer to a question the respondent
 * later hid is not kept), values outside the offered options refused, and
 * required visible questions enforced.
 */
export function validateAnswers(
  layout: FormLayout,
  raw: Answers,
): { answers: Record<string, string | string[]>; problems: string[] } {
  const answers: Record<string, string | string[]> = {};
  const problems: string[] = [];
  for (const q of layout.questions) {
    if (q.type === "section") continue;
    // Against the CLEANED answers only. A condition names an earlier question,
    // so its answer is already settled here, and reading `raw` instead would let
    // a stale answer to a question that is itself hidden reveal its dependents.
    if (!isQuestionVisible(q, answers)) continue;
    const values = asList(raw[q.key]).map((v) => v.trim());

    if (values.length === 0) {
      if (q.required) problems.push(`Answer "${q.label}".`);
      continue;
    }
    switch (q.type) {
      case "short_text":
      case "long_text": {
        const limit = q.type === "short_text" ? 500 : 10_000;
        const v = values[0];
        if (v.length > limit) problems.push(`"${q.label}" is too long (max ${limit} characters).`);
        else answers[q.key] = v;
        break;
      }
      case "single_choice": {
        const v = values[0];
        if (!q.options?.includes(v)) problems.push(`Pick one of the listed options for "${q.label}".`);
        else answers[q.key] = v;
        break;
      }
      case "multi_choice": {
        const ok = values.every(
          (v) => q.options?.includes(v) || (q.allowOther && v.startsWith(OTHER_PREFIX) && v.length > OTHER_PREFIX.length),
        );
        if (!ok) problems.push(`Pick from the listed options for "${q.label}".`);
        else answers[q.key] = [...new Set(values)];
        break;
      }
      case "rating": {
        const n = Number(values[0]);
        const max = q.scale?.max ?? 5;
        if (!Number.isInteger(n) || n < 1 || n > max) problems.push(`Rate "${q.label}" from 1 to ${max}.`);
        else answers[q.key] = String(n);
        break;
      }
    }
  }
  return { answers, problems };
}

/** A question key from a label: lowercase words joined by underscores, unique within `taken`. */
export function keyFromLabel(label: string, taken: Set<string>): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 48) || "question";
  let key = base;
  for (let i = 2; taken.has(key); i++) key = `${base}_${i}`;
  return key;
}
