/**
 * The whole point of this helper is WHICH end of the chain it reads, so that is
 * what the cases assert: a value the client wrote must never become the key a
 * rate limiter counts against.
 */
import { describe, expect, it } from "vitest";
import { clientIpForRateLimit } from "./client-ip";

function headers(forwardedFor: string | null) {
  return { get: (name: string) => (name === "x-forwarded-for" ? forwardedFor : null) };
}

describe("clientIpForRateLimit", () => {
  it("ignores a client-supplied leading hop and keys on the edge's own entry", () => {
    // What an attacker sends: their own X-Forwarded-For, which the edge keeps and
    // then appends the real connecting address to.
    expect(clientIpForRateLimit(headers("203.0.113.7, 198.51.100.4"))).toBe("198.51.100.4");
    // Rotating the spoofed value (the actual bypass) changes nothing.
    expect(clientIpForRateLimit(headers("10.9.8.7, 198.51.100.4"))).toBe("198.51.100.4");
  });

  it("returns the only hop when nothing was forwarded", () => {
    expect(clientIpForRateLimit(headers("198.51.100.4"))).toBe("198.51.100.4");
  });

  it("tolerates whitespace and empty entries", () => {
    expect(clientIpForRateLimit(headers("  203.0.113.7 ,  , 198.51.100.4  "))).toBe("198.51.100.4");
  });

  it("returns null when there is no forwarded chain at all", () => {
    expect(clientIpForRateLimit(headers(null))).toBeNull();
    expect(clientIpForRateLimit(headers(""))).toBeNull();
    expect(clientIpForRateLimit(headers(" , "))).toBeNull();
  });
});
