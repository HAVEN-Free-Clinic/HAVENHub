import { describe, it, expect } from "vitest";
import { parseProse } from "./prose";

describe("parseProse", () => {
  it("splits blank-line separated paragraphs", () => {
    expect(parseProse("one\n\ntwo")).toEqual([
      { kind: "p", spans: [{ kind: "text", text: "one" }] },
      { kind: "p", spans: [{ kind: "text", text: "two" }] },
    ]);
  });

  it("parses bold spans", () => {
    expect(parseProse("a **b** c")).toEqual([
      { kind: "p", spans: [
        { kind: "text", text: "a " },
        { kind: "bold", text: "b" },
        { kind: "text", text: " c" },
      ] },
    ]);
  });

  it("groups consecutive dash lines into one list", () => {
    expect(parseProse("- one\n- two")).toEqual([
      { kind: "ul", items: [
        [{ kind: "text", text: "one" }],
        [{ kind: "text", text: "two" }],
      ] },
    ]);
  });

  it("parses labelled links", () => {
    expect(parseProse("see [docs](https://hipaa.yale.edu)")).toEqual([
      { kind: "p", spans: [
        { kind: "text", text: "see " },
        { kind: "link", text: "docs", href: "https://hipaa.yale.edu" },
      ] },
    ]);
  });

  it("parses text on both sides of a labelled link", () => {
    expect(parseProse("see [docs](https://hipaa.yale.edu) for more")).toEqual([
      { kind: "p", spans: [
        { kind: "text", text: "see " },
        { kind: "link", text: "docs", href: "https://hipaa.yale.edu" },
        { kind: "text", text: " for more" },
      ] },
    ]);
  });

  it("autolinks bare https urls", () => {
    expect(parseProse("go to https://hipaa.yale.edu now")).toEqual([
      { kind: "p", spans: [
        { kind: "text", text: "go to " },
        { kind: "link", text: "https://hipaa.yale.edu", href: "https://hipaa.yale.edu" },
        { kind: "text", text: " now" },
      ] },
    ]);
  });

  // Trailing sentence punctuation must not be captured into the href; it renders
  // as ordinary text after the link.
  it("keeps trailing sentence punctuation out of a bare url's href", () => {
    expect(parseProse("go to https://hipaa.yale.edu.")).toEqual([
      { kind: "p", spans: [
        { kind: "text", text: "go to " },
        { kind: "link", text: "https://hipaa.yale.edu", href: "https://hipaa.yale.edu" },
        { kind: "text", text: "." },
      ] },
    ]);
  });

  it("keeps trailing punctuation before more text out of a bare url's href", () => {
    expect(parseProse("see https://hipaa.yale.edu, ok?")).toEqual([
      { kind: "p", spans: [
        { kind: "text", text: "see " },
        { kind: "link", text: "https://hipaa.yale.edu", href: "https://hipaa.yale.edu" },
        { kind: "text", text: ", ok?" },
      ] },
    ]);
  });

  it("keeps balanced parentheses inside a labelled link's href", () => {
    expect(parseProse("see [wiki](https://en.wikipedia.org/wiki/Cat_(animal)) now")).toEqual([
      { kind: "p", spans: [
        { kind: "text", text: "see " },
        { kind: "link", text: "wiki", href: "https://en.wikipedia.org/wiki/Cat_(animal)" },
        { kind: "text", text: " now" },
      ] },
    ]);
  });

  it("keeps a link inside bold clickable", () => {
    expect(parseProse("**See [the HIPAA policy](https://hipaa.yale.edu) before signing**")).toEqual([
      { kind: "p", spans: [
        { kind: "bold", text: "See " },
        { kind: "link", text: "the HIPAA policy", href: "https://hipaa.yale.edu" },
        { kind: "bold", text: " before signing" },
      ] },
    ]);
  });

  it("refuses non-http schemes, leaving them as text", () => {
    expect(parseProse("[x](javascript:alert(1))")).toEqual([
      { kind: "p", spans: [{ kind: "text", text: "[x](javascript:alert(1))" }] },
    ]);
  });

  it("treats html in the source as literal text", () => {
    expect(parseProse("<script>alert(1)</script>")).toEqual([
      { kind: "p", spans: [{ kind: "text", text: "<script>alert(1)</script>" }] },
    ]);
  });

  // Regression coverage for the "first opener only" bug: matchLabelledLink used
  // to run LABEL_OPEN.exec once and give up on the whole string if that single
  // opener's paren scan never balanced. A later, perfectly valid `[...](` opener
  // in the same string was never tried. Pinned against the pre-fix commit
  // (546b1423), whose LABELLED regex backtracked naturally and did slide
  // forward past a failed opener.
  it("recovers a later labelled link when an earlier opener never balances", () => {
    expect(parseProse("[bad link](not a url) then [good link](https://good.com)")).toEqual([
      { kind: "p", spans: [
        { kind: "text", text: "[bad link](not a url) then " },
        { kind: "link", text: "good link", href: "https://good.com" },
      ] },
    ]);
  });

  // A second shape of the same bug: the first opener's paren scan balances
  // structurally (so it is not rejected as malformed), but only by swallowing a
  // nested, genuinely valid link as if it were part of the outer href. Once
  // isSafeHref rejects that nonsense href, the scanner must not discard the
  // whole match: it must retry from the next `[...](` opener, which is the
  // nested one, and recover it as a real anchor.
  it("recovers a nested labelled link when the outer opener's href is unsafe", () => {
    expect(parseProse("[a]([b](https://good.com))")).toEqual([
      { kind: "p", spans: [
        { kind: "text", text: "[a](" },
        { kind: "link", text: "b", href: "https://good.com" },
        { kind: "text", text: ")" },
      ] },
    ]);
  });

  // Not a regression repro (this already worked pre-fix and post-fix): pins
  // that an unmatched trailing `)` after a well-formed labelled link still ends
  // the link at that character, without eating the rest of the line.
  it("still terminates a labelled link at an unbalanced trailing paren", () => {
    expect(parseProse("see [x](https://a.com) extra) more")).toEqual([
      { kind: "p", spans: [
        { kind: "text", text: "see " },
        { kind: "link", text: "x", href: "https://a.com" },
        { kind: "text", text: " extra) more" },
      ] },
    ]);
  });

  // isSafeHref must stay the sole scheme gate after the retry-scanning change,
  // in all three places a link can originate: a bare autolink, a labelled link,
  // and a labelled link nested inside bold. None of these three schemes may
  // ever become a live anchor.
  describe("unsafe schemes stay inert across contexts", () => {
    const unsafeUrls = ["javascript:alert(1)", "javascript://evil", "//host/path"];

    it("bare autolink branch never turns an unsafe scheme into a link", () => {
      for (const url of unsafeUrls) {
        expect(parseProse(`go to ${url} now`)).toEqual([
          { kind: "p", spans: [{ kind: "text", text: `go to ${url} now` }] },
        ]);
      }
    });

    it("labelled link branch never turns an unsafe scheme into a link", () => {
      for (const url of unsafeUrls) {
        expect(parseProse(`[x](${url})`)).toEqual([
          { kind: "p", spans: [{ kind: "text", text: `[x](${url})` }] },
        ]);
      }
    });

    it("labelled link nested in bold never turns an unsafe scheme into a link", () => {
      for (const url of unsafeUrls) {
        expect(parseProse(`**[x](${url}) hi**`)).toEqual([
          { kind: "p", spans: [{ kind: "bold", text: `[x](${url}) hi` }] },
        ]);
      }
    });
  });

  it("later safe link is found even after an unsafe opener earlier on the line", () => {
    // Pins that an UNSAFE opener at the start of a line does not prevent the
    // retry loop from finding a later, valid link. The first opener [x]( fails
    // the isSafeHref check, so searchFrom advances. The second opener [y](
    // succeeds and is returned. This is exactly what the retry loop was added
    // to fix: the old code gave up after the first isSafeHref failure.
    expect(parseProse("[x](javascript:alert(1)) [y](https://good.com)")).toEqual([
      { kind: "p", spans: [
        { kind: "text", text: "[x](javascript:alert(1)) " },
        { kind: "link", text: "y", href: "https://good.com" },
      ] },
    ]);
  });

  it("parses two safe links on the same line with text between", () => {
    // Pins that two labelled links on a single line are both extracted with
    // the correct text and hrefs, and the text between them is preserved.
    // After the first link is found and consumed, parseSpans continues on
    // the remainder and finds the second link.
    expect(parseProse("[a](https://one.com) and [b](https://two.com)")).toEqual([
      { kind: "p", spans: [
        { kind: "link", text: "a", href: "https://one.com" },
        { kind: "text", text: " and " },
        { kind: "link", text: "b", href: "https://two.com" },
      ] },
    ]);
  });

  // Termination and performance analysis for matchLabelledLink retry loop.
  // The retry loop is O(n squared) in the length of the string: each of n possible
  // openers can spawn a paren scan that scans O(n) characters in the worst case
  // (when all openers fail to balance or contain unsafe hrefs). Measured on adversarial inputs:
  // approximately 164ms at 12,000 characters, 2,492ms at 48,000 characters (quadratic growth).
  // This is acceptable only because parseSpans splits input on blank lines and per-paragraph
  // and per-list-item boundaries, never receiving a whole document. The invariant is that n is
  // one paragraph's length (typically much less than 5,000 characters), so quadratic cost stays
  // under acceptable latency bounds.
  describe("scanner termination and performance", () => {
    it("does not hang on repeated openers where paren scan fails on whitespace", () => {
      // Each unit is `[a]( x)` - the opener is found, paren scan starts from
      // the space, hits whitespace immediately, and breaks. Retry loop advances
      // and finds the next opener. About 2500 retries on a ~17.5k-char string.
      const input = "[a]( x)".repeat(2500);
      expect(input.length).toBeGreaterThan(15000);
      const start = Date.now();
      const result = parseProse(input);
      const elapsed = Date.now() - start;
      expect(result).toEqual([{ kind: "p", spans: [{ kind: "text", text: input }] }]);
      expect(elapsed).toBeLessThan(2000);
    });

    it("does not hang on repeated openers with unsafe but balanced hrefs", () => {
      // Each unit is `[a](javascript:x)` - opener is found, parens balance cleanly,
      // but isSafeHref rejects the javascript: scheme. Retry loop advances to find
      // the next opener. About 2400 retries on a ~18k-char string.
      const input = "[a](javascript:x)".repeat(2400);
      expect(input.length).toBeGreaterThan(15000);
      const start = Date.now();
      const result = parseProse(input);
      const elapsed = Date.now() - start;
      expect(result).toEqual([{ kind: "p", spans: [{ kind: "text", text: input }] }]);
      expect(elapsed).toBeLessThan(2000);
    });

    it("handles a 12,000-character adversarial input without hanging", () => {
      // Every unit is a `[...](` opener that never closes, so every retry
      // scans forward without ever finding a balancing `)`. Worst case for the
      // retry loop: about 3000 retries, each scanning most of the remainder.
      const input = "[a](".repeat(3000);
      expect(input.length).toBeGreaterThan(10000);
      const start = Date.now();
      const result = parseProse(input);
      const elapsed = Date.now() - start;
      expect(result).toEqual([{ kind: "p", spans: [{ kind: "text", text: input }] }]);
      expect(elapsed).toBeLessThan(2000);
    });
  });
});
