/**
 * The one definition of "which IP is this request from?" for rate limiting.
 *
 * Every per-IP limiter in the app used to inline `xff.split(",")[0]` -- the
 * LEFTMOST value, which is the one hop in the chain that nothing verified. A
 * client that sends its own `X-Forwarded-For: 203.0.113.<random>` gets that value
 * echoed at the front, so every request looked like a brand-new IP and the
 * limiter never fired at all: a single script could burn the whole daily
 * magic-link budget from one machine (audit 14, UNAUTH-04).
 *
 * Each proxy in a chain APPENDS the address it received the connection from, so
 * the rightmost entry is the one written by the hop closest to us -- our own edge
 * -- and is the only entry a client cannot choose. That is what this returns.
 *
 * The trade-off, stated plainly: this assumes exactly one trusted proxy in front
 * of the app (Vercel's edge, which is the only deployment target). Behind two
 * trusted proxies the rightmost entry would be the inner proxy's address and
 * every request would share one bucket -- over-limiting rather than the
 * under-limiting it replaces, but still wrong. Revisit this function, not its
 * callers, if that ever changes.
 */

/** Just the shape both `Headers` and Next's `ReadonlyHeaders` satisfy. */
type HeaderReader = { get(name: string): string | null };

/**
 * The client IP to key a rate limiter on, or null when there is no forwarded
 * chain at all (local dev, direct request). Callers treat null as "cannot
 * limit by IP" and fall back to their identity-scoped limits.
 */
export function clientIpForRateLimit(headers: HeaderReader): string | null {
  const forwardedFor = headers.get("x-forwarded-for");
  if (!forwardedFor) return null;
  const hops = forwardedFor
    .split(",")
    .map((hop) => hop.trim())
    .filter((hop) => hop.length > 0);
  return hops.at(-1) ?? null;
}
