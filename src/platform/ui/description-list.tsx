import type { ReactNode } from "react";
import { cx } from "./cx";

/**
 * The label-over-value rows every detail page in the app is built from.
 *
 * Thirty-seven dt/dd pairs across eleven files, and they did not agree on which
 * half of the pair is the loud one. Nine sites set the label small and grey over
 * a dark value; two set the label dark and bold over a grey value. Those two are
 * not in some far corner of the app: /incidents/[id] and the strike row on
 * /incidents/strikes are two views of the SAME case, and a reviewer who reads a
 * report and then expands its strike sees the visual hierarchy turn inside out.
 *
 * The direction here is the majority one, and it is also the right one: the
 * field name is chrome the reader learns once, and the value is what they came
 * for, so the value gets the ink.
 *
 * ## The empty value is the part that was actually broken
 *
 * An absent value was rendered five ways: "(none)", "(none linked)", "Not
 * answered", a subtle "Not set", an italic "Not provided". Three of those drew
 * in the SAME ink as a real answer, so on an incident report a reviewer could
 * not tell "the reporter said the setting was (none)" from "the reporter left
 * the setting blank" -- on a page where that distinction can decide whether a
 * strike is issued.
 *
 * So the treatment is fixed here and is not a caller's choice: italic, subtle,
 * never the value's own ink. The WORD stays a prop, because the honest sentence
 * differs -- an applicant who skipped a question was "Not provided", a profile
 * field nobody has filled is "Not set", an incident form's unanswered radio is
 * "Not answered". One treatment, the caller's own noun.
 *
 * Emptiness is judged on the children, so the ordinary React idioms all land in
 * the right place: `{list.length > 0 && <ul/>}` yields false, `{x ?? ""}` yields
 * "", and both are empty. A caller that renders its own fallback (a `<DateTime
 * fallback>`) is passing a real element and keeps its own wording.
 *
 * ## Not everything with a dt in it belongs here
 *
 * Two sites keep their own shape deliberately. The readiness panel on the
 * schedule lays its rows out HORIZONTALLY (`dt` and `dd` side by side in a flex
 * row) because it is a compact status strip, not a detail card. The custom
 * answers inside an onboarding table cell are annotation on a row, sized to the
 * cell. Both are different objects that happen to use the same HTML element.
 */

const COLUMNS = {
  /** Stacked. One row per line at every width. */
  1: "",
  /** The house default for a detail card. */
  2: "sm:grid-cols-2",
  /** For identity cards with many short fields. */
  3: "sm:grid-cols-2 lg:grid-cols-3",
} as const;

export function DescriptionList({
  columns = 2,
  className,
  children,
}: {
  columns?: keyof typeof COLUMNS;
  className?: string;
  children: ReactNode;
}) {
  return (
    <dl className={cx("grid min-w-0 gap-x-6 gap-y-3", COLUMNS[columns], className)}>
      {children}
    </dl>
  );
}

/**
 * `false` covers `{cond && <x/>}`, `""` covers `{value ?? ""}`, and null and
 * undefined cover a nullable column read straight through -- the four ways a
 * caller writes "there is nothing here" without meaning to say anything. An
 * array is blank only if every part of it is, so `{a}{b}` behaves like the
 * single values it is made of. A zero is a value and stays.
 */
function isBlank(node: ReactNode): boolean {
  if (Array.isArray(node)) return node.every(isBlank);
  return node === null || node === undefined || node === false || node === "";
}

/**
 * `empty` is the word, not the styling: see the note above on why the treatment
 * is fixed. Pass the value as children.
 */
export function DetailRow({
  label,
  empty = "Not provided",
  wide = false,
  wrap = false,
  control,
  children,
}: {
  label: ReactNode;
  /** The sentence shown when there is no value. "Not set", "Not answered", ... */
  empty?: string;
  /** Span the full width of a multi-column list. For prose and long lists. */
  wide?: boolean;
  /** Honour newlines in a stored free-text answer. */
  wrap?: boolean;
  /**
   * A form that CHANGES this field, shown under the value. Separate from
   * children because it is not part of the value: a manager who can link an
   * incident report to a strike must still get the picker on a row whose value
   * is empty, and folding it into children would make that row look non-empty.
   */
  control?: ReactNode;
  children?: ReactNode;
}) {
  const blank = isBlank(children);
  return (
    // break-words plus overflow-wrap:anywhere because these hold user-entered
    // values -- a pasted URL or an unbroken accession number would otherwise
    // widen the grid column and push the card sideways.
    <div className={cx("min-w-0 break-words [overflow-wrap:anywhere]", wide && "sm:col-span-full")}>
      <dt className="text-xs text-subtle-foreground">{label}</dt>
      <dd className={cx("mt-0.5 text-sm text-foreground", wrap && "whitespace-pre-wrap")}>
        {blank ? <span className="italic text-subtle-foreground">{empty}</span> : children}
        {control && <div className="mt-2 whitespace-normal">{control}</div>}
      </dd>
    </div>
  );
}
