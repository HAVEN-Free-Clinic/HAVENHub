import { describe, it, expect } from "vitest";
import { VOLUNTEER_LAYOUT } from "./volunteer";

const ids = VOLUNTEER_LAYOUT.blocks.map((b) => ("id" in b ? b.id : b.kind === "system_field" ? b.systemKey : b.key));

describe("VOLUNTEER_LAYOUT", () => {
  it("carries the Airtable section headings in order", () => {
    const sections = VOLUNTEER_LAYOUT.blocks.filter((b) => b.kind === "section").map((b) => b.title);
    expect(sections).toEqual(["Basic Information", "HIPAA Compliance", "Epic Access", "Scheduling", "Volunteer Contract"]);
  });

  it("all five agreements have correct confirmKind values", () => {
    const confirmKinds: Record<string, string> = {
      agreement: "initials",
      professionalism: "initials",
      commitment: "initials",
      training: "initials",
      haven_agreement: "signature",
    };

    for (const [id, expectedKind] of Object.entries(confirmKinds)) {
      const b = VOLUNTEER_LAYOUT.blocks.find((x) => x.kind === "agreement" && x.id === id);
      expect(b && "confirmKind" in b && b.confirmKind).toBe(expectedKind);
    }
  });

  it("training acknowledgement body carries the trainingDate token", () => {
    const b = VOLUNTEER_LAYOUT.blocks.find((x) => x.kind === "agreement" && x.id === "training");
    expect(b && "body" in b && b.body).toContain("{{trainingDate}}");
  });

  it("has no department-gated blocks", () => {
    expect(VOLUNTEER_LAYOUT.blocks.some((b) => b.visibleWhen?.field === "department")).toBe(false);
  });

  it("never asks the volunteer whether they need Epic", () => {
    expect(ids).not.toContain("epic_needed_self");
  });

  it("shows the Epic section only when the department uses Epic", () => {
    const epic = VOLUNTEER_LAYOUT.blocks.filter(
      (b) => (b.kind === "section" && b.id === "sec_epic") || (b.kind === "system_field" && b.systemKey === "epic"),
    );
    expect(epic).toHaveLength(2);
    for (const b of epic) expect(b.visibleWhen).toEqual({ field: "epicRequirement", op: "is", value: "ALL" });
  });

  it("asks the two scheduling questions in their own section, before the contract", () => {
    const at = (id: string) => ids.indexOf(id);
    expect(at("sec_scheduling")).toBeGreaterThan(-1);
    expect(at("shiftsWanted")).toBe(at("sec_scheduling") + 1);
    expect(at("availabilityChange")).toBe(at("sec_scheduling") + 2);
    expect(at("availabilityChange")).toBeLessThan(at("sec_contract"));
  });

  it("asks for a profile photo", () => {
    expect(ids).toContain("photo");
  });

  it("includes pronouns and staff title", () => {
    expect(ids).toContain("pronouns");
    expect(ids).toContain("staffTitle");
  });
});
