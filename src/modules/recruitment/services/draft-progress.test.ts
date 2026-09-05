import { describe, expect, it } from "vitest";
import { progressFor, selectedDepartmentsFrom, type ProgressSection } from "./draft-progress";

function section(id: string, title: string, key: string, type = "SHORT_TEXT", departmentCode: string | null = null): ProgressSection {
  return {
    id,
    title,
    appliesTo: "BOTH",
    departmentCode,
    fields: [{ key, type, required: true }],
  };
}

describe("draft progress", () => {
  it("treats pre-seeded blank keys as unanswered and reports a ready draft accurately", () => {
    const sections = [section("personal", "Personal details", "first_name"), section("contract", "Contract", "signature", "SIGNATURE")];
    const blank = progressFor({ sections, answers: { first_name: "", signature: "" }, applicantType: "NEW", selectedDepartmentCodes: [] });
    expect(blank.tier).toBe("just_started");
    expect(blank.remaining.map((step) => step.title)).toEqual(["Personal details", "Contract"]);

    const ready = progressFor({ sections, answers: { first_name: "Ada", signature: "signed" }, applicantType: "NEW", selectedDepartmentCodes: [] });
    expect(ready.tier).toBe("ready");
    expect(ready.remaining).toEqual([]);
  });

  it("includes only supplements for departments selected in the draft answers", () => {
    const fields = [{ key: "department", type: "DEPARTMENT_CHOICE", required: true }];
    const answers = { department: ["MED"] };
    const progress = progressFor({
      sections: [
        section("shared", "Shared", "name"),
        section("med", "Medical questions", "med_answer", "SHORT_TEXT", "MED"),
        section("legal", "Legal questions", "legal_answer", "SHORT_TEXT", "LEGAL"),
      ],
      answers: { ...answers, name: "Ada" },
      applicantType: "NEW",
      selectedDepartmentCodes: selectedDepartmentsFrom(answers, fields),
    });
    expect(progress.steps.map((step) => step.title)).toEqual(["Shared", "Medical questions"]);
    expect(progress.remaining.map((step) => step.title)).toEqual(["Medical questions"]);
    expect(progress.tier).toBe("almost_done");
  });
});
