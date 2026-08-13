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
`RENAME` / type-narrow), the old code (whose generated Prisma client still `SELECT`s
the dropped column on every query) runs against the already-migrated schema for the
whole build window. On a hot table like `Person` (read on essentially every
authenticated request via the session/onboarding gate), that means **app-wide 500s
until promotion completes**.

### What actually decides whether the old deployment breaks

Not "does the old code reference the column". **Does the old client's generated SQL
name the column.** Prisma emits an explicit column list, and which columns it names
comes from `schema.prisma`, not from your application code. Measured against a
database with the column dropped and a client that still declares it (audit 13,
2026-08-13):

| Query shape | Result |
| --- | --- |
| `findFirst({ where })`, no projection | **fails**, 42703 |
| `findFirst({ where, include: {...} })` | **fails**, 42703 (`include` names relations; every scalar is still emitted) |
| `findFirst({ where, select: {...} })` | survives |
| `count()` | survives |

The consequence is the important part: **splitting into two releases does not on its
own save you.** In release N the field is still in `schema.prisma` (it has to be, or
the `DROP` migration would already be written), so release N's client still emits it,
and release N is exactly what is serving traffic when release N+1's migration lands.
An earlier version of this runbook claimed otherwise, and a real incident followed it:
commit `2ce40c15` dropped seven `TechRequest` columns, and `/support/[id]` (an
`include:` query) plus the Intercom `ticket.created` webhook (no projection) 500'd for
the whole build window.

Rule:

- **Additive migrations** (`ADD COLUMN ... NOT NULL DEFAULT x`, new nullable columns,
  new tables) are safe in a single release. This is the common case.
- **Before narrowing a table, give its read paths an explicit `select:`.** That is the
  only change in this list that actually closes the window rather than shortening it.
  Ship it in release **N**; `tsc` will tell you if the projection is missing a field a
  caller uses. Then ship the `DROP` in release **N+1**.
- Prefer **not dropping at all** when the column is merely dead: leaving a nullable,
  unread column costs nothing and carries no deploy window.
- Deploy any destructive change **off-peak** (not a clinic day, not recruitment
  crunch), and expect a window on any table whose read paths are not fully projected.
- The window is a property of running `migrate deploy` inside `buildCommand`. Moving
  migrations to a post-promotion step would remove it entirely, at the cost of a
  deploy that can be live before its schema is. Not done; noted so the tradeoff is
  on the record.

## 2. A failed migration wedges the whole pipeline

CI runs `prisma migrate deploy` only against a **fresh, empty** Postgres, so it catches
DDL syntax errors but **cannot** catch data-dependent failures:

- adding `NOT NULL` where production has nulls,
- adding a `UNIQUE` index where production has duplicates,
- an enum/type cast that hits an unexpected value.

These pass CI green and fail at the production build. When `migrate deploy` fails it
records the migration as failed in `_prisma_migrations`, and **every subsequent
`migrate deploy`, including the build for the fix, aborts with P3009** until a human
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

## 3. Cron scheduling is external: monitor it

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
  admins: the heartbeat banner only shows if someone opens `/admin`.
- **Turn on cron-job.org's built-in per-job failure email** so a non-200 is noticed.

### Rotating `CRON_SECRET`

`authorizeCron` fails **closed**: a missing/rotated secret 401s every tick. If you rotate
`CRON_SECRET`, you **must** update the `Authorization` header in the cron-job.org (and any
dead-man's-switch) configuration **in the same change**, or all scheduled work silently
stops.

## Staging environment (`staging.havenfreeclinic.org`)

A persistent pre-production mirror runs as a Vercel custom environment named
`staging`, tracking the `staging` git branch. `vercel.json`'s `ignoreCommand`
builds `main` and `staging` and skips every other branch, so pushing `staging`
deploys it through the same `prisma migrate deploy && next build` pipeline as
production. Promote by merging `staging` into `main`.

Staging is isolated from production so a test can never touch real data. Each of
these is scoped to the `staging` environment only:

- **Database:** its own Neon branch `staging` (project `floral-dawn-97522801`),
  forked from `main` with a distinct role password, wired through `DATABASE_URL`
  and `DATABASE_URL_UNPOOLED`. It doubles as the safest place to rehearse a
  constraint-adding migration before it runs against production (see section 2).
- **File storage:** its own Vercel Blob store `havenhub-staging-uploads`.
- **Email:** `EMAIL_TRANSPORT=log`, so staging never sends real mail.
- **Auth:** `DEMO_MODE=true` enables the email/credentials login and drops the
  Azure requirement. Keep Vercel Deployment Protection on the environment: the
  database is a fork of production and the login is open.
- **Links:** `APP_BASE_URL=https://staging.havenfreeclinic.org`.

Regenerate the staging connection strings with
`neonctl connection-string staging --project-id floral-dawn-97522801`.

The Airtable, Azure, Graph, GitBook, PostHog, and cron/auth variables still read
production's values; scope any of them to `staging` the same way if it needs to
diverge.

---

_Owner: keep the "holder" and scheduler-account notes above filled in. When the pipeline
or scheduler changes, update this file and `docs/cron-jobs.md` together._
