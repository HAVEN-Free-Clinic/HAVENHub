import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  getSetting,
  getCategory,
  setSetting,
  resetSetting,
  SettingValidationError,
  _resetSettingsCache,
} from "./service";
import * as configModule from "@/platform/config";

beforeEach(async () => {
  await resetDb();
  _resetSettingsCache();
});

describe("getSetting", () => {
  it("returns the env default when no override row exists", async () => {
    // config.RHD_MAX_PROCEDURES defaults to 3 in the test env.
    expect(await getSetting<number>("rhd.maxProcedures")).toBe(3);
  });

  it("returns the stored override when present and valid", async () => {
    await prisma.setting.create({ data: { key: "rhd.maxProcedures", value: 5 } });
    expect(await getSetting<number>("rhd.maxProcedures")).toBe(5);
  });

  it("falls back to the env default when the stored value is invalid", async () => {
    await prisma.setting.create({ data: { key: "rhd.maxProcedures", value: "garbage" } });
    expect(await getSetting<number>("rhd.maxProcedures")).toBe(3);
  });

  it("throws for an unregistered key", async () => {
    await expect(getSetting("nope.missing")).rejects.toThrow(/Unregistered/);
  });

  it("serves the second read within the TTL from cache (no DB hit)", async () => {
    await getSetting("rhd.maxProcedures"); // warms the cache
    const spy = vi.spyOn(prisma.setting, "findUnique");
    await getSetting("rhd.maxProcedures");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("getCategory", () => {
  it("returns resolved values and an isOverridden flag", async () => {
    const before = await getCategory("Operations");
    expect(before).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "rhd.maxProcedures", value: 3, isOverridden: false }),
      ])
    );

    await setSetting("rhd.maxProcedures", 7, null);
    const after = await getCategory("Operations");
    const rhdEntry = after.find((e) => e.key === "rhd.maxProcedures");
    expect(rhdEntry).toMatchObject({ value: 7, isOverridden: true });
  });
});

describe("setSetting", () => {
  it("rejects a value that fails the schema", async () => {
    await expect(setSetting("rhd.maxProcedures", -1, null)).rejects.toBeInstanceOf(
      SettingValidationError
    );
    expect(await prisma.setting.findUnique({ where: { key: "rhd.maxProcedures" } })).toBeNull();
  });

  it("writes the override and an audit row", async () => {
    await setSetting("rhd.maxProcedures", 9, "person-1");
    const row = await prisma.setting.findUnique({ where: { key: "rhd.maxProcedures" } });
    expect(row).toMatchObject({ value: 9, updatedById: "person-1" });

    const audit = await prisma.auditLog.findFirst({ where: { action: "setting.update" } });
    expect(audit).toMatchObject({
      entityType: "Setting",
      entityId: "rhd.maxProcedures",
      before: 3,
      after: 9,
      actorPersonId: "person-1",
    });
  });
});

describe("resetSetting", () => {
  it("deletes the override and audits the reset", async () => {
    await setSetting("rhd.maxProcedures", 9, "person-1");
    await resetSetting("rhd.maxProcedures", "person-1");
    expect(await prisma.setting.findUnique({ where: { key: "rhd.maxProcedures" } })).toBeNull();
    expect(await getSetting<number>("rhd.maxProcedures")).toBe(3);

    const audit = await prisma.auditLog.findFirst({ where: { action: "setting.reset" } });
    expect(audit).toMatchObject({ entityId: "rhd.maxProcedures", before: 9, after: 3 });
  });

  it("is a no-op (no audit) when the key has no override", async () => {
    await resetSetting("rhd.maxProcedures", "person-1");
    const audit = await prisma.auditLog.findFirst({ where: { action: "setting.reset" } });
    expect(audit).toBeNull();
    expect(await getSetting<number>("rhd.maxProcedures")).toBe(3);
  });
});

describe("phase 1 operations scalars", () => {
  it("resolves uploads.maxMb from env default then DB override", async () => {
    expect(await getSetting<number>("uploads.maxMb")).toBe(5); // MAX_UPLOAD_MB default
    await prisma.setting.create({ data: { key: "uploads.maxMb", value: 12 } });
    _resetSettingsCache();
    expect(await getSetting<number>("uploads.maxMb")).toBe(12);
  });

  it("resolves the compliance scalars from env defaults", async () => {
    expect(await getSetting<number>("compliance.reminderIntervalDays")).toBe(7);
    expect(await getSetting<number>("compliance.escalationThreshold")).toBe(3);
  });
});

describe("phase 1 email/links/teams scalars", () => {
  it("resolves app.baseUrl from env default", async () => {
    expect(await getSetting<string>("app.baseUrl")).toBe("http://localhost:3000");
  });
  it("resolves teams.clinicGroupId (empty string default when env unset)", async () => {
    expect(typeof (await getSetting<string>("teams.clinicGroupId"))).toBe("string");
  });
  it("resolves email.sender (string)", async () => {
    expect(typeof (await getSetting<string>("email.sender"))).toBe("string");
  });
});

