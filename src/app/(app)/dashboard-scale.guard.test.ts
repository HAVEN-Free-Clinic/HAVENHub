import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buttonClasses } from "@/platform/ui/button";

/**
 * The hub landing page ran its own type and button scale: an h1 a step larger
 * than every other page's, and three calls to action whose geometry was typed
 * out by hand (`px-4 py-2.5` where the house `md` size is `px-4 py-2`).
 *
 * The white-on-brand one is genuinely correct -- it sits ON a filled brand
 * surface -- which is why it became a Button variant rather than being flattened
 * into `primary`.
 */
const PAGE = "src/app/(app)/page.tsx";

describe("the hub landing page", () => {
  it("uses the same h1 size as every other page", () => {
    expect(readFileSync(PAGE, "utf8")).not.toContain("text-3xl");
  });

  it("has no hand-rolled CTA geometry left", () => {
    // There were THREE, not two: two brand-filled links with the identical
    // class string plus the white one.
    const src = readFileSync(PAGE, "utf8");
    expect(src).not.toContain("rounded-lg bg-brand px-4 py-2.5");
    expect(src).not.toContain("rounded-lg bg-white px-4 py-2.5");
  });

  it("takes the house geometry, which is py-2 rather than py-2.5", () => {
    expect(buttonClasses("primary", "md")).toContain("px-4 py-2");
    expect(buttonClasses("primary", "md")).not.toContain("py-2.5");
  });

  it("has an inverse variant that is white on brand, not brand on white", () => {
    expect(buttonClasses("inverse", "md")).toContain("bg-white");
    expect(buttonClasses("inverse", "md")).toContain("text-brand");
  });
});
