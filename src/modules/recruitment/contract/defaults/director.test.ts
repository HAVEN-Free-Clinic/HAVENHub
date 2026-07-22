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
});
