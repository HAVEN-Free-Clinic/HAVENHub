/**
 * Shrink a phone photo in the browser before the onboarding form posts it.
 *
 * The contract submits as one Server Action carrying the HIPAA certificate AND
 * the photo, and the platform refuses a request body over ~4.5 MB at the edge,
 * before any app code runs, which reads as a form that did nothing (see
 * UploadSizeField). A current phone photo alone is often 3 to 5 MB. The server
 * crops and re-encodes every photo to a 512 px square anyway
 * (platform/photos/normalize.ts), so sending a 1600 px JPEG instead loses
 * nothing anyone sees.
 *
 * Best-effort: a file the browser cannot decode or draw is sent as chosen, and
 * the size check and server validation still apply to it.
 */
export const PHOTO_UPLOAD_MAX_EDGE = 1600;

/** The largest size with the same aspect ratio whose long edge is at most `max`.
 *  Never enlarges. */
export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

export async function downscalePhoto(file: File): Promise<File> {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return file;
  let bitmap: ImageBitmap;
  try {
    // "from-image" draws a portrait phone photo upright. The canvas output below
    // carries no EXIF at all, so any GPS location is dropped before it leaves
    // the device.
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return file;
  }
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height, PHOTO_UPLOAD_MAX_EDGE);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return file;
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
    if (!blob || blob.size >= file.size) return file;
    const base = file.name.replace(/\.[^.]*$/, "") || "photo";
    return new File([blob], `${base}.jpg`, { type: "image/jpeg" });
  } finally {
    bitmap.close();
  }
}
