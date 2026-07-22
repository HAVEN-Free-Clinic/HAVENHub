import type { ReactNode } from "react";

export type Span =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "link"; text: string; href: string };

export type ProseNode =
  | { kind: "p"; spans: Span[] }
  | { kind: "ul"; items: Span[][] };

/** Only http(s) links render as anchors. Anything else stays literal text, so a
 *  javascript: or data: URL authored into an agreement body can never become a
 *  live link. This is the renderer's only security-relevant decision. */
function isSafeHref(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

const LABEL_OPEN = /\[([^\]\n]+)\]\(/;
const BARE = /https?:\/\/[^\s)]+/;
const BOLD = /\*\*([^*\n]+)\*\*/;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

type LinkMatch = { at: number; length: number; label: string; href: string };

/** Finds the next usable `[label](url)` in `text`. Tracks paren depth through
 *  the url portion (starting at depth 1 for the link's own opening paren) so a
 *  url that itself contains balanced parentheses (Wikipedia-style references)
 *  is captured whole, while an unmatched `)` inside the url still closes the
 *  link at that character rather than swallowing more text. Whitespace before
 *  depth returns to 0 means the parenthetical never closes as a url, so the
 *  candidate is rejected, same as the old `(\S+?)` regex refusing to span a
 *  space.
 *
 *  A candidate opener can fail three ways: the paren scan never balances, it
 *  crosses whitespace, or the extracted href is empty or unsafe. None of
 *  those should sink the whole string, because a later `[...](` opener, quite
 *  possibly nested inside the failed candidate's own scan region (an outer
 *  `[a](` whose "href" turns out to be `[b](https://good.com)`), can still be
 *  a valid link. So on any failure the search resumes just past the failed
 *  opener's `[` and looks for the next one, instead of giving up on the whole
 *  string the way a single `LABEL_OPEN.exec` call used to.
 *
 *  Termination: `searchFrom` only ever advances to `openIndex + 1`, and
 *  `openIndex` is always >= the `searchFrom` it was found from (a regex exec
 *  against `text.slice(searchFrom)` can only match at or after that offset).
 *  So each retry starts strictly later than the previous one, `searchFrom` is
 *  bounded above by `text.length`, and the `while` below runs at most
 *  `text.length` times regardless of input shape. */
function matchLabelledLink(text: string): LinkMatch | null {
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const open = LABEL_OPEN.exec(text.slice(searchFrom));
    if (!open) return null;
    const openIndex = searchFrom + open.index;
    const urlStart = openIndex + open[0].length;
    let depth = 1;
    let i = urlStart;
    let brokeOnWhitespace = false;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) break;
      } else if (/\s/.test(ch)) {
        brokeOnWhitespace = true;
        break;
      }
    }
    if (!brokeOnWhitespace && depth === 0) {
      const href = text.slice(urlStart, i);
      if (href && isSafeHref(href)) {
        return { at: openIndex, length: i + 1 - openIndex, label: open[1], href };
      }
    }
    searchFrom = openIndex + 1;
  }
  return null;
}

/** Splits trailing sentence punctuation off a bare autolinked url so
 *  "https://x.com." keeps the period out of the href, rendering it as
 *  ordinary text right after the link instead. */
function splitTrailingPunctuation(url: string): { href: string; trailing: string } {
  const trailing = TRAILING_PUNCTUATION.exec(url);
  if (!trailing) return { href: url, trailing: "" };
  return { href: url.slice(0, trailing.index), trailing: trailing[0] };
}

/** Tokenizes one line into spans. Order matters: labelled links are matched
 *  before bare URLs so the url inside [a](url) is not autolinked twice. */
