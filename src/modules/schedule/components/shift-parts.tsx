import type { ReactNode } from "react";
import { Clock } from "lucide-react";

/**
 * The parts of a "my shifts" list that the volunteer and attending views share.
 *
 * Both live on /schedule: the volunteer list is rendered by the page itself and
 * the attending list by attending-portal-section, and the handful of people who
 * are genuinely both (a PA who also volunteers, a faculty member who directs a
 * department) scroll past both. They were built separately and had drifted in
 * ways a reader meets directly: "pending director review" against "pending
 * Faculty Relations review", "Cancel request" against "Withdraw request",
 * "past shifts" against "past dates".
 *
 * ## What is deliberately NOT shared
 *
 * The shift CARD. The two bodies genuinely differ: the volunteer card carries a
 * department code, a role badge, triage/walk-in/CC/remote tags and a
 * clinic-closed note; the attending card carries a slot label, start and end
 * times and an on-call badge. A shared card would need ReactNode slots for both
 * the badge row and the body, leaving only the Card wrapper actually shared,
 * which is not worth the indirection.
 *
 * The availability pills are already shared, as class constants with their own
 * bug history, in availability-pill.ts.
 */

/**
 * The strip that replaces the request controls once a change is pending.
 *
 * `reviewerLabel` is who reviews it, and it is the whole reason this is a prop:
 * a volunteer's request goes to their directors, an attending's to Faculty
 * Relations, and telling either one the wrong reviewer is worse than saying
 * nothing. `children` is the action row, because the two differ (a volunteer can
 * nudge their directors after five days; an attending cannot).
 */
export function PendingRequestStrip({
  description,
  reviewerLabel,
  children,
}: {
  /** What was asked for: "drop", or "swap with Dana Lee (Sat, Nov 8)". */
  description: string;
  /** Who reviews it, e.g. "director" or "Faculty Relations". */
  reviewerLabel: string;
  /** The withdraw/cancel control, plus anything else this view offers. */
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-muted px-3 py-2">
      <p className="text-sm text-foreground-soft flex-1 flex items-center gap-1.5">
        <Clock className="h-4 w-4 shrink-0 text-warning" aria-hidden />
        Change requested: {description} (pending {reviewerLabel} review)
      </p>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

/** Shared by both disclosures: a summary that reads as a link, with the native
 *  marker suppressed so the underlined text is the whole affordance. */
const SUMMARY_CLASS =
  "cursor-pointer font-medium text-subtle-foreground hover:text-foreground-soft list-none [&::-webkit-details-marker]:hidden";

/** The collapsed "Request a change" form, holding whichever forms the view offers. */
export function RequestChangeDisclosure({ children }: { children: ReactNode }) {
  return (
    <details className="group">
      <summary className={`text-xs ${SUMMARY_CLASS}`}>
        <span className="underline underline-offset-2">Request a change</span>
      </summary>
      <div className="mt-3 flex flex-col gap-4 pl-1 border-t border-border-subtle pt-3">
        {children}
      </div>
    </details>
  );
}

/**
 * The collapsed list of dates already gone by.
 *
 * `defaultOpen` exists for one case: the volunteer list opens it when a past
 * shift still has a request pending, so a member is not left hunting for a
 * request that has quietly scrolled into history.
 */
export function PastShiftsDisclosure({
  count,
  noun,
  defaultOpen = false,
  children,
}: {
  count: number;
  /** Singular noun for this view, e.g. "shift" or "date". */
  noun: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="group" open={defaultOpen}>
      <summary className={`text-sm ${SUMMARY_CLASS}`}>
        <span className="underline underline-offset-2">
          {count} past {noun}
          {count === 1 ? "" : "s"}
        </span>
      </summary>
      <div className="mt-3 flex flex-col gap-3">{children}</div>
    </details>
  );
}
