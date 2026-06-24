import { describe, expect, it } from "vitest";
import {
  CERT_VALIDITY_DAYS,
  TERM_END_BUFFER_DAYS,
  RENEWAL_WARNING_DAYS,
  certExpiresAt,
  complianceStatus,
  overallClearance,
} from "./rules";

// All tests use noon UTC to avoid any day-boundary ambiguity.
function noon(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
}

describe("constants", () => {
  it("exports CERT_VALIDITY_DAYS = 365", () => {
    expect(CERT_VALIDITY_DAYS).toBe(365);
  });
  it("exports TERM_END_BUFFER_DAYS = 30", () => {
    expect(TERM_END_BUFFER_DAYS).toBe(30);
  });
  it("exports RENEWAL_WARNING_DAYS = 60", () => {
    expect(RENEWAL_WARNING_DAYS).toBe(60);
  });
});

describe("certExpiresAt", () => {
  it("returns completionDate + 365 days", () => {
    const completion = noon(2025, 1, 1);
    const expires = certExpiresAt(completion);
    // 2025-01-01 + 365d = 2026-01-01
    expect(expires.toISOString()).toBe(noon(2026, 1, 1).toISOString());
  });

  it("handles leap-year arithmetic (2024-02-28 + 365 = 2025-02-27)", () => {
    const completion = noon(2024, 2, 28);
    const expires = certExpiresAt(completion);
    const expected = new Date(completion.getTime() + 365 * 24 * 60 * 60 * 1000);
    expect(expires.getTime()).toBe(expected.getTime());
  });
});

describe("complianceStatus - null cert", () => {
  it("returns NO_CERTIFICATE when cert is null", () => {
    const now = noon(2025, 6, 1);
    expect(complianceStatus(null, null, now)).toBe("NO_CERTIFICATE");
  });

  it("returns NO_CERTIFICATE when cert is null even with a termEnd", () => {
    const now = noon(2025, 6, 1);
    const termEnd = noon(2025, 8, 15);
    expect(complianceStatus(null, termEnd, now)).toBe("NO_CERTIFICATE");
  });
});

describe("complianceStatus - null completionDate", () => {
  it("returns UNKNOWN_DATE when cert exists but completionDate is null", () => {
    const now = noon(2025, 6, 1);
    expect(complianceStatus({ completionDate: null }, null, now)).toBe("UNKNOWN_DATE");
  });

  it("returns UNKNOWN_DATE with a termEnd too", () => {
    const now = noon(2025, 6, 1);
    const termEnd = noon(2025, 8, 15);
    expect(complianceStatus({ completionDate: null }, termEnd, now)).toBe("UNKNOWN_DATE");
  });
});

describe("complianceStatus - EXPIRED", () => {
  it("returns EXPIRED when expiresAt < now", () => {
    // completionDate = 2024-01-01; expiresAt = 2025-01-01; now = 2025-06-01 -> expired
    const completion = noon(2024, 1, 1);
    const now = noon(2025, 6, 1);
    expect(complianceStatus({ completionDate: completion }, null, now)).toBe("EXPIRED");
  });

  it("does NOT return EXPIRED when expiresAt === now (>= semantics)", () => {
    // expiresAt exactly equals now -> not expired; lands in EXPIRING_SOON (within 60d)
    const completion = noon(2024, 6, 1);
    const expiresAt = certExpiresAt(completion); // noon 2025-06-01
    const now = expiresAt;
    const status = complianceStatus({ completionDate: completion }, null, now);
    expect(status).not.toBe("EXPIRED");
    // expiresAt === now means it is NOT >= now+60d, so EXPIRING_SOON
    expect(status).toBe("EXPIRING_SOON");
  });
});

describe("complianceStatus - without termEnd (no active term)", () => {
  it("returns COMPLIANT when expiresAt >= now + 60d", () => {
    // completionDate = 2025-01-01; expiresAt = 2026-01-01; now = 2025-06-01
    // now + 60d = 2025-07-31; expiresAt 2026-01-01 >= 2025-07-31 -> COMPLIANT
    const completion = noon(2025, 1, 1);
    const now = noon(2025, 6, 1);
    expect(complianceStatus({ completionDate: completion }, null, now)).toBe("COMPLIANT");
  });

  it("returns EXPIRING_SOON when expiresAt < now + 60d (but not expired)", () => {
    // completionDate = 2024-06-15; expiresAt = 2025-06-15; now = 2025-05-15
    // now + 60d = 2025-07-14; expiresAt 2025-06-15 < 2025-07-14 -> EXPIRING_SOON
    const completion = noon(2024, 6, 15);
    const now = noon(2025, 5, 15);
    expect(complianceStatus({ completionDate: completion }, null, now)).toBe("EXPIRING_SOON");
  });

  it("returns COMPLIANT exactly at the now + 60d boundary", () => {
    // expiresAt === now + 60d exactly -> COMPLIANT (>= semantics)
    const now = noon(2025, 6, 1);
    const nowPlus60 = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);
    // work backward: completionDate such that expiresAt = nowPlus60
    const completion = new Date(nowPlus60.getTime() - 365 * 24 * 60 * 60 * 1000);
    expect(complianceStatus({ completionDate: completion }, null, now)).toBe("COMPLIANT");
  });

  it("returns EXPIRING_SOON exactly 1ms before the now + 60d boundary", () => {
    const now = noon(2025, 6, 1);
    const nowPlus60MinusMs = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000 - 1);
    const completion = new Date(nowPlus60MinusMs.getTime() - 365 * 24 * 60 * 60 * 1000);
    expect(complianceStatus({ completionDate: completion }, null, now)).toBe("EXPIRING_SOON");
  });
});

