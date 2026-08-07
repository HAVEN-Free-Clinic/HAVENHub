import { describe, expect, it } from "vitest";
import { scrubPath, scrubProperties, scrubUrl } from "./scrub-url";

describe("scrubPath", () => {
  it("redacts the onboarding token, which is a 21-day standing credential", () => {
    expect(scrubPath("/onboard/abc123def")).toBe("/onboard/[redacted]");
  });

  it("keeps any trailing segment after the onboarding token", () => {
    expect(scrubPath("/onboard/abc123def/review")).toBe("/onboard/[redacted]/review");
  });

  it("redacts the magic-link token but keeps the other params", () => {
    expect(scrubPath("/login/verify?token=secret&next=/schedule")).toBe(
      "/login/verify?token=[redacted]&next=/schedule",
    );
  });

  it("redacts the applicant portal token", () => {
    expect(scrubPath("/apply/verify?token=secret")).toBe("/apply/verify?token=[redacted]");
  });

  it("redacts a token param wherever it appears", () => {
    expect(scrubPath("/anything?a=1&token=secret")).toBe("/anything?a=1&token=[redacted]");
  });

  it("leaves ordinary paths untouched", () => {
    expect(scrubPath("/schedule/requests?termId=abc")).toBe("/schedule/requests?termId=abc");
  });

  it("preserves the fragment", () => {
    expect(scrubPath("/login/verify?token=secret#top")).toBe("/login/verify?token=[redacted]#top");
  });

  it("does not redact a path that merely starts with the same letters", () => {
    expect(scrubPath("/onboarding-help")).toBe("/onboarding-help");
  });

  it("redacts a credential token in the path", () => {
    expect(scrubPath("/credential/abc123def")).toBe("/credential/[redacted]");
  });

  it("is total on empty and malformed input", () => {
    expect(scrubPath("")).toBe("");
    expect(scrubPath("?token=secret")).toBe("?token=[redacted]");
  });
});

describe("scrubUrl", () => {
  it("redacts while preserving the origin", () => {
    expect(scrubUrl("https://hub.havenfreeclinic.org/onboard/tok123")).toBe(
      "https://hub.havenfreeclinic.org/onboard/[redacted]",
    );
    expect(scrubUrl("https://hub.havenfreeclinic.org/login/verify?token=tok123")).toBe(
      "https://hub.havenfreeclinic.org/login/verify?token=[redacted]",
    );
  });

  it("falls back to path handling for a relative value", () => {
    expect(scrubUrl("/onboard/tok123")).toBe("/onboard/[redacted]");
  });

  it("is total on empty input", () => {
    expect(scrubUrl("")).toBe("");
  });
});

describe("scrubProperties", () => {
  it("scrubs every URL-bearing PostHog property", () => {
    const out = scrubProperties({
      $current_url: "https://hub/onboard/tok",
      $pathname: "/onboard/tok",
      $initial_current_url: "https://hub/login/verify?token=tok",
      $referrer: "https://hub/apply/verify?token=tok",
      $session_entry_url: "https://hub/onboard/tok",
      distinct_id: "person_1",
    });
    expect(out.$current_url).toBe("https://hub/onboard/[redacted]");
    expect(out.$pathname).toBe("/onboard/[redacted]");
    expect(out.$initial_current_url).toBe("https://hub/login/verify?token=[redacted]");
    expect(out.$referrer).toBe("https://hub/apply/verify?token=[redacted]");
    expect(out.$session_entry_url).toBe("https://hub/onboard/[redacted]");
    expect(out.distinct_id).toBe("person_1");
  });

  it("leaves non-string and absent properties alone", () => {
    const out = scrubProperties({ $current_url: undefined, count: 3 });
    expect(out.$current_url).toBeUndefined();
    expect(out.count).toBe(3);
  });

  it("never lets a raw token survive in any URL property", () => {
    const out = scrubProperties({
      $current_url: "https://hub/onboard/SUPERSECRET",
      $pathname: "/onboard/SUPERSECRET",
    });
    expect(JSON.stringify(out)).not.toContain("SUPERSECRET");
  });
});
