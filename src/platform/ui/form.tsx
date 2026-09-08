import type { ComponentProps, ReactNode } from "react";
import { cx } from "./cx";
import { Field } from "./input";

/**
 * A labeled group of fields inside a form. Replaces the divergent hand-rolled
 * fieldset/legend blocks (and the field()/FieldPreview helpers) with one
 * consistent legend style.
 */
export function FormSection({
  title,
  description,
  children,
}: {
  title?: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <fieldset className="m-0 space-y-4 border-0 p-0">
      {title && (
        <legend className="mb-3 p-0 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </legend>
      )}
      {description && <p className="-mt-2 text-xs text-subtle-foreground">{description}</p>}
      {children}
    </fieldset>
  );
}

// Matches either a scheme URL ("https://example.com/anything") or a bare
// domain with a mandatory path segment ("example.com/apply"). The mandatory
// path on the bare-domain branch is deliberate: without it, plain-text
// mentions of a filename ("policy.pdf", "resume.docx", "node.js") or an email
// address's domain ("info@example.com") read as false-positive domains, since
// a filename extension and a TLD are indistinguishable in isolation. A path
// is the cheapest signal that a bare "word.word" is actually a link and not
// a file or an email host. This does mean a bare domain with no path never
// linkifies -- there is no rule here that covers "see example.com" with
// nothing after it; the task this exists for always has a path
// ("havenfreeclinic.com/apply"), so that trade-off is deliberately accepted.
// The leading (?<!@) keeps an emailed URL that does have a path
// ("user@example.com/reset") from linkifying starting mid-domain, but only
// when the host is a single label. A multi-label host still linkifies past
// the "@": "admin@sub.example.com/reset" still produces a link to
// "example.com/reset", because \b also matches the boundary right before
// "example", and the lookbehind there only sees the "." immediately before
// it, not the "@" two labels back. Not patched, for the same reason as the
// filename case below: the strings this helper renders are staff-authored
// department/form descriptions, not arbitrary user text, and this has not
// shown up in real content.
//
// Known residual limitation, accepted rather than patched: a filename
// immediately followed by a path ("node.js/api", "policy.pdf/v2") still
// linkifies, because an extension and a TLD are the same shape once a path
// follows -- nothing in the string itself says which one it is. This is not
// always a harmlessly dead link either: "node.js/api" resolves nowhere
// (there is no ".js" gTLD), but "handbook.zip/latest" resolves to a real
// origin, because ".zip" and ".mov" are live gTLDs. Fixing this would mean
// maintaining a blocklist of known extensions, which is its own permanent
// drift problem for a case that has not shown up in real content. The
// mandatory path already removes the common bare-filename false positive
// (see above).
const URL_PATTERN =
  /(?<!@)\b(?:https?:\/\/[^\s<>"]+|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\/[^\s<>"]*)/gi;

/**
 * Splits sentence punctuation trailing a matched URL from the URL itself, so
 * "...apply." links only "...apply" and leaves the period as plain text.
 * Trailing ")" is only treated as punctuation (not part of the URL) when it
 * has no matching "(" earlier in the match, so a Wikipedia-style URL ending
 * in a real parenthesized path segment ("Foo_(bar)") keeps its balanced
 * paren intact.
 */
function splitTrailingPunctuation(raw: string): { url: string; trailing: string } {
  let end = raw.length;
  while (end > 0) {
    const ch = raw[end - 1];
    if (".,;:!?".includes(ch)) {
      end--;
      continue;
    }
    if (ch === ")") {
      const core = raw.slice(0, end);
      const opens = (core.match(/\(/g) ?? []).length;
      const closes = (core.match(/\)/g) ?? []).length;
      if (closes <= opens) break; // this ")" is balanced by an earlier "(" -- keep it
      end--;
      continue;
    }
    break;
  }
  return { url: raw.slice(0, end), trailing: raw.slice(end) };
}

/**
 * Turns bare URLs/domains embedded in plain text into safe external links,
 * leaving the rest of the text untouched.
 *
 * Section descriptions (e.g. the "See department descriptions at
 * havenfreeclinic.com/apply" pointer) are persisted verbatim to
 * FormSection.description, a text column staff can edit in the cycle
 * builder -- so a real <a> can never live in the stored string. This lets
 * every renderer of a persisted description turn it into a real link at
 * display time instead.
 */
