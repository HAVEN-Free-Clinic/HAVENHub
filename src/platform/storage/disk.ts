/**
 * Local filesystem driver. The default for local dev, CI, and the test suite.
 * Files are written under config.UPLOAD_DIR. Deployed environments use the R2
 * driver instead (./r2.ts); selection happens in ./index.ts.
 */
import path from "node:path";
import { promises as fs } from "node:fs";
import { config } from "@/platform/config";

/** Resolve a storage key to an absolute disk path, refusing traversal escapes. */
function localPath(key: string): string {
  const root = path.resolve(config.UPLOAD_DIR);
  const resolved = path.resolve(root, key);
  // The resolved path must stay inside `root`. Compute the path relative to the
  // root: anything that escapes produces a leading ".." segment or an absolute
  // path (a different drive on Windows), both of which we reject.
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to access path outside the upload dir: ${key}`);
  }
  return resolved;
}

/** Store bytes under `key`, overwriting any existing object at that key. */
export async function putObject(
  key: string,
  bytes: Buffer,
  _contentType: string
): Promise<void> {
  // Content type is not persisted on disk: the serving routes already derive it
  // from the database row or the file extension.
  const diskPath = localPath(key);
  await fs.mkdir(path.dirname(diskPath), { recursive: true });
  await fs.writeFile(diskPath, bytes);
}

/**
 * Read bytes stored under `key`, or null when the object is missing.
 *
 * localPath is called INSIDE the try on purpose: a traversing key reads as a
 * miss, not an exception. Serving routes turn null into a 404, and the R2 driver
 * likewise answers an unreachable key with null, so the two drivers agree.
 */
export async function getObject(key: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(localPath(key));
  } catch {
    return null;
  }
}

/** The object's size in bytes, or null when it is missing. */
export async function objectSize(key: string): Promise<number | null> {
  try {
    return (await fs.stat(localPath(key))).size;
  } catch {
    return null;
  }
}

/**
 * Read bytes `start` through `end` (inclusive) of the object, or null when it is
 * missing. Lets the local-dev video route answer Range requests without loading
 * a whole recording into memory.
 */
export async function getObjectRange(key: string, start: number, end: number): Promise<Buffer | null> {
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(localPath(key), "r");
    const length = Math.max(0, end - start + 1);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/** Delete the object stored under `key`. Missing objects are a no-op. */
export async function deleteObject(key: string): Promise<void> {
  await fs.rm(localPath(key), { force: true }).catch(() => undefined);
}

/** Delete every object stored under `prefix`, which maps to a directory. */
export async function deletePrefix(prefix: string): Promise<void> {
  const dir = localPath(prefix.replace(/\/$/, ""));
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}
