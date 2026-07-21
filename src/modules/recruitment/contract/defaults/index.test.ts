import { describe, it, expect } from "vitest";
import { defaultContractLayout } from "./index";
import { parseContractLayout } from "../layout";
import { assertTwoTier } from "../block-ops";
import { SYSTEM_FIELD_KEYS } from "../system-fields";

describe.each(["VOLUNTEER", "DIRECTOR"] as const)("%s default layout", (track) => {
  const layout = defaultContractLayout(track);

  it("parses as a valid layout", () => {
    expect(() => parseContractLayout(layout)).not.toThrow();
  });

  it("satisfies the two tier contract", () => {
    expect(() => assertTwoTier(layout)).not.toThrow();
  });

  it("references only real system field keys", () => {
    for (const b of layout.blocks) {
      if (b.kind === "system_field") expect(SYSTEM_FIELD_KEYS).toContain(b.systemKey);
    }
  });

  it("no longer asks about Spanish", () => {
    expect(layout.blocks.some((b) => b.kind === "system_field" && b.systemKey === "spanish")).toBe(false);
  });

  it("gives every agreement a non-empty body", () => {
    for (const b of layout.blocks) {
      if (b.kind === "agreement") expect(b.body.trim().length).toBeGreaterThan(0);
    }
  });

  it("opens with a section block", () => {
    expect(layout.blocks[0].kind).toBe("section");
  });
});

describe("director extras", () => {
  it("carries the data privacy agreement", () => {
    const layout = defaultContractLayout("DIRECTOR");
    expect(layout.blocks.some((b) => b.kind === "agreement" && b.id === "data_privacy")).toBe(true);
  });

  it("the volunteer layout does not", () => {
    const layout = defaultContractLayout("VOLUNTEER");
    expect(layout.blocks.some((b) => b.kind === "agreement" && b.id === "data_privacy")).toBe(false);
  });
});
