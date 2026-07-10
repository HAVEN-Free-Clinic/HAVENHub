# Background cron jobs

HAVEN Hub has no long-running process. The background jobs that used to run on an
in-process pg-boss worker are now HTTP routes under `src/app/api/cron/*`, each
triggered on a schedule by hitting its path with `Authorization: Bearer
$CRON_SECRET`. The worker has been removed, so these routes are the only place
the queues are drained.

All jobs are driven by a single **external scheduler
([cron-job.org](https://cron-job.org), free).** Vercel only executes `vercel.json`
crons on a sufficiently-provisioned paid plan (on the Pro trial they register but
never fire, see commit `7be5efd`), so every job is scheduled externally to stay
plan-independent and free. `vercel.json` carries **no** `crons` array.

Because nothing is visible from `vercel.json`, **this file is the source of truth
for what must be scheduled.** If an external schedule is dropped on re-provision,
the job below silently stops running with no in-repo error.

## The jobs

| Path | Trigger | Cadence | UTC schedule | What it does | What breaks if it stops |
| --- | --- | --- | --- | --- | --- |
| `/api/cron/email` | External (cron-job.org) | every minute | `* * * * *` | Dispatches due campaigns, then drains the email + Teams notification queues. The **sole** drainer. | Queued email and Teams notifications never send. |
| `/api/cron/reminders` | External (cron-job.org) | daily | `0 13 * * *` | Enqueues HIPAA compliance reminders and director escalations (delivery happens on the email tick). | HIPAA reminders and director escalations are never enqueued. |
| `/api/cron/shift-reminders` | External (cron-job.org) | weekly (Mon) | `0 13 * * 1` | Enqueues weekly shift reminders to everyone scheduled for the upcoming Saturday clinic day (delivery happens on the email tick). | Volunteers stop receiving their Saturday shift reminders. |
| `/api/cron/recruitment-drafts` | External (cron-job.org) | daily | `0 4 * * *` | Sweeps abandoned onboarding drafts older than 30 days. | Stale draft rows accumulate. |

Notes:

- **Exactly one** scheduler may call `/api/cron/email`. It assumes a single
  drainer (no `SELECT ... FOR UPDATE SKIP LOCKED`); a second concurrent caller
  would double-send. For the same reason the reminders job only **enqueues**
  email, it never drains it.
- `reminders` is deliberately split from email delivery: its enqueued mail is
  delivered by the per-minute email tick within ~60s.
- `recruitment-drafts` used to be a Vercel Cron but was moved to the external
  scheduler for the same reason as the others (Vercel does not fire `vercel.json`
  crons on the current plan). `vercel.json` no longer declares any crons.

## Authorization

Every route calls `authorizeCron` (`src/platform/cron.ts`), which **fails
closed**: it rejects the request unless `CRON_SECRET` is set on the deployment
**and** the request carries `Authorization: Bearer <that secret>`.

- Set `CRON_SECRET` in the Vercel project environment (Production, and any
  environment that should run crons).
- Configure each external cron-job.org job to send the header
  `Authorization: Bearer <CRON_SECRET>`.
- With no `CRON_SECRET` configured, every cron request is rejected (401) and no
  job runs.

## (Re)provisioning the external schedules

On cron-job.org, create one job per external endpoint above. For each:

1. **URL:** `https://<production-domain>/api/cron/<path>` (GET).
2. **Schedule:** the UTC cron expression from the table. Set the job's timezone
   to UTC so the cadence matches.
3. **Header:** `Authorization: Bearer <CRON_SECRET>` (the value set on Vercel).

A successful run returns HTTP 200 with a small JSON summary
(`{ "ok": true, ... }`); a 401 means the secret/header is missing or wrong.
