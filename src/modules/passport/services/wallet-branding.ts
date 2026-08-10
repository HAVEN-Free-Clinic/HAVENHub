/**
 * Branding images for a wallet pass, resolved to data URIs.
 *
 * The vendor accepts either an HTTPS URL or a data URI for logoURL/iconURL. We
 * send data URIs, deliberately, because the URL route does not work here: the
 * vendor fetches the URL from its own infrastructure, and whatever sits in front
 * of hub.havenfreeclinic.org refuses automated fetches. On 2026-08-10 that
 * produced a hard 400 in production:
 *
 *   {"error":"logoURL could not be fetched"}
 *
 * with the app's own /api/branding/logo AND the bundled static asset behind it
 * both returning 429 to a plain curl and to a browser user agent. Inlining the
 * bytes removes the round trip entirely, so a badge cannot fail to issue because
 * of edge protection, rate limiting, or a redirect the fetcher will not follow.
 *
 * Everything here is best-effort: a missing or oversized image yields null and
 * the pass simply issues without that image, keeping its brand colour.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { readBrandingAsset } from "@/platform/branding/assets";
import type { BrandingAssetName } from "@/platform/branding/asset-types";
import { log, errorAttrs } from "@/platform/logging";

/**
 * The vendor documents a 1MB ceiling per image. Base64 inflates bytes by ~4/3,
 * so the raw cap is set below that to leave room for the encoding and the data
 * URI prefix rather than discovering the limit as another opaque 400.
 */
const MAX_RAW_BYTES = 700 * 1024;

/** The bundled defaults the branding route falls back to when nothing is uploaded. */
const BUNDLED: Record<BrandingAssetName, { file: string; contentType: string }> = {
  logo: { file: "brand/haven-logo-white.png", contentType: "image/png" },
  favicon: { file: "brand/haven-favicon.png", contentType: "image/png" },
};

/** Resolved data URIs are stable for a process; recomputing per issued badge is waste. */
const cache = new Map<BrandingAssetName, string | null>();

function toDataUri(contentType: string, bytes: Buffer): string {
  return `data:${contentType};base64,${bytes.toString("base64")}`;
}

/**
 * A data URI for the admin-uploaded branding image, falling back to the bundled
 * default. Returns null when neither is available or the image is too large,
 * which callers treat as "issue the pass without this image".
 */
export async function brandingDataUri(asset: BrandingAssetName): Promise<string | null> {
  const cached = cache.get(asset);
  if (cached !== undefined) return cached;

  const resolved = await resolve(asset);
  cache.set(asset, resolved);
  return resolved;
}

async function resolve(asset: BrandingAssetName): Promise<string | null> {
  // An admin upload wins, and its bytes are already in hand from object storage.
  try {
    const custom = await readBrandingAsset(asset);
    if (custom) {
      if (custom.bytes.byteLength > MAX_RAW_BYTES) {
        log.error("[passport] branding image too large for a wallet pass", {
          asset,
          bytes: custom.bytes.byteLength,
          maxBytes: MAX_RAW_BYTES,
        });
        return null;
      }
      return toDataUri(custom.contentType, custom.bytes);
    }
  } catch (error) {
    log.error("[passport] could not read uploaded branding asset", errorAttrs(error, { asset }));
  }

  // Fall back to the file the branding route redirects to. Read through
  // try/catch rather than assumed present: `public/` is served by the CDN and is
  // not guaranteed to be in a serverless function's filesystem, so this is
  // opportunistic, and a miss just means no image rather than a failed badge.
  const bundled = BUNDLED[asset];
  try {
    const bytes = await readFile(path.join(process.cwd(), "public", bundled.file));
    if (bytes.byteLength > MAX_RAW_BYTES) return null;
    return toDataUri(bundled.contentType, bytes);
  } catch {
    return null;
  }
}

/** Test seam: the cache is process-global and would leak between cases. */
export function _resetBrandingCache(): void {
  cache.clear();
}
