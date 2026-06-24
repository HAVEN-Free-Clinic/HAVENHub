import { describe, expect, it } from "vitest";
import {
  STRINGS,
  VITALS,
  LABS,
  FOLLOW_UP,
  COMMUNITY_RESOURCES,
  FINANCIAL_RESOURCES,
  optionLabel,
  type OptionList,
} from "./strings";

describe("STRINGS dictionaries", () => {
  it("has identical key sets for en and es", () => {
    expect(Object.keys(STRINGS.en).sort()).toEqual(Object.keys(STRINGS.es).sort());
  });

  it("has no empty values in either language", () => {
    for (const lang of ["en", "es"] as const) {
      for (const [key, value] of Object.entries(STRINGS[lang])) {
        expect(value, `${lang}.${key}`).toBeTruthy();
      }
    }
  });
});

describe("option lists", () => {
  const lists: Record<string, OptionList> = {
    VITALS,
    LABS,
    FOLLOW_UP,
    COMMUNITY_RESOURCES,
    FINANCIAL_RESOURCES,
  };

  it("every entry has a stable key plus non-empty en and es labels", () => {
    for (const [name, list] of Object.entries(lists)) {
      for (const opt of list) {
        expect(opt.key, `${name} key`).toBeTruthy();
        expect(opt.en, `${name}.${opt.key}.en`).toBeTruthy();
        expect(opt.es, `${name}.${opt.key}.es`).toBeTruthy();
      }
    }
  });

  it("has unique keys within each list", () => {
    for (const [name, list] of Object.entries(lists)) {
      const keys = list.map((o) => o.key);
      expect(new Set(keys).size, name).toBe(keys.length);
    }
  });
});

describe("optionLabel", () => {
  it("returns the language-specific label", () => {
    expect(optionLabel(VITALS, "blood-pressure", "en")).toBe("Blood pressure");
    expect(optionLabel(VITALS, "blood-pressure", "es")).toBe("Presión arterial");
  });

  it("falls back to the key when not found", () => {
    expect(optionLabel(VITALS, "nope", "en")).toBe("nope");
  });
});
