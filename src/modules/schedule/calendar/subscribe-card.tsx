import { CalendarPlus } from "lucide-react";
import { Card } from "@/platform/ui/card";
import { Button, buttonClasses } from "@/platform/ui/button";
import { formatDateTime } from "@/platform/dates/format";
import { FeedUrlField } from "./feed-url-field";

type Props = {
  /** Full subscribe URL, or null when the member has not generated one yet. */
  feedUrl: string | null;
  lastFetchedAt: Date | null;
  timeZone: string;
  generateAction: () => Promise<void>;
  resetAction: () => Promise<void>;
};

/** Deep link that opens Google Calendar's add-by-URL flow. */
export function googleCalendarUrl(feedUrl: string): string {
  return `https://www.google.com/calendar/render?cid=${encodeURIComponent(feedUrl)}`;
}

export function CalendarSubscribeCard({ feedUrl, lastFetchedAt, timeZone, generateAction, resetAction }: Props) {
  return (
    <Card>
      <div className="flex items-start gap-3">
        <CalendarPlus aria-hidden className="mt-0.5 h-5 w-5 shrink-0 text-brand" />
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold text-foreground">Your shifts in your calendar</h3>
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