export function linkifyUrls(text: string): ReactNode {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  URL_PATTERN.lastIndex = 0;
  while ((match = URL_PATTERN.exec(text))) {
    const raw = match[0];
    const { url, trailing } = splitTrailingPunctuation(raw);
    if (!url) continue;
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    nodes.push(
      <a
        key={match.index}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="underline underline-offset-2"
      >
        {url}
        <span className="sr-only"> (opens in a new tab)</span>
      </a>,
    );
    if (trailing) nodes.push(trailing);
    lastIndex = match.index + raw.length;
  }
  if (nodes.length === 0) return text;
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

/**
 * The single-line form row: a few controls and their submit, side by side.
 *
 * Forty-odd write forms across recruitment, schedule, admin, volunteers,
 * incidents, outreach, support and my-info hand-rolled this row, in five
 * spellings of the same idea: `flex flex-wrap items-end gap-3` (32 of them),
 * the same with `gap-2` (11), `flex items-end gap-2`, `flex items-end gap-3`,
 * and `flex flex-wrap items-end gap-4`.
 *
 * The widths inside drifted further than the rows did. Field wrappers used
 * eight fixed values (w-28 through w-72) and five different grow spellings,
 * and three more forms put the width on the `<Input>` itself instead of a
 * wrapper. /volunteers/spanish-review had gone one further and defined its own
 * page-local `Field` with its own label style. On the applicant detail page
 * the result is visible in one screen: four stacked rows whose columns do not
 * line up with each other, so the eye re-finds every control.
 *
 * `RowField` owns the widths so a Notes field is the same width on the
 * interview page and the applicant page, and `FilterBar` draws from the same
 * table, so the Category select in the strike composer lines up with the
 * Category select in the strike filter bar directly below it.
 *
 * ## Why this is a container, not the <form>
 *
 * These rows are not all forms. Six of them are `<div>`s inside a larger form
 * (the outreach identity and scope forms, the strike composer), and the ones
 * that are forms carry their own bound server action and their own spacing or
 * separator classes. A primitive that silently rendered `<form>` or `<div>`
 * depending on whether an `action` prop was passed would hide that difference
 * rather than serve it, so the caller keeps its own element and this owns only
 * the row.
 *
 * The submit goes LAST, unwrapped: `items-end` already sits it on the row's
 * baseline, and giving it a width wrapper is what pushes it out of line.
 *
 * ## What this is not
 *
 * Not every bottom-aligned flex row is a form row, and four kinds were left
 * alone deliberately:
 *
 *  - **Header bars** (`justify-between`), where the row's job is to push a
 *    count or a status to the far edge rather than to lay out controls.
 *  - **The two schedule toolbars**, which use `gap-x-6 gap-y-4` on purpose:
 *    a toolbar separates groups of controls, and the tighter form gap runs
 *    them together.
 *  - **Card-internal control pairs**, e.g. the builder's field card, whose
 *    layout belongs to the card.
 *  - **Grids** that happen to bottom-align their last row.
 */
/** The row's own flex classes. Exported for `FilterBar`, which needs the same
 * row on a `NavForm` rather than on a `<div>`. */
export const FORM_ROW = "flex flex-wrap items-end gap-3";

export function FormRow({
  children,
  className,
}: {
  children: ReactNode;
  /** Outer spacing and separators only. The row's own flex classes are not overridable. */
  className?: string;
}) {
  return (
    <div className={cx(FORM_ROW, className)}>{children}</div>
  );
}

/**
 * Column widths for one control in a `FormRow` or a `FilterBar`.
 *
 * Four roles, named for what the control HOLDS rather than for a size, because
 * a size name is what let eight values drift in: "medium" invites a judgement
 * call on every form, "a bounded number" does not.
 */
export const ROW_WIDTH = {
  /** A bounded number or a 1-5 score: percentages, attempt counts, ratings. */
  numeric: "w-28",
  /** The default. A select, a date, or a short input. */
  control: "w-44",
  /** Content that is genuinely long: a person picker, an email address, a place. */
  wide: "w-56",
  /** Free text -- notes, comments, search. Takes the leftover room. */
  grow: "flex-1 min-w-48",
} as const;

export type RowWidth = keyof typeof ROW_WIDTH;

/** One labelled control in a `FormRow`. Takes every `Field` prop, plus a width. */
export function RowField({
  width = "control",
  ...field
}: { width?: RowWidth } & ComponentProps<typeof Field>) {
  return (
    <div className={ROW_WIDTH[width]}>
      <Field {...field} />
    </div>
  );
}

/** Standard footer row for form submit/secondary buttons. */
export function FormActions({
  children,
  align = "start",
  className,
}: {
  children: ReactNode;
  align?: "start" | "end";
  className?: string;
}) {
  return (
    <div
      className={cx(
        "flex items-center gap-3 pt-2",
        align === "end" && "justify-end",
        className,
      )}
    >
      {children}
    </div>
  );
}
