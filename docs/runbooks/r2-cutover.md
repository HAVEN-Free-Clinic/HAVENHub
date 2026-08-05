# Cutting over from Vercel Blob to R2

Prerequisite: `docs/runbooks/r2-bucket-setup.md` is complete, so the buckets, the
API token, and the CORS rules exist.

There is a window between the backfill finishing and the new deploy going live in
which a write could still land in Vercel Blob and be missed. Step 5 closes it by
re-running the backfill. Nothing before step 7 (Decommission) is destructive: the
Blob store is untouched throughout steps 1-6, so at any point before step 7,
rollback is unsetting the four R2 variables and redeploying. Once step 7 runs,
that option is gone -- see Rollback below.

## 1. Dry-run the backfill

```bash
BLOB_READ_WRITE_TOKEN=<prod blob token> \
R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_BUCKET=havenhub-uploads \
npm run migrate:r2:dry
```

Confirm the key list looks like real storage keys and the object count is
plausible. Nothing is written.

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
the branch. The application now reads and writes R2 exclusively.

## 4. Smoke-test

- Open a HIPAA certificate from `/my-info` and confirm the PDF renders.
- Open a course under `/learning` and confirm the SCORM content loads. This
  exercises the per-file read path.
- Upload a replacement SCORM package from `/learning/manage/<courseId>`. Confirm
  the progress percentage advances and ingest succeeds. **A CORS error here means
  the bucket rule from the setup runbook is missing or does not list this origin.**
- Upload a branding logo from `/admin/settings` and confirm it renders.

## 5. Sweep the cutover window

Re-run `npm run migrate:r2:apply`. This copies anything written to Blob between
step 2 and step 3. Expect a small number of new objects, or zero.

This pass is not free, though: the script checks whether an object is already in
R2 by downloading its full body from R2 and comparing the byte count, since R2
exposes no cheaper head-only check here. On this second pass, that means every
object copied in step 2 gets fully re-downloaded from R2 just to confirm it is
already there, even though nothing new is written for it. For a store holding
large SCORM packages, expect this sweep to take noticeably longer than the object
count written to Blob during the cutover window would suggest -- its runtime
tracks the size of the whole store, not just the size of what changed.

## 6. Verify

Compare object counts between the Vercel Blob dashboard and the R2 bucket,
allowing for the `scorm-uploads/` staging objects the script deliberately skips.

## 7. Decommission

Only after the above is confirmed, in a follow-up change:

- `npm uninstall @vercel/blob`
- `git rm scripts/migrate-blob-to-r2.ts` and drop its two `package.json` entries
  (`migrate:r2:dry`, `migrate:r2:apply`)
- Remove `BLOB_READ_WRITE_TOKEN` from the Vercel project
- Delete the Vercel Blob store

## Rollback

Before step 7: unset the four `R2_*` variables and redeploy. The Blob store still
holds every object, untouched, so the application falls straight back to reading
and writing it. After step 7 there is no rollback -- the Blob store is gone and the
code path back to it no longer exists -- which is why decommission is a separate,
later change and not folded into step 6.
