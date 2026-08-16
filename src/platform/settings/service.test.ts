import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
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

  it("falls back to the env default when the database is unreachable", async () => {
    // Simulate a brief Neon outage: the query fails to reach the server. A
    // momentary blip must degrade to the default, not throw a 500 up through
    // generateMetadata on every render.
    const spy = vi
      .spyOn(prisma.setting, "findUnique")
      .mockRejectedValueOnce(
        new Prisma.PrismaClientInitializationError(
          "Can't reach database server at ep-flat-block.neon.tech:5432",
          "5.0.0"
        )
      );
    expect(await getSetting<number>("rhd.maxProcedures")).toBe(3);
    spy.mockRestore();
  });

  it("does not cache the unreachable-DB fallback (recovers on next read)", async () => {
    const spy = vi
      .spyOn(prisma.setting, "findUnique")
      .mockRejectedValueOnce(
        new Prisma.PrismaClientInitializationError("Can't reach database server", "5.0.0")
      );
    expect(await getSetting<number>("rhd.maxProcedures")).toBe(3); // fallback
    spy.mockRestore();

    // DB recovered: a stored override is now readable, proving the fallback was
    // never cached.
    await prisma.setting.create({ data: { key: "rhd.maxProcedures", value: 8 } });
    expect(await getSetting<number>("rhd.maxProcedures")).toBe(8);
  });

  it("falls back to the env default when the Setting table is missing (P2021)", async () => {
    // The database answers, but the schema is behind the code: the Setting table
    // was never migrated. This must degrade to the default like a Neon blip, not
    // 500 every route through generateMetadata.
    const spy = vi
      .spyOn(prisma.setting, "findUnique")
      .mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError(
          "The table `public.Setting` does not exist in the current database.",
          { code: "P2021", clientVersion: "5.0.0" }
        )
      );
    expect(await getSetting<number>("rhd.maxProcedures")).toBe(3);
    spy.mockRestore();
  });

  it("still rethrows non-connectivity DB errors", async () => {
    const spy = vi
      .spyOn(prisma.setting, "findUnique")
      .mockRejectedValueOnce(new Error("boom"));
    await expect(getSetting("rhd.maxProcedures")).rejects.toThrow(/boom/);
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

  it("getCategory excludes hidden settings", async () => {
    const rows = await getCategory("Onboarding");
    expect(rows).toEqual([]);
  });

  it("falls back to env defaults when the database is unreachable", async () => {
    // A stored override exists, but the DB blips while rendering the settings
    // form. Rather than 500 the admin page, getCategory degrades to defaults:
    // every setting reads as its default with isOverridden=false.
    await setSetting("rhd.maxProcedures", 9, null);
    _resetSettingsCache();
    const spy = vi
      .spyOn(prisma.setting, "findMany")
      .mockRejectedValueOnce(
        new Prisma.PrismaClientInitializationError(
          "Can't reach database server at ep-flat-block.neon.tech:5432",
          "5.0.0"
        )
      );

    const rows = await getCategory("Operations");
    const rhdEntry = rows.find((e) => e.key === "rhd.maxProcedures");
    expect(rhdEntry).toMatchObject({ value: 3, isOverridden: false });
    spy.mockRestore();

    // The fallback is not cached: once the DB recovers the real override reads.
    const recovered = await getCategory("Operations");
    expect(recovered.find((e) => e.key === "rhd.maxProcedures")).toMatchObject({
      value: 9,
      isOverridden: true,
    });
  });

  it("falls back to env defaults when the Setting table is missing (P2021)", async () => {
    await setSetting("rhd.maxProcedures", 9, null);
    _resetSettingsCache();
    const spy = vi
      .spyOn(prisma.setting, "findMany")
      .mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError(
          "The table `public.Setting` does not exist in the current database.",
          { code: "P2021", clientVersion: "5.0.0" }
        )
      );

    const rows = await getCategory("Operations");
    const rhdEntry = rows.find((e) => e.key === "rhd.maxProcedures");
    expect(rhdEntry).toMatchObject({ value: 3, isOverridden: false });
    spy.mockRestore();
  });

  it("still rethrows non-connectivity DB errors", async () => {
    const spy = vi
      .spyOn(prisma.setting, "findMany")
      .mockRejectedValueOnce(new Error("boom"));
    await expect(getCategory("Operations")).rejects.toThrow(/boom/);
    spy.mockRestore();
  });
});

describe("setSetting", () => {
  it("rejects a value that fails the schema", async () => {
    await expect(setSetting("rhd.maxProcedures", -1, null)).rejects.toBeInstanceOf(
      SettingValidationError
    );
    expect(await prisma.setting.findUnique({ where: { key: "rhd.maxProcedures" } })).toBeNull();
  });

  it("caps uploads.maxMb at the 4 MB server-action body limit (#75)", async () => {
    // A larger value is unusable: uploads over the platform's ~4.5 MB cap fail at
    // the edge before app code runs, so the setting must not promise more than 4.
    await expect(setSetting("uploads.maxMb", 20, null)).rejects.toBeInstanceOf(SettingValidationError);
    expect(await prisma.setting.findUnique({ where: { key: "uploads.maxMb" } })).toBeNull();
    // The deployable range still saves.
    await setSetting("uploads.maxMb", 4, null);
    expect(await getSetting<number>("uploads.maxMb")).toBe(4);
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
    expect(await getSetting<number>("uploads.maxMb")).toBe(4); // MAX_UPLOAD_MB default
    await prisma.setting.create({ data: { key: "uploads.maxMb", value: 3 } });
    _resetSettingsCache();
    expect(await getSetting<number>("uploads.maxMb")).toBe(3);
  });

  it("resolves the compliance scalars from env defaults", async () => {
    expect(await getSetting<number>("compliance.reminderIntervalDays")).toBe(7);
  });

  it("resolves the onboarding reminder interval from its env default", async () => {
    expect(await getSetting<number>("onboarding.reminderIntervalDays")).toBe(1);
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

describe("phase 2a branding settings", () => {
  it("resolves branding.appName default then DB override", async () => {
    expect(await getSetting<string>("branding.appName")).toBe("HAVEN Hub");
    await prisma.setting.create({ data: { key: "branding.appName", value: "Clinic Hub" } });
    _resetSettingsCache();
    expect(await getSetting<string>("branding.appName")).toBe("Clinic Hub");
  });

  it("resolves branding.applyPortalTitle default then DB override", async () => {
    expect(await getSetting<string>("branding.applyPortalTitle")).toBe("HAVEN Application Portal");
    await prisma.setting.create({ data: { key: "branding.applyPortalTitle", value: "Clinic Application Portal" } });
    _resetSettingsCache();
    expect(await getSetting<string>("branding.applyPortalTitle")).toBe("Clinic Application Portal");
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
