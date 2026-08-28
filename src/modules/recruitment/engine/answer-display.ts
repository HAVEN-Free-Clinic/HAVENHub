/**
 * How a STORED application answer reads to a human.
 *
 * Answers are persisted as machine values, not as the words the applicant saw:
 * a select stores its option's `value` ("yale_college", "option_3"), a checkbox
 * stores a boolean, the language question stores ISO codes ("zh"), and the
 * availability question stores date keys ("2026-10-17"). Every one of those is
 * meaningless to a reviewer reading the application back.
 *
 * The applicant-facing side of this already existed -- the wizard's review step
 * resolves the same values through formatFieldValue (app/apply/[slug]/
 * wizard-review.tsx), which works off the FormData shapes rather than the stored
 * ones -- and so did a private copy inside the speed-score service. The
 * reviewer's own detail page had neither and rendered String(value), which is
 * what put "yale_college", "zh", "true" and "option_3" in front of reviewers.
 * Both reviewer surfaces resolve through here now, so a reviewer reads back
 * exactly what the applicant confirmed.
 *
 * Kept client-safe (Prisma is a type-only import, and both platform imports are
 * the client-safe halves of their modules) so a client review surface can use it
 * without dragging the server graph into the browser bundle.
 */
import type { FieldType } from "@prisma/client";
import { formatCalendarDate } from "@/platform/dates/format";
import { LANGUAGES_FIELD_KEY, languageLabel } from "@/platform/languages/catalog";
import type { Choice } from "./options";

/** The field metadata display needs: enough to resolve a value, nothing more. */
export type DisplayField = { key: string; type: FieldType; options?: unknown };

/** A stored FILE / SIGNATURE answer, once it has been proven to be one. */
export type StoredFileRef = { storedName: string; fileName: string | null };

/** FormField.options is untyped JSON; keep only well-formed choices. */
export function parseOptions(raw: unknown): Choice[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (o): o is Choice =>
      !!o &&
      typeof o === "object" &&
      typeof (o as { value?: unknown }).value === "string" &&
      typeof (o as { label?: unknown }).label === "string",
  );
}

/** The option's label, or the raw value when the option is gone -- an option
 *  deleted after submission degrades to its stored value rather than blanking. */
export function labelFor(options: Choice[], value: string): string {
  return options.find((o) => o.value === value)?.label ?? value;
}

/** The stored-blob ref behind a FILE or SIGNATURE answer, or null for anything
 *  else. Without this a ref falls through to String() and renders as the
 *  literal "[object Object]". */
export function storedFileRef(value: unknown): StoredFileRef | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const ref = value as { storedName?: unknown; fileName?: unknown };
  if (typeof ref.storedName !== "string") return null;
  return { storedName: ref.storedName, fileName: typeof ref.fileName === "string" ? ref.fileName : null };
}

const CHOICE_TYPES = new Set<FieldType>(["SINGLE_SELECT", "MULTI_SELECT", "DEPARTMENT_CHOICE"]);

/**
 * Last resort for a choice value with no surviving option: turn the machine
 * token back into words ("fluent_non_native" -> "Fluent Non Native").
 *
 * Deliberately narrow. It fires only for a choice field whose option list is
 * missing or has drifted -- which happens on cycles seeded before a question
 * gained its options, and on any answer whose option was later deleted -- and
 * only for values that are unambiguously machine tokens. Anything carrying
 * capitals, spaces, or punctuation (a department code like "SCTP", a free-text
 * answer) is left exactly as stored.
 */
function humanizeToken(value: string): string {
  if (!/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(value)) return value;
  return value
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** A DATE answer ("2026-10-17") as a calendar day. Date-only strings are
 *  anchored at UTC midnight so the rendered day is the day that was picked. */
function formatDateAnswer(value: string): string {
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  return Number.isNaN(d.getTime()) ? value : formatCalendarDate(d);
}

function resolveChoice(field: DisplayField, options: Choice[], value: string): string {
  if (value === "") return "";
  if (!CHOICE_TYPES.has(field.type)) return value;
  const match = options.find((o) => o.value === value);
  if (match) return match.label;
  // The standard language question stores ISO codes. Its options carry labels,
  // so the lookup above normally wins; this covers a cycle seeded before the
  // question was standardized, where the codes would otherwise read as "zh".
  if (field.key === LANGUAGES_FIELD_KEY) return languageLabel(value);
  return humanizeToken(value);
}

/**
 * One stored answer as display text. Returns "" when the question was not
 * answered -- callers decide whether that means a placeholder row or no row at
 * all, which is the one thing the two reviewer surfaces disagree about.
 *
 * SUBCOMMITTEE_RANK is not handled here: its answer is hoisted out of the blob
 * into Application.subcommitteeRanking at submit, so it is rendered from that
 * column (with subcommittee names looked up) by each caller.
 */
export function formatAnswer(field: DisplayField, value: unknown): string {
  // A CHECKBOX -- and an acknowledging NOTICE, which stores the same shape -- is
  // a yes/no question, so it reads as one. "on" is the wizard/draft shape;
  // a submitted answer is a real boolean.
  if (field.type === "CHECKBOX" || field.type === "NOTICE") {
    if (value === undefined || value === null || value === "") return "";
    return value === true || value === "on" ? "Yes" : "No";
  }
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "boolean") return value ? "Yes" : "No";

  const file = storedFileRef(value);
  if (file) return file.fileName ?? "(file)";

  if (field.type === "DATE" && typeof value === "string") return formatDateAnswer(value);

  const options = parseOptions(field.options);
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === "string" ? resolveChoice(field, options, v) : String(v)))
      .filter((s) => s !== "")
      .join(", ");
  }
  if (typeof value === "string") return resolveChoice(field, options, value);
  return String(value);
}
