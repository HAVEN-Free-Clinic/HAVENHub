import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Award, ShieldCheck } from "lucide-react";
import { StatusBanner } from "./status-banner";

const render = (node: React.ReactElement) => renderToStaticMarkup(node);

/**
 * Exact class strings, pinned deliberately. Two pages drew this banner a pixel
 * apart on both lines -- /training at text-lg over text-sm, /my-info at
 * text-[17px] over text-[13px] with a rounded-[13px] chip -- which reads as a
 * rendering bug rather than a decision. Asserting the strings is what stops a
 * caller reintroducing a near-miss.
 */
describe("StatusBanner", () => {
  it("uses the token scale, not the arbitrary pixels it replaced", () => {
    const out = render(
      <StatusBanner tone="success" icon={Award} eyebrow="Cleared" title="All set" description="Done." />,
    );
    expect(out).toContain("text-lg font-bold tracking-tight text-foreground");
    expect(out).toContain("text-sm leading-snug text-foreground-soft");
    expect(out).toContain("rounded-xl");
    // The two /my-info was using. Neither is on any scale this app has.
    expect(out).not.toContain("text-[17px]");
    expect(out).not.toContain("text-[13px]");
    expect(out).not.toContain("rounded-[13px]");
  });

  it("puts the vivid token on the chip and the AA pair on the eyebrow", () => {
    // The house rule, and a contrast requirement rather than a preference: the
    // vivid tokens clear 3:1 and are for icons and fills; text needs the
    // -foreground variant. A swapped mapping is a legibility bug.
    const out = render(<StatusBanner tone="warning" icon={Award} eyebrow="Not yet cleared" title="x" />);
    expect(out).toContain("bg-warning text-white");
    expect(out).toContain("text-warning-foreground");
    expect(out).not.toContain('class="text-xs font-bold uppercase tracking-wider text-warning"');
  });

  it("gives every tone a chip and an eyebrow, so none can fall through", () => {
    for (const tone of ["success", "warning", "critical", "neutral"] as const) {
      const out = render(<StatusBanner tone={tone} icon={Award} eyebrow="x" title="y" />);
      expect(out, tone).toMatch(/bg-(success|warning|critical|muted-strong)/);
      expect(out, tone).toMatch(/text-(success|warning|critical|muted)-foreground/);
    }
  });

  it("stands alone on `card` and attaches on `attached`", () => {
    // attached is the strip on top of a Card that owns the content below it:
    // its own border and radius would read as a second card.
    const card = render(<StatusBanner tone="success" icon={ShieldCheck} eyebrow="a" title="b" />);
    const attached = render(
      <StatusBanner surface="attached" tone="success" icon={ShieldCheck} eyebrow="a" title="b" />,
    );
    expect(card).toContain("rounded-2xl");
    expect(attached).not.toContain("rounded-2xl");
    expect(attached).toContain("border-b border-border bg-muted");
  });

  it("omits the description and the trailing pill when there is none", () => {
    const out = render(<StatusBanner tone="neutral" icon={Award} eyebrow="Not open yet" title="Soon" />);
    expect(out).not.toContain("leading-snug");
    expect(out).not.toContain("rounded-full");
  });
});
