/**
 * Cloudflare R2 driver, spoken over R2's S3-compatible API.
 *
 * Used in every deployed environment. Local dev, CI, and the test suite use the
 * disk driver instead (./disk.ts); selection happens in ./index.ts, which also
 * validates prefixes before they reach deletePrefix here.
 */
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  HeadBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "@/platform/config";

let client: S3Client | null = null;

/** Lazily built so importing this module never requires credentials. */
function s3(): S3Client {
  if (client) return client;
  client = new S3Client({
    // R2 has no regions. The SDK requires the field, and "auto" is what
    // Cloudflare documents.
    region: "auto",
    endpoint: `https://${config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.R2_ACCESS_KEY_ID as string,
      secretAccessKey: config.R2_SECRET_ACCESS_KEY as string,
    },
    // AWS SDK v3 sends integrity checksums by default. That breaks presigned
    // PUTs against R2: the default forces a checksum header into the signature
    // that the browser can never reproduce, so the upload fails with
    // SignatureDoesNotMatch. WHEN_REQUIRED keeps checksums off the signature for
    // routine operations, which is why presignPut's SignedHeaders ends up being
    // just `host` -- see the doc comment there for what that does and does not
    // cover.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  return client;
}

function bucket(): string {
  return config.R2_BUCKET as string;
}

/**
 * A missing object is a null, not an error. R2 answers GetObject with NoSuchKey
 * and some paths with a bare 404, so check the name and the status code. Any
 * other failure is rethrown: a 500 or a credentials error must never be
 * mistaken for "file not found", which would render an empty state over a real
 * outage.
 */
function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404;
}

/** Store bytes under `key`, overwriting any existing object at that key. */
export async function putObject(
  key: string,
  bytes: Buffer,
  contentType: string
): Promise<void> {
  await s3().send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: bytes,
      ContentType: contentType,
    })
  );
}

/** Read bytes stored under `key`, or null when the object is missing. */
export async function getObject(key: string): Promise<Buffer | null> {
  try {
    const result = await s3().send(
      new GetObjectCommand({ Bucket: bucket(), Key: key })
    );
    if (!result.Body) return null;
    return Buffer.from(await result.Body.transformToByteArray());
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/**
 * Check whether `key` exists without downloading its bytes.
 *
 * Used by the R2 backfill script (scripts/migrate-blob-to-r2.ts) as a presence
 * check that only asks "does this exist," never "is it the same size" (see that
 * script's alreadyPresent for why a size comparison is actively wrong once R2 is
 * the live store).
 *
 * This cannot also serve as a bucket-existence preflight: R2 answers a missing
 * bucket with the same generic 404/NotFound as a missing key, so headObject has
 * no way to tell "wrong key" from "wrong bucket" apart. Use bucketExists below
 * for that.
 */
export async function headObject(key: string): Promise<{ size: number } | null> {
  try {
    const result = await s3().send(
      new HeadObjectCommand({ Bucket: bucket(), Key: key })
    );
    return { size: result.ContentLength ?? 0 };
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/**
 * Whether the configured R2_BUCKET itself exists.
 *
 * Used by the R2 backfill script (scripts/migrate-blob-to-r2.ts) as a preflight
 * so a typo'd R2_BUCKET fails once, loudly, before the main copy loop starts,
 * instead of failing on every single object once it does. HeadBucket takes no
 * key, so a 404 from it unambiguously means the bucket is absent -- unlike
 * HeadObject, whose 404 cannot distinguish a missing bucket from a missing key
 * (see headObject above). A credentials or connectivity failure is rethrown,
 * never read as "bucket missing": only a genuine 404/NotFound means that.
 */
export async function bucketExists(): Promise<boolean> {
  try {
    await s3().send(new HeadBucketCommand({ Bucket: bucket() }));
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

/** Delete the object stored under `key`. Missing objects are a no-op. */
export async function deleteObject(key: string): Promise<void> {
  try {
    await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
  } catch (err) {
    if (isNotFound(err)) return;
    throw err;
  }
}

/**
 * Delete every object under `prefix`.
 *
 * ListObjectsV2 returns at most 1000 keys per call and an unzipped SCORM package
 * can exceed that, so this pages to exhaustion. The caller (./index.ts) has
 * already validated the prefix against the storage-namespace allowlist.
 *
 * Throws if any key fails to delete, whether the failure is transport-level or
 * reported per-object in the batch response (see below). A caller that can live
 * with a partial sweep has to say so with its own catch; this never reports a
 * prefix as emptied when it was not.
 */
export async function deletePrefix(prefix: string): Promise<void> {
  let token: string | undefined;
  do {
    const page = await s3().send(
      new ListObjectsV2Command({
        Bucket: bucket(),
        Prefix: prefix,
        ContinuationToken: token,
      })
    );
    const keys = (page.Contents ?? [])
      .map((object) => object.Key)
      .filter((key): key is string => Boolean(key));
    if (keys.length > 0) {
      const response = await s3().send(
        new DeleteObjectsCommand({
          Bucket: bucket(),
          Delete: { Objects: keys.map((Key) => ({ Key })) },
        })
      );
      // S3 batch delete answers 200 even when individual keys fail: per-object
      // failures arrive in response.Errors, never as a thrown error. Discarding
      // that array would let a partial delete read as a clean sweep, leaving
      // stale SCORM files under a prefix the caller believes it emptied. Throw
      // instead, which is already what a transport-level failure does here.
      const errors = response.Errors ?? [];
      if (errors.length > 0) {
        const details = errors
          .map(
            (e) =>
              `${e.Key ?? "<unknown>"} (${e.Code ?? "Unknown"}): ${e.Message ?? "no message"}`
          )
          .join(", ");
        throw new Error(
          `Failed to delete ${errors.length} object(s) under prefix "${prefix}": ${details}`
        );
      }
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
}

/**
 * Sign a PUT so a browser can upload straight to R2, bypassing the 4.5 MB Vercel
 * function request-body limit. The signature covers only the `host` header (the
 * checksum settings above are what keep it that narrow -- see the comment on
 * them). `contentType` is NOT signature-covered: R2 accepts the PUT even if the
 * browser sends a different Content-Type than this one. The caller should still
 * send this exact value anyway, because it is what R2 stores as the object's
 * content type as-sent -- a mismatch is accepted, not rejected, so it would
 * silently mislabel the stored object rather than fail the upload.
 */
export function presignPut(
  key: string,
  contentType: string,
  expiresIn: number
): Promise<string> {
  return getSignedUrl(
    s3(),
    new PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: contentType }),
    { expiresIn }
  );
}
