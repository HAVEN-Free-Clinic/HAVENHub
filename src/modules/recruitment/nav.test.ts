import { describe, it, expect } from "vitest";
import { recruitmentNavItems, MY_INTERVIEWS_NAV_ITEM } from "./nav";

const STAFF_NAV = [{ label: "Cycles", href: "/recruitment" }];

describe("recruitmentNavItems", () => {
  it("shows only the staff nav for a non-panelist staffer", () => {
    expect(recruitmentNavItems({ staffNav: STAFF_NAV, isPanelist: false })).toEqual(STAFF_NAV);
  });

  it("appends My interviews after the staff nav for a staffer who is also a panelist", () => {
    expect(recruitmentNavItems({ staffNav: STAFF_NAV, isPanelist: true })).toEqual([
      ...STAFF_NAV,
      MY_INTERVIEWS_NAV_ITEM,
    ]);
  });

  it("shows only My interviews for a non-staff panelist", () => {
    expect(recruitmentNavItems({ staffNav: [], isPanelist: true })).toEqual([MY_INTERVIEWS_NAV_ITEM]);
  });

  it("shows nothing for a non-staff non-panelist", () => {
    expect(recruitmentNavItems({ staffNav: [], isPanelist: false })).toEqual([]);
  });

  it("does not mutate the passed staff nav", () => {
    const staffNav = [{ label: "Cycles", href: "/recruitment" }];
    recruitmentNavItems({ staffNav, isPanelist: true });
    expect(staffNav).toEqual([{ label: "Cycles", href: "/recruitment" }]);
  });
});
