import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TextLink } from "./text-link";

const render = (node: React.ReactElement) => renderToStaticMarkup(node);

describe("TextLink", () => {
  it("uses the brand token that lifts in dark mode, never the flat one", () => {
    // This is the bug the primitive exists to end: --color-brand is Yale Blue in
    // BOTH themes, and only --color-brand-fg is lifted for dark (globals.css).
    // Three links shipped on the flat token and were near-invisible on the dark
    // canvas, including the only way out of the check-in kiosk.
    const out = render(<TextLink href="/x">Check in</TextLink>);
    expect(out).toContain("text-brand-fg");
    expect(out).not.toMatch(/class="[^"]*\btext-brand\b(?!-)/);
  });

  it("carries the house focus ring, which most hand-rolled links omitted", () => {
    const out = render(<TextLink href="/x">Link</TextLink>);
    expect(out).toContain("focus-visible:outline-2");
    expect(out).toContain("focus-visible:outline-brand");
  });

  it("sets no font size by default, so a caller's size cannot lose a specificity race", () => {
    // No tailwind-merge in this repo: if the base declared a size, an override of
    // the same property would be emission-order unreliable.
    const out = render(<TextLink href="/x">Link</TextLink>);
    expect(out).not.toContain("text-xs");
    expect(out).not.toContain("text-sm");
  });

  it("applies a size only when asked", () => {
    expect(render(<TextLink href="/x" size="xs">a</TextLink>)).toContain("text-xs");
    expect(render(<TextLink href="/x" size="sm">a</TextLink>)).toContain("text-sm");
  });

  it("renders an internal link as a real href", () => {
    const out = render(<TextLink href="/recruitment/events">Events</TextLink>);
    expect(out).toContain('href="/recruitment/events"');
    expect(out).toContain("<a ");
  });

  it("gives an external link the safe rel pair", () => {
    const out = render(
      <TextLink href="https://example.org" external>
        Policy
      </TextLink>,
    );
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noreferrer noopener"');
  });

  it("does not open internal links in a new tab", () => {
    const out = render(<TextLink href="/x">Link</TextLink>);
    expect(out).not.toContain('target="_blank"');
  });

  it("takes layout classes from the caller without dropping its own", () => {
    const out = render(
      <TextLink href="/x" className="mt-2 inline-block">
        Link
      </TextLink>,
    );
    expect(out).toContain("mt-2");
    expect(out).toContain("inline-block");
    expect(out).toContain("underline");
    expect(out).toContain("text-brand-fg");
  });
});
