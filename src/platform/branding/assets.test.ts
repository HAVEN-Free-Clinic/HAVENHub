import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { _resetSettingsCache, getSetting } from "@/platform/settings/service";
import { getObject, deleteObject } from "@/platform/storage";
import {
  saveBrandingAsset,
  removeBrandingAsset,
  readBrandingAsset,
  BrandingAssetError,
} from "./assets";

beforeEach(async () => {
  await resetDb();
  _resetSettingsCache();
  // resetDb truncates the database but NOT the object store: branding bytes written
  // under the fixed keys by a prior test (or a prior run of this file) survive and
  // would fool the "no custom asset set" / "putObject not reached" assertions.
  await Promise.all([
    deleteObject("branding/logo").catch(() => undefined),
    deleteObject("branding/favicon").catch(() => undefined),
  ]);
});

const png = (): { name: string; type: string; size: number; bytes: Buffer } => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic-ish
  return { name: "logo.png", type: "image/png", size: bytes.length, bytes };
};

describe("saveBrandingAsset", () => {
  it("rejects a disallowed mime type", async () => {
    await expect(
      saveBrandingAsset("logo", { name: "x.gif", type: "image/gif", size: 4, bytes: Buffer.from([1, 2, 3, 4]) }, null)
    ).rejects.toBeInstanceOf(BrandingAssetError);
    expect(await prisma.setting.findUnique({ where: { key: "branding.logo" } })).toBeNull();
    expect(await getObject("branding/logo")).toBeNull(); // putObject not reached
  });

  it("rejects an oversize file", async () => {
    const big = { name: "logo.png", type: "image/png", size: 999 * 1024 * 1024, bytes: Buffer.from([1]) };
    await expect(saveBrandingAsset("logo", big, null)).rejects.toBeInstanceOf(BrandingAssetError);
  });

  it("stores bytes and bumps the version on each upload", async () => {
    await saveBrandingAsset("logo", png(), "person-1");
    expect(await getSetting("branding.logo")).toMatchObject({ contentType: "image/png", version: 1 });
    expect(await getObject("branding/logo")).not.toBeNull();

    _resetSettingsCache();
    await saveBrandingAsset("logo", png(), "person-1");
    expect(await getSetting("branding.logo")).toMatchObject({ version: 2 });
  });

  it("bumps from the committed DB version, not a stale cross-instance cache (#122)", async () => {
    // First upload: DB version 1. The assertion below then reads it back, warming
    // THIS process's getSetting cache with version 1.
    await saveBrandingAsset("logo", png(), null);
    expect(await getSetting("branding.logo")).toMatchObject({ version: 1 });

    // Another serving instance advances the version (upload/remove cycles) to 5.
    // This process never saw those writes, so its 30s getSetting cache still holds
    // version 1 -- the warm-cache staleness the fix must not trust. Deliberately do
    // NOT reset the cache: getSetting("branding.logo") would still return 1 here.
    await prisma.setting.update({
      where: { key: "branding.logo" },
      data: { value: { contentType: "image/png", version: 5 } },
    });

    // The bump must read the committed row (5) and land on 6, not the cached 1 -> 2
    // (which would reuse a version another instance already shipped other bytes under,
    // leaving browsers pinned to the stale asset for the full Cache-Control TTL).
    await saveBrandingAsset("logo", png(), null);
    _resetSettingsCache();
    expect(await getSetting("branding.logo")).toMatchObject({ version: 6 });
  });
});

describe("readBrandingAsset", () => {
  it("returns null when no custom asset is set", async () => {
    expect(await readBrandingAsset("favicon")).toBeNull();
  });

  it("returns the contentType and bytes when present", async () => {
    await saveBrandingAsset("favicon", { ...png(), name: "f.png" }, null);
    _resetSettingsCache();
    const read = await readBrandingAsset("favicon");
    expect(read?.contentType).toBe("image/png");
    expect(read?.bytes).toBeInstanceOf(Buffer);
  });
});

describe("removeBrandingAsset", () => {
  it("deletes the object, clears contentType, and keeps the version counter monotonic", async () => {
    await saveBrandingAsset("logo", png(), null); // version 1
    _resetSettingsCache();
    await removeBrandingAsset("logo", null);
    // contentType cleared (route serves the default) but version advances, not resets.
    expect(await getSetting("branding.logo")).toEqual({ contentType: "", version: 2 });
    expect(await getObject("branding/logo")).toBeNull();

    // A re-upload keeps advancing, so the cache-busting ?v= never repeats a value.
    _resetSettingsCache();
    await saveBrandingAsset("logo", png(), null);
    expect(await getSetting("branding.logo")).toMatchObject({ version: 3 });
  });
});
