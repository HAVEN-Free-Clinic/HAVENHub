# Migrate file storage from Vercel Blob to Cloudflare R2

Date: 2026-08-05

## Problem

Uploaded artifacts (HIPAA certificates, recruitment application files, onboarding
contract documents, incident attachments, support ticket attachments, branding
images, and unzipped SCORM package trees) are stored in Vercel Blob whenever
`BLOB_READ_WRITE_TOKEN` is present, and on the local filesystem otherwise. The
Blob store is approaching its free storage allowance.

SCORM packages are the bulk of it. A single course expands to an entire unzipped
site under `scorm/<courseId>/`, and every replacement writes a fresh tree. The
per-file read path compounds the cost: `/learning/play/<courseId>/<...path>`
serves each asset through an authenticated route handler, so every image, script,
and stylesheet in a package is a separate metered read plus metered egress.

Cloudflare R2 is a better fit for this access pattern on both axes. Its perpetual
free tier is 10 GB of storage, 1M Class A operations, and 10M Class B operations,
and egress is free at any volume. Because every read in this app is proxied
through a route handler rather than served from a public URL, the egress line is
pure savings.

## Goals

- Production and preview deployments store and serve uploads from R2.
- Existing objects survive the cutover with their keys unchanged, so no
  `storedName` value in the database has to be rewritten.
- Local dev, CI, and the test suite keep the existing local-disk driver and
  require no credentials.
- The SCORM upload path keeps bypassing the Vercel 4.5 MB function body limit,
  and keeps its live upload progress indicator.

## Non-goals

- Changing the storage key scheme. Keys round-trip byte-identical.
- Changing any of the 24 call sites that consume `@/platform/storage`.
- Serving objects from public URLs or a CDN. Every read stays behind an
  authenticated route handler, which is what makes the current authorization
  model correct.
- R2 Data Catalog. That is a managed Apache Iceberg catalog for analytics
  tables and has no bearing on opaque file storage. It was linked in the
  original request but is not part of this work.

## Architecture

### The seam stays; the driver changes

`src/platform/storage.ts` becomes `src/platform/storage/`, keeping its public API
exactly as it is today:

```ts
putObject(key, bytes, contentType): Promise<void>
getObject(key): Promise<Buffer | null>
deleteObject(key): Promise<void>
deletePrefix(prefix): Promise<void>
```

Every one of the 24 importing files is unchanged.

The split into a directory follows the `platform/branding/` and `platform/rbac/`
convention, and is driven by need rather than taste: the current file interleaves
both drivers inside every function body, and an R2 driver adds a client
singleton, presigning, and list pagination on top of that.

| File | Responsibility |
| --- | --- |
| `storage/index.ts` | Public API, driver selection, prefix validation |
| `storage/r2.ts` | S3 client, the four operations, presign helper |
| `storage/disk.ts` | Local filesystem driver, moved verbatim |

### Driver selection

