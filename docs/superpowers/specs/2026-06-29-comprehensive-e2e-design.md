# Comprehensive e2e test coverage — design

Date: 2026-06-29
Branch: `test/comprehensive-e2e` (based on `test/e2e-in-ci`, the tip of the open e2e stack PRs #153/#155/#156)
Delivery: a single PR.

## Goal

Bring the Playwright `e2e/` suite to comprehensive coverage now that it runs in CI, and
run the **whole** suite in the CI `e2e` job. Two bodies of work:

1. **Fix the existing failing specs** so the current suite is fully green against a freshly
   seeded CI database.
2. **Add net-new coverage** for the surfaces that have zero e2e today.

Coverage philosophy is **layered**: every page gets a fast smoke + RBAC check; the critical
flow in each module additionally gets one deep "round-trip" journey (create → act → assert →
restore), matching the style of the existing `schedule`/`volunteers` specs.

## Current state (2026-06-29)

Existing specs (`e2e/`):

- **Green and in the scoped CI job:** `recruitment`, `recruitment-onboarding`, `recruitment-review`,
  `recruitment-interviews` (PRs #153/#155/#156). `recruitment-training` exists but was in the
  failing set — to be confirmed/fixed in Phase 1.
- **Exist but fail against the seed-only CI DB:** `admin`, `schedule`, `volunteers`, `my-info`,
  `login`, `theme`. A fresh-seed full-suite run was 26 pass / 18 fail; every failure was in
  these files.

Surfaces with **no** e2e coverage at all: `clinic/avs`, `learning` (course/dashboard/manage),
`notifications`, `admin/email/campaigns`, the `get-started/*` onboarding gate, `onboard/[token]`
(only partially hit), `welcome`.

### Why the existing specs fail (root cause, verified)

The failures are **not** login or RBAC. `prisma/seed.ts` creates Jack (Platform Admin + ITCM
director + Compliance/Volunteer-Ops manager on EXEC/SRR/ITCM), Dev Director (VADM director),
Dev Volunteer (VADM volunteer), term SU26 ACTIVE, departments, and roles. The specs fail
because they assume **data the seed never creates**:

- `volunteers` status-badge / offboarding / disciplinary / epic tests need **ITCM members with
  HIPAA certificates**, Epic config, and disciplinary setup. The seed has Jack as the only ITCM
  person (a director, no cert rows).
- `schedule` capacity / RHD-readiness / attendings tests need **capacity config**, an **RHD
  department (SCTS)**, and **attendings** — none seeded.

Secondary cause: some selector drift from UI changes (same class of breakage already fixed in
the recruitment specs: the `TypePicker` builder and the `/apply` portal gate).

## Architecture — shared infrastructure

Built once, reused by every spec.

### `e2e/auth.ts`

Extract the `devLogin(page, email)` helper currently copy-pasted into ~7 specs into one module,
plus a `loginAs(page, "admin" | "director" | "volunteer")` convenience mapping roles to the
seeded emails (`j.carney@yale.edu`, `dev.director@yale.edu`, `dev.volunteer@yale.edu`). Specs
import from here instead of redefining it.

### `e2e/fixtures.ts`

A typed helper that creates the data the seed does not, directly via Prisma.

- Instantiates **its own `PrismaClient`** (not the app's server-only singleton) against
  `DATABASE_URL`, with a `.env` fallback that mirrors `portal-cookie.ts`'s `AUTH_SECRET` read.
- Exposes small builders, each returning the created row(s) **and a `cleanup()`**:
  - `seedComplianceMember(deptCode, { status })` → person + `TermMembership` (SU26) +
    `HipaaCertificate` dated to yield COMPLIANT / EXPIRING_SOON / EXPIRED / DATE_UNKNOWN.
  - `seedCapacityConfig(deptCode, capacity)` and `seedAttending(deptCode)` → unblock the
    schedule capacity and RHD-readiness panels.
  - `seedNotification(personId, {...})` → an inbox/bell row.
  - `ingestTestScormCourse()` → a learning course with a package so it is assignable/openable.
  - `seedEpicConfig()` / `seedEpicRequest(personId)` → the Epic request surface.
- Every created row is uniquely tagged (the existing `Date.now()` suffix pattern) so specs never
  collide on the **live** CI database. There is no `resetDb` — the dev server holds the
  connection — so each spec removes exactly what it created in `afterEach`/`afterAll` via the
  returned `cleanup()`.

This is the only mechanism that can reach UI-unreachable surfaces (SCORM ingest, system
notifications, certs), and it removes the seed-data assumptions that break the existing specs.

## Phase 1 — make the existing suite green

For `admin`, `schedule`, `volunteers`, `my-info`, `login`, `theme`, and `recruitment-training`:
feed each spec the data it assumes via `fixtures.ts`, fix any drifted selectors, and keep the
existing deep journeys. Switch their local `devLogin` copies to `e2e/auth.ts`. End state: the
entire existing suite passes against a fresh seed.

## Phase 2 — breadth: smoke + RBAC matrix

`e2e/smoke.spec.ts` iterates a table of `{ route, allowedRole, deniedRole }` over **every**
`(app)` page. For each route it asserts: loads for the allowed role (no error boundary; expected
heading visible) and redirects / lands on `no-access` for the denied role. This is the
"catches crashes everywhere" layer and immediately covers the zero-coverage pages.

## Phase 3 — depth: one key journey per uncovered surface

Using `fixtures.ts`:

- **clinic/AVS** — fill the form, generate, assert the PDF download fires (EN + ES).
- **learning** — fixture-ingest a course → open it → mark complete → dashboard reflects it.
- **notifications** — fixture a notification → bell badge + `/notifications` row → mark read.
- **admin/email/campaigns** — create a campaign with an audience condition → preview / test-send
  to sample "Sam".
- **get-started gate** — a fresh un-cleared person is held at `/get-started`; clearing the steps
  (profile / HIPAA / training / learning) releases them to the hub.

## Phase 4 — CI

In `.github/workflows/ci.yml`, replace the scoped 4-spec list in the `e2e` job with the whole
`e2e/` directory. Add Playwright `workers`/sharding only if wall-clock requires it. Keep the
`test-results/` artifact upload on failure.

## Out of scope / YAGNI

- No separate CI workflow — the new specs join the existing `e2e` job.
- No `resetDb` for e2e — incompatible with the live dev-server connection; per-spec
  create-and-cleanup instead.
- No deep journeys beyond one per surface (the layered philosophy); extra depth can follow later.
- `testsprite_tests/` artifacts stay untracked and are never committed.

## Risks

- **Live-DB collisions:** mitigated by unique tagging + per-spec cleanup; no shared mutable
  fixtures.
- **Wall-clock in CI:** the full suite is larger; mitigated by Playwright workers/sharding if
  needed, and `webServer.timeout` already raised to 120s.
- **Prisma client in tests:** instantiate a fresh client in `e2e/fixtures.ts` to avoid importing
  server-only app code.

## Related

- `e2e/portal-cookie.ts` (forged applicant session) — the `.env` fallback pattern `fixtures.ts`
  reuses.
- Memory: `e2e-not-in-ci-portal-gate`, `local-db-neon-hazard`, `vitest-test-db-isolation`.
