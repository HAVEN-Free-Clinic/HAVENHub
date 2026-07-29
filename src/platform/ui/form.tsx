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

// Matches a bare URL ("https://example.com/path") or a bare domain
// ("example.com/path") glued directly to a 2+ letter TLD, so sentence
// abbreviations like "e.g." or "U.S." (single-letter "TLD") never match and
// a space between two sentences never bridges into a false domain.
const URL_PATTERN = /\b((?:https?:\/\/)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?:\/[^\s<>"]*)?)/gi;

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
    // Strip sentence punctuation trailing the URL (the period ending "...apply.")
    // so it renders after the link instead of being swallowed into the href.
    const trailingMatch = /^(.*?)([.,;:!?)]+)$/.exec(raw);
    const url = trailingMatch ? trailingMatch[1] : raw;
    const trailing = trailingMatch ? trailingMatch[2] : "";
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
