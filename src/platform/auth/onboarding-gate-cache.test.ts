import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isGateClearedCached,
  markGateCleared,
  _resetOnboardingGateCache,
} from "./onboarding-gate-cache";

afterEach(() => {
  _resetOnboardingGateCache();
  vi.useRealTimers();
});

describe("onboarding gate cache", () => {
  it("reports not-cleared for an unseen person", () => {
    expect(isGateClearedCached("p1")).toBe(false);
  });

  it("reports cleared after marking", () => {
    markGateCleared("p1");
    expect(isGateClearedCached("p1")).toBe(true);
  });

  it("scopes clearance per person", () => {
    markGateCleared("p1");
    expect(isGateClearedCached("p2")).toBe(false);
  });

  it("keeps the clearance just under the TTL", () => {
    vi.useFakeTimers();
    markGateCleared("p1");
    vi.advanceTimersByTime(5 * 60_000 - 1);
    expect(isGateClearedCached("p1")).toBe(true);
  });

  it("expires the clearance after the TTL", () => {
    vi.useFakeTimers();
    markGateCleared("p1");
    vi.advanceTimersByTime(5 * 60_000 + 1);
    expect(isGateClearedCached("p1")).toBe(false);
  });

  it("reset clears all entries", () => {
    markGateCleared("p1");
    _resetOnboardingGateCache();
    expect(isGateClearedCached("p1")).toBe(false);
  });
});
