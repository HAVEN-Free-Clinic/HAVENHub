/**
 * File storage abstraction for uploaded artifacts (HIPAA certificates,
 * recruitment application files, onboarding documents).
 *
 * Two drivers, selected at runtime:
 *   - Vercel Blob  -- used when BLOB_READ_WRITE_TOKEN is present (i.e. on Vercel).
 *                     Vercel's function filesystem is read-only/ephemeral, so disk
 *                     storage does not persist there.
 *   - Local disk   -- the default for local dev, CI, and the test suite. Files are
 *                     written under config.UPLOAD_DIR exactly as before.
 *
 * Callers pass a stable `key` (a relative path such as "<certId>.pdf" or
 * "recruitment/<cycleId>/<storedName>"). The same key round-trips through both
 * drivers, so DB-stored `storedName` values keep working unchanged.
 */
import path from "node:path";
import { promises as fs } from "node:fs";
import { config } from "@/platform/config";

const blobToken = process.env.BLOB_READ_WRITE_TOKEN;

/** True when running against Vercel Blob rather than the local filesystem. */
export const usingBlobStorage = Boolean(blobToken);

/** Resolve a storage key to an absolute disk path, refusing traversal escapes. */
function localPath(key: string): string {
  const root = path.resolve(config.UPLOAD_DIR);
  const resolved = path.resolve(root, key);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Refusing to access path outside the upload dir: ${key}`);
  }
  return resolved;
}

/** Store bytes under `key`, overwriting any existing object at that key. */
export async function putObject(
  key: string,
  bytes: Buffer,
  contentType: string
): Promise<void> {
  if (blobToken) {
    const { put } = await import("@vercel/blob");
    // Private access: these are HIPAA certificates and recruitment documents.
    // The bytes are only ever served back through authenticated route handlers
    // that enforce ownership; the blob URL is never handed to a client, so a
    // deterministic key is safe (the store token is the access gate).
    await put(key, bytes, {
      access: "private",
      contentType,
      addRandomSuffix: false,
      allowOverwrite: true,
      token: blobToken,
    });
    return;
  }
  const diskPath = localPath(key);
  await fs.mkdir(path.dirname(diskPath), { recursive: true });
  await fs.writeFile(diskPath, bytes);
}

/** Read bytes stored under `key`, or null when the object is missing. */
export async function getObject(key: string): Promise<Buffer | null> {
  if (blobToken) {
    const { get } = await import("@vercel/blob");
    try {
      // Authenticated server-side read of a private blob. The token authorizes
      // the download; bytes are returned to the caller (an already-authorized
      // route handler), never via a public URL.
      const result = await get(key, { access: "private", token: blobToken });
      if (!result || result.statusCode !== 200) return null;
      return Buffer.from(await new Response(result.stream).arrayBuffer());
    } catch {
      return null;
    }
  }
  try {
    return await fs.readFile(localPath(key));
  } catch {
    return null;
  }
}

/** Delete the object stored under `key`. Missing objects are a no-op. */
export async function deleteObject(key: string): Promise<void> {
  if (blobToken) {
    const { del } = await import("@vercel/blob");
    try {
      await del(key, { token: blobToken });
    } catch {
      // Already gone, or never existed -- nothing to clean up.
    }
    return;
  }
  await fs.rm(localPath(key), { force: true }).catch(() => undefined);
}
