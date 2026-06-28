import { describe, it, expect } from "vitest";
import { recruitmentTrail, cycleTrail, interviewDetailTrail } from "./breadcrumbs";

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

describe("interviewDetailTrail", () => {
  // The interview detail page lives outside the recruitment-staff gate so panelists
  // can reach it, but it is shared with cycle staff. Each role gets a trail whose
  // links it can actually follow: staff back into the cycle, panelists to their
  // own "My interviews" list (they have no recruitment-module access).
  it("staff viewer: links back into the cycle's interview list", () => {
    expect(
      interviewDetailTrail({ staff: true, cycleId: "c1", cycleTitle: "Fall 2026", candidate: "Jane Doe" }),
    ).toEqual([
      HUB,
      REC,
      { label: "Fall 2026", href: "/recruitment/cycles/c1" },
      { label: "Interviews", href: "/recruitment/cycles/c1/interviews" },
      { label: "Jane Doe" },
    ]);
  });

  it("panelist viewer: links to My interviews, not the gated cycle pages", () => {
    expect(
      interviewDetailTrail({ staff: false, cycleId: "c1", cycleTitle: "Fall 2026", candidate: "Jane Doe" }),
    ).toEqual([
      HUB,
      { label: "My interviews", href: "/recruitment/interviews" },
      { label: "Jane Doe" },
    ]);
  });
});
