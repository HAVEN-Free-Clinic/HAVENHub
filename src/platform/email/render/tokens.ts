export type Token =
  | { type: "text"; value: string }
  | { type: "var"; name: string }
  | { type: "rawVar"; name: string }
  | { type: "ifOpen"; name: string }
  | { type: "else" }
  | { type: "ifClose" };

// Triple-brace (raw) alternative is listed first so it wins over double-brace.
const TAG = /\{\{\{\s*(.*?)\s*\}\}\}|\{\{\s*(.*?)\s*\}\}/g;

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;

  for (const m of source.matchAll(TAG)) {
    const idx = m.index ?? 0;
    if (idx > last) tokens.push({ type: "text", value: source.slice(last, idx) });

    if (m[1] !== undefined) {
      tokens.push({ type: "rawVar", name: m[1].trim() });
    } else {
      const inner = (m[2] ?? "").trim();
      if (inner.startsWith("#if ")) {
        tokens.push({ type: "ifOpen", name: inner.slice(4).trim() });
      } else if (inner === "else") {
        tokens.push({ type: "else" });
      } else if (inner === "/if") {
        tokens.push({ type: "ifClose" });
      } else {
        tokens.push({ type: "var", name: inner });
      }
    }
    last = idx + m[0].length;
  }

  if (last < source.length) tokens.push({ type: "text", value: source.slice(last) });
  return tokens;
}
