import { describe, it, expect } from "vitest";
import { identitySection, eligibilitySection, languagesSection, acknowledgementsSection, availabilitySection } from "./field-groups";

describe("field-group builders", () => {
  it("identitySection has the three stable identity keys and is NEW-only", () => {
    const s = identitySection();
    expect(s.appliesTo).toBe("NEW");
    expect(s.departmentCode).toBeNull();
    const keys = s.fields.map((f) => f.key);
    expect(keys).toEqual(expect.arrayContaining(["first_name", "last_name", "email"]));
    const email = s.fields.find((f) => f.key === "email")!;
    expect(email.type).toBe("EMAIL");
    expect(email.required).toBe(true);
  });

  it("eligibilitySection offers the licensed-professional certifications as MULTI_SELECT", () => {
    const s = eligibilitySection();
    const certs = s.fields.find((f) => f.key === "medical_certifications")!;
    expect(certs.type).toBe("MULTI_SELECT");
    expect(certs.options!.map((o) => o.value)).toContain("EMT");
  });

  it("languagesSection Spanish proficiency is a SINGLE_SELECT with the five levels", () => {
    const s = languagesSection();
    const sp = s.fields.find((f) => f.key === "spanish_proficiency")!;
    expect(sp.type).toBe("SINGLE_SELECT");
    expect(sp.options!.map((o) => o.value)).toEqual(["none", "some", "conversational", "fluent_native", "fluent_non_native"]);
  });

  it("acknowledgementsSection(VOLUNTEER) carries the three signed policies with non-empty bodies", () => {
    const s = acknowledgementsSection("VOLUNTEER");
    const keys = s.fields.map((f) => f.key);
    expect(keys).toEqual(["volunteer_agreement", "professionalism_policy", "training_acknowledgement"]);
    expect(s.fields.every((f) => (f.helpText ?? "").length > 0 && f.required)).toBe(true);
  });

  it("availabilitySection uses the supplied dates as MULTI_SELECT options", () => {
    const s = availabilitySection([{ label: "May 30", value: "2026-05-30" }]);
    const a = s.fields.find((f) => f.key === "availability")!;
    expect(a.type).toBe("MULTI_SELECT");
    expect(a.options).toEqual([{ label: "May 30", value: "2026-05-30" }]);
  });

  it("no field label looks like a generic Airtable placeholder", () => {
    for (const s of [identitySection(), eligibilitySection(), languagesSection()]) {
      for (const f of s.fields) expect(f.label).not.toMatch(/supplement #?\d+$/i);
    }
  });
});
