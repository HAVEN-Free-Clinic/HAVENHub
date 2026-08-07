import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CalendarSubscribeCard, googleCalendarUrl } from "./calendar-subscribe-card";

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
  it("points Google at the encoded feed URL", () => {
    expect(googleCalendarUrl(FEED_URL)).toBe(
      "https://www.google.com/calendar/render?cid=https%3A%2F%2Fhub.example.org%2Fapi%2Fcalendar%2Fabc.ics",
    );
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
