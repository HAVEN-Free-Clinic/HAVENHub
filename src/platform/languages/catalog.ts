/**
 * The language catalog and the pure helpers over it.
 *
 * Split from the service half (./index.ts) because this half is CLIENT-SAFE and
 * that half is not. index.ts imports prisma, notify, and the email renderer, so
 * a client component importing languageLabel from it drags the whole server
 * graph into the browser bundle.
 *
 * That is not a lint error and not a type error: typecheck and vitest both pass,
 * and only `next build` fails, with an error about "after" that names
 * flush-on-enqueue rather than anything to do with languages. It reached the
 * browser through passport-pdf, which is imported by a "use client" card.
 *
 * Anything added here must stay free of server imports. Anything that needs the
 * database belongs in ./index.ts, which re-exports this file so server callers
 * can keep importing everything from "@/platform/languages".
 */

/**
 * Languages the clinic can record. A closed list, not free text: the same
 * language must not appear as "Spanish", "spanish", and "Espanol" across three
 * people, which is exactly what makes a flag unsearchable.
 *
 * Codes are ISO 639-1 where one exists. Add to this list to support another
 * language; existing rows are unaffected.
 */
export const LANGUAGES = [
  { code: "es", label: "Spanish" },
  { code: "zh", label: "Chinese" },
  { code: "ht", label: "Haitian Creole" },
  { code: "pt", label: "Portuguese" },
  { code: "fr", label: "French" },
  { code: "ar", label: "Arabic" },
  { code: "ru", label: "Russian" },
  { code: "vi", label: "Vietnamese" },
  { code: "ko", label: "Korean" },
  { code: "pl", label: "Polish" },
  { code: "it", label: "Italian" },
  { code: "bn", label: "Bengali" },
  { code: "hi", label: "Hindi" },
  { code: "ur", label: "Urdu" },
  { code: "tr", label: "Turkish" },
  { code: "fa", label: "Persian" },
  { code: "sw", label: "Swahili" },
  { code: "am", label: "Amharic" },
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]["code"];

/**
 * Spanish is the one language the interpreting department scores, because it is
 * the one they run a formal 1-5 assessment for. Named rather than spelled "es"
 * inline so the coupling is greppable if a second language ever gets one.
 */
export const SPANISH = "es";

/**
 * The INTP proficiency scale. INTERNAL: this score is not shown to the volunteer
 * it describes, per the interpreting directors' decision. It appears on the
 * language review page and on a member's profile, both of which are gated to
 * staff, and nowhere on /my-info.
 *
 * The scale runs 1 to 5 in half steps. 4 and up is the clinic-wide interpreting
 * bar; anything below it is conversational, which some departments staff and some
 * do not. That call is theirs to make from the number, so nothing here turns the
 * score into a hard gate.
 *
 * This array is the ONLY definition of the scale. Every validator derives from it
 * (see isSpanishScore), so adding a level here is the whole change.
 */
export const SPANISH_PROFICIENCY_LEVELS = [
  { score: 1, label: "Almost none" },
  { score: 1.5, label: "Almost none / Some" },
  { score: 2, label: "Some" },
  { score: 2.5, label: "Some / Conversational" },
  { score: 3, label: "Conversational" },
  { score: 3.5, label: "Conversational / Fluent" },
  { score: 4, label: "Fluent" },
  { score: 4.5, label: "Fluent / Native" },
  { score: 5, label: "Native" },
] as const;

const SPANISH_LABEL_BY_SCORE = new Map<number, string>(
  SPANISH_PROFICIENCY_LEVELS.map((l) => [l.score, l.label]),
);

/**
 * Whether a number is a point on the scale.
 *
 * Derived from SPANISH_PROFICIENCY_LEVELS rather than spelled out as a range
 * test, because a range test is what let the half steps reach the select while
 * every validator still rejected or truncated them. A score that is not on the
 * list the reviewer picked from is not a score.
 */
export function isSpanishScore(value: unknown): value is number {
  return typeof value === "number" && SPANISH_LABEL_BY_SCORE.has(value);
}

/**
 * "Conversational" for 3. Empty string for no score, so it can render inline.
 *
 * Empty for an off-scale score too, and deliberately: the history tab prefills
 * this into the row's notes field, so a guessed label for a 0 ("did not attend",
 * which the importer preserves rather than clamping) would be saved as the
 * assessor's own note the next time anyone touched that row.
 */
export function spanishProficiencyLabel(score: number | null): string {
  if (score === null) return "";
  return SPANISH_LABEL_BY_SCORE.get(score) ?? "";
}

/**
 * The badge text for a score: "3.5" today, or "4-" for an imported row that
 * carried a modifier. "Not scored" reads better than an empty chip when INTP
 * assessed someone but never wrote a number down, which the older rows often did.
 *
 * A half step and a modifier are two spellings of the same thing, so a row never
 * carries both and there is nothing here to reconcile: normalizeScoreAndModifier
 * drops the modifier at the write boundary.
 */
export function formatSpanishScore(score: number | null, modifier: string | null): string {
  if (score === null) return "Not scored";
  const mod = modifier === "plus" ? "+" : modifier === "minus" ? "-" : "";
  return `${score}${mod}`;
}

