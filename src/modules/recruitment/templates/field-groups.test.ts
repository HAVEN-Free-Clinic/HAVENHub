import { describe, it, expect } from "vitest";
import { identitySection, eligibilitySection, languagesSection, acknowledgementsSection, availabilitySection } from "./field-groups";
import { LANGUAGES_FIELD_KEY, languageCodeFromAnswer } from "@/platform/languages";

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

  // The old free-text "any other languages?" pair is gone on purpose. A typed
  // answer cannot be matched to a language, so nothing downstream could act on
  // it; the standard multi-select is what lets an application answer flow into
  // the verification queue. publishCycle enforces the same three properties on
  // every cycle, so a regression here is a regression there.
  it("languagesSection asks the standard language question, with resolvable option values", () => {
    const s = languagesSection();
    const field = s.fields.find((f) => f.key === LANGUAGES_FIELD_KEY)!;
    expect(field.type).toBe("MULTI_SELECT");
    for (const o of field.options ?? []) {
      expect(languageCodeFromAnswer(o.value)).not.toBeNull();
    }
  });

  // Load-bearing, not cosmetic. submissions.ts reads the answer out of
  // visibleFields, and a NEW-only section is not visible to a renewal, so
  // scoping this to NEW would silently give every returning applicant an empty
  // languagesClaimed. Returning volunteers are exactly the people most likely to
  // have no language on record, having applied before the question existed.
  it("languagesSection is asked of returning applicants too", () => {
    expect(languagesSection().appliesTo).toBe("BOTH");
  });

  it("languagesSection no longer carries the unmatchable free-text language fields", () => {
    const keys = languagesSection().fields.map((f) => f.key);
    expect(keys).not.toContain("other_languages");
    expect(keys).not.toContain("other_languages_detail");
  });

  it("eligibilitySection gates medical_certifications and medical_details on licensed_professional = yes", () => {
    const s = eligibilitySection();
    const certs = s.fields.find((f) => f.key === "medical_certifications")!;
    const details = s.fields.find((f) => f.key === "medical_details")!;
    expect(certs.visibleWhen).toEqual({ field: "licensed_professional", op: "is", value: "yes" });
    expect(details.visibleWhen).toEqual({ field: "licensed_professional", op: "is", value: "yes" });
  });

  it("identitySection gates yale_affiliation_other on yale_affiliation being other_yale or staff", () => {
    const s = identitySection();
    const other = s.fields.find((f) => f.key === "yale_affiliation_other")!;
    expect(other.visibleWhen).toEqual({ field: "yale_affiliation", op: "isAnyOf", value: ["other_yale", "staff"] });
  });
});
