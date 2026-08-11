import { describe, expect, it } from "vitest";
import { backoffMs, shouldAttemptYaliesPull, type PhotoState } from "./policy";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-08-10T12:00:00Z");

/** A person who passes every condition, so each test can break exactly one. */
function eligible(overrides: Partial<PhotoState> = {}): PhotoState {
  return {
    netId: "abc12",
    yaleAffiliation: "yale_college",
    photoKey: null,
    photoSuppressed: false,
    photoSyncedAt: null,
    photoSyncMisses: 0,
    ...overrides,
  };
}

describe("backoffMs", () => {
  it("waits a day after the first miss", () => {
    expect(backoffMs(1)).toBe(1 * DAY);
  });

  it("waits a week after the second", () => {
    expect(backoffMs(2)).toBe(7 * DAY);
  });

  it("waits a month after the third", () => {
    expect(backoffMs(3)).toBe(30 * DAY);
  });

  it("caps at a month thereafter", () => {
    expect(backoffMs(4)).toBe(30 * DAY);
    expect(backoffMs(99)).toBe(30 * DAY);
  });
});

describe("shouldAttemptYaliesPull", () => {
  it("attempts for an eligible person never synced before", () => {
    expect(shouldAttemptYaliesPull(eligible(), NOW)).toBe(true);
  });

  it("refuses when a photo already exists", () => {
    expect(shouldAttemptYaliesPull(eligible({ photoKey: "people/p1" }), NOW)).toBe(false);
  });

  it("refuses when suppressed", () => {
    expect(shouldAttemptYaliesPull(eligible({ photoSuppressed: true }), NOW)).toBe(false);
  });

  it("refuses without a netId", () => {
    expect(shouldAttemptYaliesPull(eligible({ netId: null }), NOW)).toBe(false);
  });

  it("refuses for a non-Yale affiliation", () => {
    expect(shouldAttemptYaliesPull(eligible({ yaleAffiliation: "non_yale" }), NOW)).toBe(false);
  });

  it("attempts for an unknown affiliation, which is worth one try", () => {
    expect(shouldAttemptYaliesPull(eligible({ yaleAffiliation: null }), NOW)).toBe(true);
  });

  it("attempts for a non-Yale-College Yale affiliation, which is worth one try", () => {
    expect(shouldAttemptYaliesPull(eligible({ yaleAffiliation: "ysm_md" }), NOW)).toBe(true);
  });

  it("refuses inside the backoff window", () => {
    const person = eligible({
      photoSyncMisses: 1,
      photoSyncedAt: new Date(NOW.getTime() - 12 * 60 * 60 * 1000),
    });

    expect(shouldAttemptYaliesPull(person, NOW)).toBe(false);
  });

  it("attempts once the backoff window has elapsed", () => {
    const person = eligible({
      photoSyncMisses: 1,
      photoSyncedAt: new Date(NOW.getTime() - 2 * DAY),
    });

    expect(shouldAttemptYaliesPull(person, NOW)).toBe(true);
  });

  it("still refuses a long-missed person inside the capped window", () => {
    const person = eligible({
      photoSyncMisses: 50,
      photoSyncedAt: new Date(NOW.getTime() - 10 * DAY),
    });

    expect(shouldAttemptYaliesPull(person, NOW)).toBe(false);
  });

  it("attempts exactly when the backoff window expires", () => {
    const person = eligible({
      photoSyncMisses: 1,
      photoSyncedAt: new Date(NOW.getTime() - backoffMs(1)),
    });

    expect(shouldAttemptYaliesPull(person, NOW)).toBe(true);
  });

  it("refuses when the backoff window has not yet elapsed", () => {
    const person = eligible({
      photoSyncMisses: 1,
      photoSyncedAt: new Date(NOW.getTime() - backoffMs(1) + 1),
    });

    expect(shouldAttemptYaliesPull(person, NOW)).toBe(false);
  });
});
