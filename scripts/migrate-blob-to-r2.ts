// One-off migration of every object from Vercel Blob to Cloudflare R2.
// Dry-run by default:
//   npx tsx --env-file=.env scripts/migrate-blob-to-r2.ts
//   npx tsx --env-file=.env scripts/migrate-blob-to-r2.ts --apply
//
// Keys round-trip unchanged: putObject has always written with
// addRandomSuffix:false, so a Blob pathname already IS the storage key and no
// database row has to change.
//
// Safe to re-run. Objects already present in R2 at the same size are skipped, so
// an interrupted run resumes, and a second pass after the deploy sweeps anything
// written during the cutover window.
import { list, head, get } from "@vercel/blob";
import { config } from "@/platform/config";
import { putObject, getObject } from "@/platform/storage/r2";

const apply = process.argv.includes("--apply");

/**
 * Transient SCORM staging uploads. These were written with addRandomSuffix:true
 * as short-lived input to ingest, are deleted by the ingest action, and are
 * referenced by no database row. Copying them would waste the R2 budget on
 * garbage.
 */
const SKIP_PREFIX = "scorm-uploads/";

type Stats = {
  copied: number;
  skippedExisting: number;
  skippedTransient: number;
  failed: number;
  bytes: number;
};

function requireConfig(): string {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    throw new Error(
      "BLOB_READ_WRITE_TOKEN is required to read the source store. Set it to the " +
        "Vercel Blob token for the environment you are migrating FROM."
    );
  }
  if (!config.R2_BUCKET) {
    throw new Error(
      "R2_BUCKET is unset, so there is no destination. Set all four R2_* variables " +
        "to the bucket you are migrating TO."
    );
  }
  return token;
}

/** True when R2 already holds this key with the same byte length. */
async function alreadyPresent(key: string, size: number): Promise<boolean> {
  const existing = await getObject(key);
  return existing !== null && existing.length === size;
}

async function copyOne(
  key: string,
  size: number,
  token: string,
  stats: Stats
): Promise<void> {
  if (key.startsWith(SKIP_PREFIX)) {
    stats.skippedTransient++;
    return;
  }
  // Everything below can fail on a transient R2 or Blob error (including the
  // presence check itself). Isolate failures per object so one bad key does
  // not abort the whole run -- the failure is recorded and the loop continues.
  try {
    if (await alreadyPresent(key, size)) {
      stats.skippedExisting++;
      return;
    }
    if (!apply) {
      console.log(`  would copy ${key} (${size} bytes)`);
      stats.copied++;
      stats.bytes += size;
      return;
    }
    const meta = await head(key, { token });
    const source = await get(key, { access: "private", token });
    if (!source || source.statusCode !== 200) {
      throw new Error(`source read returned ${source?.statusCode ?? "nothing"}`);
    }
    const bytes = Buffer.from(await new Response(source.stream).arrayBuffer());
    await putObject(key, bytes, meta.contentType || "application/octet-stream");
    stats.copied++;
    stats.bytes += bytes.length;
    console.log(`  copied ${key} (${bytes.length} bytes)`);
  } catch (err) {
    stats.failed++;
    console.error(`  FAILED ${key}: ${(err as Error).message}`);
  }
}

async function main(): Promise<void> {
  const token = requireConfig();
  console.log(
    apply
      ? `Apply mode -- copying Vercel Blob objects into R2 bucket "${config.R2_BUCKET}".`
      : "Dry run -- no writes. Re-run with --apply to copy."
  );

  const stats: Stats = {
    copied: 0,
    skippedExisting: 0,
    skippedTransient: 0,
    failed: 0,
    bytes: 0,
  };

  let cursor: string | undefined;
  do {
    const page = await list({ cursor, token });
    for (const blob of page.blobs) {
      await copyOne(blob.pathname, blob.size, token, stats);
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);

  console.log("");
  console.log(`Copied:             ${stats.copied}`);
  console.log(`Skipped (in R2):    ${stats.skippedExisting}`);
  console.log(`Skipped (transient):${stats.skippedTransient}`);
  console.log(`Failed:             ${stats.failed}`);
  console.log(`Bytes:              ${stats.bytes}`);

  if (stats.failed > 0) {
    console.error("");
    console.error(
      "Some objects failed. The script is idempotent, so re-run it to retry only " +
        "the ones that are still missing."
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
