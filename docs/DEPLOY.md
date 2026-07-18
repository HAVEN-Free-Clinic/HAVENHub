# Deploy & database runbook

HAVEN Hub deploys on Vercel (region `iad1`) against a Neon Postgres database. This
runbook covers the two failure modes that can strand the app: a bad schema migration
and a silently-stopped cron scheduler. Keep it short; keep it current.

## The deploy pipeline

`vercel.json` sets:

```
"buildCommand": "prisma migrate deploy && next build"
```

So on every push to `main`, Vercel runs `prisma migrate deploy` against the **production
Neon database first**, then builds. The `&&` means a failed migration aborts the build,
so a broken migration is never promoted. But two consequences follow, below.

## 1. Destructive migrations: use a two-release expand/contract

`prisma migrate deploy` runs at the **start** of the build, while Vercel keeps the
**previous** deployment serving traffic until the new build finishes and is promoted
(minutes later). For a schema-**narrowing** change (`DROP COLUMN` / `DROP TABLE` /
`RENAME` / type-narrow), the old code — whose generated Prisma client still `SELECT`s
the dropped column on every query — runs against the already-migrated schema for the
whole build window. On a hot table like `Person` (read on essentially every
authenticated request via the session/onboarding gate), that means **app-wide 500s
until promotion completes**.

Rule:

- **Additive migrations** (`ADD COLUMN ... NOT NULL DEFAULT x`, new nullable columns,
  new tables) are safe in a single release — this is the common case.
- **Destructive migrations** must be split across **two releases**:
  1. Release **N**: stop referencing the column/table in code (deploys cleanly; old
     code tolerates the column still being present).
  2. Release **N+1**: ship the `DROP`.
- Deploy any destructive change **off-peak** (not a clinic day, not recruitment crunch).

## 2. A failed migration wedges the whole pipeline

CI runs `prisma migrate deploy` only against a **fresh, empty** Postgres, so it catches
DDL syntax errors but **cannot** catch data-dependent failures:

- adding `NOT NULL` where production has nulls,
- adding a `UNIQUE` index where production has duplicates,
- an enum/type cast that hits an unexpected value.

These pass CI green and fail at the production build. When `migrate deploy` fails it
records the migration as failed in `_prisma_migrations`, and **every subsequent
`migrate deploy` — including the build for the fix — aborts with P3009** until a human
resolves it directly against prod. All deploys (including urgent security fixes) are
blocked until then.

### Prevent it

For any migration that adds a constraint (`NOT NULL`, `UNIQUE`, `FK`), first dry-run it
against a **Neon branch forked from production** (the same machinery preview deploys
use) so a data-dependent failure surfaces before the `main` build.

### Recover from it

1. Get the **direct (unpooled) production database URL**. Holder: **_<fill in: which
   admin holds the Neon prod credentials>_**.
2. Inspect the failed migration:
   ```
   DATABASE_URL="<direct prod url>" npx prisma migrate status
   ```
3. If the migration's partial changes did **not** apply, mark it rolled back so the
   pipeline unblocks, then fix the migration and redeploy:
   ```
   DATABASE_URL="<direct prod url>" npx prisma migrate resolve --rolled-back <migration_name>
   ```
4. If the migration **partially applied**, manually undo its partial effects first (or
   restore via Neon point-in-time recovery), then `--rolled-back`.
5. Never hand-edit `_prisma_migrations` unless you know exactly why.

> Instant rollback caveat: Vercel "instant rollback" only reverts **code**, not the
> database. Once a deploy includes a schema-**narrowing** migration, rolling back to
> pre-migration code runs it against the already-migrated schema and will error. Roll
> forward with a fix instead, or pair the code rollback with a database restore.

## 3. Cron scheduling is external — monitor it

There is **no Vercel cron** (`vercel.json` declares no `crons`). Every scheduled job is
fired by an external scheduler (**cron-job.org**, free tier) hitting `/api/cron/*` with
`Authorization: Bearer $CRON_SECRET`. See `docs/cron-jobs.md` for the schedule. The jobs:

| Job | Cadence | If it silently stops |
| --- | --- | --- |
| `/api/cron/email` | ~30 min | Failed-send retries + scheduled campaigns stall (interactive mail still flows via enqueue-flush). |
| `/api/cron/reminders` | daily | HIPAA/EHS compliance reminders + director escalations never sent. |
| `/api/cron/shift-reminders` | weekly | Volunteers miss clinic-day notice. |
| `/api/cron/recruitment-review-digest` | daily | Reviewers stop getting the digest. |
| `/api/cron/recruitment-drafts` | daily | Abandoned drafts not swept. |
| `/api/cron/schedule-reminders` | daily | Pending shift-swap approvals not chased. |

Because the enqueue-only jobs leave no backlog and no failed rows when dead, a stopped
schedule is otherwise **invisible**.

Mitigations in place / to set up:

- **In-app heartbeat (in place):** each route stamps a `cron.lastSuccess.<job>` setting
  on success; the `/admin` overview shows a red banner when a job that was running goes
  stale (`src/platform/cron-heartbeat.ts`).
- **External dead-man's-switch (recommended):** point each cron-job.org job at (or add)
  a free healthchecks.io / cronitor check so a **missed** tick pushes an alert to the
  admins — the heartbeat banner only shows if someone opens `/admin`.
- **Turn on cron-job.org's built-in per-job failure email** so a non-200 is noticed.

### Rotating `CRON_SECRET`

`authorizeCron` fails **closed**: a missing/rotated secret 401s every tick. If you rotate
`CRON_SECRET`, you **must** update the `Authorization` header in the cron-job.org (and any
dead-man's-switch) configuration **in the same change**, or all scheduled work silently
stops.

---

_Owner: keep the "holder" and scheduler-account notes above filled in. When the pipeline
or scheduler changes, update this file and `docs/cron-jobs.md` together._
