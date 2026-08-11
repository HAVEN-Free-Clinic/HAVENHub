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
    throw new PhotoError(
      `Could not read that image. Use a PNG, JPEG, or WebP file. (${
        err instanceof Error ? err.message : "unknown error"
      })`
    );
  }
}
