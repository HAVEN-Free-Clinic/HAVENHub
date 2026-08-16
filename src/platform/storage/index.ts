/**
 * File storage abstraction for uploaded artifacts (HIPAA certificates,
 * recruitment application files, onboarding documents, incident and support
 * attachments, branding images, unzipped SCORM package trees).
 *
 * Two drivers, selected at runtime:
 *   - Cloudflare R2 -- the primary store whenever the R2_* variables are set
 *                      (every deployed environment). Vercel's function
 *                      filesystem is read-only/ephemeral, so disk storage does
 *                      not persist there.
 *   - Local disk    -- the default for local dev, CI, and the test suite. Files
 *                      are written under config.UPLOAD_DIR.
 *
 * Callers pass a stable `key` (a relative path such as "<certId>.pdf" or
 * "recruitment/<cycleId>/<storedName>"). The same key round-trips through both
 * drivers, so DB-stored `storedName` values keep working unchanged.
 *
 * The R2 driver is loaded dynamically so its SDK is never pulled into
 * environments that do not use it.
 */
import { config } from "@/platform/config";
import * as disk from "./disk";

/** R2 is the primary store whenever it is configured. */
const r2Active = Boolean(config.R2_BUCKET);

/**
 * True when bytes live in a remote store rather than on this machine.
 *
 * Two things care about this flag: import-certificates refuses to write rows
 * to a remote database while bytes go to local disk, and
 * seed-ux-audit-fixtures refuses to write throwaway fixtures into a shared
 * store.
 */
export const usingRemoteStorage = r2Active;

/**
 * True when the browser can PUT bytes straight to object storage via a
 * presigned URL, i.e. R2 is configured.
 *
 * This is currently the same question as `usingRemoteStorage` above -- R2 is
 * the only remote driver, so the two flags always agree. They stay separate
 * exports anyway: `usingRemoteStorage` answers "do bytes live somewhere
 * remote?" while `supportsPresignedUpload` answers a narrower one, "can a
 * browser presign a PUT against that store?" Collapsing them into one flag
 * would silently reintroduce the risk that made two flags necessary in the
 * first place -- a future driver that is remote but cannot presign (or vice
 * versa) would need the distinction back, and by then every call site would
 * have to be re-audited to tell which question it was actually asking. The
 * SCORM upload form gates its direct-upload path on this flag specifically,
 * not on usingRemoteStorage, for that reason.
 */
export const supportsPresignedUpload = r2Active;

/** Store bytes under `key`, overwriting any existing object at that key. */
export async function putObject(
  key: string,
  bytes: Buffer,
  contentType: string
): Promise<void> {
  if (r2Active) return (await import("./r2")).putObject(key, bytes, contentType);
  return disk.putObject(key, bytes, contentType);
}

/** Read bytes stored under `key`, or null when the object is missing. */
export async function getObject(key: string): Promise<Buffer | null> {
  if (r2Active) return (await import("./r2")).getObject(key);
  return disk.getObject(key);
}

/** Delete the object stored under `key`. Missing objects are a no-op. */
export async function deleteObject(key: string): Promise<void> {
  if (r2Active) return (await import("./r2")).deleteObject(key);
  return disk.deleteObject(key);
}

/**
 * Delete every object stored under `prefix` (e.g. "scorm/<courseId>/"). Used when
 * replacing a SCORM package so stale files from the previous upload don't linger.
 */
export async function deletePrefix(prefix: string): Promise<void> {
  // Allowlist the prefix to our own storage namespace before it reaches any path
  // or list operation: slash-separated segments of safe chars only. This rejects
  // "..", absolute paths, and backslashes outright (our prefixes are "scorm/<id>/").
  if (!/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*\/?$/.test(prefix)) {
    throw new Error(`Refusing unsafe storage prefix: ${prefix}`);
  }
  if (r2Active) return (await import("./r2")).deletePrefix(prefix);
  return disk.deletePrefix(prefix);
}
