# Task 1: Local environment state

Recorded 2026-07-28. Later tasks (2-8) depend on this environment still running.
Do not tear down the database described here.

The dev server is owned by the controller session, not by any task subagent. A background
process started inside a subagent dies when that subagent's session ends, so no task can leave a
running server for the next one to inherit. The controller starts and keeps the dev server
running across the whole audit. A subagent must never start its own long-lived dev server; it
should only verify the controller's server is up (see "Dev server" below) and, if it is not,
report NEEDS_CONTEXT rather than starting one itself.

## Database

- Name: `havenhub_uxaudit`
- Host: `localhost:5434` (native Postgres, role `haven` / `haven_dev`, NOT Docker, NOT Neon)
- Created by: superuser `jcarney` (`CREATE DATABASE havenhub_uxaudit OWNER haven;`), because
  role `haven` lacks the CREATEDB attribute on this Postgres instance. `haven` connects to it
  fine once created (matches every other `havenhub_*` database on this instance).
- Migrations applied: 96 (via `npx prisma migrate deploy`), all reported as applied cleanly,
  no drift.
- Seed: `npm run db:seed` printed `Seed complete.` Verified three `Person` rows exist:
  - `j.carney@yale.edu` (no phone)
  - `dev.director@yale.edu` (phone `203-555-0131`)
  - `dev.volunteer@yale.edu` (phone `203-555-0142`)

## Env file

`.env.local` (gitignored, not committed) created fresh in this worktree with:

```
DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_uxaudit
DATABASE_URL_UNPOOLED=postgresql://haven:haven_dev@localhost:5434/havenhub_uxaudit
AUTH_SECRET=<generated with openssl rand -base64 32>
```

Note: the Prisma CLI does not auto-load `.env.local` (that is a Next.js-only convention), so
`migrate deploy` and `db:seed` were run with `DATABASE_URL` / `DATABASE_URL_UNPOOLED` also
exported in the shell for that one-off invocation. The dev server itself loads `.env.local`
natively (confirmed in its startup log: `Environments: .env.local`). No `.env` file exists in
this worktree, and none was created, since `next dev` picks up `.env.local` on its own -- do not
add DB credentials to `.env` in this worktree.

## Dev server

- Port: `3000`
- Started with `npm run dev` (Next.js 16.2.11, Turbopack). At the time Task 1 ran it was launched
  with `run_in_background: true` inside the task's own subagent session; that process died when
  the session ended, so the server was NOT actually running when Task 1's review checked it. The
  controller has since started its own long-lived server and owns it going forward (see the note
  above). Do not repeat the subagent-background-process approach.
- Before any browser work, verify the controller's server is actually up:

  ```bash
  curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/login
  ```

  Expected `200`. If it is anything else (connection refused, non-200), stop and report
  NEEDS_CONTEXT so the controller can restart it. Do not start your own server.

## Credential login verification (Playwright MCP)

All three seeded personas used the "Local development" dev-sign-in form on `/login` (shown
because `NODE_ENV !== "production"`). Each landed on the dashboard, not `/get-started`:

| Persona | Email | Landing URL | Page title |
| --- | --- | --- | --- |
| Platform Admin | `j.carney@yale.edu` | `http://localhost:3000/` | Dashboard - HAVEN Hub |
| Director | `dev.director@yale.edu` | `http://localhost:3000/` | Dashboard - HAVEN Hub |
| Volunteer | `dev.volunteer@yale.edu` | `http://localhost:3000/` | Dashboard - HAVEN Hub |

All three cleared the onboarding gate as expected (verified HIPAA cert for all three; phone on
file for director and volunteer). Signed out between each check via the account-menu "Sign out"
button, confirming a clean return to `/login` each time.

## Known non-blocking noise

- Next.js Turbopack prints a workspace-root warning at startup because the main checkout's
  `package-lock.json` and this worktree's `package-lock.json` both exist on disk. Cosmetic only,
  does not affect serving.
- Every page reports 1 browser console error: `[PostHog.js] PostHog was initialized without a
  token.` Expected -- `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN` is intentionally unset in this audit
  `.env.local`. Harmless, ignore it in later journey tasks unless a page-specific issue is also
  present.
