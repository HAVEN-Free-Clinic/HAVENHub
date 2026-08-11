import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time check that a presented `Authorization` header carries exactly
 * `Bearer <secret>`.
 *
 * A naive `!==` string comparison short-circuits at the first mismatched
 * byte, so a forged header can recover the secret byte-by-byte by measuring
 * response-timing differences across repeated attempts. Shared by every
 * bearer-token gate in this codebase (cron routes, the MCP endpoint) so that
 * threat gets the same treatment everywhere rather than being re-litigated
 * per call site.
 */
export function constantTimeBearerMatch(providedHeader: string | null, secret: string): boolean {
  if (!providedHeader) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(providedHeader);
  // timingSafeEqual requires equal-length buffers, so guard length first. The
  // expected length is fixed, so this comparison leaks no useful signal.
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
