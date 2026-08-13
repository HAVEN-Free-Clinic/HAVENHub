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

/** What the page resolves via getDisplayTimeZone(). */
const ZONE = "America/New_York";

describe("LastLoginPanel", () => {
  it("shows the parsed browser rather than the raw user agent", () => {
    const out = renderToStaticMarkup(<LastLoginPanel person={BASE} timeZone={ZONE} />);
    expect(out).toContain("Safari 18 on iPhone");
    expect(out).not.toContain("AppleWebKit");
  });

  it("shows the city and country", () => {
    const out = renderToStaticMarkup(<LastLoginPanel person={BASE} timeZone={ZONE} />);
    expect(out).toContain("New Haven");
    expect(out).toContain("US");
  });

  // 14:30 UTC is 10:30 AM in New York during daylight time. Asserting the whole
  // rendered string, including the zone abbreviation, so a regression to UTC or
  // to 24-hour fails here rather than only looking subtly wrong to an admin.
  //
  // Not asserting the absence of "14:30": the <time dateTime> attribute
  // correctly carries the full ISO instant, which contains it. That attribute is
  // the machine-readable value and should stay in UTC.
  it("renders the time in the configured zone, in 12-hour form", () => {
    const out = renderToStaticMarkup(<LastLoginPanel person={BASE} timeZone={ZONE} />);
    expect(out).toContain("Aug 1, 2026");
    expect(out).toContain("10:30 AM EDT");
    expect(out).not.toContain(" UTC");
  });

  // The zone is a prop, not a constant, so a configured non-Eastern zone works.
  it("honors a different configured zone", () => {
    const out = renderToStaticMarkup(<LastLoginPanel person={BASE} timeZone="America/Los_Angeles" />);
    expect(out).toContain("7:30");
    expect(out).toContain("AM");
    expect(out).toContain("PDT");
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
        timeZone={ZONE}
      />
    );
    expect(out).toContain("No sign-in recorded");
  });

  // Local sign-ins carry no geo headers, so this is the normal shape in dev.
  it("omits location entirely when it was not captured", () => {
    const out = renderToStaticMarkup(
      <LastLoginPanel
        person={{ ...BASE, lastLoginCity: null, lastLoginCountry: null }}
        timeZone={ZONE}
      />
    );
    expect(out).toContain("Safari 18 on iPhone");
    expect(out).not.toContain("Location");
  });

  it("still renders the timestamp when the user agent was not captured", () => {
    const out = renderToStaticMarkup(
      <LastLoginPanel person={{ ...BASE, lastLoginUserAgent: null }} timeZone={ZONE} />
    );
    expect(out).toContain("10:30");
    expect(out).not.toContain("Browser");
  });
});
