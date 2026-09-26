/**
 * Photo values shared by server and client code.
 *
 * This module imports NOTHING on purpose. normalize.ts pulls in sharp and
 * service.ts pulls in Prisma, so any client component reaching those (or the
 * index.ts barrel that re-exports them) would bundle a native image library and
 * a database client into the browser. Client components import this file
 * directly instead.
 */

/** Stored photos are square at this edge length, in pixels. */
export const PHOTO_SIZE = 512;

/** Every stored photo is WebP, regardless of what came in. */
export const PHOTO_CONTENT_TYPE = "image/webp";

/** Thrown when bytes cannot be decoded, or an upload fails validation. */
export class PhotoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhotoError";
  }
}

/**
 * The versioned URL an in-app <img> points at.
 *
 * The ?v= parameter is what makes the route's long immutable cache safe: it
 * changes on every photo set and every removal.
 */
export function photoUrl(person: { id: string; photoVersion: number }): string {
  return `/api/people/${person.id}/photo?v=${person.photoVersion}`;
}

/**
 * HEIC/HEIF, the iPhone camera format. Browsers report it inconsistently (some
 * leave `type` empty for a .heic file), so the extension counts too. The server's
 * image library cannot decode HEIC, so a photo in this format has to be converted
 * in the browser before it is sent.
 */
export function isHeic(file: { type: string; name: string }): boolean {
  return /^image\/hei[cf](-sequence)?$/i.test(file.type) || /\.hei[cf]$/i.test(file.name);
}

/**
 * What a person sees when a HEIC photo reaches the server anyway. Specific on
 * purpose: "could not read that image" sent iPhone users hunting for a problem
 * with their photo, when the fix is only to pick a JPG or PNG.
 */
export const HEIC_UNSUPPORTED_MESSAGE =
  "iPhone HEIC photos aren't supported. Please upload a JPG or PNG instead.";

/** ISO-BMFF brands that mark a HEIF/HEIC still or sequence (not AVIF). */
const HEIF_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "hevm", "hevs"]);
/** Generic HEIF brands that AVIF ALSO lists; HEIF only when no AVIF brand is present. */
const GENERIC_HEIF_BRANDS = new Set(["mif1", "msf1"]);
const AVIF_BRANDS = new Set(["avif", "avis"]);

/**
 * Whether these bytes are a HEIF/HEIC file, by content rather than by name.
 *
 * The type and name a browser reports are not reliable (a HEIC can arrive as
 * image/jpeg with a .jpg name), so this reads the ISO-BMFF `ftyp` box: size,
 * "ftyp", a major brand, a minor version, then compatible brands.
 */
export function looksLikeHeif(bytes: Uint8Array): boolean {
  if (bytes.length < 16) return false;
  const ascii = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (ascii(4) !== "ftyp") return false;
  const boxSize = ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
  const end = Math.min(boxSize || bytes.length, bytes.length, 256);
  const brands = [ascii(8)];
  for (let at = 16; at + 4 <= end; at += 4) brands.push(ascii(at));
  if (brands.some((b) => HEIF_BRANDS.has(b))) return true;
  return brands.some((b) => GENERIC_HEIF_BRANDS.has(b)) && !brands.some((b) => AVIF_BRANDS.has(b));
}
