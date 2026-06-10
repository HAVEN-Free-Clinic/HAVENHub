import { getSetting, setSetting, resetSetting } from "@/platform/settings/service";
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
  const current = await getSetting<BrandingAsset>(`branding.${asset}`);
  await setSetting(
    `branding.${asset}`,
    { contentType: file.type, version: current.version + 1 },
    actorPersonId
  );
}

/** Remove the custom asset; the descriptor resets to default so the route serves the bundled default. */
export async function removeBrandingAsset(
  asset: BrandingAssetName,
  actorPersonId: string | null
): Promise<void> {
  await deleteObject(assetKey(asset));
  await resetSetting(`branding.${asset}`, actorPersonId);
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
