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

  it("is total on empty and malformed input", () => {
    expect(scrubPath("")).toBe("");
    expect(scrubPath("?token=secret")).toBe("?token=[redacted]");
  });

  it("redacts the calendar feed token, a standing credential polled forever", () => {
    expect(scrubPath("/api/calendar/abc123.ics")).toBe("/api/calendar/[redacted]");
  });

  it("redacts the calendar feed token even without the .ics suffix", () => {
    expect(scrubPath("/api/calendar/abc123")).toBe("/api/calendar/[redacted]");
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

  it("redacts the calendar feed token in an absolute URL", () => {
    expect(scrubUrl("https://hub.havenfreeclinic.org/api/calendar/tok123.ics")).toBe(
      "https://hub.havenfreeclinic.org/api/calendar/[redacted]",
    );
  });

  it("is total on empty input", () => {
    expect(scrubUrl("")).toBe("");
  });

  it("redacts a credential nested inside another domain's query string, as in the Google Calendar deep link", () => {
    // The card's "Add to Google" anchor points at
    // https://www.google.com/calendar/render?cid=<encoded feed URL>. The outer
    // path (/calendar/render) and param name (cid) are both innocuous; the
    // token only shows up once the value is decoded.
    const feedUrl = "https://hub.example.org/api/calendar/SUPERSECRETTOKEN.ics";
    const deepLink = `https://www.google.com/calendar/render?cid=${encodeURIComponent(feedUrl)}`;
    const scrubbed = scrubUrl(deepLink);
    expect(scrubbed).not.toContain("SUPERSECRETTOKEN");
    expect(scrubbed).toBe(
      `https://www.google.com/calendar/render?cid=${encodeURIComponent(
        "https://hub.example.org/api/calendar/[redacted]",
      )}`,
    );
  });

  it("does not mangle a scheme-shaped query value into the literal string 'null'", () => {
    // Regression: scrubQueryPair used to run scrubUrl on every decoded query
    // value unconditionally. For any value the URL parser accepts as an
    // opaque (non-special-scheme) URL, `origin` serializes to "null", which
    // silently corrupted ordinary, non-secret values app-wide.
    expect(scrubPath("/x?q=status:ACTIVE")).toBe("/x?q=status:ACTIVE");
    expect(scrubPath("/x?filter=dept:IM,role:VOLUNTEER")).toBe("/x?filter=dept:IM,role:VOLUNTEER");
    expect(scrubPath("/x?mail=mailto:a@b.com")).toBe("/x?mail=mailto:a@b.com");
    expect(scrubPath("/x?ref=tel:+12035551234")).toBe("/x?ref=tel:+12035551234");
  });

  it("does not throw on a deeply pathological URL and stays bounded in size", () => {
    // Regression: scrubPath -> scrubQueryPair -> scrubUrl -> scrubPath was
    // unbounded mutual recursion, O(input length) deep, throwing
    // "Maximum call stack size exceeded" around a 10 KB input.
    const pathological = "https://example.org/x?" + "a=b?".repeat(4000);
    let result = "";
    expect(() => {
      result = scrubUrl(pathological);
    }).not.toThrow();
    // Bounded, not necessarily equal to the input, but not a multi-megabyte
    // blowup either.
    expect(result.length).toBeLessThan(pathological.length * 10);
  });

  it("does not throw when a chain of validly-nested http(s) URLs exceeds the depth cap", () => {
    // Regression: even gating recursion to genuine http(s) URLs (the fix for
    // the "null" mangling defect) still leaves unbounded recursion possible
    // for a deliberately deep chain of legitimately-shaped nested URLs. The
    // depth cap is what actually bounds this, independent of that gate.
    let inner = "https://innermost.example.org/api/calendar/SUPERSECRETTOKEN.ics";
    for (let i = 0; i < 50; i++) {
      inner = `https://layer${i}.example.org/?u=${encodeURIComponent(inner)}`;
    }
    let result = "";
    expect(() => {
      result = scrubUrl(inner);
    }).not.toThrow();
    expect(typeof result).toBe("string");
  });

  it("is total on a value containing a lone surrogate", () => {
    // Regression: encodeURIComponent throws URIError on a lone surrogate
    // that survives decode-then-scrub. The file promises to never throw.
    expect(() => scrubPath("/x?u=%2Fonboard%2Fabc%2F\uD800")).not.toThrow();
  });

  // Regression: the Google deep link had to switch from an https cid to a
  // webcal one (Google reads https as a Google calendar ID, not an external
  // feed). The nested-URL scrub was gated to http/https, so the switch would
  // have silently stopped scrubbing the feed token riding inside the link.
  it("redacts the feed token nested in a webcal Google deep link", () => {
    const link =
      "https://www.google.com/calendar/render?cid=webcal%3A%2F%2Fhub.example.org%2Fapi%2Fcalendar%2FSECRET.ics";

    const scrubbed = scrubUrl(link);

    expect(scrubbed).not.toContain("SECRET");
    expect(scrubbed).toContain("webcal%3A%2F%2Fhub.example.org");
  });

  it("still redacts the token in the older https deep-link form", () => {
    const link =
      "https://www.google.com/calendar/render?cid=https%3A%2F%2Fhub.example.org%2Fapi%2Fcalendar%2FSECRET.ics";

    expect(scrubUrl(link)).not.toContain("SECRET");
  });

  it("preserves the scheme and host of a non-special URL instead of writing 'null'", () => {
    // `URL#origin` is the literal string "null" for any non-special scheme, so
    // reconstructing from it corrupted the value. A real android-app referrer
    // is the common case in the wild.
    expect(scrubUrl("android-app://com.google.android.gm/")).toBe("android-app://com.google.android.gm/");
  });

  it("redacts a bare webcal feed URL", () => {
    expect(scrubUrl("webcal://hub.example.org/api/calendar/SECRET.ics")).toBe(
      "webcal://hub.example.org/api/calendar/[redacted]",
    );
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

  it("scrubs $external_click_url, the autocapture property for a cross-origin anchor click", () => {
    // This is what an $autocapture event carries when a member clicks "Add to
    // Google" on the calendar subscribe card: a google.com URL with their own
    // feed URL (and its live token) embedded in the `cid` param.
    const feedUrl = "https://hub.example.org/api/calendar/SUPERSECRETTOKEN.ics";
    const out = scrubProperties({
      $external_click_url: `https://www.google.com/calendar/render?cid=${encodeURIComponent(feedUrl)}`,
    });
    expect(out.$external_click_url).not.toContain("SUPERSECRETTOKEN");
    expect(JSON.stringify(out)).not.toContain("SUPERSECRETTOKEN");
  });
});
