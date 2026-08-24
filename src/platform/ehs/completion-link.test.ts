import { describe, expect, it } from "vitest";
import { ehsCompletionLabel, ehsCompletionUrl, externalSystemName } from "./completion-link";
import { HEALTH_ON_TRACK_URL, WORKDAY_LEARNING_URL } from "@/platform/external-links";

describe("ehsCompletionUrl", () => {
  it("is null when there is nothing for the member to go and do", () => {
    // "Added to EHS?" is a coordinator's record, not a task, so it earns no CTA.
    expect(ehsCompletionUrl(null)).toBeNull();
    expect(ehsCompletionUrl(undefined)).toBeNull();
    expect(ehsCompletionUrl("   ")).toBeNull();
  });

  it("keeps the training's own link", () => {
    expect(ehsCompletionUrl(HEALTH_ON_TRACK_URL)).toBe(HEALTH_ON_TRACK_URL);
  });
});

describe("externalSystemName", () => {
  it("names the systems the app links to", () => {
    expect(externalSystemName(HEALTH_ON_TRACK_URL)).toBe("HealthOnTrack");
    expect(externalSystemName(WORKDAY_LEARNING_URL)).toBe("Workday");
  });

  it("returns null for an unknown host or an unparseable URL", () => {
    expect(externalSystemName("https://example.org/thing")).toBeNull();
    expect(externalSystemName("not a url")).toBeNull();
  });

  it("does not match a lookalike host that merely contains the name", () => {
    expect(externalSystemName("https://healthontrack.yale.edu.evil.test/")).toBeNull();
  });
});

describe("ehsCompletionLabel", () => {
  it("names the destination so the CTA is not a guess", () => {
    // The whole point of the per-item link: the health requirements are done in
    // HealthOnTrack, and a button reading "Complete in Workday" sent people to the
    // wrong system for exactly the items that were holding up their EHS clearance.
    expect(ehsCompletionLabel(HEALTH_ON_TRACK_URL)).toBe("Complete in HealthOnTrack");
    expect(ehsCompletionLabel(WORKDAY_LEARNING_URL)).toBe("Complete in Workday");
  });

  it("stays generic for a link it cannot name", () => {
    expect(ehsCompletionLabel("https://example.org/thing")).toBe("Complete");
  });
});