describe("complianceStatus - with termEnd", () => {
  it("returns COMPLIANT when expiresAt >= termEnd + 30d AND expiresAt >= now + 60d", () => {
    // completionDate = 2025-01-01; expiresAt = 2026-01-01
    // termEnd = 2025-08-15; termEnd+30d = 2025-09-14; expiresAt 2026-01-01 >= 2025-09-14 -> term bar met
    // now = 2025-06-01; now+60d = 2025-07-31; expiresAt 2026-01-01 >= 2025-07-31 -> renewal bar met
    // -> COMPLIANT
    const completion = noon(2025, 1, 1);
    const now = noon(2025, 6, 1);
    const termEnd = noon(2025, 8, 15);
    expect(complianceStatus({ completionDate: completion }, termEnd, now)).toBe("COMPLIANT");
  });

  it("returns COMPLIANT exactly at termEnd + 30d boundary", () => {
    // expiresAt === termEnd + 30d exactly -> COMPLIANT (term bar exactly met)
    // also need expiresAt >= now + 60d
    const now = noon(2025, 6, 1);
    const termEnd = noon(2025, 8, 15);
    const termEndPlus30 = new Date(termEnd.getTime() + 30 * 24 * 60 * 60 * 1000);
    // termEndPlus30 = 2025-09-14; need expiresAt = 2025-09-14
    // expiresAt >= now+60d = 2025-07-31? Yes, 2025-09-14 >= 2025-07-31
    const completion = new Date(termEndPlus30.getTime() - 365 * 24 * 60 * 60 * 1000);
    expect(complianceStatus({ completionDate: completion }, termEnd, now)).toBe("COMPLIANT");
  });

  it("returns EXPIRING_SOON 1ms before termEnd + 30d boundary", () => {
    const now = noon(2025, 6, 1);
    const termEnd = noon(2025, 8, 15);
    const termEndPlus30MinusMs = new Date(termEnd.getTime() + 30 * 24 * 60 * 60 * 1000 - 1);
    const completion = new Date(termEndPlus30MinusMs.getTime() - 365 * 24 * 60 * 60 * 1000);
    const status = complianceStatus({ completionDate: completion }, termEnd, now);
    expect(status).toBe("EXPIRING_SOON");
  });

  it("returns EXPIRING_SOON when term bar is met but expiresAt within 60d of now", () => {
    // cert covers termEnd+30d but expires soon: renewal warning wins
    // now = 2025-08-01; now+60d = 2025-09-30
    // termEnd = 2025-08-10; termEnd+30d = 2025-09-09
    // expiresAt = 2025-09-15 -> >= termEnd+30d (term bar met) BUT < now+60d (2025-09-30) -> EXPIRING_SOON
    const now = noon(2025, 8, 1);
    const termEnd = noon(2025, 8, 10);
    const termEndPlus30 = new Date(termEnd.getTime() + 30 * 24 * 60 * 60 * 1000); // 2025-09-09
    // pick expiresAt = termEndPlus30 + 6 days = 2025-09-15 (>= termEnd+30d but < now+60d)
    const expiresAt = new Date(termEndPlus30.getTime() + 6 * 24 * 60 * 60 * 1000);
    const completion = new Date(expiresAt.getTime() - 365 * 24 * 60 * 60 * 1000);
    expect(complianceStatus({ completionDate: completion }, termEnd, now)).toBe("EXPIRING_SOON");
  });

  it("returns EXPIRING_SOON when valid today but term bar not met", () => {
    // expiresAt is in the future (not expired) but < termEnd+30d -> EXPIRING_SOON
    const now = noon(2025, 6, 1);
    const termEnd = noon(2025, 11, 30);
    // expiresAt = 2025-08-01 -> in future but termEnd+30d = 2025-12-30; 2025-08-01 < 2025-12-30
    const expiresAt = noon(2025, 8, 1);
    const completion = new Date(expiresAt.getTime() - 365 * 24 * 60 * 60 * 1000);
    expect(complianceStatus({ completionDate: completion }, termEnd, now)).toBe("EXPIRING_SOON");
  });
});

describe("overallClearance", () => {
  it("is CLEARED only when the cert is valid and training is COMPLETE", () => {
    expect(overallClearance("COMPLIANT", "COMPLETE")).toBe("CLEARED");
    expect(overallClearance("EXPIRING_SOON", "COMPLETE")).toBe("CLEARED");
    expect(overallClearance("COMPLIANT", "PENDING")).toBe("NOT_CLEARED");
    expect(overallClearance("EXPIRING_SOON", "PENDING")).toBe("NOT_CLEARED");
  });

  it("is NOT_CLEARED for any invalid cert regardless of training", () => {
    for (const s of ["EXPIRED", "UNKNOWN_DATE", "NO_CERTIFICATE"] as const) {
      expect(overallClearance(s, "COMPLETE")).toBe("NOT_CLEARED");
      expect(overallClearance(s, "PENDING")).toBe("NOT_CLEARED");
    }
  });

  it("ignores training when it is not required (non-volunteer, e.g. director-only)", () => {
    expect(overallClearance("COMPLIANT", "PENDING", false)).toBe("CLEARED");
    expect(overallClearance("EXPIRING_SOON", "PENDING", false)).toBe("CLEARED");
    // an invalid cert still blocks clearance even when training is not required
    expect(overallClearance("EXPIRED", "PENDING", false)).toBe("NOT_CLEARED");
  });
});
