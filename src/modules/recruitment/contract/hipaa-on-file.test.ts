import { describe, it, expect } from "vitest";
import { hipaaOnFileFor } from "./hipaa-on-file";

const DAY = 86_400_000;
const now = new Date("2026-09-15T12:00:00.000Z");
const termEnd = new Date("2026-12-19T00:00:00.000Z");
const ago = (days: number) => new Date(now.getTime() - days * DAY);
const expiry = (d: Date) => new Date(d.getTime() + 365 * DAY);

describe("hipaaOnFileFor", () => {
  it("accepts a verified certificate that stays valid through the term", () => {
    expect(hipaaOnFileFor([{ completionDate: ago(60), verifiedAt: ago(50) }], termEnd, now)).toEqual({
      completionDate: ago(60),
      expiresAt: expiry(ago(60)),
      pendingVerification: false,
    });
  });

  it("asks again for a certificate that runs out before the term does", () => {
    expect(hipaaOnFileFor([{ completionDate: ago(300), verifiedAt: ago(290) }], termEnd, now)).toBeNull();
  });

  it("counts an upload still waiting for verification when its date would clear the term", () => {
    expect(hipaaOnFileFor([{ completionDate: ago(10), verifiedAt: null }], termEnd, now)).toEqual({
      completionDate: ago(10),
      expiresAt: expiry(ago(10)),
      pendingVerification: true,
    });
  });

  it("uses the older verified certificate behind an unverified renewal", () => {
    const certs = [
      { completionDate: ago(5), verifiedAt: null },
      { completionDate: ago(100), verifiedAt: ago(95) },
    ];
    expect(hipaaOnFileFor(certs, termEnd, now)).toMatchObject({ completionDate: ago(100), pendingVerification: false });
  });

  it("asks when nothing usable is on file", () => {
    expect(hipaaOnFileFor([], termEnd, now)).toBeNull();
    expect(hipaaOnFileFor([{ completionDate: null, verifiedAt: null }], termEnd, now)).toBeNull();
  });
});
