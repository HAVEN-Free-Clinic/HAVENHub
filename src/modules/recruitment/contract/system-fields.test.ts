import { describe, it, expect } from "vitest";
import { SYSTEM_FIELDS, SYSTEM_FIELD_KEYS, DEFAULT_CONTRACT_LAYOUT, defaultContractLayout, YALE_AFFILIATION_OPTIONS, systemFieldOptions } from "./system-fields";
import { parseContractLayout, type AgreementBlock, type SystemFieldBlock } from "./layout";
import { GRAD_YEAR, YALE_AFFILIATION } from "../templates/content/options";

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

  it("DEFAULT_CONTRACT_LAYOUT validates and carries the onboarding fields", () => {
    const layout = parseContractLayout(DEFAULT_CONTRACT_LAYOUT);
    const systemKeys = layout.blocks
      .filter((b): b is SystemFieldBlock => b.kind === "system_field")
      .map((b) => b.systemKey);
    // parity: every field on today's onboard-form is represented, except
    // "spanish" and "initials", which the defaults module (see ./defaults)
    // deliberately drops from the default layout -- initials are now captured
    // per-agreement via confirmKind: "initials" rather than a standalone
    // system field. Both keys stay in SYSTEM_FIELD_KEYS as field types a
    // builder can still add back.
    for (const k of ["name","email","netId","phone","dob","dietary","yaleAffiliation","gradYear","epic","licensedRN","hipaa"]) {
      expect(systemKeys).toContain(k);
    }
    expect(systemKeys).not.toContain("spanish");
    expect(systemKeys).not.toContain("initials");
    const agreements = layout.blocks
      .filter((b): b is AgreementBlock => b.kind === "agreement")
      .map((b) => b.id);
    expect(agreements).toEqual(["agreement", "professionalism", "commitment", "training", "haven_agreement"]);
  });

  it("default agreement bodies are non-empty (see ./defaults)", () => {
    const layout = parseContractLayout(DEFAULT_CONTRACT_LAYOUT);
    for (const b of layout.blocks) if (b.kind === "agreement") expect(b.body.trim().length).toBeGreaterThan(0);
  });
});

describe("defaultContractLayout(track)", () => {
  it("volunteer default keeps its five agreements", () => {
    const ids = defaultContractLayout("VOLUNTEER").blocks.filter((b): b is AgreementBlock => b.kind === "agreement").map((b) => b.id);
    expect(ids).toEqual(["agreement", "professionalism", "commitment", "training", "haven_agreement"]);
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

  it("offers the canonical grad-year options, not a parallel copy", () => {
    expect(SYSTEM_FIELDS.gradYear.options).toEqual(GRAD_YEAR);
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

  it("prepends a stored grad year outside the canonical list rather than dropping it", () => {
    const opts = systemFieldOptions("gradYear", "1999");
    expect(opts[0]).toEqual({ value: "1999", label: "1999" });
    expect(opts.length).toBe(GRAD_YEAR.length + 1);
  });
});
