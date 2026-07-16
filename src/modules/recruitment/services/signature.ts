/**
 * Shared drawn-signature helpers. A signature reaches the server as a PNG data
 * URL (produced by the SignaturePad primitive). This module is the single
 * security boundary that turns that untrusted string into bytes: it enforces the
 * image/png data-URL shape, a hard size cap, and the PNG magic-byte signature
 * before any bytes are written to storage.
 */
const PNG_PREFIX = "data:image/png;base64,";

/** Hard ceiling on a decoded signature PNG. A real drawn signature is a few KB;
 *  1 MB leaves generous headroom while bounding a hostile payload. */
export const SIGNATURE_MAX_BYTES = 1_000_000;

export class SignatureError extends Error {
  constructor(message = "A valid signature is required.") {
    super(message);
    this.name = "SignatureError";
  }
}

/** True when `v` looks like a PNG data URL (prefix only; full validation is in
 *  decodeSignaturePng). */
export function isSignatureDataUrl(v: unknown): v is string {
  return typeof v === "string" && v.startsWith(PNG_PREFIX);
}

/** Decode a PNG data URL to bytes, or throw SignatureError. Buffer.from(base64)
 *  never throws (it silently drops invalid chars), so validity is enforced by the
 *  length checks and the PNG magic-byte signature, not a try/catch. */
export function decodeSignaturePng(dataUrl: string): Buffer {
  if (!isSignatureDataUrl(dataUrl)) throw new SignatureError();
  const bytes = Buffer.from(dataUrl.slice(PNG_PREFIX.length), "base64");
  if (bytes.length === 0) throw new SignatureError();
  if (bytes.length > SIGNATURE_MAX_BYTES) throw new SignatureError("Signature image is too large.");
  const isPng =
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (!isPng) throw new SignatureError();
  return bytes;
}
