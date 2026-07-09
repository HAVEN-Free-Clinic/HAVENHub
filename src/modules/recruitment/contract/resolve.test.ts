import { describe, it, expect } from "vitest";
import { resolveLayoutSources } from "./resolve";
import { DEFAULT_CONTRACT_LAYOUT } from "./system-fields";

describe("resolveLayoutSources", () => {
  it("prefers the cycle override", () => {
    const override = { blocks: [{ kind: "agreement", id: "x", title: "X", body: "hi", signatureLabel: "sign" }] };
    expect(resolveLayoutSources(override, null).blocks).toHaveLength(1);
  });
  it("falls back to the global default", () => {
    const global = { blocks: [{ kind: "system_field", systemKey: "name" }] };
    expect(resolveLayoutSources(null, global).blocks[0]).toMatchObject({ systemKey: "name" });
  });
  it("falls back to the code default when both are null", () => {
    expect(resolveLayoutSources(null, null).blocks).toEqual(DEFAULT_CONTRACT_LAYOUT.blocks);
  });
  it("falls back to the code default when a stored value is malformed", () => {
    expect(resolveLayoutSources({ garbage: true }, null).blocks).toEqual(DEFAULT_CONTRACT_LAYOUT.blocks);
  });
  it("prefers the cycle override over a non-null global default", () => {
    const cycle = { blocks: [{ kind: "agreement", id: "c", title: "Cycle", body: "", signatureLabel: "sign" }] };
    const global = { blocks: [{ kind: "agreement", id: "g", title: "Global", body: "", signatureLabel: "sign" }] };
    const out = resolveLayoutSources(cycle, global);
    expect(out.blocks).toHaveLength(1);
    expect((out.blocks[0] as { id: string }).id).toBe("c");
  });
});
