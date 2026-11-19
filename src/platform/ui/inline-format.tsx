import { Fragment, type ReactNode } from "react";
import { linkifyUrls } from "./form";
import { MARKERS } from "./inline-markers";

export { stripInlineFormatting, toggleMarker, type InlineMarker } from "./inline-markers";

/**
 * Light text formatting for text staff write in the form builder: question
 * labels, help text, notices and section descriptions.
 *
 *   **bold**   *italic*   ==highlight==
 *
 * The stored value stays plain text with these markers in it, never HTML, so
 * nothing typed into a form can inject markup. Every renderer turns the
 * markers into real elements at display time (formatInline), and anywhere only
 * plain text fits, such as a <select> option or an export, drops them
 * (stripInlineFormatting). Markers can nest (**bold and *italic***), links are
 * still made clickable, and a marker with no partner is shown as typed.
 */

export const HIGHLIGHT_CLASS = "rounded-sm bg-amber-200/80 px-0.5 text-inherit dark:bg-amber-400/30";

export function formatInline(text: string | null | undefined): ReactNode {
  if (!text) return text ?? null;
  return render(text, "f");
}

function render(text: string, keyPrefix: string): ReactNode {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  const re = new RegExp(MARKERS.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    // For italic, the captured character before the * belongs to the text.
    const lead = m[3] ?? "";
    const startOfMarker = m.index + lead.length;
    if (startOfMarker > last) out.push(<Fragment key={`${keyPrefix}t${n}`}>{linkifyUrls(text.slice(last, startOfMarker))}</Fragment>);
    const key = `${keyPrefix}m${n}`;
    if (m[1] !== undefined) out.push(<strong key={key} className="font-semibold">{render(m[1], `${key}-`)}</strong>);
    else if (m[2] !== undefined) out.push(<mark key={key} className={HIGHLIGHT_CLASS}>{render(m[2], `${key}-`)}</mark>);
    else out.push(<em key={key}>{render(m[4], `${key}-`)}</em>);
    last = m.index + m[0].length;
    n += 1;
  }
  if (n === 0) return linkifyUrls(text);
  if (last < text.length) out.push(<Fragment key={`${keyPrefix}t${n}`}>{linkifyUrls(text.slice(last))}</Fragment>);
  return out;
}
