import path from "node:path";
import { randomUUID } from "node:crypto";
import { putObject, deleteObject } from "@/platform/storage";
import type { FieldValidation } from "../engine/schema-builder";

export type UploadedFile = { fileName: string; mimeType: string; bytes: Buffer };

/** Validate one uploaded file against a FILE field's size cap and accepted
 *  types. `globalMaxMb` is the uploads.maxMb hard ceiling; a field's maxFileMB
 *  can only lower it. Returns `{ message, detail }` for the first rule broken,
 *  or null when the file is acceptable. Shared by the submit path and the draft
 *  upload path so both enforce identical limits. */
export function validateUploadedFile(
  file: UploadedFile,
  rules: FieldValidation | null | undefined,
  globalMaxMb: number,
): { message: string; detail: string } | null {
  const capMb = Math.min(rules?.maxFileMB ?? globalMaxMb, globalMaxMb);
  if (file.bytes.length > capMb * 1024 * 1024) {
    return { message: `File is too large (max ${capMb} MB).`, detail: `max ${capMb} MB` };
  }
  const accepted = rules?.acceptedTypes;
  if (accepted && accepted.length > 0) {
    const name = file.fileName.toLowerCase();
    const mime = file.mimeType.toLowerCase();
    const ok = accepted.some((t) => {
      const tl = t.toLowerCase();
      return tl.startsWith(".") ? name.endsWith(tl) : mime === tl || (tl.endsWith("/*") && mime.startsWith(tl.slice(0, -1)));
    });
    if (!ok) return { message: "File type not allowed for this field.", detail: `allowed: ${accepted.join(", ")}` };
  }
  return null;
}

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
