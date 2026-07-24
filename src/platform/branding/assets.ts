import { getSetting, setSetting } from "@/platform/settings/service";
import { prisma } from "@/platform/db";
import { putObject, getObject, deleteObject } from "@/platform/storage";
import { type BrandingAsset, type BrandingAssetName } from "./asset-types";

const ALLOWED_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/x-icon",
  "image/vnd.microsoft.icon",
]);

/** Thrown when an uploaded branding asset is the wrong type or too large. */
export class BrandingAssetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrandingAssetError";
  }
}

/** Storage key for an asset's bytes. */
function assetKey(asset: BrandingAssetName): string {
  return `branding/${asset}`;
}

/**
 * Read the asset's current version straight from the Setting row, bypassing the
 * 30s getSetting cache.
 *
 * The version is the ONLY cache-buster in the fixed `/api/branding/<asset>?v=<n>`
 * URL, and both writers below compute the next version as current+1. `favicon` is
 * read on every request (root generateMetadata) and `logo` on every page that
 * renders HavenLogo, so the getSetting cache is warm in essentially every serving
 * instance at all times, and setSetting only invalidates the cache of the instance
 * that wrote. Deriving the bump from getSetting therefore lets an instance with a
 * stale cache reuse a version that already shipped different bytes, pinning
 * browsers to the old logo/favicon. Reading the row directly makes the increment
 * see the latest committed version instead (audit #122).
 */
async function currentAssetVersion(asset: BrandingAssetName): Promise<number> {
  const row = await prisma.setting.findUnique({ where: { key: `branding.${asset}` } });
  const value = (row?.value ?? null) as { version?: unknown } | null;
  return typeof value?.version === "number" ? value.version : 0;
}

/** Validate the upload, store the bytes, and bump the descriptor (contentType + version). */
export async function saveBrandingAsset(
  asset: BrandingAssetName,
  file: { name: string; type: string; size: number; bytes: Buffer },
  actorPersonId: string | null
): Promise<void> {
  if (!ALLOWED_TYPES.has(file.type)) {
    throw new BrandingAssetError(
      `Unsupported image type "${file.type}". Use PNG, JPEG, WebP, or ICO.`
    );
  }
  const maxMb = await getSetting<number>("uploads.maxMb");
  if (file.size > maxMb * 1024 * 1024) {
    throw new BrandingAssetError(`Image too large; the limit is ${maxMb} MB.`);
  }

  await putObject(assetKey(asset), file.bytes, file.type);
  const version = (await currentAssetVersion(asset)) + 1;
  try {
    // Bump the descriptor only after the bytes land. If this write fails, the new
    // bytes already sit at the fixed key while the descriptor still records the
    // previous contentType/version, so the route would serve the new bytes under a
    // stale contentType. Drop the bytes so the route falls back to the bundled
    // default instead of serving a mismatched type.
    await setSetting(
      `branding.${asset}`,
      { contentType: file.type, version },
      actorPersonId
    );
  } catch (err) {
    await deleteObject(assetKey(asset)).catch(() => undefined);
    throw err;
  }
}

/** Remove the custom asset; the descriptor resets to default so the route serves the bundled default. */
export async function removeBrandingAsset(
  asset: BrandingAssetName,
  actorPersonId: string | null
): Promise<void> {
  await deleteObject(assetKey(asset));
  // Keep the version counter monotonic across upload/remove cycles. Resetting it
  // let a later re-upload reuse an old version number, so the cache-busting query
  // param (?v=) repeated and browsers kept serving the stale cached logo/favicon.
  // Empty contentType still makes readBrandingAsset fall back to the bundled default.
  const version = (await currentAssetVersion(asset)) + 1;
  await setSetting(`branding.${asset}`, { contentType: "", version }, actorPersonId);
}

/** For the public route: the descriptor + bytes, or null when no custom asset exists. */
export async function readBrandingAsset(
  asset: BrandingAssetName
): Promise<{ contentType: string; bytes: Buffer } | null> {
  const desc = await getSetting<BrandingAsset>(`branding.${asset}`);
  if (!desc.contentType) return null;
  const bytes = await getObject(assetKey(asset));
  if (!bytes) return null;
  return { contentType: desc.contentType, bytes };
}
