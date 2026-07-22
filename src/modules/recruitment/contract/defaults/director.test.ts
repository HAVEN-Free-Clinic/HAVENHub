import { describe, it, expect } from "vitest";
import { DIRECTOR_LAYOUT } from "./director";
import { DEPARTMENT_RESPONSIBILITY_BLOCKS } from "./departments";

describe("DIRECTOR_LAYOUT", () => {
  it("carries every department responsibility block", () => {
    const ids = DIRECTOR_LAYOUT.blocks.filter((b) => b.kind === "agreement").map((b) => b.id);
    for (const b of DEPARTMENT_RESPONSIBILITY_BLOCKS) expect(ids).toContain(b.id);
  });

  it("carries board responsibilities, strike policy and data privacy", () => {
    const ids = DIRECTOR_LAYOUT.blocks.filter((b) => b.kind === "agreement").map((b) => b.id);
    expect(ids).toEqual(expect.arrayContaining(["board_responsibilities", "strike_policy", "data_privacy"]));
  });

  it("places department blocks after the board responsibilities", () => {
    const boardAt = DIRECTOR_LAYOUT.blocks.findIndex((b) => b.kind === "agreement" && b.id === "board_responsibilities");
    const firstDeptAt = DIRECTOR_LAYOUT.blocks.findIndex((b) => b.kind === "agreement" && b.id.startsWith("dept_"));
    expect(firstDeptAt).toBeGreaterThan(boardAt);
  });

  it("closes with a full-name signature", () => {
    const last = DIRECTOR_LAYOUT.blocks[DIRECTOR_LAYOUT.blocks.length - 1];
    expect(last.kind).toBe("agreement");
    expect("confirmKind" in last && last.confirmKind).toBe("signature");
  });

  it("hand-authored agreements have correct confirmKind values", () => {
    const confirmKinds: Record<string, string> = {
      board_responsibilities: "checkbox",
      strike_policy: "checkbox",
      data_privacy: "signature",
      haven_agreement: "signature",
      final_acknowledgement: "signature",
    };

    for (const [id, expectedKind] of Object.entries(confirmKinds)) {
      const b = DIRECTOR_LAYOUT.blocks.find((x) => x.kind === "agreement" && x.id === id);
      expect(b && "confirmKind" in b && b.confirmKind).toBe(expectedKind);
    }
  });

  it("gates staffTitle, second_department_name, epic_needed_self, the Epic section and block correctly", () => {
    const staffTitle = DIRECTOR_LAYOUT.blocks.find((b) => b.kind === "system_field" && b.systemKey === "staffTitle");
    expect(staffTitle?.visibleWhen).toMatchObject({ field: "yaleAffiliation", op: "is", value: "staff" });

    const secondDeptName = DIRECTOR_LAYOUT.blocks.find((b) => b.kind === "custom_question" && b.key === "second_department_name");
    expect(secondDeptName?.visibleWhen).toMatchObject({ field: "second_department", op: "is", value: "yes" });

    const epicNeededSelf = DIRECTOR_LAYOUT.blocks.find((b) => b.kind === "custom_question" && b.key === "epic_needed_self");
    expect(epicNeededSelf?.visibleWhen).toMatchObject({ field: "epicAsk", op: "is", value: "yes" });

    const epicSection = DIRECTOR_LAYOUT.blocks.find((b) => b.kind === "section" && b.id === "sec_epic");
    expect(epicSection?.visibleWhen).toMatchObject({ field: "epicSection", op: "is", value: "show" });

    const epicBlock = DIRECTOR_LAYOUT.blocks.find((b) => b.kind === "system_field" && b.systemKey === "epic");
    expect(epicBlock?.visibleWhen).toMatchObject({ field: "epicSection", op: "is", value: "show" });

    // epicIdExpiration is no longer collected on the onboarding form.
    expect(DIRECTOR_LAYOUT.blocks.some((b) => b.kind === "system_field" && b.systemKey === "epicIdExpiration")).toBe(false);
  });

  it("training agreement body carries the trainingDate and trainingLocation tokens", () => {
    const b = DIRECTOR_LAYOUT.blocks.find((x) => x.kind === "agreement" && x.id === "training");
    expect(b && "body" in b && b.body).toContain("{{trainingDate}}");
    expect(b && "body" in b && b.body).toContain("{{trainingLocation}}");
  });

  it("Epic section body carries the decision guidance, not the generic preamble", () => {
    const b = DIRECTOR_LAYOUT.blocks.find((x) => x.kind === "section" && x.id === "sec_epic");
    expect(b && "body" in b && b.body).toContain("Answer Yes if you need Epic");
  });
});
