/**
 * NOTICE fields: display-only content blocks inside an application section.
 *
 * A notice asks nothing by default. It reuses the columns every FormField
 * already has rather than earning new ones:
 *
 *   label    -> the heading. Optional, unlike every other field type: the
 *               notices this exists for ("AI assistance is not encouraged for
 *               this application...") are a paragraph with no title, so an
 *               empty string is a legitimate value here and the builder lets
 *               one be cleared.
 *   helpText -> the body, rendered with newlines preserved.
 *
 * Before this existed, staff authored a notice as a whole FormSection whose
 * title WAS the notice text and which held no fields. deriveSteps pushes every
 * visible section, so each of those became its own wizard step: the applicant
 * landed on a page with a shouty heading, no questions, and a Next button.
 *
 * ACKNOWLEDGEMENT. A notice may additionally ask the applicant to confirm they
 * read it, which is the one case where it carries an answer. That lives in the
 * validation blob (`acknowledge` + `acknowledgeLabel`) rather than a new column,
 * and the answer is deliberately CHECKBOX-shaped so `required`, the zod schema,
 * the missing-required-keys sweep and the review row all keep working unchanged.
 *
 * The distinction that matters everywhere downstream is display-only vs
 * acknowledging: a display-only notice must be absent from the answer schema,
 * the review summary, the reviewer's answer grid and the speed-score board,
 * because it has no answer to show and a "(none)" row for a paragraph of policy
 * text is noise. Route both questions through the helpers here so no caller
 * has to re-derive the rule from the raw JSON.
 */

/** Shown when acknowledgement is on but no custom confirmation text is set. */
export const DEFAULT_ACKNOWLEDGE_LABEL = "I have read and understand the above.";

/** Placeholder heading a freshly added notice starts with (see FIELD_TYPE_META). */
export const NOTICE_TYPE_LABEL = "Notice";

/** The shape of the notice-specific keys inside FormField.validation. */
export type NoticeValidation = {
  acknowledge?: boolean;
  acknowledgeLabel?: string;
};

/**
 * The confirmation text for a notice that asks to be acknowledged, or null when
 * it does not. Tolerates the untyped JSON the column actually holds.
 */
export function noticeAcknowledgeLabel(validation: unknown): string | null {
  if (!validation || typeof validation !== "object" || Array.isArray(validation)) return null;
  const v = validation as NoticeValidation;
  if (v.acknowledge !== true) return null;
  const custom = typeof v.acknowledgeLabel === "string" ? v.acknowledgeLabel.trim() : "";
  return custom || DEFAULT_ACKNOWLEDGE_LABEL;
}

/**
 * True for a notice that renders no input at all -- so it contributes no answer
 * key, can never be required, and must be skipped by every answer-shaped view.
 * False for any non-notice field, so this is safe to call over a mixed list.
 */
export function isDisplayOnlyNotice(field: { type: string; validation?: unknown }): boolean {
  return field.type === "NOTICE" && noticeAcknowledgeLabel(field.validation) === null;
}

/**
 * What to call an acknowledging notice in a list of answers (review summary,
 * reviewer grid). Its heading is optional, so fall back to the confirmation
 * text -- which reads perfectly well as the question that "Yes" answers -- and
 * only then to the type name.
 */
export function noticeDisplayLabel(field: { label: string; validation?: unknown }): string {
  return field.label.trim() || noticeAcknowledgeLabel(field.validation) || NOTICE_TYPE_LABEL;
}
