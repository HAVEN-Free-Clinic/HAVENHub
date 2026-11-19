import { describe, expect, it } from "vitest";
import {
  INFO_SESSION_BADGE,
  INFO_SESSION_EXEMPT_APPLICANT_TYPES,
  attendedInfoSession,
  infoSessionEndsAt,
  infoSessionPhase,
  infoSessionStatus,
} from "./info-session";

const at = (iso: string) => new Date(iso);

describe("infoSessionPhase", () => {
  it("is NONE with no events", () => {
    expect(infoSessionPhase([], at("2026-11-01T00:00:00Z"))).toEqual({ phase: "NONE", lastEndsAt: null });
  });
  it("judges by the LAST session to end, counting an hour when there is no end time", () => {
    const events = [
      { startsAt: at("2026-10-01T22:00:00Z"), endsAt: at("2026-10-01T23:00:00Z") },
      { startsAt: at("2026-10-08T22:00:00Z"), endsAt: null },
    ];
    expect(infoSessionEndsAt(events[1])).toEqual(at("2026-10-08T23:00:00Z"));
    expect(infoSessionPhase(events, at("2026-10-05T00:00:00Z")).phase).toBe("UPCOMING");
    expect(infoSessionPhase(events, at("2026-10-08T22:30:00Z")).phase).toBe("UPCOMING");
    expect(infoSessionPhase(events, at("2026-10-08T23:00:00Z"))).toEqual({ phase: "ENDED", lastEndsAt: at("2026-10-08T23:00:00Z") });
  });
});

describe("attendedInfoSession", () => {
  const attendance = { personIds: new Set(["p1"]), emails: new Set(["walk@y.edu"]) };
  it("matches a linked person", () => {
    expect(attendedInfoSession({ applicantPersonId: "p1", emailLower: "x@y.edu" }, attendance)).toBe(true);
  });
  it("matches a walk-up by email", () => {
    expect(attendedInfoSession({ applicantPersonId: null, emailLower: "walk@y.edu" }, attendance)).toBe(true);
  });
  it("does not match anyone else", () => {
    expect(attendedInfoSession({ applicantPersonId: "p2", emailLower: "other@y.edu" }, attendance)).toBe(false);
  });
});

describe("infoSessionStatus", () => {
  it("is null on a cycle with no info sessions", () => {
    expect(infoSessionStatus({ phase: "NONE", attended: false, applicantType: "NEW" })).toBeNull();
  });
  it("is NOT_YET before the last session ends and FLAGGED after", () => {
    expect(infoSessionStatus({ phase: "UPCOMING", attended: false, applicantType: "NEW" })).toBe("NOT_YET");
    expect(infoSessionStatus({ phase: "ENDED", attended: false, applicantType: "NEW" })).toBe("FLAGGED");
  });
  it("flags renewals too, unless they are added to the exempt list", () => {
    expect(INFO_SESSION_EXEMPT_APPLICANT_TYPES).not.toContain("RENEWAL");
    expect(infoSessionStatus({ phase: "ENDED", attended: false, applicantType: "RENEWAL" })).toBe("FLAGGED");
  });
  it("is ATTENDED whenever they checked in, and only flags get a badge", () => {
    expect(infoSessionStatus({ phase: "ENDED", attended: true, applicantType: "NEW" })).toBe("ATTENDED");
    expect(INFO_SESSION_BADGE.ATTENDED).toBeNull();
    expect(INFO_SESSION_BADGE.FLAGGED?.tone).toBe("critical");
  });
});
