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
| `storage/index.ts` | Public API, driver selection, read-through, prefix validation |
| `storage/r2.ts` | S3 client, the four operations, presign helper |
| `storage/blob.ts` | Vercel Blob driver, retained only for rollback and cutover-window read-through (added after this document's original design, in Task 8) |
| `storage/disk.ts` | Local filesystem driver, moved verbatim |

### Driver selection

Three-way, selected at runtime in `storage/index.ts`:

- **R2** whenever `R2_BUCKET` is set (and, by the all-or-nothing guard below,
  the other three `R2_*` variables with it). The primary store in every
  deployed environment.
- **Vercel Blob** whenever `R2_BUCKET` is unset and `BLOB_READ_WRITE_TOKEN` is
  set. This is the rolled-back state: the app reads and writes Blob exactly as
  it did before this migration.
- **Local disk** only when neither is set -- local dev, CI, and the test suite.

Unsetting the R2 variables does NOT land on local disk while a Blob token is
still configured; it lands on Blob. Local disk is reached only when nothing
remote is configured at all.

While R2 is active and a Blob token is also present (the cutover window),
`getObject` reads R2 first and falls through to Blob on a miss, so an object
written to Blob between the backfill and the deploy is served immediately
rather than 404ing until the next backfill pass. `deleteObject` and
`deletePrefix` fan out to both stores in that same window: deleting only from
R2 would leave a Blob-only object for the read-through to resurrect on the next
read.

**A partially-set R2 configuration must throw at boot.** This is a deliberate
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

### Two exported flags

`usingBlobStorage` becomes `usingRemoteStorage`. Originally (this document's
first draft) that meant "R2 is configured," full stop. Task 8 broadens the
predicate to "bytes live in ANY remote store": `r2Active || blobConfigured`, so
it is also true in the rolled-back, Blob-only state.

It has two consumers, both **safety guards** whose logic depends on the flag
meaning "remote", not specifically "R2":

| Consumer | Use |
| --- | --- |
| `scripts/import-certificates.ts` | `assertStorageMatchesDatabase` refuses to run against a remote database while bytes silently go to local disk |
| `scripts/seed-ux-audit-fixtures.ts` | `assertLocalStorage` refuses to write and delete fixture PDFs in a shared remote store |

Both guards keep working after the widening because the predicate they check
("remote", not "which remote") is unchanged, but their error messages and
comments must name whichever store is actually active (R2 or Blob) rather than
naming only one.

A second, narrower flag, `supportsPresignedUpload`, is `r2Active` alone: true
only when R2 itself is configured, because only the R2 driver can presign a PUT.
Its one consumer, `learning/manage/[courseId]/page.tsx`, gates the SCORM upload
form's direct-upload path on this flag, not on `usingRemoteStorage`. The two
diverge in exactly the rolled-back state: bytes are remote (in Blob), so
`usingRemoteStorage` is true, but presigning against Blob is not a thing, so
gating the direct-upload path on `usingRemoteStorage` there would build an R2
presigned request from undefined credentials. Using the wrong flag for this
choice was an actual bug caught during this migration, not a hypothetical one.

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
- Dry-run by default. `--apply` performs writes, matching the flag every other
  script in `scripts/` already uses.
- Idempotent and resumable: a key already present in R2 with a matching size is
  skipped, so an interrupted run is safe to re-run.
- Skips `scorm-uploads/` staging artifacts. Those were written with
  `addRandomSuffix: true`, are transient inputs to ingest rather than served
  content, and are not referenced by any database row.
- Prints counts, total bytes, and any failures when it finishes. It does not
  itself compare key sets between Blob and R2 -- that verification is manual:
  the cutover runbook's step 6 has the operator compare object counts between
  the Vercel Blob dashboard and the R2 bucket.

## Cutover

The backfill runs ahead of the deploy in step 3, which leaves a window between
the backfill finishing and the deployment going live in which a write could land
in Blob and be missed. The initial plan closed that window only by re-running the
backfill afterward (step 4). Review of that plan found it also left production
with no working rollback: unsetting the R2 variables alone selects the local disk
driver, which is ephemeral on Vercel, so the documented rollback was a storage
outage rather than a revert. A retained Blob driver (`src/platform/storage/blob.ts`)
was added to fix both problems together: `storage/index.ts` selects it whenever
`R2_BUCKET` is unset and `BLOB_READ_WRITE_TOKEN` is present, which is what makes
rollback a real config change, and while R2 is active the same driver lets
`getObject` read through to Blob on a miss, closing the cutover window directly
instead of only narrowing it.

1. Operator creates the R2 buckets (one production, one preview), an API token
   scoped to them, and the CORS rule.
2. Run the backfill against production, dry-run first, then `--apply`.
3. Deploy with the R2 variables set, leaving `BLOB_READ_WRITE_TOKEN` in place.
4. Re-run the backfill to sweep anything written during the window. The
   read-through fallback already serves those objects live, so this step exists
   to copy them into R2 before the Blob store is torn down in step 6, not to
   prevent a 404. It is not cheap: the script checks presence by downloading each
   object's full body from R2, so this pass re-downloads everything step 2 already
   copied.
5. Verify key sets match, then spot-check a certificate download and a SCORM
   course playthrough.
6. A follow-up change removes `@vercel/blob` from `package.json`, deletes
   `scripts/migrate-blob-to-r2.ts` (its only remaining importer), removes
   `src/platform/storage/blob.ts` and the `BLOB_READ_WRITE_TOKEN` config field,
   removes that variable from the Vercel project, and tears down the Vercel Blob
   store itself.

Every step before step 6 is reversible by unsetting the four R2 variables and
redeploying, provided `BLOB_READ_WRITE_TOKEN` was never removed -- that token,
not merely the absence of the R2 variables, is what `storage/index.ts` selects
the Blob driver on. Writes only ever go to the currently active store, so an
object created or updated in R2 after step 3 is not visible from a rolled-back,
Blob-only application; rollback is safest exercised close to step 3, not after
the migration has been live for a while. After step 6 there is no rollback: the
token is gone and the Blob store it pointed at no longer exists.

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
| Write lands in Blob during the cutover window | Closed by read-through: `getObject` falls back to Blob on an R2 miss (`storage/index.ts`, Task 8), so the object is served correctly the moment the step-3 deploy is live. The sweep in step 5 still copies it into R2 itself before step 7 deletes the Blob store. |
| Backfill interrupted midway | Idempotent and resumable by design |
