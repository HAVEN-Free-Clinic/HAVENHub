/**
 * Normalization for member profile photos.
 *
 * Every photo reaching storage goes through here, whether auto-sourced from
 * Yalies or uploaded by a member, so the badge and the public credential page
 * can assume one square size and one content type.
 *
 * Stripping EXIF is not only hygiene: an uploaded phone photo carries
 * orientation (which would render sideways without .rotate()) and often GPS
 * coordinates, which have no business on a public credential page.
 *
 * This is the only import of sharp in the app, and the reason package.json
 * lists it under BOTH `dependencies` and `overrides`, which is worth explaining
 * because it looks redundant:
 *
 * - `dependencies` is what makes the import legitimate. sharp was previously
 *   reaching us only as an OPTIONAL dependency of next (`^0.34.5`), so every
 *   photo route was resting on a package this repo never asked for -- one
 *   `--omit=optional` install, one failed optional build, or next dropping the
 *   dep, and normalizePhoto throws at runtime with nothing in the manifest to
 *   explain why.
 * - `overrides` keeps that from costing a second copy. Declaring `^0.35.3`
 *   directly no longer satisfies next's `^0.34.5`, so npm would otherwise
 *   install a nested sharp 0.34 (plus its ~17MB libvips) under next. The
 *   override forces one 0.35.3 everywhere; keep the two ranges equal.
 *
 * The native library that sharp dlopens also has to be traced into the
 * standalone build by hand -- see outputFileTracingIncludes in next.config.ts.
 */
import sharp from "sharp";
import { PHOTO_SIZE, PhotoError } from "./shared";
import { log, errorAttrs } from "@/platform/logging";

/**
 * Decode, auto-orient, centre-crop square, resize, and re-encode as WebP.
 *
 * .rotate() with no argument applies the EXIF orientation tag and then drops
 * it. sharp does not carry metadata to the output unless asked, so the result
 * has no EXIF at all.
 */
export async function normalizePhoto(input: Buffer): Promise<Buffer> {
  try {
    return await sharp(input)
      .rotate()
      .resize(PHOTO_SIZE, PHOTO_SIZE, { fit: "cover", position: "centre" })
      .webp({ quality: 82 })
      .toBuffer();
  } catch (err) {
    // sharp's own message (e.g. "Input buffer contains unsupported image
    // format") is a decode-library internal, not something a member on the
    // my-info upload form can act on. Log the real detail for developers and
    // keep the member-facing message plain and actionable.
    log.error("[photos] normalizePhoto failed to decode image", errorAttrs(err));
    throw new PhotoError("Could not read that image. Use a PNG, JPEG, or WebP file.");
  }
}
