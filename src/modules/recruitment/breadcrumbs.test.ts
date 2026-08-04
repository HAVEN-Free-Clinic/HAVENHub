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

describe("cycleTrail overview link", () => {
  // The cycle SUBTREE gate admits committee scorers and department-scoped
  // reviewers who lack recruitment.access, but the overview enforces it. Three
  // pages inside a cycle are reachable without it (Applicants, an applicant
  // detail, Speed route), so on those the cycle crumb must not link there.
  it("links the cycle crumb to the overview by default", () => {
    const trail = cycleTrail({ cycleId: "c1", cycleTitle: "Fall 2026" });
    expect(trail.at(-1)).toEqual({ label: "Fall 2026", href: "/recruitment/cycles/c1" });
  });

  it("drops the overview link for a viewer who cannot open it", () => {
    const trail = cycleTrail({ cycleId: "c1", cycleTitle: "Fall 2026", canOpenOverview: false });
    expect(trail.at(-1)).toEqual({ label: "Fall 2026" });
  });

  it("keeps the section crumb navigable when the overview link is dropped", () => {
    // Losing the overview link must not strand the viewer: the section crumb
    // below it is their step back up.
    const trail = cycleTrail({
      cycleId: "c1",
      cycleTitle: "Fall 2026",
      section: { label: "Applicants", slug: "applicants" },
      leaf: "Dee Volunteer",
      canOpenOverview: false,
    });
    expect(trail).toEqual([
      HUB,
      REC,
      { label: "Fall 2026" },
      { label: "Applicants", href: "/recruitment/cycles/c1/applicants" },
      { label: "Dee Volunteer" },
    ]);
  });

  it("never emits an overview href anywhere in the trail when the viewer lacks access", () => {
    const trail = cycleTrail({
      cycleId: "c1",
      cycleTitle: "Fall 2026",
      section: { label: "Speed route", slug: "speed-route" },
      canOpenOverview: false,
    });
    expect(trail.some((c) => c.href === "/recruitment/cycles/c1")).toBe(false);
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
