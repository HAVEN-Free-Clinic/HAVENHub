import { describe, expect, it } from "vitest";
import { SETTINGS, getSettingDef, listCategories, type SettingValidateCtx } from "./registry";
import { config } from "@/platform/config";

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

  it("excludes hidden settings' categories from listCategories()", () => {
    // onboarding.contractTemplate is hidden: true (edited via dedicated pages, not the generic form)
    expect(listCategories()).not.toContain("Onboarding");
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

describe("branding.applyPortalTitle setting", () => {
  const def = SETTINGS.find((s) => s.key === "branding.applyPortalTitle");

  it("is registered under Branding as a text input", () => {
    expect(def).toBeDefined();
    expect(def!.category).toBe("Branding");
    expect(def!.input).toEqual({ type: "text" });
  });

  it("defaults to 'HAVEN Application Portal'", () => {
    expect(def!.envDefault()).toBe("HAVEN Application Portal");
  });

  it("requires a non-empty title", () => {
    expect(def!.schema.safeParse("Apply Here").success).toBe(true);
    expect(def!.schema.safeParse("").success).toBe(false);
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

describe("clinic hours settings", () => {
  it("registers a start and end time with HH:MM defaults", () => {
    expect(getSettingDef("schedule.clinicStartTime").envDefault()).toBe("08:00");
    expect(getSettingDef("schedule.clinicEndTime").envDefault()).toBe("13:00");
  });

  it("accepts a valid 24-hour time", () => {
    expect(getSettingDef("schedule.clinicStartTime").schema.safeParse("09:30").success).toBe(true);
    expect(getSettingDef("schedule.clinicEndTime").schema.safeParse("23:59").success).toBe(true);
  });

  it("rejects malformed, 12-hour, and out-of-range times", () => {
    const schema = getSettingDef("schedule.clinicStartTime").schema;
    expect(schema.safeParse("8:00").success).toBe(false);
    expect(schema.safeParse("08:00 AM").success).toBe(false);
    expect(schema.safeParse("24:00").success).toBe(false);
    expect(schema.safeParse("08:60").success).toBe(false);
    expect(schema.safeParse("").success).toBe(false);
  });

  it("start time validate rejects when equal to or later than end time", async () => {
    const startDef = getSettingDef("schedule.clinicStartTime");
    const mockCtx: SettingValidateCtx = {
      config,
      getSetting: <U>() => Promise.resolve("13:00") as Promise<U>,
    };
    expect(await startDef.validate?.("13:00", mockCtx)).toBe("Start time must be earlier than the clinic end time.");
    expect(await startDef.validate?.("14:00", mockCtx)).toBe("Start time must be earlier than the clinic end time.");
  });

  it("start time validate accepts when earlier than end time", async () => {
    const startDef = getSettingDef("schedule.clinicStartTime");
    const mockCtx: SettingValidateCtx = {
      config,
      getSetting: <U>() => Promise.resolve("13:00") as Promise<U>,
    };
    expect(await startDef.validate?.("08:00", mockCtx)).toBe(null);
    expect(await startDef.validate?.("12:59", mockCtx)).toBe(null);
  });

  it("end time validate rejects when equal to or earlier than start time", async () => {
    const endDef = getSettingDef("schedule.clinicEndTime");
    const mockCtx: SettingValidateCtx = {
      config,
      getSetting: <U>() => Promise.resolve("08:00") as Promise<U>,
    };
    expect(await endDef.validate?.("08:00", mockCtx)).toBe("End time must be later than the clinic start time.");
    expect(await endDef.validate?.("07:00", mockCtx)).toBe("End time must be later than the clinic start time.");
  });

  it("end time validate accepts when later than start time", async () => {
    const endDef = getSettingDef("schedule.clinicEndTime");
    const mockCtx: SettingValidateCtx = {
      config,
      getSetting: <U>() => Promise.resolve("08:00") as Promise<U>,
    };
    expect(await endDef.validate?.("13:00", mockCtx)).toBe(null);
    expect(await endDef.validate?.("23:59", mockCtx)).toBe(null);
  });
});

describe("maintenance settings", () => {
  it("groups the switch and its copy under one Maintenance category", () => {
    for (const key of ["maintenance.enabled", "maintenance.message", "maintenance.until"]) {
      expect(getSettingDef(key).category, key).toBe("Maintenance");
    }
    expect(listCategories()).toContain("Maintenance");
  });

  it("renders Maintenance last, away from the settings edited week to week", () => {
    const categories = listCategories();
    expect(categories[categories.length - 1]).toBe("Maintenance");
  });

  it("defaults to off, so a database blip can never strand the hub in maintenance", () => {
    expect(getSettingDef("maintenance.enabled").envDefault()).toBe(false);
  });

  it("defaults the message and the estimate to blank", () => {
    expect(getSettingDef("maintenance.message").envDefault()).toBe("");
    expect(getSettingDef("maintenance.until").envDefault()).toBe("");
  });

  it("documents the no-deploy escape hatch on the switch itself", () => {
    // The one place an admin locked out by this setting will actually look.
    expect(getSettingDef("maintenance.enabled").help).toContain("UPDATE \"Setting\"");
  });

  it("caps the free-text fields so neither can break the page layout", () => {
    const message = getSettingDef("maintenance.message");
    expect(message.schema.safeParse("Back shortly.").success).toBe(true);
    expect(message.schema.safeParse("x".repeat(501)).success).toBe(false);
    const until = getSettingDef("maintenance.until");
    expect(until.schema.safeParse("9:00 PM Eastern").success).toBe(true);
    expect(until.schema.safeParse("x".repeat(121)).success).toBe(false);
  });
});
