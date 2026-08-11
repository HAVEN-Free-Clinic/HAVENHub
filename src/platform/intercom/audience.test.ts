import { describe, it, expect } from "vitest";
import { buildAudienceAttributes, HUB_AUDIENCE_ATTRIBUTES } from "./audience";

describe("buildAudienceAttributes", () => {
  it("sets a flag when the person holds its permission", () => {
    const attrs = buildAudienceAttributes(new Set(["admin.access"]));

    expect(attrs["Hub admin access"]).toBe(true);
  });

  /**
   * The load-bearing one. Intercom MERGES custom attributes onto the contact, so
   * an omitted key keeps its previous value. If false flags were dropped to keep
   * the token small, a demoted director would keep "Hub admin access": true
   * forever and keep seeing admin articles. Sending false is the revocation.
   */
  it("emits every flag including the false ones, so revoked access is cleared", () => {
    const attrs = buildAudienceAttributes(new Set(["admin.access"]));

    expect(Object.keys(attrs).sort()).toEqual(HUB_AUDIENCE_ATTRIBUTES.map((a) => a.key).sort());
    expect(attrs["Hub recruitment access"]).toBe(false);
    expect(attrs["Hub support manage"]).toBe(false);
  });

  it("emits all seven as false for a person with no permissions", () => {
    const attrs = buildAudienceAttributes(new Set());

    expect(Object.values(attrs)).toHaveLength(HUB_AUDIENCE_ATTRIBUTES.length);
    expect(Object.values(attrs).every((v) => v === false)).toBe(true);
  });

  it("treats a wildcard grant as holding every permission", () => {
    const attrs = buildAudienceAttributes(new Set(["*"]));

    expect(Object.values(attrs).every((v) => v === true)).toBe(true);
  });

  it("sets a multi-permission flag when the person holds either permission", () => {
    const viaManage = buildAudienceAttributes(new Set(["incidents.manage"]));
    const viaStrikes = buildAudienceAttributes(new Set(["incidents.view_strikes"]));

    expect(viaManage["Hub incidents access"]).toBe(true);
    expect(viaStrikes["Hub incidents access"]).toBe(true);
  });

  /**
   * The keys are the contract with the Intercom workspace: segments are built on
   * these exact strings, spaces and capital H included. Renaming one here would
   * silently detach every segment filtering on it, so pin them.
   */
  it("uses the exact attribute keys the Intercom workspace was configured with", () => {
    expect(HUB_AUDIENCE_ATTRIBUTES.map((a) => a.key)).toEqual([
      "Hub admin access",
      "Hub recruitment access",
      "Hub incidents access",
      "Hub volunteers access",
      "Hub schedule manage",
      "Hub learning manage",
      "Hub support manage",
    ]);
  });
});
