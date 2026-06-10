import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { _resetSettingsCache, getSetting } from "@/platform/settings/service";
import { getObject } from "@/platform/storage";
import {
  saveBrandingAsset,
  removeBrandingAsset,
  readBrandingAsset,
  BrandingAssetError,
} from "./assets";

beforeEach(async () => { await resetDb(); _resetSettingsCache(); });

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
  it("deletes the object and resets the descriptor to default", async () => {
    await saveBrandingAsset("logo", png(), null);
    _resetSettingsCache();
    await removeBrandingAsset("logo", null);
    expect(await getSetting("branding.logo")).toEqual({ contentType: "", version: 0 });
    expect(await getObject("branding/logo")).toBeNull();
  });
});
