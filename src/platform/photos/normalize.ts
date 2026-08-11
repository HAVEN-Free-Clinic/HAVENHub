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
