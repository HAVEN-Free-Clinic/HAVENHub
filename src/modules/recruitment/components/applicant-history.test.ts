import { describe, expect, it } from "vitest";
import { summaryLine } from "./applicant-history";
import type { ApplicantHistory, HistoryEntry } from "@/modules/recruitment/services/history";

const applicationEntry = (over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  kind: "application",
  era: "archive",
  cycleCode: "V-FA25",
  cycleLabel: "Fall 2025 Volunteer Recruitment",
  track: "VOLUNTEER",
  departmentCodes: ["BVHD"],
  resultDepartment: null,
  furthestStage: "APPLIED",
  outcome: "REJECTED",
  occurredAt: new Date("2025-09-01"),
  href: null,
  ...over,
});

const interestEntry = (over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  kind: "interest",
  era: "archive",
  cycleCode: "INTEREST",
  cycleLabel: "Interest form",
  track: "VOLUNTEER",
  departmentCodes: [],
  resultDepartment: null,
  furthestStage: null,
  outcome: null,
  occurredAt: new Date("2024-01-01"),
  href: null,
  ...over,
});

const history = (over: Partial<ApplicantHistory> = {}): ApplicantHistory => ({
  entries: [],
  applicationCount: 0,
  furthest: null,
  ...over,
});

describe("summaryLine", () => {
  describe("reviewer-card mode (pendingApplication: true)", () => {
    it("counts the pending application not present in history, with the furthest stage", () => {
      const entry = applicationEntry({ furthestStage: "APPLIED", cycleLabel: "Fall 2025 Volunteer Recruitment" });
      const h = history({
        entries: [entry],
        applicationCount: 1,
        furthest: { stage: "APPLIED", cycleLabel: "Fall 2025 Volunteer Recruitment" },
      });
      // One prior application in history + the pending one being reviewed = 2nd.
      expect(summaryLine(h, true)).toBe(
        "2nd application. Furthest: Applied (Fall 2025 Volunteer Recruitment).",
      );
    });

    it("shows the reviewer-card empty-state copy when there is no earlier record at all", () => {
      expect(summaryLine(history(), true)).toBe("First application, no earlier record.");
    });
  });

  describe("non-pending mode (pendingApplication: false)", () => {
    it("counts only history's own applications, with the furthest stage", () => {
      const entryOne = applicationEntry({ furthestStage: "APPLIED", cycleLabel: "Fall 2025 Volunteer Recruitment" });
      const entryTwo = applicationEntry({
        furthestStage: "ACCEPTED",
        cycleLabel: "Spring 2025 Volunteer Recruitment",
      });
      const h = history({
        entries: [entryOne, entryTwo],
        applicationCount: 2,
        furthest: { stage: "ACCEPTED", cycleLabel: "Spring 2025 Volunteer Recruitment" },
      });
      // Two applications recorded, no pending one to add: "2 prior applications",
      // never the reviewer card's ordinal "3rd application".
      expect(summaryLine(h, false)).toBe(
        "2 prior applications. Furthest: Accepted (Spring 2025 Volunteer Recruitment).",
      );
    });

    it("uses the non-pending empty-state copy, never the reviewer card's wording", () => {
      expect(summaryLine(history(), false)).toBe("No recorded applications.");
    });
  });

  describe("interest-only case (no applications, but an interest-form entry exists)", () => {
    it("reads the same regardless of pendingApplication", () => {
      const h = history({ entries: [interestEntry()], applicationCount: 0, furthest: null });
      expect(summaryLine(h, true)).toBe("First application. Interest form on file.");
      expect(summaryLine(h, false)).toBe("First application. Interest form on file.");
    });
  });
});
