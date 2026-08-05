import { describe, it, expect } from "vitest";
import { deriveStage, parseOutcome, stageLabel } from "./stages";

const none = { advanced: false, finalRound: false, accepted: false, onboarded: false };

describe("deriveStage", () => {
  it("returns APPLIED when nothing else is signalled", () => {
    expect(deriveStage(none)).toBe("APPLIED");
  });

  it("returns the FURTHEST stage, not the first true one", () => {
    expect(deriveStage({ ...none, advanced: true, finalRound: true })).toBe("FINAL_ROUND");
    expect(deriveStage({ ...none, advanced: true, accepted: true })).toBe("ACCEPTED");
    expect(deriveStage({ ...none, accepted: true, onboarded: true })).toBe("ONBOARDED");
  });

  it("does not require lower stages to be set, since old cycles skipped them", () => {
    // V-SP26 records acceptance with no round-1 selection row at all.
    expect(deriveStage({ ...none, accepted: true })).toBe("ACCEPTED");
  });
});

describe("parseOutcome", () => {
  it("maps the vocabularies the old bases actually used", () => {
    expect(parseOutcome("Accepted")).toBe("ACCEPTED");
    expect(parseOutcome("ACCEPT")).toBe("ACCEPTED");
    expect(parseOutcome("Rejected")).toBe("REJECTED");
    expect(parseOutcome("Deny")).toBe("REJECTED");
    expect(parseOutcome("Waitlist")).toBe("WAITLISTED");
    expect(parseOutcome("Withdrew")).toBe("WITHDRAWN");
    expect(parseOutcome("Ineligible")).toBe("INELIGIBLE");
  });

  it("distinguishes absent from unrecognized", () => {
    expect(parseOutcome(null)).toBe("NO_DECISION");
    expect(parseOutcome("")).toBe("NO_DECISION");
    expect(parseOutcome("Purple")).toBe("UNKNOWN");
  });
});

describe("stageLabel", () => {
  it("names FINAL_ROUND per track", () => {
    expect(stageLabel("FINAL_ROUND", "DIRECTOR")).toBe("Interviewed");
    expect(stageLabel("FINAL_ROUND", "VOLUNTEER")).toBe("Round 2");
  });
});
