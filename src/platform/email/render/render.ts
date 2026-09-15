import { esc } from "./escape";
import { tokenize, type Token } from "./tokens";

function truthy(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "boolean") return v;
  return Boolean(v);
}

/**
 * @param opts.onUnknownName Called once per token whose name is ABSENT from the
 *   context, so a caller that can report it (renderEmail) may. Deliberately a
 *   callback rather than logging here: this function is pure and is used in
 *   preview and test paths where a warning would be noise, and the send path is
 *   the only place a silently-empty variable actually reaches someone.
 *
 *   Absence is the signal, NOT emptiness: a declared variable that is legitimately
 *   null or "" renders empty on purpose and must stay quiet. `in` distinguishes
 *   the two; a truthiness check could not.
 */
export function renderTemplate(
  source: string,
  context: Record<string, unknown>,
  opts: { escape?: boolean; onUnknownName?: (name: string) => void } = {}
): string {
  // Bodies and layouts render HTML, so {{var}} is HTML-escaped by default. Plain-text
  // contexts (e.g. an email Subject header) pass { escape: false } so an ampersand or
  // apostrophe in a value is emitted as-is rather than turned into an entity.
  const escapeVars = opts.escape ?? true;
  const tokens = tokenize(source);
  let i = 0;

  function renderUntil(stopAtElse: boolean): string {
    let out = "";
    while (i < tokens.length) {
      const t: Token = tokens[i];
      if (t.type === "ifClose") return out; // caller consumes the close
      if (t.type === "else" && stopAtElse) return out;
      i++;

      if (t.type === "text") {
        out += t.value;
      } else if (t.type === "var") {
        if (!(t.name in context)) opts.onUnknownName?.(t.name);
        const v = context[t.name];
        out += v === null || v === undefined ? "" : (escapeVars ? esc(String(v)) : String(v));
      } else if (t.type === "rawVar") {
        if (!(t.name in context)) opts.onUnknownName?.(t.name);
        const v = context[t.name];
        out += v === null || v === undefined ? "" : String(v);
      } else if (t.type === "ifOpen") {
        // Reported too: an {{#if}} on a name nobody supplies is always false, so
        // the whole branch silently disappears from the email. That is the more
        // dangerous version of this bug, not the milder one -- a missing {{var}}
        // leaves a visible gap, a dropped {{#if}} leaves no trace at all.
        if (!(t.name in context)) opts.onUnknownName?.(t.name);
        const cond = truthy(context[t.name]);
        const consequent = renderUntil(true);
        let alternate = "";
        if (tokens[i]?.type === "else") {
          i++; // consume {{else}}
          alternate = renderUntil(false);
        }
        if (tokens[i]?.type === "ifClose") i++; // consume {{/if}}
        out += cond ? consequent : alternate;
      }
      // stray {{else}}/{{/if}} with no matching open are ignored
    }
    return out;
  }

  const out = renderUntil(false);
  // HTML only: drop list items a conditional left empty. The email editor is a rich
  // text editor, and saving a list with {{#if x}}...{{/if}} between its items moves
  // each marker into a list item of its own, so the markers render as blank bullets
  // whether the condition is true or false. Plain-text renders (subjects, Teams
  // drafts) pass escape: false and are left exactly as rendered.
  return escapeVars ? removeEmptyListItems(out) : out;
}

/** A list item holding nothing visible: whitespace, non-breaking spaces, line
 *  breaks, or empty paragraphs (what the editor writes for an empty line). */
const EMPTY_LIST_ITEM = /<li\b[^>]*>(?:\s|&nbsp;|<br\s*\/?>|<p\b[^>]*>(?:\s|&nbsp;|<br\s*\/?>)*<\/p>)*<\/li>/gi;
const EMPTY_LIST = /<(ul|ol)\b[^>]*>\s*<\/\1>/gi;

/** Remove list items with no visible content, then any list left with none. */
export function removeEmptyListItems(html: string): string {
  return html.replace(EMPTY_LIST_ITEM, "").replace(EMPTY_LIST, "");
}
