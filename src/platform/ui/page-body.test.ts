import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { PageBody } from "./page-body";

const render = (props: Parameters<typeof PageBody>[0]) =>
  renderToStaticMarkup(createElement(PageBody, props));

/**
 * Class strings pinned exactly, the same way section-header.test.tsx pins its
 * levels: the point of the token is that two pages asking for the same thing get
 * the same measure, and an assertion on "contains max-w" would not catch one of
 * them drifting to a neighbouring step.
 */
describe("PageBody widths", () => {
  it("gives each width exactly one measure", () => {
    expect(render({ width: "form", children: "x" })).toContain("max-w-2xl");
    expect(render({ width: "content", children: "x" })).toContain("max-w-3xl");
    expect(render({ width: "wide", children: "x" })).toContain("max-w-4xl");
  });

  it("declines to narrow at `full` rather than setting its own bound", () => {
    // AppShell already caps the main column. A max-w here would be a second
    // opinion about the same edge.
    expect(render({ width: "full", children: "x" })).not.toContain("max-w");
  });

  it("keeps the four widths distinct, which is the whole point of naming them", () => {
    const seen = (["form", "content", "wide", "full"] as const).map((w) =>
      render({ width: w, children: "x" }),
    );
    expect(new Set(seen).size).toBe(4);
  });
});

describe("PageBody gaps", () => {
  it("spaces sections by default and can stand them further apart", () => {
    expect(render({ children: "x" })).toContain("space-y-6");
    expect(render({ gap: "loose", children: "x" })).toContain("space-y-8");
  });

  it("adds no gap at all when the page owns its own spacing", () => {
    expect(render({ gap: "none", children: "x" })).not.toContain("space-y");
  });
});

describe("PageBody className", () => {
  it("appends, so a caller can add outer classes", () => {
    const out = render({ width: "form", className: "mt-8", children: "x" });
    expect(out).toContain("max-w-2xl");
    expect(out).toContain("mt-8");
  });
});
