import { describeUserAgent } from "@/platform/auth/user-agent";
import { formatDateTime } from "@/platform/dates/format";
import { EmptyState } from "@/platform/ui/empty-state";

type LastLoginFields = {
  lastLoginAt: Date | null;
  lastLoginUserAgent: string | null;
  lastLoginCity: string | null;
  lastLoginCountry: string | null;
};

/**
 * Admin-only view of a person's most recent sign-in.
 *
 * Rendered from the person page, which already requires admin.manage_people, so
 * the gating is inherited rather than reinvented. Nothing here appears on the
 * member's own page or to department directors.
 *
 * Synchronous on purpose, with the zone passed in rather than resolved here.
 * The async DateTime server component in @/platform/dates/display cannot be
 * rendered by renderToStaticMarkup, which is how this is tested, so the page
 * (already async) resolves getDisplayTimeZone() and hands the zone down. That
 * keeps the shared formatter, and its configured zone and 12-hour convention,
 * without dragging the test into an async harness.
 */
export function LastLoginPanel({
  person,
  timeZone,
}: {
  person: LastLoginFields;
  /** From getDisplayTimeZone(). Resolved by the caller; see the note above. */
  timeZone: string;
}) {
  if (!person.lastLoginAt) {
    // Absence has a real meaning here (never signed in, or not since this
    // shipped), and a blank row would read like a bug.
    return <EmptyState inline>No sign-in recorded.</EmptyState>;
  }

  const browser = describeUserAgent(person.lastLoginUserAgent);
  const location = [person.lastLoginCity, person.lastLoginCountry].filter(Boolean).join(", ");

  return (
    // The rows sit BESIDE their labels rather than under them, and the dt/dd
    // pairs are direct grid children so the value column lines up across rows --
    // which is why this is not a DescriptionList (its rows are wrapped, and a
    // wrapper breaks that alignment). The INK is the house one: the label is the
    // small grey and the value carries the weight. It used to be the other way
    // round here, which made a compact panel read as a heading list.
    <dl className="grid gap-2 sm:grid-cols-[auto_1fr] sm:gap-x-6">
      <dt className="text-xs text-subtle-foreground">Last sign-in</dt>
      <dd className="text-sm text-foreground">
        <time dateTime={person.lastLoginAt.toISOString()}>
          {formatDateTime(person.lastLoginAt, timeZone)}
        </time>
      </dd>
      {browser ? (
        <>
          <dt className="text-xs text-subtle-foreground">Browser</dt>
          <dd className="text-sm text-foreground">{browser}</dd>
        </>
      ) : null}
      {/* Omitted rather than shown empty when absent: local and non-Vercel
          sign-ins carry no geo headers at all. */}
      {location ? (
        <>
          <dt className="text-xs text-subtle-foreground">Location</dt>
          <dd className="text-sm text-foreground">{location}</dd>
        </>
      ) : null}
    </dl>
  );
}
