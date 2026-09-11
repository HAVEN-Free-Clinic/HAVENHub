import { describe, it, expect } from "vitest";
import { detectLocationPlatform, locationUnblockSteps, type LocationPlatform } from "./location-help";

const UA = {
  iphoneSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
  iphoneChrome:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/138.0.7204.156 Mobile/15E148 Safari/604.1",
  iphoneFirefox:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/141.0 Mobile/15E148 Safari/605.1.15",
  macSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15",
  android:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36",
  windows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
};

const ALL: LocationPlatform[] = ["ios-safari", "ios-chrome", "ios-other", "android", "desktop"];

describe("detectLocationPlatform", () => {
  it.each<[string, string, number, LocationPlatform]>([
    ["Safari on iPhone", UA.iphoneSafari, 5, "ios-safari"],
    ["Chrome on iPhone", UA.iphoneChrome, 5, "ios-chrome"],
    ["Firefox on iPhone", UA.iphoneFirefox, 5, "ios-other"],
    // iPadOS Safari asks for the desktop site by default and sends a Mac user
    // agent; touch support is the only tell.
    ["Safari on iPad, which claims to be a Mac", UA.macSafari, 5, "ios-safari"],
    ["a real Mac", UA.macSafari, 0, "desktop"],
    ["Chrome on Android", UA.android, 5, "android"],
    ["Chrome on Windows", UA.windows, 0, "desktop"],
  ])("recognises %s", (_label, ua, touchPoints, expected) => {
    expect(detectLocationPlatform(ua, touchPoints)).toBe(expected);
  });
});

describe("locationUnblockSteps", () => {
  it.each(ALL)("gives %s steps that end with reloading the page", (platform) => {
    const steps = locationUnblockSteps(platform);
    expect(steps.length).toBeGreaterThan(1);
    expect(steps.at(-1)).toMatch(/reload/i);
  });

  it.each<LocationPlatform>(["ios-safari", "ios-chrome", "ios-other"])(
    "tells %s to check the phone-wide Location Services switch",
    (platform) => {
      // With Location Services off, iOS answers every site with a flat denial,
      // indistinguishable from the volunteer having tapped "Don't Allow".
      expect(locationUnblockSteps(platform).join(" ")).toMatch(/Location Services/);
    },
  );

  it("points Safari users at both the Safari Websites switch and the per-site setting", () => {
    const text = locationUnblockSteps("ios-safari").join(" ");
    expect(text).toMatch(/Safari Websites/);
    expect(text).toMatch(/Website Settings/);
  });

  it("points Chrome on iPhone users at Chrome's own location permission", () => {
    expect(locationUnblockSteps("ios-chrome").join(" ")).toMatch(/Settings > Chrome > Location/);
  });
});
