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

  // The BARE regex (`[^\s)]+`) has no notion of sentence-ending punctuation, so a
  // trailing period on a bare URL is captured into the href/text rather than left
  // outside the link. Pinning the actual behavior here, not asserting it is correct.
  it("captures trailing punctuation into a bare url's href", () => {
    expect(parseProse("go to https://hipaa.yale.edu.")).toEqual([
      { kind: "p", spans: [
        { kind: "text", text: "go to " },
        { kind: "link", text: "https://hipaa.yale.edu.", href: "https://hipaa.yale.edu." },
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
});