describe("email.transport guard", () => {
  it("rejects graph when Graph OAuth env vars are absent", async () => {
    // Temporarily strip graph credentials from the config so the guard fires.
    const saved = {
      GRAPH_OAUTH_TENANT_ID: configModule.config.GRAPH_OAUTH_TENANT_ID,
      GRAPH_OAUTH_CLIENT_ID: configModule.config.GRAPH_OAUTH_CLIENT_ID,
      GRAPH_OAUTH_CLIENT_SECRET: configModule.config.GRAPH_OAUTH_CLIENT_SECRET,
      EMAIL_SENDER: configModule.config.EMAIL_SENDER,
    };
    Object.assign(configModule.config, {
      GRAPH_OAUTH_TENANT_ID: undefined,
      GRAPH_OAUTH_CLIENT_ID: undefined,
      GRAPH_OAUTH_CLIENT_SECRET: undefined,
      EMAIL_SENDER: undefined,
    });
    try {
      await expect(setSetting("email.transport", "graph", null)).rejects.toBeInstanceOf(
        SettingValidationError
      );
      expect(await prisma.setting.findUnique({ where: { key: "email.transport" } })).toBeNull();
    } finally {
      Object.assign(configModule.config, saved);
    }
  });

  it("allows log without any prerequisites", async () => {
    await setSetting("email.transport", "log", null);
    expect(await getSetting<string>("email.transport")).toBe("log");
  });
});

describe("airtable.mirrorEnabled guard", () => {
  it("rejects enabling when AIRTABLE_PAT/base/people-table env vars are absent", async () => {
    // Temporarily blank the Airtable credentials so the guard fires even when
    // the local .env has them set.
    const saved = {
      AIRTABLE_PAT: configModule.config.AIRTABLE_PAT,
      AIRTABLE_MIRROR_BASE_ID: configModule.config.AIRTABLE_MIRROR_BASE_ID,
      AIRTABLE_MIRROR_PEOPLE_TABLE_ID: configModule.config.AIRTABLE_MIRROR_PEOPLE_TABLE_ID,
    };
    Object.assign(configModule.config, {
      AIRTABLE_PAT: undefined,
      AIRTABLE_MIRROR_BASE_ID: undefined,
      AIRTABLE_MIRROR_PEOPLE_TABLE_ID: undefined,
    });
    try {
      await expect(setSetting("airtable.mirrorEnabled", true, null)).rejects.toBeInstanceOf(
        SettingValidationError
      );
      expect(await prisma.setting.findUnique({ where: { key: "airtable.mirrorEnabled" } })).toBeNull();
    } finally {
      Object.assign(configModule.config, saved);
    }
  });

  it("allows disabling without prerequisites", async () => {
    await setSetting("airtable.mirrorEnabled", false, null);
    expect(await getSetting<boolean>("airtable.mirrorEnabled")).toBe(false);
  });
});

describe("phase 2a branding settings", () => {
  it("resolves branding.appName default then DB override", async () => {
    expect(await getSetting<string>("branding.appName")).toBe("HAVEN Hub");
    await prisma.setting.create({ data: { key: "branding.appName", value: "Clinic Hub" } });
    _resetSettingsCache();
    expect(await getSetting<string>("branding.appName")).toBe("Clinic Hub");
  });

  it("resolves branding.orgName default then DB override", async () => {
    expect(await getSetting<string>("branding.orgName")).toBe("HAVEN Free Clinic");
    await prisma.setting.create({ data: { key: "branding.orgName", value: "Open Door Clinic" } });
    _resetSettingsCache();
    expect(await getSetting<string>("branding.orgName")).toBe("Open Door Clinic");
  });

  it("resolves branding.orgTagline default then DB override (blank allowed)", async () => {
    expect(await getSetting<string>("branding.orgTagline")).toBe("Yale University");
    await prisma.setting.create({ data: { key: "branding.orgTagline", value: "" } });
    _resetSettingsCache();
    expect(await getSetting<string>("branding.orgTagline")).toBe("");
  });

  it("resolves branding.brandColor default", async () => {
    expect(await getSetting<string>("branding.brandColor")).toBe("#00356b");
  });

  it("falls back to the default when a stored brand color is not a hex", async () => {
    await prisma.setting.create({ data: { key: "branding.brandColor", value: "red" } });
    _resetSettingsCache();
    expect(await getSetting<string>("branding.brandColor")).toBe("#00356b");
  });
});

describe("phase 2b branding asset settings", () => {
  it("resolves branding.logo to the default descriptor", async () => {
    expect(await getSetting("branding.logo")).toEqual({ contentType: "", version: 0 });
  });

  it("resolves a stored branding.favicon descriptor", async () => {
    await prisma.setting.create({
      data: { key: "branding.favicon", value: { contentType: "image/png", version: 2 } },
    });
    _resetSettingsCache();
    expect(await getSetting("branding.favicon")).toEqual({ contentType: "image/png", version: 2 });
  });
});
