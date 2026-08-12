import { describeUserAgent } from "@/platform/auth/user-agent";

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
 * Synchronous on purpose: an async server component cannot be rendered by
 * renderToStaticMarkup, which is how this is tested. That rules out the async
 * DateTime helper in @/platform/dates/display, so the timestamp is formatted
 * inline in UTC rather than the configured display zone. Worth knowing before
 * "fixing" it to match other date rendering in the app.
 */
export function LastLoginPanel({ person }: { person: LastLoginFields }) {
  if (!person.lastLoginAt) {
    // Absence has a real meaning here (never signed in, or not since this
    // shipped), and a blank row would read like a bug.
    return <p className="text-sm text-muted-foreground">No sign-in recorded.</p>;
  }

  const browser = describeUserAgent(person.lastLoginUserAgent);
  const location = [person.lastLoginCity, person.lastLoginCountry].filter(Boolean).join(", ");

  return (
    <dl className="grid gap-2 text-sm sm:grid-cols-[auto_1fr] sm:gap-x-6">
      <dt className="font-medium text-foreground">Last sign-in</dt>
      <dd className="text-muted-foreground">
        <time dateTime={person.lastLoginAt.toISOString()}>
          {person.lastLoginAt.toISOString().replace("T", " ").slice(0, 16)} UTC
        </time>
      </dd>
      {browser ? (
        <>
          <dt className="font-medium text-foreground">Browser</dt>
          <dd className="text-muted-foreground">{browser}</dd>
        </>
      ) : null}
      {/* Omitted rather than shown empty when absent: local and non-Vercel
          sign-ins carry no geo headers at all. */}
      {location ? (
        <>
          <dt className="font-medium text-foreground">Location</dt>
          <dd className="text-muted-foreground">{location}</dd>
        </>
      ) : null}
    </dl>
  );
}
