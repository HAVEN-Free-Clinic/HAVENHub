import { describe, it, expect } from "vitest";
import { recruitmentNavItems, MY_INTERVIEWS_NAV_ITEM, recruitmentGlobalNav } from "./nav";

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

describe("recruitmentGlobalNav", () => {
  it("gives a bare panelist (no scope, no recruitment.access) the recruitment module id AND My interviews", () => {
    expect(recruitmentGlobalNav({ isReviewer: false, isPanelist: true })).toEqual({
      extraModuleIds: ["recruitment"],
      extraNavItems: { recruitment: [MY_INTERVIEWS_NAV_ITEM] },
    });
  });

  it("gives a scope reviewer who is not a panelist the module id but no My interviews item", () => {
    expect(recruitmentGlobalNav({ isReviewer: true, isPanelist: false })).toEqual({
      extraModuleIds: ["recruitment"],
      extraNavItems: {},
    });
  });

  it("gives someone who is neither a reviewer nor a panelist nothing", () => {
    expect(recruitmentGlobalNav({ isReviewer: false, isPanelist: false })).toEqual({
      extraModuleIds: [],
      extraNavItems: {},
    });
  });

  it("does not duplicate the recruitment module id for someone who is both a reviewer and a panelist", () => {
    const result = recruitmentGlobalNav({ isReviewer: true, isPanelist: true });
    expect(result.extraModuleIds).toEqual(["recruitment"]);
    expect(result.extraNavItems).toEqual({ recruitment: [MY_INTERVIEWS_NAV_ITEM] });
  });
});
