import { describe, it, expect } from "vitest";
import { recruitmentTrail, cycleTrail } from "./breadcrumbs";

const HUB = { label: "Hub", href: "/" };
const REC = { label: "Recruitment", href: "/recruitment" };

describe("recruitmentTrail", () => {
  it("prepends Hub > Recruitment to the supplied tail", () => {
    expect(recruitmentTrail({ label: "New" })).toEqual([HUB, REC, { label: "New" }]);
  });
  it("supports a multi-crumb tail", () => {
    expect(recruitmentTrail({ label: "Interviews", href: "/recruitment/interviews" })).toEqual([
      HUB,
      REC,
      { label: "Interviews", href: "/recruitment/interviews" },
    ]);
  });
});

describe("cycleTrail", () => {
  it("cycle overview: Hub > Recruitment > {title}", () => {
    expect(cycleTrail({ cycleId: "c1", cycleTitle: "Fall 2026" })).toEqual([
      HUB,
      REC,
      { label: "Fall 2026", href: "/recruitment/cycles/c1" },
    ]);
  });

  it("section page: appends a linked section under the cycle", () => {
    expect(
      cycleTrail({
        cycleId: "c1",
        cycleTitle: "Fall 2026",
        section: { label: "Applicants", slug: "applicants" },
      }),
    ).toEqual([
      HUB,
      REC,
      { label: "Fall 2026", href: "/recruitment/cycles/c1" },
      { label: "Applicants", href: "/recruitment/cycles/c1/applicants" },
    ]);
  });

  it("detail page: appends a section link and a leaf for the current entity", () => {
    expect(
      cycleTrail({
        cycleId: "c1",
        cycleTitle: "Fall 2026",
        section: { label: "Applicants", slug: "applicants" },
        leaf: "Jane Doe",
      }),
    ).toEqual([
      HUB,
      REC,
      { label: "Fall 2026", href: "/recruitment/cycles/c1" },
      { label: "Applicants", href: "/recruitment/cycles/c1/applicants" },
      { label: "Jane Doe" },
    ]);
  });
});
