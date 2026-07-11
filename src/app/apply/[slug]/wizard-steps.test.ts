import { describe, expect, it } from "vitest";
import { deriveSteps, stepIndexForKeys, type WizardSection } from "./wizard-steps";

function section(overrides: Partial<WizardSection> & { id: string; title: string }): WizardSection {
  return {
    description: null,
    appliesTo: "BOTH",
    departmentCode: null,
    fields: [],
    ...overrides,
  };
}

const base = section({ id: "s-about", title: "About you" });
const renewalOnly = section({ id: "s-ren", title: "Renewal", appliesTo: "RENEWAL" });
const deptSupp = section({ id: "s-srhd", title: "SRHD questions", departmentCode: "SRHD" });

describe("deriveSteps", () => {
  it("prepends an intro step only when renewals are accepted", () => {
    const withIntro = deriveSteps({ sections: [base], acceptsRenewals: true, applicantType: "NEW", selectedDepartmentCodes: [] });
    expect(withIntro.map((s) => s.kind)).toEqual(["intro", "section", "review"]);

    const noIntro = deriveSteps({ sections: [base], acceptsRenewals: false, applicantType: "NEW", selectedDepartmentCodes: [] });
    expect(noIntro.map((s) => s.kind)).toEqual(["section", "review"]);
  });

  it("hides RENEWAL-only sections for a NEW applicant", () => {
    const steps = deriveSteps({ sections: [base, renewalOnly], acceptsRenewals: false, applicantType: "NEW", selectedDepartmentCodes: [] });
    expect(steps.filter((s) => s.kind === "section").map((s) => s.id)).toEqual(["s-about"]);
  });

  it("shows a department supplement only when its department is selected", () => {
    const without = deriveSteps({ sections: [base, deptSupp], acceptsRenewals: false, applicantType: "NEW", selectedDepartmentCodes: [] });
    expect(without.filter((s) => s.kind === "section").map((s) => s.id)).toEqual(["s-about"]);

    const withDept = deriveSteps({ sections: [base, deptSupp], acceptsRenewals: false, applicantType: "NEW", selectedDepartmentCodes: ["SRHD"] });
    expect(withDept.filter((s) => s.kind === "section").map((s) => s.id)).toEqual(["s-about", "s-srhd"]);
  });

  it("always ends with review", () => {
    const steps = deriveSteps({ sections: [], acceptsRenewals: false, applicantType: "NEW", selectedDepartmentCodes: [] });
    expect(steps[steps.length - 1].kind).toBe("review");
  });
});

describe("stepIndexForKeys", () => {
  it("returns the earliest section step containing any key", () => {
    const steps = deriveSteps({
      sections: [
        section({ id: "a", title: "A", fields: [{ key: "first_name", label: "First", helpText: null, type: "TEXT", required: true, options: null, validation: null }] }),
        section({ id: "b", title: "B", fields: [{ key: "why", label: "Why", helpText: null, type: "LONG_TEXT", required: true, options: null, validation: null }] }),
      ],
      acceptsRenewals: false,
      applicantType: "NEW",
      selectedDepartmentCodes: [],
    });
    // steps: [section a (0), section b (1), review (2)]
    expect(stepIndexForKeys(steps, ["why"])).toBe(1);
    expect(stepIndexForKeys(steps, ["first_name", "why"])).toBe(0);
    expect(stepIndexForKeys(steps, ["nope"])).toBeNull();
    expect(stepIndexForKeys(steps, [])).toBeNull();
  });
});
