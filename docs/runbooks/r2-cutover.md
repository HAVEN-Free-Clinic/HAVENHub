# Cutting over from Vercel Blob to R2

Prerequisite: `docs/runbooks/r2-bucket-setup.md` is complete, so the buckets, the
API token, and the CORS rules exist.

There is a window between the backfill finishing and the new deploy going live in
which a write could still land in Vercel Blob. The application closes that window
itself: once R2 is active, a read that misses in R2 falls through to Blob
automatically (`src/platform/storage/index.ts`), so an object written during the
window is served correctly the moment the deploy in step 3 goes live, with no
operator action required. Step 5 still matters for a different reason -- see that
step.

Nothing before step 7 (Decommission) is destructive. Blob is never deleted before
then, and rollback -- at any point before step 7 -- is unsetting the four `R2_*`
variables and redeploying. That only works, though, if `BLOB_READ_WRITE_TOKEN`
stays set on the Vercel project the whole time: unsetting the R2 variables makes
`storage/index.ts` select the Blob driver only when that token is present, and
falls through to the local disk driver otherwise, which is ephemeral on Vercel
and produces a silent outage, not a revert. `BLOB_READ_WRITE_TOKEN` should
already be set from before this migration -- do not remove it at any point before
step 7.

## 1. Dry-run the backfill

```bash
BLOB_READ_WRITE_TOKEN=<prod blob token> \
R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_BUCKET=havenhub-uploads \
npm run migrate:r2:dry
```

Confirm the key list looks like real storage keys and the object count is
plausible. Nothing is written.

The `BLOB_READ_WRITE_TOKEN` here is a local environment variable for this
one-off script, letting it read the source store -- a separate thing from the
`BLOB_READ_WRITE_TOKEN` already set on the Vercel project, which the deployed
app itself reads for rollback and read-through. Both should hold the same
token, but only the Vercel-project one matters after step 3.

Before it lists anything, the script does one round-trip against R2 (the
"preflight" check) to catch a bad credential, account ID, or bucket name with a
single clear error instead of a wall of per-object failures. If the dry run fails
immediately with an `R2 preflight check failed` message, fix the R2 variables
before re-running; nothing else in this step touches Blob or R2.

## 2. Run the backfill

Same command with `npm run migrate:r2:apply`. Re-run it if any object fails; the
script skips what it already copied.

The script also has a circuit breaker: if 5 objects in a row fail to copy, it
aborts the run rather than working through the rest of the list. That pattern
means something systemic is wrong (credentials, network, bucket config), not that
a handful of objects are individually bad, so the run stops early on purpose
instead of quietly producing a half-migrated bucket. The console output says
`Aborted after 5 failures in a row` when this happens; fix the underlying problem
and re-run the same command. Objects already copied are skipped, so re-running is
always safe and resumes from where it stopped.

If the run instead completes the full list with a handful of scattered failures
(no abort, but `Failed:` is nonzero in the summary), that is the ordinary case:
re-run the command to retry just the missing objects.

Either way, do not proceed to step 3 until a full run reports `Failed: 0` with no
abort.

## 3. Deploy

Set the four `R2_*` variables on the Vercel project (production scope) and deploy
the branch. **Leave `BLOB_READ_WRITE_TOKEN` in place.** The application now reads
R2 first for every object; a miss falls through to Blob for the rest of the
cutover window, and the same token is the entirety of the rollback path described
above. Removing it here, thinking of it as Blob-era cleanup, converts both of
those safety nets into a silent outage the next time anyone needs them.

Leave `BLOB_READ_WRITE_TOKEN` unset on the preview scope, or confirm it points at
a staging Blob store, not the production one. Preview deploys already run against
the production database (see `docs/runbooks/r2-bucket-setup.md`'s reasoning for
keeping preview and production R2 buckets separate), and with both a Blob token
and R2 configured, deletes fan out to Blob as well as R2. A reviewer replacing a
file on a preview build could otherwise issue a `deletePrefix` against whatever
Blob store the preview token points at, using real keys read from the production
database.