R2 is used when all four of `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, and `R2_BUCKET` are set. Local disk is used when none
are set.

**A partially-set configuration must throw at boot.** This is a deliberate
change from today's behavior, not an incidental one. Right now a missing
`BLOB_READ_WRITE_TOKEN` silently degrades to the disk driver, and on Vercel the
function filesystem is ephemeral, so uploads appear to succeed and then vanish on
the next deploy with no error anywhere. Three-of-four R2 variables in production
would reproduce exactly that failure. The check lives in the `config.ts` zod
schema as a `superRefine` so it fails loudly at startup.

### R2 client configuration

```ts
new S3Client({
  region: "auto",
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId, secretAccessKey },
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
})
```

The two checksum settings are load-bearing. AWS SDK v3 began sending default
integrity checksums on `PutObject` in early 2025, which breaks against several
S3-compatible providers. R2 has since added support for the common algorithms,
but the default also forces a checksum header onto presigned PUT URLs, which the
browser then has to reproduce exactly or the request fails with
`SignatureDoesNotMatch`. Setting both to `WHEN_REQUIRED` avoids that class of
failure. This must be verified against a real bucket rather than assumed.

New dependencies: `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`, both
server-side only.

### Operation mapping

| Storage API | R2 / S3 operation | Class |
| --- | --- | --- |
| `putObject` | `PutObject` | A |
| `getObject` | `GetObject`, `NoSuchKey` returns `null` | B |
| `deleteObject` | `DeleteObject`, missing key is a no-op | A |
| `deletePrefix` | `ListObjectsV2` paged, then batched `DeleteObjects` | A |

`deletePrefix` keeps its existing prefix allowlist regex unchanged. It runs
before any list or delete call, so the R2 driver inherits the same rejection of
`..`, absolute paths, and backslashes.

### Exported flag rename

`usingBlobStorage` becomes `usingRemoteStorage`. It has one consumer,
`learning/manage/[courseId]/page.tsx`, which uses it to choose between the
direct-upload form and the Server Action form. The new name states the actual
predicate: storage is remote, so the direct-upload path is required.

## SCORM upload via presigned PUT

### Current flow

The browser calls `upload()` from `@vercel/blob/client`, which handshakes with
`/api/learning/blob-upload`. That route runs `handleUpload`, checks
`learning.manage_courses`, and returns a scoped client token. The browser uploads
to Blob, then calls `ingestUploadedPackageAction` with the resulting pathname,
and the server unzips from storage.

### New flow

1. The browser POSTs `{ filename, contentType, size }` to
   `/api/learning/upload-url`.
2. The route runs the identical `learning.manage_courses` check, validates the
   declared size against the 75 MB cap and the content type against the existing
   allowlist, then returns `{ url, key }` from `getSignedUrl(PutObjectCommand)`
   with a 10 minute expiry. The key is
   `scorm-uploads/<courseId>/<uuid>-<sanitized filename>`.
3. The browser PUTs the file to that URL.
4. The browser calls `ingestUploadedPackageAction({ key })`. Everything
   downstream of this point is unchanged.

### Upload progress requires XMLHttpRequest

The form currently renders a live `Uploading… 42%` label driven by
`onUploadProgress`. `fetch` exposes no upload progress event, so using it would
silently regress a 75 MB upload to a dead spinner. The PUT uses
`XMLHttpRequest` with `xhr.upload.onprogress`, wrapped in a promise.

### Size enforcement is layered

A presigned PUT URL cannot by itself cap the request body. Three layers cover it:

1. Client-side size check before requesting a URL (exists today).
2. Server-side check of the declared size before signing.
3. Actual object size checked at ingest, before unzipping.

The existing unzip limits (100 MB inflated, 2000 files) are unchanged and remain
the real backstop. Only `learning.manage_courses` holders can obtain a URL at
all, so the residual risk is a trusted user uploading something oversized, which
layer 3 rejects before any expansion happens.

### Bucket CORS is a prerequisite

The bucket needs a CORS rule permitting `PUT` from the application origins with
`Content-Type` in `AllowedHeaders`. Without it the browser upload fails with an
opaque CORS error that looks nothing like a configuration problem. The exact
rule is documented in the operator runbook produced by this work.

## Backfill

`scripts/migrate-blob-to-r2.ts`, following the existing `scripts/import-*.ts`
conventions.

- Pages through `list()` from `@vercel/blob` using its cursor.
- For each blob: `head()` for the content type, download the bytes, then
  `PutObject` into R2 **under the identical key**. Because `putObject` has always
  set `addRandomSuffix: false`, a Blob `pathname` already is the storage key, so
  no database migration is needed.
- Dry-run by default. `--execute` performs writes.
- Idempotent and resumable: a key already present in R2 with a matching size is
  skipped, so an interrupted run is safe to re-run.
- Skips `scorm-uploads/` staging artifacts. Those were written with
  `addRandomSuffix: true`, are transient inputs to ingest rather than served
  content, and are not referenced by any database row.
- Ends with a verification pass comparing key sets on both sides and printing
  counts, total bytes, and any failures.

## Cutover

The chosen approach is a backfill without a dual-read fallback, which leaves a
window between the backfill finishing and the deployment going live in which a
write could land in Blob and be missed. The sequence closes that window by
re-running the backfill afterward.

1. Operator creates the R2 buckets (one production, one preview), an API token
   scoped to them, and the CORS rule.
2. Run the backfill against production, dry-run first, then `--execute`.
3. Deploy with the R2 variables set.
4. Re-run the backfill to sweep anything written during the window. This is
   cheap because the script is idempotent.
5. Verify key sets match, then spot-check a certificate download and a SCORM
   course playthrough.
6. A follow-up change removes `@vercel/blob` from `package.json`, deletes
   `scripts/migrate-blob-to-r2.ts` (its only remaining importer), and tears down
   the Vercel Blob store itself.

The Blob store is not deleted until step 6, so every step before it is
reversible by unsetting the R2 variables and redeploying.

Given this application's write volume, the exposure in step 3 is realistically a
few minutes of near-zero traffic. If that is judged too risky, the alternative is
a temporary dual-read in `getObject` (R2 first, Blob on miss), which removes the
window entirely at the cost of keeping `@vercel/blob` installed for longer.

## Testing

- The existing suite runs against the disk driver and must stay green with zero
  configuration changes. This is the main regression signal for the refactor.
- New unit tests for the R2 driver mock `@aws-sdk/client-s3` at the module
  boundary and assert command shapes: correct bucket and key, `NoSuchKey`
  mapping to `null`, `deletePrefix` paging through a continuation token and
  batching deletes.
- New tests for the `config.ts` partial-configuration guard, asserting that
  three-of-four R2 variables throws.
- The presign route gets a test covering the permission check and the
  declared-size rejection.
- The disk driver currently has **no** direct test coverage. Its
  path-traversal guard (`localPath`) and the `deletePrefix` prefix allowlist are
  security-relevant and are being moved during this refactor, so both get unit
  tests as part of this work. This is new coverage, not a port.
- Manual verification against a real R2 bucket is required for the checksum
  settings and the browser PUT, because both are integration behaviors that a
  mocked test cannot confirm.

## Risks

| Risk | Mitigation |
| --- | --- |
| SDK checksum defaults break PUT or presigning | Explicit `WHEN_REQUIRED` settings, verified against a real bucket before merge |
| Missing CORS rule breaks browser upload with an opaque error | Documented as an explicit prerequisite in the runbook |
| Partial R2 config silently falls back to disk in production | `config.ts` guard throws at boot |
| Write lands in Blob during the cutover window | Backfill re-run in step 4 |
| Backfill interrupted midway | Idempotent and resumable by design |
