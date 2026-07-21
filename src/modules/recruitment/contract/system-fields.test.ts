import { describe, it, expect } from "vitest";
import { SYSTEM_FIELDS, DEFAULT_CONTRACT_LAYOUT, defaultContractLayout, systemFieldOptions } from "./system-fields";
import { parseContractLayout, type AgreementBlock, type SystemFieldBlock } from "./layout";

describe("systemFieldOptions", () => {
  it("renders yaleAffiliation as a choice list, not free text", () => {
    expect(SYSTEM_FIELDS.yaleAffiliation.render).toBe("select");
    expect(SYSTEM_FIELDS.gradYear.render).toBe("select");
  });

  it("gives every affiliation key a human label", () => {
    const opts = systemFieldOptions("yaleAffiliation", "other_yale");
    expect(opts.find((o) => o.value === "other_yale")?.label).toBe("Other Yale Affiliation");
    expect(opts.find((o) => o.value === "ysm_md")?.label).toBe("Yale School of Medicine (YSM), MD or MD/PhD");
  });

  it("leaves the canonical list untouched for a known value", () => {
    expect(systemFieldOptions("yaleAffiliation", "staff")).toHaveLength(13);
  });

  it("leaves the canonical list untouched when there is no stored value", () => {
    expect(systemFieldOptions("yaleAffiliation", "")).toHaveLength(13);
    expect(systemFieldOptions("yaleAffiliation", undefined)).toHaveLength(13);
  });

  // Person.yaleAffiliation holds a mix of vocabularies (recruitment machine keys,
  // /my-info human strings, Airtable imports). An unrecognised stored value must
  // survive a round-trip through the form rather than being silently reset.
  it("preserves a stored value that is not in the canonical list", () => {
    const opts = systemFieldOptions("yaleAffiliation", "Yale School of Medicine");
    expect(opts).toHaveLength(14);
    expect(opts[0]).toEqual({ value: "Yale School of Medicine", label: "Yale School of Medicine" });
  });

  it("returns no options for a field that is not a choice list", () => {
    expect(systemFieldOptions("netId", "abc123")).toEqual([]);
  });
});

describe("system fields + default layout", () => {
  it("marks name, email, epic, hipaa as core", () => {
    expect(SYSTEM_FIELDS.name.core).toBe(true);
    expect(SYSTEM_FIELDS.email.core).toBe(true);
    expect(SYSTEM_FIELDS.epic.core).toBe(true);
    expect(SYSTEM_FIELDS.hipaa.core).toBe(true);
  });

  it("DEFAULT_CONTRACT_LAYOUT validates and reproduces today's fields", () => {
    const layout = parseContractLayout(DEFAULT_CONTRACT_LAYOUT);
    const systemKeys = layout.blocks
      .filter((b): b is SystemFieldBlock => b.kind === "system_field")
      .map((b) => b.systemKey);
    // parity: every field on today's onboard-form is represented
    for (const k of ["name","email","netId","phone","dob","dietary","yaleAffiliation","gradYear","epic","spanish","licensedRN","hipaa","initials"]) {
      expect(systemKeys).toContain(k);
    }
    const agreements = layout.blocks
      .filter((b): b is AgreementBlock => b.kind === "agreement")
      .map((b) => b.id);
    expect(agreements).toEqual(["agreement", "professionalism", "training"]);
  });

  it("default agreement bodies are empty for parity with today's form", () => {
    const layout = parseContractLayout(DEFAULT_CONTRACT_LAYOUT);
    for (const b of layout.blocks) if (b.kind === "agreement") expect(b.body).toBe("");
  });
});

describe("defaultContractLayout(track)", () => {
  it("volunteer default keeps the three agreements", () => {
    const ids = defaultContractLayout("VOLUNTEER").blocks.filter((b): b is AgreementBlock => b.kind === "agreement").map((b) => b.id);
    expect(ids).toEqual(["agreement", "professionalism", "training"]);
  });
  it("director default includes a data-privacy agreement the volunteer default lacks", () => {
    const dirIds = defaultContractLayout("DIRECTOR").blocks.filter((b) => b.kind === "agreement").map((b) => (b as AgreementBlock).id);
    const volIds = defaultContractLayout("VOLUNTEER").blocks.filter((b) => b.kind === "agreement").map((b) => (b as AgreementBlock).id);
    expect(dirIds).toContain("data_privacy");
    expect(volIds).not.toContain("data_privacy");
  });
});
