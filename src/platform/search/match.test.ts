import { describe, it, expect } from "vitest";
import { matchPages, subsequenceScore } from "./match";
import type { NavModule } from "@/platform/modules/nav";

const ITEMS: NavModule[] = [
  {
    id: "recruitment",
    title: "Recruitment",
    href: "/recruitment",
    nav: [
      { label: "Cycles", href: "/recruitment" },
      { label: "My interviews", href: "/recruitment/interviews" },
    ],
  },
  {
    id: "schedule",
    title: "Schedule",
    href: "/schedule",
    nav: [
      { label: "My schedule", href: "/schedule" },
      { label: "Full schedule", href: "/schedule/full" },
    ],
  },
];

describe("subsequenceScore", () => {
  it("returns null when the needle is not a subsequence", () => {
    expect(subsequenceScore("cycles", "zzz")).toBeNull();
  });
  it("matches a scattered subsequence", () => {
    expect(subsequenceScore("speed route", "spdrt")).not.toBeNull();
  });
  it("is case insensitive", () => {
    expect(subsequenceScore("Cycles", "cyc")).not.toBeNull();
  });
  it("scores a contiguous prefix better (lower) than a scattered match", () => {
    const prefix = subsequenceScore("schedule", "sch")!;
    const scattered = subsequenceScore("speed check", "sch")!;
    expect(prefix).toBeLessThan(scattered);
  });
});

describe("matchPages", () => {
  it("finds a sub-page by its label", () => {
    const hits = matchPages(ITEMS, "interviews");
    expect(hits[0].href).toBe("/recruitment/interviews");
    expect(hits[0].group).toBe("Recruitment");
  });

  it("matches on the owning module title too, so 'recruitment' surfaces its pages", () => {
    const hits = matchPages(ITEMS, "recruit");
    expect(hits.some((h) => h.href === "/recruitment/interviews")).toBe(true);
  });

  it("includes the module root itself as a hit", () => {
    const hits = matchPages(ITEMS, "schedule");
    expect(hits.some((h) => h.href === "/schedule" && h.label === "Schedule")).toBe(true);
  });

  it("returns nothing for a query that matches nothing", () => {
    expect(matchPages(ITEMS, "zzzzz")).toEqual([]);
  });

  it("never returns a page the caller did not supply, since items are already permission-filtered", () => {
    const hits = matchPages(ITEMS, "e");
    const allowed = new Set(["/recruitment", "/recruitment/interviews", "/schedule", "/schedule/full"]);
    for (const h of hits) expect(allowed.has(h.href)).toBe(true);
  });

  it("honours the limit", () => {
    expect(matchPages(ITEMS, "e", 2)).toHaveLength(2);
  });

  it("deduplicates when a sub-item href equals the module root", () => {
    // Recruitment's "Cycles" points at /recruitment, same as the module root.
    const hits = matchPages(ITEMS, "recruitment");
    const roots = hits.filter((h) => h.href === "/recruitment");
    expect(roots).toHaveLength(1);
  });
});
