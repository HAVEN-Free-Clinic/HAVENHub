import type { ReactNode } from "react";

/**
 * One notification, as it reads in both places that list them.
 *
 * The bell popover and /notifications render the same rows and had been built
 * twice, drifting apart on every detail: a 6px dot against an 8px one, a
 * line-clamped 12px body against an unclamped 14px one, and a relative "3h ago"
 * against an absolute timestamp for the same notification one click apart. Only
 * the page's dot carried an sr-only "Unread" label, so in the bell a screen
 * reader could not tell a read notification from an unread one at all.
 *
 * This owns the row's CONTENT, not its interactivity: the bell wraps it in a
 * button that calls a client handler, the page wraps it in a form submit. Each
 * host keeps its own element, so neither has to pretend to be the other.
 *
 * ## Why the caller passes a formatted `time` string
 *
 * `DateTime` (platform/dates/display) is an async server component: it awaits
 * getDisplayTimeZone(). The bell is a client component polling /api/notifications,
 * so it cannot render one. That constraint is what split these two rows in the
 * first place. Rather than let the bell hand-roll a second time format, the
 * server formats the label in the configured zone on both paths (the API route
 * for the bell, the page itself for the list) and passes the string in. The
 * `iso` prop keeps the machine-readable value on a real <time> element.
 *
 * The bell's old label came from a `timeAgo()` helper that read Date.now()
 * during render, which is also the impurity the house rules forbid.
 */
export function NotificationRow({
  title,
  body,
  time,
  iso,
  unread,
}: {
  title: ReactNode;
  body: ReactNode;
  /** Pre-formatted in the display zone by the server. */
  time: string;
  /** Machine-readable instant for the <time> element. */
  iso: string;
  unread: boolean;
}) {
  return (
    <>
      <span className="flex w-full items-center gap-2">
        {unread && (
          <>
            <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-brand" />
            <span className="sr-only">Unread</span>
          </>
        )}
        <span className="font-medium text-foreground">{title}</span>
      </span>
      <span className="text-sm text-muted-foreground">{body}</span>
      <span className="text-xs text-subtle-foreground">
        <time dateTime={iso}>{time}</time>
      </span>
    </>
  );
}

/** The row's own layout classes, so both hosts' wrapper elements match. */
export const notificationRowClasses =
  "flex w-full flex-col items-start gap-1 px-4 py-3 text-left transition-colors hover:bg-muted";
