/**
 * Questions answered from the applicant's HAVEN record instead of by the
 * applicant.
 *
 * The director form asks "Have you previously volunteered at HAVEN?" and "Have
 * you previously been on the Board?". The Hub already knows both answers for
 * anyone it can identify, so a field can opt in with a marker in its validation
 * JSON:
 *
 *   validation: { derive: "haven_volunteer_history" }   (options yes / no)
 *   validation: { derive: "haven_board_history" }        (options yes_term_extension / yes_new_position / no)
 *
 * The marker, not the field key, is what turns this on, so a renamed or
 * re-keyed question keeps working and an unrelated question that happens to
 * share a key is never overwritten.
 *
 * When the applicant's Person is known the wizard shows the derived answer
 * locked, and the server recomputes it at submit and overwrites whatever the
 * client sent. When no Person is known the question stays an ordinary editable
 * question. A derived value is only ever one of the field's OWN option values:
 * a field whose options do not contain the expected value is left alone.
 *
 * Client-safe: no server imports. The record lookup lives in
 * services/haven-history.ts.
 */

export type HavenHistoryDerive = "haven_volunteer_history" | "haven_board_history";

/** What the Hub record says about a person, across every term on file
 *  (including imported, archived terms) and every membership status. */
export type HavenHistory = { volunteered: boolean; directed: boolean };

export type DerivableField = { key: string; type: string; options?: unknown; validation?: unknown };

/** The short line shown under a question filled in from the record. */
export const DERIVED_ANSWER_HINT = "Filled in from your HAVEN record.";

/** The field's derive marker, or null when it has none (or an unknown one). */
export function fieldDerivation(validation: unknown): HavenHistoryDerive | null {
  if (!validation || typeof validation !== "object") return null;
  const d = (validation as { derive?: unknown }).derive;
  return d === "haven_volunteer_history" || d === "haven_board_history" ? d : null;
}

function optionValues(options: unknown): string[] {
  if (!Array.isArray(options)) return [];
  return options
    .map((o) => (o && typeof o === "object" ? (o as { value?: unknown }).value : undefined))
    .filter((v): v is string => typeof v === "string");
}

/**
 * The answer a derived field takes for this person and applicant type, or null
 * when the field is not derived or its options cannot carry the answer.
 *
 * Board history: a RENEWAL with director history is extending a term; anyone
 * else with director history (a NEW or TRANSFER application) is going for a new
 * position; no director history at all is "no".
 */
export function derivedAnswer(
  field: DerivableField,
  history: HavenHistory,
  applicantType: string,
): string | null {
  if (field.type !== "SINGLE_SELECT") return null;
  const kind = fieldDerivation(field.validation);
  if (!kind) return null;
  let value: string;
  if (kind === "haven_volunteer_history") {
    // Any membership counts: a director has served at HAVEN even with no
    // volunteer-kind row, and "no" would tell reviewers the opposite.
    value = history.volunteered || history.directed ? "yes" : "no";
  } else {
    value = !history.directed ? "no" : applicantType === "RENEWAL" ? "yes_term_extension" : "yes_new_position";
  }
  return optionValues(field.options).includes(value) ? value : null;
}

/** Every derived answer on a form, keyed by field key. */
export function derivedAnswers(
  fields: DerivableField[],
  history: HavenHistory,
  applicantType: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = derivedAnswer(f, history, applicantType);
    if (v !== null) out[f.key] = v;
  }
  return out;
}
