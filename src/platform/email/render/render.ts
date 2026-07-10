import { esc } from "./escape";
import { tokenize, type Token } from "./tokens";

function truthy(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "boolean") return v;
  return Boolean(v);
}

export function renderTemplate(source: string, context: Record<string, unknown>, opts: { escape?: boolean } = {}): string {
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
        const v = context[t.name];
        out += v === null || v === undefined ? "" : (escapeVars ? esc(String(v)) : String(v));
      } else if (t.type === "rawVar") {
        const v = context[t.name];
        out += v === null || v === undefined ? "" : String(v);
      } else if (t.type === "ifOpen") {
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

  return renderUntil(false);
}
