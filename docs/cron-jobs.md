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
| `/api/cron/email` | External (cron-job.org) | every 30 min | `*/30 * * * *` | Dispatches due campaigns, then drains the email + Teams queues. **Backstop** only: primary delivery fires on enqueue (post-response flush). | Failed-send retries and scheduled campaigns stall (new transactional mail still goes out on enqueue). |
| `/api/cron/reminders` | External (cron-job.org) | daily | `0 13 * * *` | Enqueues HIPAA certificate reminders and onboarding-requirement reminders, plus the weekly per-director clearance digest (which self-paces off an ISO-week claim, so it lands on the first run of each week). | HIPAA reminders, onboarding reminders, and the weekly director digest are all never enqueued. |
| `/api/cron/shift-reminders` | External (cron-job.org) | weekly (Mon) | `0 13 * * 1` | Enqueues weekly shift reminders to everyone scheduled for the upcoming Saturday clinic day (delivered by the enqueue flush after it runs, backstopped by the email tick). | Volunteers stop receiving their Saturday shift reminders. |
| `/api/cron/recruitment-drafts` | External (cron-job.org) | daily | `0 4 * * *` | Sweeps abandoned onboarding drafts older than 30 days. | Stale draft rows accumulate. |
| `/api/cron/recruitment-review-digest` | External (cron-job.org) | daily | `0 14 * * *` | Notifies each active department director who has applications awaiting review (volunteer routed-undecided + director-track undecided) in their department(s). Enqueue-only; skips directors with nothing to review. | Directors get no daily reminder of applications waiting on their review (they can still reach them via the roster). |
| `/api/cron/schedule-reminders` | External (cron-job.org) | daily | `0 15 * * *` | Reminds a department's shift-request approvers (`schedule.manage_requests` holders) of drop/swap requests still pending, throttled so the same approver is not re-notified every day. Enqueue-only. | Pending shift drop/swap requests are never chased; approvers may never notice a request awaiting their decision. |
| `/api/cron/clinic-checkin-invites` | External (cron-job.org) | daily | `0 11 * * *` | Queues the morning-of check-in link to everyone assigned to today's clinic; no-ops on non-clinic days. Enqueue-only, one email per person even if assigned to multiple departments that day. | Volunteers get no check-in link and must be checked in manually by a director. |
| `/api/cron/wallet-passes` | External (cron-job.org) | daily | `0 5 * * *` | Revoke expired and offboarded wallet badges: re-revokes at the vendor any badge whose term has ended or whose holder has been offboarded, since the vendor has no webhooks and every other revoke path is best-effort. | A badge already believed dead can stay live and scannable on a former volunteer's or expired-term member's phone indefinitely. |

Notes:

- Primary delivery is **on enqueue**: `queueEmail` / `queueTeamsMessage` schedule
  a post-response drain, so a queued message goes out in ~1s. This 30-min tick is
  the backstop that retries failed sends and dispatches scheduled campaigns.
- Multiple drainers now coexist safely (enqueue-triggered flushes, this tick, and
  any overlapping tick): each drain claims a row with an atomic `updateMany` on
  `lockedAt` before sending, so no row is sent twice. A transiently-failed row is
  kept locked for `STALE_LOCK_MS` (5 min), so retries are paced by that window
  regardless of how often a drain is triggered; a permanently-failed row (FAILED
  after 8 attempts) releases its lock so an admin retry is immediately claimable.
- The `reminders`, `shift-reminders`, `recruitment-review-digest`, and
  `clinic-checkin-invites` jobs still only **enqueue**; their mail is delivered by
  the enqueue flush after they run, or by this backstop tick. Each is idempotent
  per (person, day) via `claimReminderDispatch`, so an at-least-once retry (a
  cron-job.org timeout/5xx re-fire, or a manual re-run) never double-sends.
  `clinic-checkin-invites` claims under its own dispatch kind
  (`clinic-checkin-invite`), keyed by clinic date, so it cannot collide with the
  weekly `shift-reminders` claims even for the same person on the same day.
- The weekly clearance digest rides the daily `reminders` job rather than its own
  schedule. Its periodKey is the ISO week, so the first daily run of a week sends and
  the rest skip. That means one fewer external schedule to lose on re-provision, and
  a failed Monday run is picked up on Tuesday instead of skipping the week.
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
