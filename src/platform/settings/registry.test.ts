import { describe, expect, it } from "vitest";
import { SETTINGS, getSettingDef } from "./registry";

describe("settings registry", () => {
  it("has unique keys", () => {
    const keys = SETTINGS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every envDefault satisfies its own schema", () => {
    for (const def of SETTINGS) {
      const result = def.schema.safeParse(def.envDefault());
      expect(result.success, `${def.key} default invalid`).toBe(true);
    }
  });

  it("never registers a secret setting", () => {
    for (const def of SETTINGS) {
      expect(def.secret).toBe(false);
    }
  });

  it("registers the rhd.maxProcedures canary", () => {
    const def = getSettingDef("rhd.maxProcedures");
    expect(def.category).toBe("Operations");
  });

  it("throws for an unregistered key", () => {
    expect(() => getSettingDef("nope.missing")).toThrowError(/Unregistered/);
  });
});

describe("branding.supportEmail setting", () => {
  const def = SETTINGS.find((s) => s.key === "branding.supportEmail");

  it("is registered under Branding", () => {
    expect(def).toBeDefined();
    expect(def!.category).toBe("Branding");
  });

  it("accepts a valid email, accepts blank, and rejects anything else", () => {
    expect(def!.schema.safeParse("hfc.it@yale.edu").success).toBe(true);
    expect(def!.schema.safeParse("").success).toBe(true);
    expect(def!.schema.safeParse("not-an-email").success).toBe(false);
    expect(def!.schema.safeParse("   ").success).toBe(false);
  });
});

describe("ui.defaultTheme setting", () => {
  const def = SETTINGS.find((s) => s.key === "ui.defaultTheme");

  it("is registered as a select", () => {
    expect(def).toBeDefined();
    expect(def!.input).toEqual({
      type: "select",
      options: [
        { value: "light", label: "Light" },
        { value: "dark", label: "Dark" },
        { value: "system", label: "System (follow device)" },
      ],
    });
  });

  it("defaults to system", () => {
    expect(def!.envDefault()).toBe("system");
  });

  it("rejects values outside light/dark/system", () => {
    expect(def!.schema.safeParse("system").success).toBe(true);
    expect(def!.schema.safeParse("blue").success).toBe(false);
  });
});