## 4. Smoke-test

- Open a HIPAA certificate from `/my-info` and confirm the PDF renders.
- Open a course under `/learning` and confirm the SCORM content loads. This
  exercises the per-file read path.
- Upload a replacement SCORM package from `/learning/manage/<courseId>`. Confirm
  the progress percentage advances and ingest succeeds. **A CORS error here means
  the bucket rule from the setup runbook is missing or does not list this origin.**
- Upload a branding logo from `/admin/settings` and confirm it renders.

## 5. Sweep the cutover window

Dry-run first -- `npm run migrate:r2:dry` -- and inspect the `would copy` list
before applying. Step 3's deploy made R2 the live store, so anything written to
a fixed key since then (for example a branding logo re-upload from
`/admin/settings`) already sits in R2 with newer bytes than the frozen Blob
snapshot has at that same key. The script's presence check is a plain existence
check, not a size or content comparison, precisely so it never mistakes that
newer R2 object for something stale and copies the old Blob bytes back over it
-- but the dry run is still the cheap way to confirm the `would copy` list is
exactly what you expect (objects genuinely written to Blob only, during the
step 2/step 3 window) before running `--apply`.

Then re-run `npm run migrate:r2:apply`. This copies anything written to Blob
between step 2 and step 3. Expect a small number of new objects, or zero.

This is no longer about preventing a 404: the read-through fallback described
above already serves cutover-window objects live, before this step ever runs.
What this step still does is copy those objects into R2 itself, not merely make
them reachable. That distinction matters because step 7 deletes the Blob store --
any object that exists only in Blob and was never copied into R2 is lost for good
at that point, read-through or not. Run this step before step 7 regardless of
whether the smoke test in step 4 turned up anything missing.

The presence check is a `HeadObject` call, not a full-body download, so this
pass is cheap: it does not re-download every object step 2 already copied just
to confirm it is still there.

## 6. Verify

Compare object counts between the Vercel Blob dashboard and the R2 bucket,
allowing for the `scorm-uploads/` staging objects the script deliberately skips.

## 7. Decommission

Only after the above is confirmed, in a follow-up change. This is the step where
rollback stops being available -- once it lands, the Blob store is gone and
nothing in the application can read or write it, so there is no going back.

- `npm uninstall @vercel/blob`
- `git rm scripts/migrate-blob-to-r2.ts` and drop its two `package.json` entries
  (`migrate:r2:dry`, `migrate:r2:apply`)
- `git rm src/platform/storage/blob.ts`
- Remove the `BLOB_READ_WRITE_TOKEN` field from `src/platform/config.ts` (and its
  coverage in `config.test.ts`)
- Collapse `src/platform/storage/index.ts` back to two-way selection (R2 or local
  disk): remove the `blobOnly` / `readThroughToBlob` branches and the Blob-related
  cases in `index.test.ts`
- Remove `BLOB_READ_WRITE_TOKEN` from the Vercel project
- Delete the Vercel Blob store

## Rollback

Before step 7: unset the four `R2_*` variables and redeploy, with
`BLOB_READ_WRITE_TOKEN` still set. `storage/index.ts` selects the Blob driver
whenever `R2_BUCKET` is unset and a Blob token is present, so the application
reverts to reading and writing Blob exactly as it did before this migration.

That reversion is not perfect symmetry with the forward migration, though: writes
only ever go to the currently active store, so any object created or updated in
R2 after step 3 and before the rollback is invisible to the rolled-back,
Blob-only application -- nothing copies R2 writes back into Blob the way step 5
copies Blob writes into R2. The longer the cutover runs before a decision to roll
back, the more R2-only data a rollback would silently strand. Treat rollback as a
near-term option exercised close to step 3, not something to reach for after the
migration has been live and taking real writes for a while.

After step 7 there is no rollback: `BLOB_READ_WRITE_TOKEN` is gone, the Blob
driver is gone, and the Blob store itself no longer exists.
