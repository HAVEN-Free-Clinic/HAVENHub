/**
 * Redaction of credential-bearing URLs before they reach PostHog.
 *
 * Four routes carry a live, unconsumed credential in the URL itself, because
 * each deliberately renders a page rather than consuming the token on GET:
 *
 *   /login/verify?token=...   member magic link, 30 min, peek-then-confirm
 *   /apply/verify?token=...   applicant portal link, grants a 7-day cookie
 *   /onboard/<token>          onboarding contract, 21 days, never consumed on view
 *   /credential/<token>       published service record, no expiry until unpublished
 *
 * posthog-js captures `$current_url` (and friends) verbatim on every pageview,
 * so without this the raw token is written into the analytics project as an
 * ordinary event property, readable by a broader population than HAVEN Hub
 * admins and replayable for the whole of its TTL.
 *
 * These helpers are pure and total: they never throw on a malformed value, so
 * they are safe to call from the telemetry and error paths.
 */

/** Query parameters whose value is a credential wherever they appear. */
const SECRET_PARAMS = ["token"];

/** Path prefixes whose NEXT segment is a credential, not an identifier. */
const SECRET_PATH_PREFIXES = ["/onboard/", "/credential/"];

const REDACTED = "[redacted]";

/**
 * Redact credentials from a path plus optional query string, e.g.
 * "/onboard/abc123" or "/login/verify?token=abc&next=/schedule".
 * Accepts a value with or without a query string; returns the same shape.
 */
export function scrubPath(pathAndQuery: string): string {
  if (!pathAndQuery) return pathAndQuery;
  const hashAt = pathAndQuery.indexOf("#");
  const hash = hashAt === -1 ? "" : pathAndQuery.slice(hashAt);
  const withoutHash = hashAt === -1 ? pathAndQuery : pathAndQuery.slice(0, hashAt);

  const queryAt = withoutHash.indexOf("?");
  let path = queryAt === -1 ? withoutHash : withoutHash.slice(0, queryAt);
  const query = queryAt === -1 ? "" : withoutHash.slice(queryAt + 1);

  for (const prefix of SECRET_PATH_PREFIXES) {
    if (path.startsWith(prefix)) {
      // Keep the route shape so the funnel is still analysable, drop the value.
      const rest = path.slice(prefix.length);
      const nextSlash = rest.indexOf("/");
      path = prefix + REDACTED + (nextSlash === -1 ? "" : rest.slice(nextSlash));
      break;
    }
  }

  if (!query) return path + hash;

  const scrubbedQuery = query
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      const key = eq === -1 ? pair : pair.slice(0, eq);
      return SECRET_PARAMS.includes(key) ? `${key}=${REDACTED}` : pair;
    })
    .join("&");

  return `${path}?${scrubbedQuery}${hash}`;
}

/**
 * Redact credentials from an absolute URL, preserving origin. Falls back to
 * treating the value as a bare path when it does not parse as a URL, so a
 * relative `$pathname` is handled by the same call.
 */
export function scrubUrl(url: string): string {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    const scrubbed = scrubPath(parsed.pathname + parsed.search + parsed.hash);
    return parsed.origin + scrubbed;
  } catch {
    return scrubPath(url);
  }
}

/** PostHog event properties that can carry a full URL or path. */
const URL_PROPERTIES = [
  "$current_url",
  "$pathname",
  "$initial_current_url",
  "$initial_pathname",
  "$referrer",
  "$initial_referrer",
  "$session_entry_url",
  "$session_entry_pathname",
  "$session_entry_referrer",
];

/**
 * posthog-js `sanitize_properties` hook: rewrite every URL-bearing property so
 * no credential leaves the browser. Unknown property shapes pass through
 * untouched.
 */
export function scrubProperties<T extends Record<string, unknown>>(properties: T): T {
  const sanitized: Record<string, unknown> = { ...properties };
  for (const key of URL_PROPERTIES) {
    const value = sanitized[key];
    if (typeof value === "string" && value) {
      sanitized[key] = scrubUrl(value);
    }
  }
  return sanitized as T;
}
