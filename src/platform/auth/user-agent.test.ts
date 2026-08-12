import { describe, expect, it } from "vitest";
import { describeUserAgent } from "./user-agent";

describe("describeUserAgent", () => {
  it("names Chrome on Windows", () => {
    expect(
      describeUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
      )
    ).toBe("Chrome 131 on Windows");
  });

  it("names Safari on iPhone", () => {
    expect(
      describeUserAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1"
      )
    ).toBe("Safari 18 on iPhone");
  });

  it("names Safari on macOS", () => {
    expect(
      describeUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15"
      )
    ).toBe("Safari 17 on macOS");
  });

  it("names Firefox on macOS", () => {
    expect(
      describeUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0"
      )
    ).toBe("Firefox 133 on macOS");
  });

  it("names Edge, and does not mistake it for Chrome", () => {
    expect(
      describeUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0"
      )
    ).toBe("Edge 131 on Windows");
  });

  it("names Chrome on Android", () => {
    expect(
      describeUserAgent(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"
      )
    ).toBe("Chrome 131 on Android");
  });

  // An admin triaging a ticket is better served by the raw string than by the
  // word "Unknown", which tells them nothing they can act on.
  it("falls back to the raw string when it recognizes nothing", () => {
    expect(describeUserAgent("SomeInternalCrawler/2.0")).toBe("SomeInternalCrawler/2.0");
  });

  it("returns null for null, undefined, and blank input", () => {
    expect(describeUserAgent(null)).toBeNull();
    expect(describeUserAgent(undefined)).toBeNull();
    expect(describeUserAgent("   ")).toBeNull();
  });
});
