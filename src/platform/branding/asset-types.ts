import { z } from "zod";

/** The branding assets that can be uploaded. */
export const BRANDING_ASSETS = ["logo", "favicon"] as const;
export type BrandingAssetName = (typeof BRANDING_ASSETS)[number];

/** Descriptor stored in the setting value. contentType "" means "no custom asset". */
export type BrandingAsset = { contentType: string; version: number };

export const brandingAssetSchema = z.object({
  contentType: z.string(),
  version: z.number().int().nonnegative(),
});
