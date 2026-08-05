/**
 * File storage abstraction for uploaded artifacts (HIPAA certificates,
 * recruitment application files, onboarding documents, incident and support
 * attachments, branding images, unzipped SCORM package trees).
 *
 * Two drivers, selected at runtime:
 *   - Cloudflare R2 -- used when the R2_* variables are set (every deployed
 *                      environment). Vercel's function filesystem is
 *                      read-only/ephemeral, so disk storage does not persist there.
 *   - Local disk    -- the default for local dev, CI, and the test suite. Files
 *                      are written under config.UPLOAD_DIR.
 *
 * Callers pass a stable `key` (a relative path such as "<certId>.pdf" or
 * "recruitment/<cycleId>/<storedName>"). The same key round-trips through both
 * drivers, so DB-stored `storedName` values keep working unchanged.
 *
 * The R2 driver is loaded dynamically so the AWS SDK is never pulled into
 * environments that do not use it.
 */
import { config } from "@/platform/config";
import * as disk from "./disk";

/**
 * True when bytes live in a remote store rather than on this machine.
 *
 * config.ts enforces that the R2 variables are all set or all unset, so testing
 * one is sufficient. Two scripts guard on this flag: import-certificates refuses
 * to write rows to a remote database while bytes go to local disk, and
 * seed-ux-audit-fixtures refuses to write throwaway fixtures into a shared store.
 */
export const usingRemoteStorage = Boolean(config.R2_BUCKET);

/** Store bytes under `key`, overwriting any existing object at that key. */
export async function putObject(
  key: string,
  bytes: Buffer,
  contentType: string
): Promise<void> {
  if (usingRemoteStorage) {
    const r2 = await import("./r2");
    return r2.putObject(key, bytes, contentType);
  }
  return disk.putObject(key, bytes, contentType);
}

/** Read bytes stored under `key`, or null when the object is missing. */
export async function getObject(key: string): Promise<Buffer | null> {
  if (usingRemoteStorage) {
    const r2 = await import("./r2");
    return r2.getObject(key);
  }
  return disk.getObject(key);
}

/** Delete the object stored under `key`. Missing objects are a no-op. */
export async function deleteObject(key: string): Promise<void> {
  if (usingRemoteStorage) {
    const r2 = await import("./r2");
    return r2.deleteObject(key);
  }
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
  if (usingRemoteStorage) {
    const r2 = await import("./r2");
    return r2.deletePrefix(prefix);
  }
  return disk.deletePrefix(prefix);
}
