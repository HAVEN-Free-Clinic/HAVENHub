import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time string equality. The shared low-level primitive behind every
 * secret-comparison in this file -- callers that need a specific format
 * (a bearer header, a hex-encoded HMAC signature) build that format and hand
 * both sides here rather than writing their own `!==`/timingSafeEqual pair,
 * so a new comparison never accidentally reintroduces the timing leak this
 * function exists to close.
 *
 * A naive `!==` string comparison short-circuits at the first mismatched
 * byte, so a forged value can be recovered byte-by-byte by measuring
 * response-timing differences across repeated attempts.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqual requires equal-length buffers, so guard length first. Both
  // sides here are either a fixed expected value or a fixed-format digest, so
  // this comparison leaks no useful signal about *why* it failed.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Constant-time check that a presented `Authorization` header carries exactly
 * `Bearer <secret>`.
 *
 * Shared by every bearer-token gate in this codebase (cron routes, the MCP
 * endpoint) so that threat gets the same treatment everywhere rather than
 * being re-litigated per call site.
 */
export function constantTimeBearerMatch(providedHeader: string | null, secret: string): boolean {
  if (!providedHeader) return false;
  return constantTimeEqual(providedHeader, `Bearer ${secret}`);
}
