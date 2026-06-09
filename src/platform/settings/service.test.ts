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
    expect(before).toEqual([
      expect.objectContaining({ key: "rhd.maxProcedures", value: 3, isOverridden: false }),
    ]);

    await setSetting("rhd.maxProcedures", 7, null);
    _resetSettingsCache();
    const after = await getCategory("Operations");
    expect(after[0]).toMatchObject({ value: 7, isOverridden: true });
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
});
