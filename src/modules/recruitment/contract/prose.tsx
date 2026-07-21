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

const LABELLED = /\[([^\]\n]+)\]\((\S+?)\)/;
const BARE = /https?:\/\/[^\s)]+/;
const BOLD = /\*\*([^*\n]+)\*\*/;

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
    const labelled = LABELLED.exec(rest);
    const bare = BARE.exec(rest);
    const bold = BOLD.exec(rest);

    const candidates = [
      labelled ? { at: labelled.index, m: labelled, t: "labelled" as const } : null,
      bare ? { at: bare.index, m: bare, t: "bare" as const } : null,
      bold ? { at: bold.index, m: bold, t: "bold" as const } : null,
    ].filter((c): c is NonNullable<typeof c> => c !== null);

    if (candidates.length === 0) {
      push(rest);
      break;
    }
    const next = candidates.reduce((a, b) => (a.at <= b.at ? a : b));
    push(rest.slice(0, next.at));
    const matched = next.m[0];

    if (next.t === "bold") {
      spans.push({ kind: "bold", text: next.m[1] });
    } else if (next.t === "labelled") {
      const href = next.m[2];
      if (isSafeHref(href)) spans.push({ kind: "link", text: next.m[1], href });
      else push(matched);
    } else {
      if (isSafeHref(matched)) spans.push({ kind: "link", text: matched, href: matched });
      else push(matched);
    }
    rest = rest.slice(next.at + matched.length);
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
