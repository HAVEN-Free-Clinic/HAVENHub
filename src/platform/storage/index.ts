/**
 * File storage abstraction for uploaded artifacts (HIPAA certificates,
 * recruitment application files, onboarding documents, incident and support
 * attachments, branding images, unzipped SCORM package trees).
 *
 * Three drivers, selected at runtime:
 *   - Cloudflare R2 -- the primary store whenever the R2_* variables are set
 *                      (every deployed environment). Vercel's function
 *                      filesystem is read-only/ephemeral, so disk storage does
 *                      not persist there.
 *   - Vercel Blob   -- retained ONLY to support the R2 migration. It is the
 *                      whole store in the rolled-back state (R2_* unset, Blob
 *                      token present), and a read-through fallback during the
 *                      cutover window (R2 active AND a Blob token present).
 *                      See ./blob.ts for the deletion plan.
 *   - Local disk    -- the default for local dev, CI, and the test suite. Files
 *                      are written under config.UPLOAD_DIR.
 *
 * Callers pass a stable `key` (a relative path such as "<certId>.pdf" or
 * "recruitment/<cycleId>/<storedName>"). The same key round-trips through every
 * driver, so DB-stored `storedName` values keep working unchanged.
 *
 * The R2 and Blob drivers are loaded dynamically so their SDKs are never pulled
 * into environments that do not use them.
 */
import { config } from "@/platform/config";
import * as disk from "./disk";

/** R2 is the primary store whenever it is configured. */
const r2Active = Boolean(config.R2_BUCKET);

/**
 * The Blob store is reachable in two situations, both temporary:
 *   - R2 is NOT configured and a Blob token is: the rolled-back state, where
 *     Blob is the whole store.
 *   - R2 IS configured and a Blob token is: the cutover window, where Blob is a
 *     read-through fallback for objects the backfill has not copied yet.
 */
const blobConfigured = Boolean(config.BLOB_READ_WRITE_TOKEN);
const blobOnly = !r2Active && blobConfigured;
const readThroughToBlob = r2Active && blobConfigured;

/**
 * True when bytes live in a remote store rather than on this machine.
 *
 * Three things have cared about this flag: import-certificates refuses to
 * write rows to a remote database while bytes go to local disk,
 * seed-ux-audit-fixtures refuses to write throwaway fixtures into a shared
 * store, and (formerly) the SCORM package upload form's choice between a
 * direct-to-R2 presigned upload and a plain Server Action upload. That third
 * use was wrong: this flag is true in the Blob-only rolled-back state, where a
 * presigned PUT would build an R2 request from undefined credentials. The
 * form now branches on supportsPresignedUpload instead -- see its doc comment
 * for why that is a different question from this one.
 */
export const usingRemoteStorage = r2Active || blobConfigured;

/**
 * True when the browser can PUT bytes straight to object storage via a
 * presigned URL, i.e. R2 is configured.
 *
 * This is a narrower question than "do bytes live somewhere remote?"
 * (usingRemoteStorage above): only the R2 driver supports presigning, so this
 * is false in the Blob-only rolled-back state even though usingRemoteStorage
 * is true there. The two flags diverge precisely in that state, which is why
 * the SCORM upload form must gate its direct-upload path on this flag and not
 * on usingRemoteStorage: presigning against Blob is not a thing, and building
 * an R2 presigned request with no R2 credentials configured fails.
 */
export const supportsPresignedUpload = r2Active;

/** Store bytes under `key`, overwriting any existing object at that key. */
export async function putObject(
  key: string,
  bytes: Buffer,
  contentType: string
): Promise<void> {
  // Writes go to the active store only. During the cutover window that is R2,
  // and reads find R2 first, so there is nothing to gain from duplicating.
  if (r2Active) return (await import("./r2")).putObject(key, bytes, contentType);
  if (blobOnly) return (await import("./blob")).putObject(key, bytes, contentType);
  return disk.putObject(key, bytes, contentType);
}

/** Read bytes stored under `key`, or null when the object is missing. */
export async function getObject(key: string): Promise<Buffer | null> {
  if (r2Active) {
    const bytes = await (await import("./r2")).getObject(key);
    if (bytes !== null) return bytes;
    // Cutover window: an object written to Blob between the backfill and this
    // deploy lives only there. Read through rather than 404.
    if (readThroughToBlob) return (await import("./blob")).getObject(key);
    return null;
  }
  if (blobOnly) return (await import("./blob")).getObject(key);
  return disk.getObject(key);
}

/** Delete the object stored under `key`. Missing objects are a no-op. */
export async function deleteObject(key: string): Promise<void> {
  if (r2Active) {
    await (await import("./r2")).deleteObject(key);
    // Delete from Blob too. An object that lives only in Blob would otherwise
    // survive the R2 no-op and be resurrected by the read-through above.
    if (readThroughToBlob) await (await import("./blob")).deleteObject(key);
    return;
  }
  if (blobOnly) return (await import("./blob")).deleteObject(key);
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
  if (r2Active) {
    await (await import("./r2")).deletePrefix(prefix);
    // Same resurrection hazard as deleteObject.
    if (readThroughToBlob) await (await import("./blob")).deletePrefix(prefix);
    return;
  }
  if (blobOnly) return (await import("./blob")).deletePrefix(prefix);
  return disk.deletePrefix(prefix);
}
