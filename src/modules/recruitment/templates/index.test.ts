import { describe, it, expect } from "vitest";
import { getApplicationTemplate } from "./index";

const dates = [{ label: "May 30", value: "2026-05-30" }];

describe("getApplicationTemplate", () => {
  it("includes the three identity keys for both tracks", () => {
    for (const track of ["VOLUNTEER", "DIRECTOR"] as const) {
      const keys = getApplicationTemplate(track, [], dates).flatMap((s) => s.fields.map((f) => f.key));
      expect(keys).toEqual(expect.arrayContaining(["first_name", "last_name", "email"]));
    }
  });

  it("emits exactly one DEPARTMENT_CHOICE field", () => {
    for (const track of ["VOLUNTEER", "DIRECTOR"] as const) {
      const fields = getApplicationTemplate(track, ["MDIC"], dates).flatMap((s) => s.fields);
      expect(fields.filter((f) => f.type === "DEPARTMENT_CHOICE")).toHaveLength(1);
    }
  });

  it("materializes a supplement section only for selected departments", () => {
    const t = getApplicationTemplate("VOLUNTEER", ["MDIC"], dates);
    const suppCodes = t.filter((s) => s.departmentCode !== null).map((s) => s.departmentCode);
    expect(suppCodes).toEqual(["MDIC"]);
  });

  it("has globally unique field keys and monotonic section order", () => {
    const t = getApplicationTemplate("DIRECTOR", ["BVHD", "MDIC"], dates);
    const keys = t.flatMap((s) => s.fields.map((f) => f.key));
    expect(new Set(keys).size).toBe(keys.length);
    expect(t.map((s) => s.order)).toEqual(t.map((_, i) => i));
  });

  it("ships no generic placeholder labels", () => {
    const labels = getApplicationTemplate("DIRECTOR", ["BVHD"], dates).flatMap((s) => s.fields.map((f) => f.label));
    for (const l of labels) expect(l).not.toMatch(/supplement #?\d+$/i);
  });

  it("director template carries the faithful board-application shape", () => {
    const t = getApplicationTemplate("DIRECTOR", [], dates);
    const keys = t.flatMap((s) => s.fields.map((f) => f.key));
    expect(keys).toEqual(expect.arrayContaining([
      "prev_volunteered", "returning_board",
      "essay_community_care", "essay_priorities", "essay_accountability",
      "department_choice", "subcommittee_rank",
      "time_commitments", "resume",
    ]));
    // The volunteer-specific contract/acknowledgements section must not leak into
    // the director track.
    expect(keys).not.toEqual(expect.arrayContaining(["volunteer_agreement"]));
    // Info-session attendance is reconciled on the backend, not self-attested.
    expect(keys).not.toEqual(expect.arrayContaining(["info_session_confirm"]));
    expect(keys.filter((k) => k === "subcommittee_rank")).toHaveLength(1);
  });

  it("VOLUNTEER template carries visibleWhen conditions on the gated fields", () => {
    const fields = getApplicationTemplate("VOLUNTEER", [], dates).flatMap((s) => s.fields);
    const byKey = (key: string) => fields.find((f) => f.key === key)!;
    expect(byKey("other_languages_detail").visibleWhen).toEqual({ field: "other_languages", op: "is", value: "yes" });
    expect(byKey("medical_certifications").visibleWhen).toEqual({ field: "licensed_professional", op: "is", value: "yes" });
    expect(byKey("medical_details").visibleWhen).toEqual({ field: "licensed_professional", op: "is", value: "yes" });
    expect(byKey("yale_affiliation_other").visibleWhen).toEqual({ field: "yale_affiliation", op: "isAnyOf", value: ["other_yale", "staff"] });
  });

  it("DIRECTOR template carries the shared identity/language visibleWhen conditions (no eligibilitySection)", () => {
    const fields = getApplicationTemplate("DIRECTOR", [], dates).flatMap((s) => s.fields);
    const byKey = (key: string) => fields.find((f) => f.key === key)!;
    expect(byKey("other_languages_detail").visibleWhen).toEqual({ field: "other_languages", op: "is", value: "yes" });
    expect(byKey("yale_affiliation_other").visibleWhen).toEqual({ field: "yale_affiliation", op: "isAnyOf", value: ["other_yale", "staff"] });
    expect(fields.find((f) => f.key === "medical_certifications")).toBeUndefined();
  });

  it("scopes the department choice to new applicants but keeps the switch-departments question for renewals", () => {
    const t = getApplicationTemplate("VOLUNTEER", [], dates);
    const sectionFor = (key: string) => t.find((s) => s.fields.some((f) => f.key === key))!;
    // The department dropdown and its "are you flexible?" follow-up are only asked
    // of new applicants and transfers (TRANSFER resolves to NEW) -- a renewal keeps
    // their current department, chosen in the intro step, so the section is hidden.
    expect(sectionFor("department_choice").appliesTo).toBe("NEW");
    expect(sectionFor("department_flexibility").appliesTo).toBe("NEW");
    // "Would you be willing to switch departments?" is still asked of renewals.
    expect(sectionFor("switch_departments").appliesTo).toBe("BOTH");
  });

  it("scopes the director department preference to new applicants (hidden from renewals)", () => {
    const t = getApplicationTemplate("DIRECTOR", [], dates);
    const sectionFor = (key: string) => t.find((s) => s.fields.some((f) => f.key === key))!;
    // A renewing director keeps their current department (chosen in the intro
    // step), so the ranked-preference dropdown is asked only of new applicants
    // and transfers (TRANSFER resolves to NEW).
    expect(sectionFor("department_choice").appliesTo).toBe("NEW");
  });

  it("volunteer department section requires a cover letter ahead of the resume", () => {
    const t = getApplicationTemplate("VOLUNTEER", [], dates);
    const deptSection = t.find((s) => s.fields.some((f) => f.key === "cover_letter"))!;
    const keys = deptSection.fields.map((f) => f.key);
    expect(keys.indexOf("cover_letter")).toBeGreaterThanOrEqual(0);
    expect(keys.indexOf("cover_letter")).toBeLessThan(keys.indexOf("resume"));
    const coverLetter = deptSection.fields.find((f) => f.key === "cover_letter")!;
    expect(coverLetter.type).toBe("FILE");
    expect(coverLetter.required).toBe(true);
  });
});
