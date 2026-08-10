import { CalendarPlus } from "lucide-react";
import { Card } from "@/platform/ui/card";
import { Button, buttonClasses } from "@/platform/ui/button";
import { formatDateTime } from "@/platform/dates/format";
import { FeedUrlField } from "./feed-url-field";
import { SectionHeader } from "@/platform/ui/section-header";

type Props = {
  /** Full subscribe URL, or null when the member has not generated one yet. */
  feedUrl: string | null;
  lastFetchedAt: Date | null;
  timeZone: string;
  generateAction: () => Promise<void>;
  resetAction: () => Promise<void>;
};

/**
 * Deep link that opens Google Calendar's add-by-URL flow.
 *
 * The cid MUST carry the webcal scheme, not https. Given an https value Google
 * treats it as a Google calendar ID to look up rather than an external feed to
 * subscribe to, and refuses with "Unable to add calendar. Check the URL." even
 * when the feed is publicly reachable and valid. Confirmed in production:
 * pasting the identical URL into Settings > Add calendar > From URL succeeded
 * while this deep link failed.
 *
 * Only the scheme is rewritten; host, path, and the .ics suffix are untouched.
 */
export function googleCalendarUrl(feedUrl: string): string {
  const webcalUrl = feedUrl.replace(/^https?:\/\//, "webcal://");
  return `https://www.google.com/calendar/render?cid=${encodeURIComponent(webcalUrl)}`;
}

export function CalendarSubscribeCard({ feedUrl, lastFetchedAt, timeZone, generateAction, resetAction }: Props) {
  return (
    <Card>
      <div className="flex items-start gap-3">
        <CalendarPlus aria-hidden className="mt-0.5 h-5 w-5 shrink-0 text-brand" />
        <div className="min-w-0 flex-1">
          <SectionHeader as="h3" level="title">Your shifts in your calendar</SectionHeader>
          <p className="mt-1 text-sm text-muted-foreground">
            Subscribe from Google Calendar, Apple Calendar, or Outlook and your shifts appear
            alongside everything else you have scheduled.
          </p>

          {!feedUrl ? (
            <form action={generateAction} className="mt-4">
              <Button type="submit">Generate link</Button>
            </form>
          ) : (
            <>
              <div className="mt-4 flex flex-wrap items-end gap-2">
                <FeedUrlField value={feedUrl} />
                <a
                  href={googleCalendarUrl(feedUrl)}
                  target="_blank"
                  rel="noopener noreferrer"
                  // ph-no-capture: the href embeds the live, non-expiring feed
                  // token. Without this, posthog-js autocapture would emit it in
                  // attr__href / $external_click_url on click, and session replay
                  // would serialize it into the DOM snapshot just from this card
                  // being on screen, click or not.
                  className={buttonClasses("primary", "sm", "ph-no-capture")}
                >
                  Add to Google
                </a>
              </div>

              <p className="mt-3 text-xs text-muted-foreground">
                Google refreshes subscribed calendars on its own timing, usually within a day.
                Check the Hub for the latest.
              </p>
              <p className="mt-1 text-xs text-subtle-foreground">
                {lastFetchedAt
                  ? `Last checked by a calendar app on ${formatDateTime(lastFetchedAt, timeZone)}.`
                  : "This link has not been checked yet by any calendar app."}
              </p>

              <form action={resetAction} className="mt-4">
                <Button type="submit" variant="outline" size="sm">
                  Reset link
                </Button>
                <span className="ml-2 text-xs text-subtle-foreground">
                  Creates a new address and stops the old one working everywhere.
                </span>
              </form>
            </>
          )}
        </div>
      </div>
    </Card>
  );
}
