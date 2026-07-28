import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TabRow, type TabItem } from "./tab-row";

const ITEMS: TabItem[] = [
  { label: "Overview", href: "/x" },
  { label: "Applicants", href: "/x/applicants" },
];

describe("TabRow", () => {
  it("renders one link per item", () => {
    const out = renderToStaticMarkup(
      <TabRow items={ITEMS} isActive={() => false} label="Cycle" />,
    );
    expect(out).toContain('href="/x"');
    expect(out).toContain('href="/x/applicants"');
  });

  it("marks the active item with aria-current so it is not colour-only", () => {
    const out = renderToStaticMarkup(
      <TabRow items={ITEMS} isActive={(i) => i.href === "/x/applicants"} label="Cycle" />,
    );
    expect(out).toContain('aria-current="page"');
  });

  it("names the nav landmark, so stacked rows are distinguishable to a screen reader", () => {
    const out = renderToStaticMarkup(
      <TabRow items={ITEMS} isActive={() => false} label="Cycle sections" />,
    );
    expect(out).toContain('aria-label="Cycle sections"');
  });

  it("renders nothing when there are no items", () => {
    expect(renderToStaticMarkup(<TabRow items={[]} isActive={() => false} label="Empty" />)).toBe("");
  });

  it("renders a badge count when supplied", () => {
    const out = renderToStaticMarkup(
      <TabRow items={[{ label: "Approvals", href: "/a", badge: 3 }]} isActive={() => false} label="X" />,
    );
    expect(out).toContain("3");
  });

  it("uses distinct markup for the two variants", () => {
    const underline = renderToStaticMarkup(
      <TabRow items={ITEMS} isActive={(i) => i.href === "/x"} label="X" variant="underline" />,
    );
    const segmented = renderToStaticMarkup(
      <TabRow items={ITEMS} isActive={(i) => i.href === "/x"} label="X" variant="segmented" />,
    );
    expect(underline).not.toBe(segmented);
  });
});
