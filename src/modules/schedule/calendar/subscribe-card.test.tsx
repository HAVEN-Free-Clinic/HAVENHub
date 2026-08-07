import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CalendarSubscribeCard, googleCalendarUrl } from "./subscribe-card";

const noop = async () => {};
const FEED_URL = "https://hub.example.org/api/calendar/abc.ics";

type Props = Parameters<typeof CalendarSubscribeCard>[0];

function html(overrides: Partial<Props> = {}): string {
  return renderToStaticMarkup(
    <CalendarSubscribeCard
      feedUrl={FEED_URL}
      lastFetchedAt={null}
      timeZone="America/New_York"
      generateAction={noop}
      resetAction={noop}
      {...overrides}
    />,
  );
}

describe("googleCalendarUrl", () => {
  // Regression: with an https cid, Google treats the value as a Google calendar
  // ID to look up rather than an external feed to subscribe to, and fails with
  // "Unable to add calendar. Check the URL." even when the feed is publicly
  // reachable and valid. Verified in production: pasting the same URL into
  // Settings > Add calendar > From URL worked while this deep link did not.
  it("carries the feed as a webcal URL, not https", () => {
    expect(googleCalendarUrl(FEED_URL)).toBe(
      "https://www.google.com/calendar/render?cid=webcal%3A%2F%2Fhub.example.org%2Fapi%2Fcalendar%2Fabc.ics",
    );
  });

  it("rewrites only the scheme, preserving host, path, and the .ics suffix", () => {
    const decoded = decodeURIComponent(googleCalendarUrl(FEED_URL).split("cid=")[1]!);
    expect(decoded).toBe("webcal://hub.example.org/api/calendar/abc.ics");
  });

  it("rewrites a plain http feed URL too, so a non-TLS deployment still subscribes", () => {
    const decoded = decodeURIComponent(
      googleCalendarUrl("http://localhost:3000/api/calendar/abc.ics").split("cid=")[1]!,
    );
    expect(decoded).toBe("webcal://localhost:3000/api/calendar/abc.ics");
  });

  it("leaves a token containing https-like text alone", () => {
    const decoded = decodeURIComponent(
      googleCalendarUrl("https://hub.example.org/api/calendar/ahttps-b.ics").split("cid=")[1]!,
    );
    expect(decoded).toBe("webcal://hub.example.org/api/calendar/ahttps-b.ics");
  });
});

describe("CalendarSubscribeCard", () => {
  it("offers to generate a link when the member has none", () => {
    const markup = html({ feedUrl: null });
    expect(markup).toContain("Generate link");
    expect(markup).not.toContain("Reset link");
  });

  it("does not render any feed address before one exists", () => {
    expect(html({ feedUrl: null })).not.toContain("/api/calendar/");
  });

  it("shows the URL and both actions once a link exists", () => {
    const markup = html();
    expect(markup).toContain(`value="${FEED_URL}"`);
    expect(markup).toContain("Reset link");
    expect(markup).toContain("Add to Google");
  });

  it("links out to Google with the encoded feed URL", () => {
    expect(html()).toContain(googleCalendarUrl(FEED_URL).replace(/&/g, "&amp;"));
  });

  it("marks the Google anchor ph-no-capture so its token-bearing href never reaches autocapture or replay", () => {
    const markup = html();
    const anchorStart = markup.indexOf("<a ");
    const anchorEnd = markup.indexOf(">", anchorStart);
    expect(markup.slice(anchorStart, anchorEnd)).toContain("ph-no-capture");
  });

  it("wraps the feed URL field in ph-no-capture so its token value is out of autocapture and masked in replay", () => {
    const markup = html();
    const wrapperIndex = markup.indexOf('<div class="ph-no-capture');
    const inputIndex = markup.indexOf('id="calendar-feed-url"');
    expect(wrapperIndex).toBeGreaterThan(-1);
    expect(wrapperIndex).toBeLessThan(inputIndex);
  });

  it("always discloses that Google refreshes on its own schedule", () => {
    expect(html()).toContain("its own timing");
  });

  it("reports the last fetch when one has happened", () => {
    expect(html({ lastFetchedAt: new Date("2026-08-06T15:00:00Z") })).toContain("Last checked");
  });

  it("says so when nothing has fetched the feed yet", () => {
    expect(html()).toContain("has not been checked yet");
  });
});
