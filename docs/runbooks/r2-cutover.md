# Record: the Vercel Blob to R2 cutover that did not happen

This file was a step-by-step cutover procedure. It is kept as a record of what
was planned and what actually happened, not as something to follow -- the
procedure below never ran and the machinery it depended on has since been
removed.

## The plan

Copy roughly 433 MB of objects from Vercel Blob into a new Cloudflare R2
bucket, using a backfill script (`scripts/migrate-blob-to-r2.ts`) that would
page through the Blob store, copy each object into R2 under its identical key,
and support a rollback via a retained Blob driver during a cutover window. The
full seven-step procedure this file used to contain covered a dry-run, an
apply run, a deploy with R2 active and Blob as a read-through fallback, a
sweep of anything written during the cutover window, a verification pass, and
a final decommission step.

## What actually happened

Before the backfill could run, Vercel blocked the Blob store. `list` and
`head` kept answering, but every byte-read returned HTTP 403 with the body
`Your store is blocked`, so no object could be copied out of it.

That turned out not to matter. Checking what the production database actually
referenced in that store found **nothing** except 647 HIPAA certificates, and
every one of those originated in Airtable. Incident attachments, tech-request
attachments, onboarding contracts, branding assets, and SCORM packages were
all zero rows. Everything else sitting in the store was orphaned test data
with no database row pointing at it.

So instead of a Blob-to-R2 copy, the certificates were re-imported straight
from Airtable into R2 (`scripts/import-certificates.ts --refresh --apply`):
**646 refreshed, 0 failures, 0 unrecoverable**, with `verifiedAt`,
`verifiedById`, and `completionDate` preserved on every row. The result was
verified end to end by reading two real certificates back out of R2 and
confirming byte length and PDF magic number.

With nothing in the database pointing at Vercel Blob, every piece of
machinery built to make a Blob-to-R2 cutover safe -- the backfill script, the
Blob driver, the read-through fallback, the dual-delete on the cutover window,
the `BLOB_READ_WRITE_TOKEN` config field -- was guarding a scenario that could
no longer occur, and was removed. See
`docs/superpowers/specs/2026-08-05-vercel-blob-to-r2-design.md`'s outcome
section for the full list of what came out.

## Bucket setup

`docs/runbooks/r2-bucket-setup.md` is unaffected by any of this: the buckets,
API token, and CORS rules it documents are what the application uses today.
