import { describe, expect, it } from "vitest";
import { shouldShowMaintenanceBanner } from "./banner-mount";

const on = { enabled: true, isMaintenancePath: false, holdsBypass: true };

describe("shouldShowMaintenanceBanner", () => {
  it("mounts for someone browsing the hub during a window", () => {
    expect(shouldShowMaintenanceBanner(on)).toBe(true);
  });

  it("never mounts while the switch is off", () => {
    expect(shouldShowMaintenanceBanner({ ...on, enabled: false })).toBe(false);
  });

  it("stays off the maintenance page, which says all of this at full size", () => {
    expect(shouldShowMaintenanceBanner({ ...on, isMaintenancePath: true })).toBe(false);
  });

  it("never shows to someone without the bypass grant", () => {
    // The case that matters: the surfaces still reachable during a window are
    // /login (any member or applicant) and /credential/[token] (anyone at all,
    // including outside the clinic). None of them are the banner's audience.
    expect(shouldShowMaintenanceBanner({ ...on, holdsBypass: false })).toBe(false);
  });
});
