import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LastLoginPanel } from "./last-login-panel";

const BASE = {
  lastLoginAt: new Date("2026-08-01T14:30:00Z"),
  lastLoginUserAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  lastLoginCity: "New Haven",
  lastLoginCountry: "US",
};

describe("LastLoginPanel", () => {
  it("shows the parsed browser rather than the raw user agent", () => {
    const out = renderToStaticMarkup(<LastLoginPanel person={BASE} />);
    expect(out).toContain("Safari 18 on iPhone");
    expect(out).not.toContain("AppleWebKit");
  });

  it("shows the city and country", () => {
    const out = renderToStaticMarkup(<LastLoginPanel person={BASE} />);
    expect(out).toContain("New Haven");
    expect(out).toContain("US");
  });

  // Absence has a real meaning (never signed in, or not since this shipped), so
  // a blank row would read like a bug.
  it("says so explicitly when there is no sign-in on record", () => {
    const out = renderToStaticMarkup(
      <LastLoginPanel
        person={{
          lastLoginAt: null,
          lastLoginUserAgent: null,
          lastLoginCity: null,
          lastLoginCountry: null,
        }}
      />
    );
    expect(out).toContain("No sign-in recorded");
  });

  // Local sign-ins carry no geo headers, so this is the normal shape in dev.
  it("omits location entirely when it was not captured", () => {
    const out = renderToStaticMarkup(
      <LastLoginPanel person={{ ...BASE, lastLoginCity: null, lastLoginCountry: null }} />
    );
    expect(out).toContain("Safari 18 on iPhone");
    expect(out).not.toContain("Location");
  });

  it("still renders the timestamp when the user agent was not captured", () => {
    const out = renderToStaticMarkup(
      <LastLoginPanel person={{ ...BASE, lastLoginUserAgent: null }} />
    );
    expect(out).toContain("2026-08-01 14:30");
    expect(out).not.toContain("Browser");
  });
});
