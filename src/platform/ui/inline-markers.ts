/**
 * The plain-text side of builder formatting (see inline-format.tsx): the marker
 * patterns, removing markers where only plain text fits, and the toggle the
 * builder's buttons use. No React here, so server code and engine helpers can
 * use it.
 */

// A marker must hug its text (no space just inside it), so "5 * 3 * 2" and a
// lone "*" stay as typed. A single * also may not touch a letter or another *
// on its outside, so it never splits a word or eats half of a "**". A closing
// ** is the last of a run of stars, so "**bold *italic***" closes correctly.
//
// No lookbehind: Safari before 16.4 cannot parse it, and a syntax error here
// would take down the whole apply form on those phones. The character before
// a single * is captured instead (group 3) and put back when rendering.
const BOLD = String.raw`\*\*(?=\S)([\s\S]*?\S)\*\*(?!\*)`;
const HIGHLIGHT = String.raw`==(?=\S)([\s\S]*?\S)==`;
const ITALIC = String.raw`(^|[^*\w])\*(?=[^\s*])([\s\S]*?[^\s*])\*(?![*\w])`;
export const MARKERS = new RegExp(`${BOLD}|${HIGHLIGHT}|${ITALIC}`, "g");

/** The text with its formatting markers removed, for places only plain text fits. */
export function stripInlineFormatting(text: string): string {
  let prev: string;
  let cur = text;
  // Repeat so nested markers come off too.
  do {
    prev = cur;
    cur = cur.replace(new RegExp(MARKERS.source, "g"), (_all, b, h, lead, i) => b ?? h ?? `${lead ?? ""}${i ?? ""}`);
  } while (cur !== prev);
  return cur;
}

export type InlineMarker = "**" | "*" | "==";

/**
 * Wrap value[start, end) in `marker`, or unwrap it when it is already wrapped
 * in exactly that marker. With nothing selected, inserts the marker pair around
 * a placeholder word and selects it, so typing replaces it. Returns the new
 * value and the selection to restore. Used by the builder's B / I / highlight
 * buttons.
 */
export function toggleMarker(
  value: string,
  start: number,
  end: number,
  marker: InlineMarker,
): { value: string; start: number; end: number } {
  const len = marker.length;
  // Keep spaces outside the markers, or they would not match when rendered.
  let s = start;
  let e = end;
  while (s < e && /\s/.test(value[s])) s++;
  while (e > s && /\s/.test(value[e - 1])) e--;

  if (s === e) {
    const word = marker === "==" ? "highlighted text" : marker === "**" ? "bold text" : "italic text";
    const next = value.slice(0, s) + marker + word + marker + value.slice(s);
    return { value: next, start: s + len, end: s + len + word.length };
  }

  const before = value.slice(s - len, s);
  const after = value.slice(e, e + len);
  // A lone * next to another * is really part of a ** pair, so it is not a match.
  const isExact = before === marker && after === marker &&
    !(marker === "*" && (value[s - len - 1] === "*" || value[e + len] === "*"));
  if (isExact) {
    const next = value.slice(0, s - len) + value.slice(s, e) + value.slice(e + len);
    return { value: next, start: s - len, end: e - len };
  }
  const next = value.slice(0, s) + marker + value.slice(s, e) + marker + value.slice(e);
  return { value: next, start: s + len, end: e + len };
}
