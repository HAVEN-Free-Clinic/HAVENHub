import path from "node:path";
import { randomUUID } from "node:crypto";
import { putObject, deleteObject } from "@/platform/storage";

export type UploadedFile = { fileName: string; mimeType: string; bytes: Buffer };

/** Store each uploaded file under a path-safe key and return the answer refs
 *  plus the storage keys (for cleanup on failure). */
export async function persistFiles(cycleId: string, files: Record<string, UploadedFile>) {
  const answerPatch: Record<string, unknown> = {};
  const storageKeys: string[] = [];
  for (const [key, file] of Object.entries(files)) {
    const safeKey = key.replace(/[^a-z0-9_]/gi, "_");
    const safeExt = (path.extname(file.fileName).match(/^\.[A-Za-z0-9]{1,8}$/)?.[0]) ?? "";
    const storedName = `${safeKey}-${randomUUID()}${safeExt}`;
    const storageKey = `recruitment/${cycleId}/${storedName}`;
    await putObject(storageKey, file.bytes, file.mimeType);
    storageKeys.push(storageKey);
    answerPatch[key] = { storedName, fileName: file.fileName, mimeType: file.mimeType, size: file.bytes.length };
  }
  return { answerPatch, storageKeys };
}

export async function cleanupFiles(storageKeys: string[]): Promise<void> {
  await Promise.all(storageKeys.map((k) => deleteObject(k)));
}