function parseSpans(line: string): Span[] {
  const spans: Span[] = [];
  let rest = line;

  const push = (text: string) => {
    if (!text) return;
    const last = spans[spans.length - 1];
    if (last?.kind === "text") last.text += text;
    else spans.push({ kind: "text", text });
  };

  while (rest) {
    const labelled = matchLabelledLink(rest);
    const bare = BARE.exec(rest);
    const bold = BOLD.exec(rest);

    const candidates = [
      labelled ? { at: labelled.at, t: "labelled" as const, labelled } : null,
      bare ? { at: bare.index, t: "bare" as const, bare } : null,
      bold ? { at: bold.index, t: "bold" as const, bold } : null,
    ].filter((c): c is NonNullable<typeof c> => c !== null);

    if (candidates.length === 0) {
      push(rest);
      break;
    }
    const next = candidates.reduce((a, b) => (a.at <= b.at ? a : b));
    push(rest.slice(0, next.at));

    if (next.t === "labelled") {
      const { length, label, href } = next.labelled;
      if (isSafeHref(href)) spans.push({ kind: "link", text: label, href });
      else push(rest.slice(next.at, next.at + length));
      rest = rest.slice(next.at + length);
    } else if (next.t === "bare") {
      const matched = next.bare[0];
      const { href, trailing } = splitTrailingPunctuation(matched);
      if (isSafeHref(href)) {
        spans.push({ kind: "link", text: href, href });
        push(trailing);
      } else {
        push(matched);
      }
      rest = rest.slice(next.at + matched.length);
    } else {
      const matched = next.bold[0];
      const inner = next.bold[1];
      // A link inside bold must still render as a real anchor: recurse into the
      // interior instead of swallowing it as inert bold text. Text spans that
      // come back stay emphasized; a link span is pushed as-is, since Span has
      // no "bold link" variant, a working link matters more than it being bold.
      for (const innerSpan of parseSpans(inner)) {
        spans.push(innerSpan.kind === "text" ? { kind: "bold", text: innerSpan.text } : innerSpan);
      }
      rest = rest.slice(next.at + matched.length);
    }
  }
  return spans;
}

export function parseProse(text: string): ProseNode[] {
  const nodes: ProseNode[] = [];
  for (const chunk of text.split(/\n\s*\n/)) {
    const lines = chunk.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    let listItems: Span[][] = [];
    let paraLines: string[] = [];

    const flushList = () => {
      if (listItems.length) { nodes.push({ kind: "ul", items: listItems }); listItems = []; }
    };
    const flushPara = () => {
      if (paraLines.length) { nodes.push({ kind: "p", spans: parseSpans(paraLines.join(" ")) }); paraLines = []; }
    };

    for (const line of lines) {
      if (line.startsWith("- ")) { flushPara(); listItems.push(parseSpans(line.slice(2))); }
      else { flushList(); paraLines.push(line); }
    }
    flushList();
    flushPara();
  }
  return nodes;
}

function renderSpans(spans: Span[]): ReactNode[] {
  return spans.map((s, i) => {
    if (s.kind === "bold") return <strong key={i} className="font-semibold text-foreground">{s.text}</strong>;
    if (s.kind === "link") {
      return (
        <a key={i} href={s.href} target="_blank" rel="noreferrer noopener" className="text-brand underline underline-offset-2">
          {s.text}
        </a>
      );
    }
    return <span key={i}>{s.text}</span>;
  });
}

/** Renders the supported markdown subset as React elements. Never uses
 *  dangerouslySetInnerHTML, so authored HTML is inert by construction. */
export function Prose({ text, className }: { text: string; className?: string }) {
  const nodes = parseProse(text);
  if (nodes.length === 0) return null;
  return (
    <div className={className}>
      {nodes.map((n, i) =>
        n.kind === "ul" ? (
          <ul key={i} className="my-2 list-disc space-y-1 pl-5 text-sm text-foreground-soft">
            {n.items.map((item, j) => <li key={j}>{renderSpans(item)}</li>)}
          </ul>
        ) : (
          <p key={i} className="my-2 text-sm text-foreground-soft">{renderSpans(n.spans)}</p>
        )
      )}
    </div>
  );
}
