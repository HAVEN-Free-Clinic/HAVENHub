/**
 * Redaction of credential-bearing URLs before they reach PostHog.
 *
 * Five routes carry a live, unconsumed credential in the URL itself, because
 * each deliberately renders a page (or, for the calendar feed, serves a
 * response) rather than consuming the token on GET:
 *
 *   /login/verify?token=...   member magic link, 30 min, peek-then-confirm
 *   /apply/verify?token=...   applicant portal link, grants a 7-day cookie
 *   /onboard/<token>          onboarding contract, 21 days, never consumed on view
 *   /api/calendar/<token>     personal calendar feed, NEVER expires, polled forever
 *   /credential/<token>       published service record, no expiry until unpublished
 *   /apply/i/<token>          recruitment invite (#613), single-use, peek-then-claim
 *
 * When a new route joins that list, it must be added here in the same change.
 * /apply/i/ was not, and shipped a live unclaimed invite token into the analytics
 * project on every claim-page view for as long as the feature existed (audit 14).
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
const SECRET_PATH_PREFIXES = [
  "/onboard/",
  "/api/calendar/",
  "/credential/",
  "/apply/i/",
];

const REDACTED = "[redacted]";

/**
 * How many times `scrubQueryPair` is allowed to decode-and-recurse into a
 * nested URL (scrubQueryPair -> scrubUrl -> scrubPath -> scrubQueryPair...).
 * Every real leak this file defends against is at most one level deep (a
 * credential URL nested inside a Google Calendar deep link), so this caps
 * well above any legitimate case while keeping the recursion bounded no
 * matter how an attacker (or a pathological ad-tracking URL) shapes the
 * input. At the cap, the value is left unscrubbed rather than descending
 * further, preserving the "never throw" contract.
 */
const MAX_QUERY_URL_DEPTH = 3;

/** Schemes we will decode-and-recurse into when they appear as a query value. */
const NESTED_URL_SCHEMES = ["http:", "https:", "webcal:"];

/**
 * Redact credentials from a path plus optional query string, e.g.
 * "/onboard/abc123" or "/login/verify?token=abc&next=/schedule".
 * Accepts a value with or without a query string; returns the same shape.
 */
export function scrubPath(pathAndQuery: string, depth = 0): string {
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
    .map((pair) => scrubQueryPair(pair, depth))
    .join("&");

  return `${path}?${scrubbedQuery}${hash}`;
}

/**
 * Scrub one `key=value` query pair. Handles two shapes of leak:
 *
 * 1. A param literally named `token` (SECRET_PARAMS): redact outright.
 * 2. A param whose value is itself a URL-encoded URL carrying a credential
 *    deeper in it, e.g. Google Calendar's add-by-URL deep link,
 *    `https://google.com/calendar/render?cid=<encoded feed URL>`. The outer
 *    path/params look innocuous; the secret is nested inside `cid`. Decoding,
 *    scrubbing, and re-encoding catches this without having to special-case
 *    every param name a third party might choose.
 *
 * Recursion into a decoded value only happens when that value itself parses
 * as an absolute http(s) URL. Every secret this file defends against lives
 * in an http(s) URL, so nothing is lost by restricting to that shape, and it
 * is what keeps ordinary non-URL values (`status:ACTIVE`, `mailto:a@b.com`,
 * `tel:+12035551234`) byte-identical: `URL#origin` serializes to the literal
 * string "null" for any opaque (non-special-scheme) URL, which would
 * otherwise silently corrupt those values.
 */
function scrubQueryPair(pair: string, depth: number): string {
  const eq = pair.indexOf("=");
  const key = eq === -1 ? pair : pair.slice(0, eq);
  if (SECRET_PARAMS.includes(key)) return `${key}=${REDACTED}`;
  if (eq === -1) return pair;
  if (depth >= MAX_QUERY_URL_DEPTH) return pair;

  const rawValue = pair.slice(eq + 1);
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawValue);
  } catch {
    return pair;
  }

  // A RELATIVE path in a query value, e.g. ?next=/apply/i/<token>. The apply
  // portal builds exactly that when an unauthenticated visitor opens an invite
  // link: it redirects to /apply?next=/apply/i/<token> so the claim survives
  // sign-in. Without this branch the prefix rules above never see it, because
  // `new URL(decoded)` throws on a relative path and the pair was returned
  // untouched -- so the token leaked a second time, from the sign-in page (audit
  // 14). Checked before the absolute-URL branch since it is the cheaper test.
  if (decoded.startsWith("/")) {
    const scrubbedPath = scrubPath(decoded, depth + 1);
    if (scrubbedPath === decoded) return pair;
    try {
      return `${key}=${encodeURIComponent(scrubbedPath)}`;
    } catch {
      return pair;
    }
  }

  let nestedUrl: URL;
  try {
    nestedUrl = new URL(decoded);
  } catch {
    return pair;
  }
  // webcal: is included because our own Google Calendar deep link carries the
  // feed that way: Google reads an https cid as a Google calendar ID to look
  // up rather than an external feed, so the link must use webcal, and the
  // token rides inside it. Restricting to these three keeps ordinary opaque
  // values (mailto:, tel:, status:ACTIVE) byte-identical.
  if (!NESTED_URL_SCHEMES.includes(nestedUrl.protocol)) return pair;

  const scrubbed = scrubUrl(decoded, depth + 1);
  if (scrubbed === decoded) return pair;
  try {
    return `${key}=${encodeURIComponent(scrubbed)}`;
  } catch {
    // A scrubbed value can (in principle) still carry a lone surrogate;
    // encodeURIComponent throws URIError on those. Fall back to the
    // original, untouched pair rather than violate the never-throw contract.
    return pair;
  }
}

/**
 * Redact credentials from an absolute URL, preserving origin. Falls back to
 * treating the value as a bare path when it does not parse as a URL, so a
 * relative `$pathname` is handled by the same call.
 */
export function scrubUrl(url: string, depth = 0): string {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    const scrubbed = scrubPath(parsed.pathname + parsed.search + parsed.hash, depth);
    // `origin` serializes to the literal string "null" for any non-special
    // scheme (webcal:, android-app:), which would corrupt the value into
    // "null/api/...". Rebuild from protocol + host in that case. Schemes with
    // no host at all (mailto:, tel:) keep the previous behavior rather than
    // widening this fix beyond what it needs to cover.
    const prefix =
      parsed.origin === "null" && parsed.host ? `${parsed.protocol}//${parsed.host}` : parsed.origin;
    return prefix + scrubbed;
  } catch {
    return scrubPath(url, depth);
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
  // $autocapture's cross-origin click property: a credential-bearing href like
  // the calendar feed's "Add to Google" link would otherwise ship the token.
  "$external_click_url",
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
