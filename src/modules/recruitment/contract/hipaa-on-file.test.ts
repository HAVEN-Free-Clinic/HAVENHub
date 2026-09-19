import { describe, it, expect } from "vitest";
import { hipaaOnFileFor } from "./hipaa-on-file";

const DAY = 86_400_000;
const now = new Date("2026-09-15T12:00:00.000Z");
const termEnd = new Date("2026-12-19T00:00:00.000Z");
const ago = (days: number) => new Date(now.getTime() - days * DAY);
const expiry = (d: Date) => new Date(d.getTime() + 365 * DAY);

describe("hipaaOnFileFor", () => {
  it("accepts a verified certificate that stays valid through the term", () => {
    expect(hipaaOnFileFor([{ completionDate: ago(60), verifiedAt: ago(50), rejectedAt: null }], termEnd, now)).toEqual({
      completionDate: ago(60),
      expiresAt: expiry(ago(60)),
      pendingVerification: false,
    });
  });

  it("asks again for a certificate that runs out before the term does", () => {
    expect(hipaaOnFileFor([{ completionDate: ago(300), verifiedAt: ago(290), rejectedAt: null }], termEnd, now)).toBeNull();
  });

  it("counts an upload still waiting for verification when its date would clear the term", () => {
    expect(hipaaOnFileFor([{ completionDate: ago(10), verifiedAt: null, rejectedAt: null }], termEnd, now)).toEqual({
      completionDate: ago(10),
      expiresAt: expiry(ago(10)),
      pendingVerification: true,
    });
  });

  it("uses the older verified certificate behind an unverified renewal", () => {
    const certs = [
      { completionDate: ago(5), verifiedAt: null, rejectedAt: null },
      { completionDate: ago(100), verifiedAt: ago(95), rejectedAt: null },
    ];
    expect(hipaaOnFileFor(certs, termEnd, now)).toMatchObject({ completionDate: ago(100), pendingVerification: false });
  });

  it("asks again for an upload the clinic refused, however good its date is", () => {
    // The pending-verification courtesy reads the newest row directly, bypassing
    // effectiveCompliance, so it needs its own rejection guard. Without one the
    // date parsed out of the very file the clinic threw out would wave the
    // applicant straight past the contract's HIPAA step.
    expect(
      hipaaOnFileFor(
        [{ completionDate: ago(10), verifiedAt: null, rejectedAt: ago(1) }],
        termEnd,
        now,
      ),
    ).toBeNull();
  });

  it("never offers a refused certificate as the fallback behind a newer upload", () => {
    const certs = [
      { completionDate: ago(5), verifiedAt: null, rejectedAt: null },
      // Dated, verified, in-date -- and refused, which is the only thing
      // disqualifying it. It must stay disqualified.
      { completionDate: ago(100), verifiedAt: ago(95), rejectedAt: ago(2) },
    ];
    // Falls through to the pending-verification branch on the newest upload
    // rather than resurrecting the rejected one.
    expect(hipaaOnFileFor(certs, termEnd, now)).toMatchObject({
      completionDate: ago(5),
      pendingVerification: true,
    });
  });

  it("asks when nothing usable is on file", () => {
    expect(hipaaOnFileFor([], termEnd, now)).toBeNull();
    expect(hipaaOnFileFor([{ completionDate: null, verifiedAt: null, rejectedAt: null }], termEnd, now)).toBeNull();
  });
});
