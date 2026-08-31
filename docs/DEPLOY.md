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
| `findFirst({ where, select: {...} })` | survives **only if the select omits the dropped column** |
| `count()` | survives |

The consequence is the important part: **splitting into two releases does not on its
own save you.** In release N the field is still in `schema.prisma` (it has to be, or
the `DROP` migration would already be written), so release N's client still emits it,
and release N is exactly what is serving traffic when release N+1's migration lands.
An earlier version of this runbook claimed otherwise, and it has already cost two
incidents in two days:

- `2ce40c15` dropped seven `TechRequest` columns. `/support/[id]` (an `include:`
  query) and the Intercom `ticket.created` webhook (no projection) 500'd for the
  whole build window.
- `20260812232000_person_languages` dropped `Person.spanishSelfReported`. Because
  `getActivePerson` runs on **every authenticated request** for session validation
  and had no projection, this was not one module, it was the whole authenticated
  app. Production filed it as
  `PrismaClientKnownRequestError: The column Person.spanishSelfReported does not
  exist in the current database` from `prisma.person.findUnique()` (issues #597,
  #598, 2026-08-13).

Both read paths are now projected (`PERSON_SCALARS`, `TICKET_SCALARS`) -- but read the
next paragraph before crediting that with anything.

**A projection only helps if it omits the doomed column** (audit 14). Both of those
constants were written to name *every* scalar of their model, which emits exactly the
SQL a query with no projection emits, the about-to-be-dropped column included. Measured
against a database with `Person.dietaryRestrictions` dropped and a client that still
declares it (2026-08-16, Prisma 6.19.3): no projection **fails**, the full-width
`PERSON_SCALARS` **fails identically**, the same projection minus that one column
**survives**. `src/platform/person-scalars.ts` now carries a `PERSON_DROP_PENDING` list
for exactly this: naming a column there in release **N** removes it from the projection
and makes `tsc` fail at every reader, so release **N+1** can drop it safely. See that
file for the procedure. `TICKET_SCALARS` (in
`src/modules/support/services/tech-request.ts`) still has no equivalent, and neither
does the Entra sign-in path (`matchPersonByClaim` runs three *unprojected* Person
lookups, so a narrowing migration still refuses every new sign-in for the length of the
build even when existing sessions survive).

Rule:

- **Additive migrations** (`ADD COLUMN ... NOT NULL DEFAULT x`, new nullable columns,
  new tables) are safe in a single release. This is the common case.
- **Before narrowing a table, give its read paths a `select:` that OMITS the column
  being dropped.** That is the only change in this list that actually closes the window
  rather than shortening it. Ship it in release **N** (for `Person`, by adding the name
  to `PERSON_DROP_PENDING`); `tsc` will then name every caller that still reads the
  field. Then ship the `DROP` in release **N+1**.
- **`DROP COLUMN` is not the only unsafe shape.** `SET NOT NULL` breaks the old code's
  *writes* (it still INSERTs rows without the column), dropping a unique index or
  constraint breaks every `upsert` whose `ON CONFLICT` targets it, and a `RENAME` is a
  DROP and an ADD at once. `src/platform/migration-safety.ts` detects all of these and
  its test fails CI unless the migration states its plan in a
  `-- rolling-deploy: <reason>` comment.
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
| `/api/cron/shift-reminders` | weekly (Mon) | Volunteers miss clinic-day notice. |
| `/api/cron/attending-reminders` | weekly (Mon) | Attendings miss their Saturday reminder, which Faculty Relations previously sent by hand. |
| `/api/cron/recruitment-review-digest` | daily | Reviewers stop getting the digest. |
| `/api/cron/recruitment-drafts` | daily | Abandoned drafts not swept. |
| `/api/cron/schedule-reminders` | daily | Pending shift-swap approvals not chased, and the Executive Directors get no digest of what has stalled. |
| `/api/cron/clinic-checkin-invites` | daily | Volunteers get no check-in link; directors check people in by hand. |
| `/api/cron/wallet-passes` | daily | An offboarded volunteer's wallet badge stays live and scannable indefinitely. |
| `/api/cron/intercom-reconcile` | daily | Hub/Intercom ticket status drifts permanently with nothing to notice it. |

All **ten** are listed here on purpose. This table carried six until audit 14,
so an operator provisioning from it created six schedules and the other four
existed only in `docs/cron-jobs.md`. Keep the two in sync (see the note at the
end of this file), and remember each job can also be individually **Inactive**
on cron-job.org.

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

## 4. Machine-read routes need a firewall bypass

The production deployment answers with Vercel's **Attack Challenge Mode**: a request
to `hub.havenfreeclinic.org` comes back `429` with `x-vercel-mitigated: challenge`
and a "Vercel Security Checkpoint" HTML page. A human browser runs the page's
JavaScript, gets a clearance cookie, and never notices. **Anything that is not a
browser cannot.**

That is fine for the authenticated app, which only humans open, and fatal for any
route whose caller is a machine:

| Route | Caller | Can it solve a challenge? | Bypassed today |
| --- | --- | --- | --- |
| `/api/calendar/[token]` | Google / Apple / Outlook, polling from their own servers | No | Yes |
| `/api/public/clinic-days` | `havenfreeclinic.org` visitors' browsers, cross-origin `fetch()` | No | **No -- needs one** |
| `/api/cron/*` | cron-job.org | No | Not from an arbitrary client (see below) |

The cross-origin case is the least obvious of the three. The *visitor* is in a real
browser, so it feels like it should pass -- but the `fetch()` is issued by
JavaScript on a different origin. It cannot render an interstitial, cannot run the
challenge script, and cannot hold a cookie for this origin. It just receives the
challenge HTML where it expected JSON, and the caller sees a parse error rather
than anything that names the real cause.

**So each of these paths needs a bypass rule in the Vercel Firewall**
(Project → Firewall → Configure → *Bypass* / "Skip Attack Challenge Mode" for the
path). `/api/calendar/*` already has one, which is why that feed works; it was
configured in the dashboard and, until this section existed, was written down
nowhere.

To check whether a path is bypassed, look for the mitigation header rather than
trusting the status code:

```sh
curl -s -o /dev/null -w "%{http_code} %header{x-vercel-mitigated}\n" \
  https://hub.havenfreeclinic.org/api/public/clinic-days
# 200            <- reaches the app
# 429 challenge  <- blocked before the app; add the bypass rule
```

### The cron paths are worth a look

Probed from an ordinary client, `/api/cron/email` answers `429 challenge` the same
way `/` does, while `/api/calendar/*` sails through. That is only an observation
from outside, not a diagnosis: the scheduler may still be getting through on some
basis this probe does not reproduce (address reputation, an allowlist rule, or
challenge behaviour that differs for its client).

It is worth confirming rather than assuming, because section 3 above says a stopped
schedule is otherwise **invisible**, and a challenged cron tick fails in exactly
that invisible way -- the job never runs, and nothing anywhere records that it
did not. The `cron.lastSuccess.<job>` heartbeat on `/admin` is the cheapest check:
if those timestamps are current, the scheduler is reaching the app and there is
nothing to fix here.

A bypassed path is exposed to the open internet with no challenge in front of it,
so it must carry its own protection. Both current bypasses do: the calendar feed
requires an unguessable path token and rate-limits per IP, and the clinic-days feed
is read-only, returns nothing non-public, and is CDN-cached so repeat traffic
mostly never reaches a function.

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
