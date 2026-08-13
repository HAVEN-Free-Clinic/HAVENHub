# HAVEN Hub whole-app audit, 13th pass: go-live readiness

**Date:** 2026-08-13
**Base:** clean worktree fork of `main` @ `2a3ca673` (includes #600)
**Scope:** correctness and go-live readiness across the platform. 1,236 TS/TSX files, 101 pages, 30 API routes, 75 server-action modules, 125 migrations
**Method:** single-session static audit plus a full automated baseline. No parallel agent fleet (unlike passes 11 and 12).
**Result:** 3 findings (1 high, 1 medium, 1 low). No critical. No auth bypass, no data-exposure hole, no data-loss path.
**Status:** all three fixed on `worktree-audit-13-prelaunch`. See "Fixes applied" at the end.

## Executive summary

The platform is in good shape for go-live. The automated baseline is entirely
green: typecheck, lint, and production build locally; all 125 migrations against
a fresh database; and both the 464-file unit suite and the 34-spec Playwright
suite green in CI on this exact commit. Every sweep aimed at the bug classes this codebase has historically
produced came back clean, and, importantly, the high findings from the 11th
pass have demonstrably shipped, with the fix sites carrying comments that name
the original defect.

The three findings below are not defects in application logic. All three sit in
the **deployment and operations boundary**, which is exactly the surface a
go-live exercises hardest and which twelve prior audits, all focused on
in-application correctness, have never had reason to look at.

Fix first: **finding 1**. It is three lines, and it is the only one that can
break the live site.

## Findings

### 1. Nothing checks that object storage is configured in production (HIGH)

`src/platform/config.ts:285-308`, `src/platform/storage/index.ts:25`

**What's wrong.** The R2 `superRefine` enforces all-or-nothing *only when at
least one* `R2_*` variable is set:

```ts
const present = keys.filter((key) => env[key]);
if (present.length === 0 || present.length === keys.length) return;
```

`present.length === 0` returns early. A deployment with **no** R2 variables at
all validates cleanly, and `storage/index.ts` then silently selects the
local-disk driver:

```ts
const r2Active = Boolean(config.R2_BUCKET);
```

**Verified**, not inferred. Calling `loadConfig` with a production-shaped env
(`NODE_ENV=production`, Azure set, no `R2_*` at all):

```
config PARSED with zero R2 vars in production
  R2_BUCKET       = undefined
  UPLOAD_DIR      = "./uploads"
  => r2Active would be: false
  => storage driver: LOCAL DISK

partial R2 config refused (expected):
    - R2_ACCOUNT_ID: required when any other R2_* variable is set ...
```

A half-configured store is refused at boot; a completely unconfigured one is not.

**How it fails.** On Vercel the function filesystem is read-only outside `/tmp`,
so `disk.putObject`'s `fs.mkdir`/`fs.writeFile` against the default
`UPLOAD_DIR` (`./uploads`) throws at write time. Every upload path in the app
fails at once, and only when a real user tries: HIPAA certificates, drawn
signatures, incident and support attachments, recruitment application files,
branding images, SCORM package trees, and member photos. If `UPLOAD_DIR` is
instead pointed at `/tmp`, writes succeed and the bytes vanish on the next
invocation: silent data loss, which is worse.

The config comment already articulates this risk ("uploads appear to succeed and
then vanish on the next deploy, with no error anywhere") but the guard it
introduces only covers the partial-config case. The only checks on
`usingRemoteStorage` live in ops scripts (`scripts/import-certificates.ts:28`,
`scripts/import-support-history.ts:49`, `scripts/seed-ux-audit-fixtures.ts:139`),
never in the application itself.

**Fix.** Mirror the Azure-AD block immediately above it. In production, when not
`DEMO_MODE`, and outside `NEXT_PHASE=phase-production-build`, require
`R2_BUCKET`. The app then refuses to boot rather than losing files quietly,
which is the posture the existing comment says it wants.

### 2. The two-release rule for destructive migrations is unenforced, and the most recent migration violated it (MEDIUM)

`prisma/migrations/20260812180207_remove_tech_request_dead_intake_columns/`, commit `2ce40c15`

**What's wrong.** `docs/DEPLOY.md` §1 mandates that any schema-narrowing change
ship across two releases, because `vercel.json` runs
`prisma migrate deploy && next build`, so the migration lands at the *start* of the
build while the *previous* deployment keeps serving traffic for the whole build
window. Commit `2ce40c15` shipped the `DROP COLUMN` and the code change that
stops referencing those columns **in a single commit**:

```
 .../migration.sql                                  | 19 ++++++++++++++
 prisma/schema.prisma                               |  8 ------
 src/modules/support/services/tech-request.ts       | 30 +++++-----------------
```

**How it fails.** The pre-drop code named all seven dropped columns. `loadDetail`
used `include:` (not `select:`), so the generated client emitted every
`TechRequest` scalar; `createTechRequestFromConversation` used a bare
`findUnique`/`findFirst` with no projection at all. For the duration of that
build, the live deployment therefore issued `SELECT ... "epicEndDate",
"epicJobTitle", "epicMirrorId", "epicStartDate", "govId", "netId",
"worksAtYnhh"` against a schema where none of them existed: Postgres 42703, a
500 on `/support/[id]` and on the Intercom `ticket.created` webhook. The ticket
*list* survived, because it alone uses an explicit `LIST_SELECT`.

This has already happened; the columns are gone and current code is consistent,
so there is no live bug. It is reported because **nothing prevents a recurrence**,
and more schema changes will land before go-live. The rule exists only as prose
in a runbook.

**Correction, found while fixing this.** The recommendation above (a CI check on
"destructive migration plus code change in one commit") rested on an incomplete
model, and so does DEPLOY.md's own rule. Prisma builds its column list from
`schema.prisma`, not from what the application code touches. In release N the
field is still declared in `schema.prisma` (it has to be, or the `DROP` migration
would already be written), so release N's client still emits it, and release N is
exactly what serves traffic when release N+1's migration lands. **Splitting into
two releases does not on its own save you.**

Measured against a database with a column dropped and a client that still
declares it:

| Query shape | Result |
| --- | --- |
| `findFirst({ where })`, no projection | fails, 42703 |
| `findFirst({ where, include: {...} })` | fails, 42703 (`include` names relations; every scalar is still emitted) |
| `findFirst({ where, select: {...} })` | survives |
| `count()` | survives |

**Fix.** An explicit `select:` is the only thing in reach that actually closes
the window rather than shortening it. Applied to the queries that broke, and
DEPLOY.md §1 corrected to state the real mechanism, since the rule as written
gave false confidence.

### 3. The support-history import reports a rollback that did not happen (LOW)

`src/platform/airtable/import/support-history/index.ts:33-41`, `:162`, `:182`, `:186-188`

**What's wrong.** `SupportHistoryNotificationError` hardcodes the claim that
"the transaction was rolled back". On the dry-run path that is true by design.
On the **apply** path the message-count check runs after the transaction has
already committed (`:162`) and after attachments have been uploaded to storage
(`:182`).

**How it fails.** An operator running the go-live history migration
(`npm run import:history:apply`) who trips this guard is told nothing was
written, when in fact every ticket row and every attachment was. The natural
next step, re-running the import, is taken on a false premise. The import does
appear to be idempotent (attachments key off the Airtable attachment id at
`:87-92`), so the damage is confusion rather than duplication, but the message
should not be the thing an operator has to distrust during a cutover.

**Fix.** Take the message from the path: state that the transaction was rolled
back only on the dry run, and on the apply path say that the rows are committed
and name what to inspect.

## Notes (not findings)

- **`src/platform/teams/channel-link.ts:32,62`** hardcodes `America/New_York`
  rather than reading the configured `display.timeZone` setting, unlike the rest
  of the date layer. Harmless while the clinic is in New Haven; inconsistent with
  the configurable-zone design.
- **`src/platform/dates/no-raw-locale.guard.test.ts`** only bans
  `.toLocaleDateString(`/`.toLocaleTimeString(`. It does not catch raw
  `new Intl.DateTimeFormat(...)`. All five current uses outside `platform/dates`
  pass an explicit `timeZone`, so nothing is broken today, but the guard has a
  hole a future edit can walk through.
- **`MAX_BULK_OFFBOARD = 25`** is sized against a 300s function budget, but the
  bulk-offboard path declares no `maxDuration`, unlike all nine cron routes which
  set it explicitly. It relies on the platform default staying 300s.
- **Clinic geofence defaults** (`41.3025, -72.937`, radius 250 m) sit roughly
  140 m from the configured clinic address default (800 Howard Ave), so the
  default fence does cover the building. Still worth confirming against the
  actual entrance before the first clinic day, as the code comment asks.

## What was checked and found clean

**Automated baseline** (all green on this tree):

| Check | Where | Result |
| --- | --- | --- |
| `tsc --noEmit` | local, this tree | clean |
| `npx eslint src e2e scripts` | local, this tree | 0 errors, 2 pre-existing `<img>` warnings |
| `next build` (production) | local, this tree | succeeds |
| `prisma migrate deploy`, fresh DB | local, this tree | 125/125 applied, 0 failed |
| `npm test` (464 vitest files) | CI `checks` @ `2a3ca673` | success |
| `npx playwright test` (34 specs) | CI `e2e` @ `2a3ca673` | success |

The two suites are reported from CI rather than from this tree deliberately.
`vitest.config.ts` sets `fileParallelism: false`, so 464 files run serially, each
truncating ~70 tables. A local run takes hours and answers exactly the question
CI already answered on the identical commit. CI run `31667465965` on
`2a3ca673` shows `checks: success` (lint + typecheck + `npm test`) and
`e2e: success`.

**Sweeps:**

- **API authorization.** All 30 routes. Nine cron routes gate on `authorizeCron`
  (fails closed without `CRON_SECRET`). `/api/mcp` and
  `/api/support/tickets/from-conversation` use constant-time bearer match behind
  `isMcpConfigured()`. `/api/support/tickets/events` verifies Intercom's
  `X-Hub-Signature` HMAC against the raw body before parsing or touching a row.
  The rest use `auth()` + `can()`. `/api/_health/log-test` 404s in production.
- **Server actions.** All 75 modules, every exported action. Each gates on
  `requirePersonSession`, `requirePermission`, or `getApplicantIdentity`, either
  directly or through a shared `run()` helper, with services self-authorizing
  underneath.
- **Prisma `not:` NULL exclusion** (the #224 class). Every use checked against
  schema nullability. No filter sits on a nullable column where dropped NULLs
  would matter.
- **RBAC engine.** `permissionDepartmentIds` keeps each assignment's own scope;
  department-targeted rows are pre-constrained to the person's active
  memberships, so a director in one department cannot carry the grant into a
  department they merely volunteer in.
- **Onboarding gate.** Allowlist is `/get-started`, `/login`, `/welcome`, with no
  `(app)` path, per the lesson encoded in its own comment. `x-pathname` is
  overwritten by `proxy.ts` on every matched path, so it is not client-spoofable;
  no API route calls `requirePersonSession`, so the `!path` no-op is confined to
  contexts that cannot redirect anyway.
- **Error handling.** No swallowed exceptions (`catch {}`) outside one telemetry
  call. No stray `console.log` in application code.
- **N+1 queries.** Candidate loops resolve to batched `in:` queries; the
  remaining hits are one-off Airtable import scripts.
- **Term activation.** Serializable transaction with a retry, so two concurrent
  activations cannot leave two ACTIVE terms.

**Prior high findings, re-verified as fixed:**

| Pass 11 finding | Status |
| --- | --- |
| #1 posthog-js ships live magic-link / onboarding tokens | fixed via `sanitize_properties` + `before_send` in `instrumentation-client.ts` |
| #6 `promoteContracts` leaves a queued Epic DEACTIVATE live | fixed via `cancelOpenDeactivationRequestsTx` in the same transaction |
| #45 strike email carries the anonymous reporter's narrative | fixed via `subjectFacingDetail`, cited as #45 in-code |
| T7 identity not trimmed before write | fixed via `promotion.ts:128-129` trims and lowercases, with the failure mode named in the comment |

## Method and limits

Single session, static reading plus the automated baseline above, on a dedicated
`havenhub_test_audit13` database so no other worktree's suite could contend.

**Limits, stated honestly:**

- **No agent fleet.** Passes 11 and 12 used 40 parallel agents and produced 139
  and 88 findings respectively. This pass is one reader. Its coverage of
  application logic is therefore far shallower than theirs, and the low finding
  count reflects the method as much as the code. It is not evidence that only
  three defects exist.
- **No browser session.** The e2e suite is green in CI on this commit, but no
  page was driven by hand in this pass, so anything Playwright does not assert
  went unexercised.
- **Finding 1 is verified** by executing `loadConfig`. Finding 3 is an argument
  from code. Finding 2 is corroborated by the commit contents and by the
  pre-drop query shapes (`include:` vs `select:`), not by an observed 500.
- **Prior-audit findings were not re-litigated** beyond the four high ones spot-
  checked above. The 139 findings of pass 11 and 88 of pass 12 are assumed
  addressed or triaged elsewhere.
- **Production configuration could not be inspected.** Finding 1 describes a
  missing guard; whether the live deployment actually has `R2_*` set is a
  question only the Vercel project can answer.
</content>
</invoke>

## Fixes applied

All three findings are fixed on `worktree-audit-13-prelaunch`.

| # | Change |
| --- | --- |
| 1 | `config.ts` gains a fourth `superRefine`: production, non-demo, outside the build phase now requires `R2_BUCKET`. Five tests cover the guard, the DEMO_MODE exemption, the `NEXT_PHASE` carve-out, and that local disk still works in development. |
| 2 | DEPLOY.md §1 rewritten around the measured mechanism, including the query-shape table and the note that two releases alone do not help. `tech-request.ts` gains a shared `TICKET_SCALARS` projection, applied to `loadDetail` and to the three unprojected reads plus the create on the Intercom webhook path. Listing every scalar keeps the result assignable to `TechRequest`, so there is no type churn at the call sites, and `tsc` now catches the next narrowing at the call site instead of production catching it. |
| 3 | `SupportHistoryNotificationError` takes the disposition from the path: it claims a rollback only on the dry run, and on the apply path states that rows are committed and names what to inspect. Four tests pin it, including the negative assertion that the apply path never says "rolled back". |

**Verification after the fixes:** `tsc --noEmit` clean; `eslint src e2e scripts`
0 errors; `next build` succeeds with no `R2_*` set, which is the regression that
mattered most (it confirms the `NEXT_PHASE` carve-out); 520 tests pass across the
24 support, config, and import test files, plus the 4 new ones.

Not done, and deliberately: moving `prisma migrate deploy` out of `buildCommand`.
That would remove the deploy window entirely rather than narrowing it, but it
trades for a deployment that can go live before its schema does, and it is not a
change to make unreviewed days before go-live. The tradeoff is now recorded in
DEPLOY.md §1 so it is a decision rather than an oversight.
