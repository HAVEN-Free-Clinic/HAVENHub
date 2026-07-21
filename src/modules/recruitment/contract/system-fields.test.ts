import { describe, it, expect } from "vitest";
import { SYSTEM_FIELDS, SYSTEM_FIELD_KEYS, DEFAULT_CONTRACT_LAYOUT, defaultContractLayout, YALE_AFFILIATION_OPTIONS, gradYearOptions } from "./system-fields";
import { parseContractLayout, type AgreementBlock, type SystemFieldBlock } from "./layout";
import { YALE_AFFILIATION } from "../templates/content/options";

describe("system fields + default layout", () => {
  it("marks name, email, epic, hipaa as core", () => {
    expect(SYSTEM_FIELDS.name.core).toBe(true);
    expect(SYSTEM_FIELDS.email.core).toBe(true);
    expect(SYSTEM_FIELDS.epic.core).toBe(true);
    expect(SYSTEM_FIELDS.hipaa.core).toBe(true);
  });

  it("DEFAULT_CONTRACT_LAYOUT validates and carries the onboarding fields", () => {
    const layout = parseContractLayout(DEFAULT_CONTRACT_LAYOUT);
    const systemKeys = layout.blocks
      .filter((b): b is SystemFieldBlock => b.kind === "system_field")
      .map((b) => b.systemKey);
    // parity: every field on today's onboard-form is represented, except
    // "spanish", which the defaults module (see ./defaults) deliberately
    // drops from the default layout; the key stays in SYSTEM_FIELD_KEYS as a
    // field type a builder can still add back.
    for (const k of ["name","email","netId","phone","dob","dietary","yaleAffiliation","gradYear","epic","licensedRN","hipaa","initials"]) {
      expect(systemKeys).toContain(k);
    }
    expect(systemKeys).not.toContain("spanish");
    const agreements = layout.blocks
      .filter((b): b is AgreementBlock => b.kind === "agreement")
      .map((b) => b.id);
    expect(agreements).toEqual(["agreement", "professionalism", "training"]);
  });

  it("default agreement bodies are non-empty (see ./defaults)", () => {
    const layout = parseContractLayout(DEFAULT_CONTRACT_LAYOUT);
    for (const b of layout.blocks) if (b.kind === "agreement") expect(b.body.trim().length).toBeGreaterThan(0);
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

describe("new system fields", () => {
  it("registers pronouns, staffTitle and epicIdExpiration as optional fields", () => {
    for (const key of ["pronouns", "staffTitle", "epicIdExpiration"] as const) {
      expect(SYSTEM_FIELD_KEYS).toContain(key);
      expect(SYSTEM_FIELDS[key].core).toBe(false);
    }
  });

  it("renders affiliation and grad year as selects", () => {
    expect(SYSTEM_FIELDS.yaleAffiliation.render).toBe("select");
    expect(SYSTEM_FIELDS.gradYear.render).toBe("select");
  });

  it("offers the canonical Yale affiliation options, not a parallel copy", () => {
    expect(YALE_AFFILIATION_OPTIONS).toEqual(YALE_AFFILIATION);
    expect(SYSTEM_FIELDS.yaleAffiliation.options).toEqual(YALE_AFFILIATION);
  });

  it("includes a literal staff value in the affiliation options", () => {
    expect(YALE_AFFILIATION_OPTIONS.some((o) => o.value === "staff")).toBe(true);
  });

  it("builds a seven year grad window plus Other and N/A", () => {
    const opts = gradYearOptions(2026);
    expect(opts.map((o) => o.value)).toEqual([
      "2026", "2027", "2028", "2029", "2030", "2031", "2032", "other", "na",
    ]);
  });

  it("keeps every system field's columns non-empty", () => {
    for (const key of SYSTEM_FIELD_KEYS) {
      expect(SYSTEM_FIELDS[key].columns.length).toBeGreaterThan(0);
    }
  });

  it("keeps SYSTEM_FIELD_KEYS and SYSTEM_FIELDS in exact correspondence", () => {
    const keySet = new Set<string>(SYSTEM_FIELD_KEYS);
    const specKeys = Object.keys(SYSTEM_FIELDS);
    // no key without a spec
    for (const key of SYSTEM_FIELD_KEYS) {
      expect(SYSTEM_FIELDS[key]).toBeDefined();
      expect(SYSTEM_FIELDS[key].key).toBe(key);
    }
    // no spec without a key
    for (const specKey of specKeys) {
      expect(keySet.has(specKey)).toBe(true);
    }
    expect(specKeys.length).toBe(SYSTEM_FIELD_KEYS.length);
  });

  it("gradYearOptions returns strictly increasing consecutive years plus two extras", () => {
    const opts = gradYearOptions(2026);
    expect(opts.length).toBe(9);
    const yearOpts = opts.slice(0, 7);
    for (let i = 0; i < yearOpts.length; i++) {
      expect(Number(yearOpts[i].value)).toBe(2026 + i);
    }
    expect(opts[7].value).toBe("other");
    expect(opts[8].value).toBe("na");
  });

  it("honors its fromYear argument rather than hardcoding a year", () => {
    const opts2026 = gradYearOptions(2026);
    const opts2030 = gradYearOptions(2030);
    expect(opts2026[0].value).toBe("2026");
    expect(opts2030[0].value).toBe("2030");
    expect(opts2026[0].value).not.toBe(opts2030[0].value);
  });
});
