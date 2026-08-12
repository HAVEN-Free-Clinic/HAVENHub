import { describe, expect, it } from "vitest";
import { shouldMountBlockerGate } from "./gate-mount";

const ON = { supportAppId: "abc123", gateEnabled: true, personExempt: false };

describe("shouldMountBlockerGate", () => {
  it("mounts when the integration is on, the switch is on, and the person is not exempt", () => {
    expect(shouldMountBlockerGate(ON)).toBe(true);
  });

  it("does not mount without an app id, which is what keeps a hard block out of CI and preview", () => {
    expect(shouldMountBlockerGate({ ...ON, supportAppId: null })).toBe(false);
  });

  it("does not mount when ops have stood the gate down globally", () => {
    expect(shouldMountBlockerGate({ ...ON, gateEnabled: false })).toBe(false);
  });

  it("does not mount for an exempted person", () => {
    expect(shouldMountBlockerGate({ ...ON, personExempt: true })).toBe(false);
  });

  it("treats an empty app id as absent, since that is how the e2e web server disables it", () => {
    expect(shouldMountBlockerGate({ ...ON, supportAppId: "" })).toBe(false);
  });

  it("stays off when several switches are off at once", () => {
    expect(
      shouldMountBlockerGate({ supportAppId: null, gateEnabled: false, personExempt: true })
    ).toBe(false);
  });
});
