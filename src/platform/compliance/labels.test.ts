import { describe, it, expect } from "vitest";
import {
  complianceStatusLabel,
  onboardingTaskLabel,
  ALL_COMPLIANCE_STATUSES,
} from "./labels";
import type { ComplianceStatus } from "./rules";
import type { OnboardingTaskState } from "./task-state";

const ALL_STATUSES: ComplianceStatus[] = [
  "COMPLIANT",
  "EXPIRING_SOON",
  "EXPIRED",
  "UNKNOWN_DATE",
  "PENDING_VERIFICATION",
  "NO_CERTIFICATE",
];

const ALL_STATES: OnboardingTaskState[] = [
  "COMPLETE",
  "IN_PROGRESS",
  "INCOMPLETE",
  "NOT_REQUIRED",
];

describe("complianceStatusLabel", () => {
  it("gives every status a label for both audiences", () => {
    for (const status of ALL_STATUSES) {
      for (const audience of ["member", "staff"] as const) {
        const { label } = complianceStatusLabel(status, audience);
        expect(label.length).toBeGreaterThan(0);
        // Never leak the raw enum to a reader.
        expect(label).not.toBe(status);
      }
    }
  });

  it("keeps the member and staff wording that differ on purpose", () => {
    expect(complianceStatusLabel("PENDING_VERIFICATION", "staff").label).toBe("Needs verification");
    expect(complianceStatusLabel("PENDING_VERIFICATION", "member").label).toBe("Awaiting verification");
    expect(complianceStatusLabel("COMPLIANT", "staff").label).toBe("Compliant");
    expect(complianceStatusLabel("COMPLIANT", "member").label).toBe("Valid");
  });

  it("agrees on tone across audiences for the states that gate clearance", () => {
    for (const status of ["COMPLIANT", "EXPIRING_SOON", "EXPIRED"] as ComplianceStatus[]) {
      expect(complianceStatusLabel(status, "member").tone).toBe(
        complianceStatusLabel(status, "staff").tone,
      );
    }
  });

  it("uses sentence case, not the Title Case the roster maps had drifted into", () => {
    expect(complianceStatusLabel("EXPIRING_SOON", "staff").label).toBe("Expiring soon");
    expect(complianceStatusLabel("UNKNOWN_DATE", "staff").label).toBe("Date unknown");
    expect(complianceStatusLabel("NO_CERTIFICATE", "staff").label).toBe("No certificate");
  });
});

describe("ALL_COMPLIANCE_STATUSES", () => {
  it("covers the whole vocabulary exactly once", () => {
    expect([...ALL_COMPLIANCE_STATUSES].sort()).toEqual([...ALL_STATUSES].sort());
    expect(new Set(ALL_COMPLIANCE_STATUSES).size).toBe(ALL_COMPLIANCE_STATUSES.length);
  });

  it("leads with compliant and ends with no certificate", () => {
    // The summary tiles, the status filter and the skeleton all render in this
    // order, so it is part of the contract rather than an implementation detail.
    expect(ALL_COMPLIANCE_STATUSES[0]).toBe("COMPLIANT");
    expect(ALL_COMPLIANCE_STATUSES[ALL_COMPLIANCE_STATUSES.length - 1]).toBe("NO_CERTIFICATE");
  });
});

describe("onboardingTaskLabel", () => {
  it("gives every state a label for both audiences", () => {
    for (const state of ALL_STATES) {
      for (const audience of ["member", "staff"] as const) {
        const { label } = onboardingTaskLabel(state, { audience });
        expect(label.length).toBeGreaterThan(0);
        expect(label).not.toBe(state);
      }
    }
  });

  it("frames a member's gap as a next step and a director's as a verdict", () => {
    expect(onboardingTaskLabel("INCOMPLETE", { audience: "member" }).label).toBe("Action needed");
    expect(onboardingTaskLabel("INCOMPLETE", { audience: "staff" }).label).toBe("Incomplete");
  });

  it("says Pending when the member has no way to act on the task", () => {
    const pending = onboardingTaskLabel("INCOMPLETE", { audience: "member", actionable: false });
    expect(pending).toEqual({ label: "Pending", tone: "default" });
  });

  it("ignores actionable for staff, whose label is about the record not the reader", () => {
    expect(onboardingTaskLabel("INCOMPLETE", { audience: "staff", actionable: false }).label).toBe(
      "Incomplete",
    );
  });

  it("only softens an outstanding task, never a resolved one", () => {
    for (const state of ["COMPLETE", "IN_PROGRESS", "NOT_REQUIRED"] as OnboardingTaskState[]) {
      expect(onboardingTaskLabel(state, { audience: "member", actionable: false })).toEqual(
        onboardingTaskLabel(state, { audience: "member" }),
      );
    }
  });

  it("uses one word for the states where member and staff have no reason to differ", () => {
    for (const state of ["COMPLETE", "IN_PROGRESS", "NOT_REQUIRED"] as OnboardingTaskState[]) {
      expect(onboardingTaskLabel(state, { audience: "member" }).label).toBe(
        onboardingTaskLabel(state, { audience: "staff" }).label,
      );
    }
  });
});
