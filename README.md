# HAVEN Hub

The internal hub for HAVEN Free Clinic: recruitment, onboarding, scheduling, compliance, learning, and IT support in one Next.js app.

Deployment and infrastructure live in [docs/DEPLOY.md](docs/DEPLOY.md). This file is about working on the code.

## Setup

Requires Node 22+ and Docker.

```sh
npm install          # also generates the Prisma client
cp .env.example .env # then fill in what you need; see "Environment" below
npm run db:setup     # starts Postgres, applies migrations, seeds dev data,
                     # and prepares the test database. Safe to re-run.
npm run dev          # http://localhost:3000
```

`npm run db:setup` seeds a Dev Director and Dev Volunteer. In development the
login page offers an email-only sign-in, so you can sign in as either without
Yale SSO.

## The local database is not production

`.env` holds the **production** Neon URL, because the deploy and import scripts
need it. Next.js does not override variables that are already set, so a bare
`next dev` would run the entire app against live clinic data, and pay a ~49ms
round trip per query instead of ~3ms.

So the scripts name the local database explicitly:

| command | database |
|---|---|
| `npm run dev` | local |
| `npm run db:migrate`, `db:deploy`, `db:seed` | local |
| `npm test`, `npm run e2e` | local test databases |
| `npm run dev:remote` | whatever `.env` says, deliberately |

`next.config.ts` refuses to start a dev server against a non-local database as a
backstop, and `playwright.config.ts` and `prisma/seed.ts` carry the same guard.
Each has an escape hatch (`ALLOW_REMOTE_DEV_DB`, `E2E_ALLOW_REMOTE_DB`,
`ALLOW_PROD_SEED`); reach for one only when connecting to a remote database is
the actual goal.

Point the dev commands somewhere else with `DEV_DATABASE_URL`.

## Testing

The suite is integration-first: most tests run against a real Postgres rather
than mocking Prisma. That is deliberate. Several bugs here were only ever
visible at the database level, such as Postgres aborting a transaction past a
`try/catch`, and Prisma's `{ not: x }` silently dropping NULL rows.

```sh
npm run test:related -- src/platform/people.ts   # ~20s, the inner loop
npm run test:watch                                # re-runs on save
npm test                                          # everything, ~3 min
npm run e2e                                       # Playwright, needs a dev server
npm run verify                                    # lint + typecheck + full suite
```

**`test:related` is the one to use while working.** It runs every test that
imports the given files, directly or transitively: about 20 seconds for a
typical service file against about three minutes for the whole suite.

Tests run in parallel, each worker on its own database cloned from the migrated
template, and its own upload directory. Nothing is shared, so a worker cannot
truncate rows another worker is using. If you add a migration, `npm run
test:prepare` brings the template up to date; the suite tells you when it is
behind rather than failing hundreds of files on missing columns.

## Before you push

A `pre-push` hook runs the repo-scanning guard tests, typecheck, lint, and the
tests related to your changes. It targets under two minutes; the full suite is
CI's job. It is wired up by `npm install` (via `core.hooksPath`).

Skip it with `git push --no-verify` when you need to.

The lint rules are not only style. They enforce that modules never import each
other, that platform code never imports a module, that raw styled controls give
way to the UI primitives in `src/platform/ui`, and that em-dashes stay out of
`src/`. These are cross-file rules, so run `npm run lint` over the whole repo
rather than a changed-files subset.

## Environment

`.env.example` is the annotated reference. Most keys are optional and the app
degrades without them: with no R2 credentials uploads go to local disk, and with
no email transport configured mail is written to the log instead of sent.

The test suite ignores all of it. `vitest.setup.ts` claims every
external-service variable as empty before the tests import config, so a test run
cannot reach a real bucket, mailbox, or Airtable base regardless of what your
`.env` contains.

## When something looks broken but is not

- **The suite hangs with no output.** Postgres is not running. `npm run db:up`.
- **A column does not exist.** The test template is behind. `npm run test:prepare`.
- **A model is `undefined` on the Prisma client.** The generated client is stale.
  `npx prisma generate`.
- **Only e2e fails, on a label or a heading.** e2e asserts real UI text, so
  renaming a button breaks specs that unit tests do not cover.
- **A test passes alone and fails in the suite.** Check for another vitest
  process still running from an earlier command before assuming a regression.

## Layout

```
src/app/        routes (App Router)
src/modules/    feature modules; these never import each other
src/platform/   shared services, auth, RBAC, email, UI primitives
prisma/         schema, migrations, seed
e2e/            Playwright specs
docs/           deploy notes, runbooks, audits, house style
```

`docs/ui-house-style.md` covers the UI conventions.
