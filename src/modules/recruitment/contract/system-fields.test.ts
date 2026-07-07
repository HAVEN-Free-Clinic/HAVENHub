import { describe, it, expect } from "vitest";
import { SYSTEM_FIELDS, DEFAULT_CONTRACT_LAYOUT } from "./system-fields";
import { parseContractLayout } from "./layout";

describe("system fields + default layout", () => {
  it("marks name, email, epic, hipaa as core", () => {
    expect(SYSTEM_FIELDS.name.core).toBe(true);
    expect(SYSTEM_FIELDS.email.core).toBe(true);
    expect(SYSTEM_FIELDS.epic.core).toBe(true);
    expect(SYSTEM_FIELDS.hipaa.core).toBe(true);
  });

  it("DEFAULT_CONTRACT_LAYOUT validates and reproduces today's fields", () => {
    const layout = parseContractLayout(DEFAULT_CONTRACT_LAYOUT);
    const systemKeys = layout.blocks.filter((b) => b.kind === "system_field").map((b: any) => b.systemKey);
    // parity: every field on today's onboard-form is represented
    for (const k of ["name","email","netId","phone","dob","dietary","yaleAffiliation","gradYear","epic","spanish","licensedRN","hipaa","initials"]) {
      expect(systemKeys).toContain(k);
    }
    const agreements = layout.blocks.filter((b) => b.kind === "agreement").map((b: any) => b.id);
    expect(agreements).toEqual(["agreement", "professionalism", "training"]);
  });

  it("default agreement bodies are empty for parity with today's form", () => {
    const layout = parseContractLayout(DEFAULT_CONTRACT_LAYOUT);
    for (const b of layout.blocks) if (b.kind === "agreement") expect(b.body).toBe("");
  });
});
