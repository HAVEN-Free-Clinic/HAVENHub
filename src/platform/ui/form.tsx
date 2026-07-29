import type { ReactNode } from "react";
import { cx } from "./cx";

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
// ("user@example.com/reset") from linkifying starting mid-domain.
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
