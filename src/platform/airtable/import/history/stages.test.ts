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
  // Every string in this block is a REAL value tallied from the ten source
  // bases on 2026-08-05, with its row count. Do not replace them with
  // invented vocabulary: an earlier draft of this table matched /^accept/i
  // and would have imported all 2097 "Approved" and "Confirmed" rows as
  // UNKNOWN while rejections mapped fine, producing a history in which
  // almost nobody was ever accepted.
  it("maps the acceptance words these bases actually use", () => {
    expect(parseOutcome("Approved")).toBe("ACCEPTED");   // 1270 rows
    expect(parseOutcome("Confirmed")).toBe("ACCEPTED");  // 827 rows
    expect(parseOutcome("Accepted")).toBe("ACCEPTED");
  });

  it("maps every rejection spelling, including the FA24 reason suffixes", () => {
    expect(parseOutcome("Rejected")).toBe("REJECTED");                          // 618
    expect(parseOutcome("Rejection - Department Capacity")).toBe("REJECTED");    // 163
    expect(parseOutcome("Rejection - Other")).toBe("REJECTED");                  // 19
    expect(parseOutcome("Denied")).toBe("REJECTED");
  });

  it("prefers INELIGIBLE over REJECTED when a rejection names ineligibility", () => {
    // Ops ruling: these applicants were not turned down on merit, so a later
    // reapplication must not read as a prior rejection. Order-dependent.
    expect(parseOutcome("Rejection - Ineligible Applicant")).toBe("INELIGIBLE"); // 19
    expect(parseOutcome("Ineligible")).toBe("INELIGIBLE");                       // 5
  });

  it("treats in-flight states from closed cycles as no decision", () => {
    expect(parseOutcome("Pending")).toBe("NO_DECISION");               // 2
    expect(parseOutcome("Awaiting Confirmation")).toBe("NO_DECISION"); // 1
    expect(parseOutcome("R2 Deferral")).toBe("NO_DECISION");           // 10
  });

  it("does not let 'Awaiting Confirmation' be captured by the Confirmed rule", () => {
    // Regression guard for the anchoring on the ACCEPTED pattern.
    expect(parseOutcome("Awaiting Confirmation")).not.toBe("ACCEPTED");
  });

  it("maps the remaining tail values", () => {
    expect(parseOutcome("Withdrawn")).toBe("WITHDRAWN"); // 1
    expect(parseOutcome("Waitlist")).toBe("WAITLISTED");
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
