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

/**
 * Consecutive `copyOne` failures that trip the circuit breaker in `main`. A
 * systemic problem (bad R2 credentials, wrong bucket, R2 outage mid-run) fails
 * every object the same way, so a short run of failures in a row is enough to
 * tell it apart from a handful of genuinely bad objects scattered through an
 * otherwise healthy run.
 */
const MAX_CONSECUTIVE_FAILURES = 5;

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

/**
 * One cheap round-trip against R2 before the main loop starts, so a broken
 * credential or wrong account/bucket fails fast with a single clear message
 * instead of degrading into one FAILED line per object once the list loop
 * begins. The key does not need to exist -- getObject treats "not found" as a
 * normal null result (see src/platform/storage/r2.ts), so only a real
 * connection/auth/config problem throws here.
 */
async function preflightR2(): Promise<void> {
  try {
    await getObject("__migrate-blob-to-r2-preflight__");
  } catch (err) {
    throw new Error(
      `R2 preflight check failed: ${(err as Error).message}. Verify R2_ACCOUNT_ID, ` +
        "R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET before retrying."
    );
  }
}

/** Returns true on success (including a legitimate skip), false on failure. */
async function copyOne(
  key: string,
  size: number,
  token: string,
  stats: Stats
): Promise<boolean> {
  if (key.startsWith(SKIP_PREFIX)) {
    stats.skippedTransient++;
    return true;
  }
  // Everything below can fail on a transient R2 or Blob error (including the
  // presence check itself). Isolate failures per object so one bad key does
  // not abort the whole run -- the failure is recorded and the loop continues.
  // main() also watches the return value to trip a circuit breaker on a run
  // of consecutive failures, which is what a systemic problem looks like.
  try {
    if (await alreadyPresent(key, size)) {
      stats.skippedExisting++;
      return true;
    }
    if (!apply) {
      console.log(`  would copy ${key} (${size} bytes)`);
      stats.copied++;
      stats.bytes += size;
      return true;
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
    return true;
  } catch (err) {
    stats.failed++;
    console.error(`  FAILED ${key}: ${(err as Error).message}`);
    return false;
  }
}

async function main(): Promise<void> {
  const token = requireConfig();
  await preflightR2();
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
  let consecutiveFailures = 0;
  let abortedOnConsecutiveFailures = false;
  do {
    const page = await list({ cursor, token });
    for (const blob of page.blobs) {
      const ok = await copyOne(blob.pathname, blob.size, token, stats);
      consecutiveFailures = ok ? 0 : consecutiveFailures + 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        abortedOnConsecutiveFailures = true;
        break;
      }
    }
    cursor = !abortedOnConsecutiveFailures && page.hasMore ? page.cursor : undefined;
  } while (cursor);

  console.log("");
  console.log(`Copied:             ${stats.copied}`);
  console.log(`Skipped (in R2):    ${stats.skippedExisting}`);
  console.log(`Skipped (transient):${stats.skippedTransient}`);
  console.log(`Failed:             ${stats.failed}`);
  console.log(`Bytes:              ${stats.bytes}`);

  if (abortedOnConsecutiveFailures) {
    console.error("");
    console.error(
      `Aborted after ${MAX_CONSECUTIVE_FAILURES} failures in a row -- the list was not fully ` +
        "processed. That pattern usually means something systemic is wrong (credentials, " +
        "network, bucket config) rather than a handful of bad objects. Fix the underlying " +
        "issue and re-run; objects already copied will be skipped."
    );
    process.exitCode = 1;
  } else if (stats.failed > 0) {
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
