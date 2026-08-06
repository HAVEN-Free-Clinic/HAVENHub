/**
 * Vercel Blob driver, retained ONLY to support the R2 migration.
 *
 * Two jobs, both temporary:
 *   - Rollback. With the R2_* variables unset and this token present, the app
 *     reverts to the pre-migration store as a config change PLUS a redeploy:
 *     r2Active/blobConfigured/blobOnly/readThroughToBlob in ./index.ts are
 *     module-level consts evaluated once at init, so a warm function instance
 *     never observes an env var change on its own.
 *   - Cutover window. While R2 is active, ./index.ts reads through to here on a
 *     miss, so an object written to Blob between the backfill and the deploy is
 *     still served.
 *
 * Delete this file, the BLOB_READ_WRITE_TOKEN config field, and the @vercel/blob
 * dependency together once the migration is decommissioned.
 */
import { config } from "@/platform/config";

function token(): string {
  return config.BLOB_READ_WRITE_TOKEN as string;
}

/** Store bytes under `key`, overwriting any existing object at that key. */
export async function putObject(
  key: string,
  bytes: Buffer,
  contentType: string
): Promise<void> {
  const { put } = await import("@vercel/blob");
  // Private access: these are HIPAA certificates and recruitment documents. The
  // bytes are only ever served back through authenticated route handlers, so a
  // deterministic key is safe (the store token is the access gate).
  await put(key, bytes, {
    access: "private",
    contentType,
    addRandomSuffix: false,
    allowOverwrite: true,
    token: token(),
  });
}

/** Read bytes stored under `key`, or null when the object is missing. */
export async function getObject(key: string): Promise<Buffer | null> {
  const { get } = await import("@vercel/blob");
  try {
    const result = await get(key, { access: "private", token: token() });
    if (!result || result.statusCode !== 200) return null;
    return Buffer.from(await new Response(result.stream).arrayBuffer());
  } catch {
    return null;
  }
}

/** Delete the object stored under `key`. Missing objects are a no-op. */
export async function deleteObject(key: string): Promise<void> {
  const { del } = await import("@vercel/blob");
  try {
    await del(key, { token: token() });
  } catch {
    // Already gone, or never existed -- nothing to clean up.
  }
}

/** Delete every object stored under `prefix`. The caller has already validated it. */
export async function deletePrefix(prefix: string): Promise<void> {
  const { list, del } = await import("@vercel/blob");
  let cursor: string | undefined;
  do {
    const page = await list({ prefix, cursor, token: token() });
    if (page.blobs.length > 0) {
      await del(page.blobs.map((b) => b.url), { token: token() });
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
}
