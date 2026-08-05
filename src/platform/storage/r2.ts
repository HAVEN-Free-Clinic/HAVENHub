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
    // PUTs against R2: the signature covers a checksum header the browser never
    // reproduces, so the upload fails with SignatureDoesNotMatch. Send them only
    // where the operation genuinely requires one.
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
      await s3().send(
        new DeleteObjectsCommand({
          Bucket: bucket(),
          Delete: { Objects: keys.map((Key) => ({ Key })) },
        })
      );
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
}

/**
 * Sign a PUT so a browser can upload straight to R2, bypassing the 4.5 MB Vercel
 * function request-body limit. `contentType` is part of the signature: the
 * caller must send exactly this value as the Content-Type header or R2 rejects
 * the upload with SignatureDoesNotMatch.
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