/**
 * Badge tone for a score. Split at the clinic-wide interpreting bar: 4 and up
 * reads as cleared, the band below it as the conversational middle a department
 * may still staff, anything under that as below it.
 *
 * Every band is a range test. The middle one compared for equality once, which
 * put a 3.5 in the same red as a 1 while a 3 rendered amber, i.e. a strictly
 * better assessment reading as the worse one on the roster.
 */
export function spanishScoreTone(
  score: number | null,
): "default" | "success" | "warning" | "critical" {
  if (score === null) return "default";
  if (score >= CLINIC_WIDE_INTERPRETER_MIN_SCORE) return "success";
  if (score >= CLINIC_WIDE_INTERPRETER_MIN_SCORE - 1) return "warning";
  return "critical";
}

/**
 * The score at which someone can interpret anywhere in the clinic.
 *
 * A department may set its own, lower, bar (Department.minInterpreterScore);
 * PATS and BHVD staff conversational speakers. This is the value used when a
 * department has not set one, and the one the language review cross-check
 * measures a clinic-wide Spanish flag against.
 */
export const CLINIC_WIDE_INTERPRETER_MIN_SCORE = 4;

/**
 * The score at which an assessment produces a verified Spanish badge.
 *
 * Lower than CLINIC_WIDE_INTERPRETER_MIN_SCORE on purpose. A 3 is
 * conversational: the person genuinely speaks Spanish with patients, and
 * whether that is enough to interpret is each department's call through
 * Department.minInterpreterScore. Reading the interpreting bar as the badge
 * floor would hide conversational speakers from the departments documented as
 * staffing them.
 *
 * 1 and 2 are assessments too, and settle the question rather than badging it.
 */
export const SPANISH_SPEAKER_MIN_SCORE = 3;

/**
 * The top of the scale, rendered as a "+" on the roster badge so a director
 * scanning a shift can pick out a native speaker without reading numbers.
 */
export const SPANISH_TOP_SCORE = 5;

/** The bar in force for a department: its own, or the clinic-wide one. */
export function interpreterBarFor(
  department: { minInterpreterScore: number | null } | null | undefined,
): number {
  return department?.minInterpreterScore ?? CLINIC_WIDE_INTERPRETER_MIN_SCORE;
}

/**
 * Whether a score clears a bar.
 *
 * An unscored speaker is NOT below the bar: INTP has verified people for years
 * without always writing a number down, and reading "no score" as failure would
 * paint most of the historical roster as unqualified. Callers that need to tell
 * the two apart check the score for null themselves.
 */
export function meetsInterpreterBar(score: number | null, bar: number): boolean {
  return score === null || score >= bar;
}

/**
 * The application form's language question. Standard across every cycle and
 * guarded at publish, because the answers feed the verification queue and that
 * only works if the question has the same key, type, and options everywhere.
 */
export const LANGUAGES_FIELD_KEY = "languages_spoken";

/**
 * The one definition of that question, imported by everything that writes it:
 * the minimal cycle seed, the application template, and the backfill for cycles
 * built before it existed. Those three each had their own copy at one point and
 * had already drifted on help text, which is the failure this constant prevents.
 *
 * `options` values are language CODES, not labels, so a submitted answer is
 * already the code the verification queue keys on with no label round-trip.
 * Not required: someone who speaks only English answers nothing, and forcing a
 * selection would put noise in the queue.
 */
export const LANGUAGE_QUESTION = {
  key: LANGUAGES_FIELD_KEY,
  label: "Languages you speak fluently, other than English",
  type: "MULTI_SELECT",
  required: false,
  helpText:
    "Select any that apply. The interpreting department will confirm each one with you before you are scheduled as a language provider.",
  options: LANGUAGES.map((l) => ({ value: l.code, label: l.label })),
} as const;

/**
 * The free-text pair the standard question replaced.
 *
 * A typed answer ("some spanish, a little french") cannot be resolved to a
 * language, so these collected data nobody could act on. The backfill removes
 * them rather than leaving them alongside the new question, which would ask an
 * applicant for the same thing twice and still only be able to use one answer.
 */
export const LEGACY_LANGUAGE_FIELD_KEYS = ["other_languages", "other_languages_detail"];

const CODE_BY_LABEL = new Map<string, string>(
  LANGUAGES.map((l) => [l.label.toLowerCase(), l.code]),
);

/**
 * Maps a stored answer back to a language code.
 *
 * Applicants pick LABELS, since "Haitian Creole" is what a person recognizes,
 * but everything downstream keys on the code. Accepts a code directly too, so a
 * re-submitted draft that already stored codes still resolves. Returns null for
 * anything unrecognized rather than inventing a language.
 */
export function languageCodeFromAnswer(answer: string): string | null {
  const v = answer.trim().toLowerCase();
  if (CODE_BY_LABEL.has(v)) return CODE_BY_LABEL.get(v)!;
  return isLanguageCode(v) ? v : null;
}

const LABEL_BY_CODE = new Map<string, string>(LANGUAGES.map((l) => [l.code, l.label]));

export function isLanguageCode(code: string): code is LanguageCode {
  return LABEL_BY_CODE.has(code);
}

/** Human label, falling back to the raw code so a retired code still renders. */
export function languageLabel(code: string): string {
  return LABEL_BY_CODE.get(code) ?? code;
}

export class LanguageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LanguageValidationError";
  }
}

/** True when this claim still needs a human assessment. */
export function needsLanguageReview(row: { verifiedAt: Date | null }): boolean {
  return row.verifiedAt === null;
}
