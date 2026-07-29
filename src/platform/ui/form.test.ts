import { describe, expect, it } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { FormSection, FormActions, linkifyUrls } from "./form";

type AnchorElement = ReactElement<{ href: string; target: string; rel: string; children: ReactNode[] }>;

function findLink(nodes: unknown): AnchorElement {
  const arr = nodes as ReactElement[];
  const link = arr.find((n) => typeof n === "object" && n !== null && n.type === "a") as
    | AnchorElement
    | undefined;
  if (!link) throw new Error("expected an <a> node in linkifyUrls output");
  return link;
}

describe("linkifyUrls", () => {
  it("returns the original string unchanged when there is no URL", () => {
    expect(linkifyUrls("Nothing to see here.")).toBe("Nothing to see here.");
  });

  it("turns a bare domain into a safe external link and keeps trailing punctuation as text", () => {
    const nodes = linkifyUrls("See department descriptions at havenfreeclinic.com/apply.") as unknown[];
    const link = findLink(nodes);
    expect(link.props.href).toBe("https://havenfreeclinic.com/apply");
    expect(link.props.children[0]).toBe("havenfreeclinic.com/apply");
    expect(link.props.target).toBe("_blank");
    expect(link.props.rel).toBe("noopener noreferrer");
    expect(nodes[nodes.length - 1]).toBe(".");
  });

  it("leaves an existing https:// URL's scheme alone", () => {
    const nodes = linkifyUrls("Visit https://example.com/path for more.") as unknown[];
    expect(findLink(nodes).props.href).toBe("https://example.com/path");
  });

  it("does not mistake sentence abbreviations for domains", () => {
    const text = "e.g. this, i.e. that, and the U.S. too.";
    expect(linkifyUrls(text)).toBe(text);
  });

  // Regressions found in review: a bare "word.word" with no path is
  // indistinguishable from a filename or an email host, so the pattern
  // requires either a scheme or a path segment before it will linkify.
  it("does not mistake a filename for a domain (policy.pdf)", () => {
    const text = "See the policy.pdf on the intranet.";
    expect(linkifyUrls(text)).toBe(text);
  });

  it("does not mistake a filename for a domain (resume.docx)", () => {
    const text = "Please attach your resume.docx to the email.";
    expect(linkifyUrls(text)).toBe(text);
  });

  it("does not mistake a filename for a domain (node.js)", () => {
    const text = "The backend runs on node.js.";
    expect(linkifyUrls(text)).toBe(text);
  });

  it("does not split an email address into a false domain link", () => {
    const text = "Contact us at info@havenfreeclinic.com";
    expect(linkifyUrls(text)).toBe(text);
  });

  it("keeps a balanced parenthesis in a scheme URL's path instead of stripping it as punctuation", () => {
    const text = "https://en.wikipedia.org/wiki/Foo_(bar)";
    const nodes = linkifyUrls(text) as unknown[];
    const link = findLink(nodes);
    expect(link.props.href).toBe("https://en.wikipedia.org/wiki/Foo_(bar)");
    expect(link.props.children[0]).toBe("https://en.wikipedia.org/wiki/Foo_(bar)");
  });
});

describe("FormSection", () => {
  it("renders a border-reset fieldset with an uppercase legend", () => {
    const el = FormSection({ title: "Contact details", children: null });
    expect(el.type).toBe("fieldset");
    expect(el.props.className).toContain("border-0");
    const [legend] = el.props.children;
    expect(legend.props.children).toBe("Contact details");
    expect(legend.props.className).toContain("uppercase");
    expect(legend.props.className).toContain("text-muted-foreground");
  });
});

describe("FormActions", () => {
  it("is a left-aligned flex row by default", () => {
    const el = FormActions({ children: null });
    expect(el.props.className).toContain("flex");
    expect(el.props.className).not.toContain("justify-end");
  });

  it("right-aligns when align=end", () => {
    expect(FormActions({ children: null, align: "end" }).props.className).toContain(
      "justify-end",
    );
  });
});
