# Comprehensive e2e Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the Playwright `e2e/` suite to comprehensive, layered coverage (smoke + RBAC on every page, one deep journey per critical flow) and run the whole suite in CI.

**Architecture:** Shared infra first - one `devLogin` helper (`e2e/auth.ts`) and a Prisma-backed fixtures module (`e2e/fixtures.ts`) that creates per-spec, uniquely-tagged, self-cleaning data the seed does not provide. Existing failing specs are then unblocked with fixtures; new smoke + journey specs are added; finally CI runs the entire directory.

**Tech Stack:** Playwright (`@playwright/test`), Next.js 16 dev server on :3100, Prisma (`@prisma/client`), PostgreSQL.

## Global Constraints

- **No em-dashes** in any prose, comment, or string. Use other punctuation.
- **Product name** is "HAVEN Hub" (two words) in UI/prose; identifiers stay `havenhub`.
- **Never run** `prisma migrate`, `vitest`, or `db:seed` against the repo `.env` DATABASE_URL outside CI (it points at shared Neon prod). Local e2e runs use the worktree-local `.env` pointed at local Postgres (`localhost:5434`).
- **No `resetDb` in e2e** - the dev server holds the live connection. Every fixture creates uniquely-tagged rows and removes exactly what it created.
- **Playwright config does NOT auto-load `.env`** - helpers read secrets/URLs from `process.env` with a `.env` fallback (mirror `e2e/portal-cookie.ts`).
- **Seeded identities:** `j.carney@yale.edu` (Platform Admin + ITCM director + Compliance/Vol-Ops manager on EXEC/SRR/ITCM), `dev.director@yale.edu` (VADM director), `dev.volunteer@yale.edu` (VADM volunteer). Active term `SU26`.
- Dev login is email-only (`button:has-text("Dev sign in")`) and lands on `/`.
- `/apply/[slug]` requires a forged `applicant_session` cookie (`e2e/portal-cookie.ts`).
- **Branch:** `test/comprehensive-e2e` (based on `test/e2e-in-ci`). Delivery is a single PR.
- `testsprite_tests/` is untracked and must never be `git add`ed.

---

### Task 1: Shared infra - `e2e/auth.ts` + `e2e/fixtures.ts`

**Files:**
- Create: `e2e/auth.ts`
- Create: `e2e/fixtures.ts`
- Create: `e2e/_infra.spec.ts` (temporary smoke validation; deleted in final step)

**Interfaces:**
- Produces (`e2e/auth.ts`):
  - `type Role = "admin" | "director" | "volunteer"`
  - `devLogin(page: Page, email: string): Promise<void>`
  - `loginAs(page: Page, role: Role): Promise<void>`
- Produces (`e2e/fixtures.ts`):
  - `prisma: PrismaClient` (singleton, e2e-only)
  - `cleanupPerson(personId: string): Promise<void>`
  - `seedComplianceMember(deptCode: string, opts?: { status?: "COMPLIANT" | "EXPIRING_SOON" | "EXPIRED" | "DATE_UNKNOWN"; kind?: "VOLUNTEER" | "DIRECTOR" }): Promise<{ person: { id: string; name: string }; cleanup: () => Promise<void> }>`
  - `seedNotification(personId: string, opts?: { type?: string; title?: string; body?: string; link?: string }): Promise<{ id: string; cleanup: () => Promise<void> }>`
  - `seedCourseWithPackage(opts?: { title?: string; assignToAll?: boolean }): Promise<{ course: { id: string; title: string }; cleanup: () => Promise<void> }>`
  - `seedRhdAttending(opts?: { scheduleName?: string; fullName?: string }): Promise<{ attending: { id: string }; cleanup: () => Promise<void> }>`
  - `tag(): string`

- [ ] **Step 1: Write `e2e/auth.ts`**

```ts
import type { Page } from "@playwright/test";

const ROLE_EMAILS = {
  admin: "j.carney@yale.edu",
  director: "dev.director@yale.edu",
  volunteer: "dev.volunteer@yale.edu",
} as const;

export type Role = keyof typeof ROLE_EMAILS;

/** Email-only dev login. Lands on the hub root. */
export async function devLogin(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.fill('input[name="email"]', email);
  await page.click('button:has-text("Dev sign in")');
  await page.waitForURL((url) => url.pathname === "/");
}

/** Convenience: log in as one of the three seeded identities. */
export function loginAs(page: Page, role: Role): Promise<void> {
  return devLogin(page, ROLE_EMAILS[role]);
}
```

- [ ] **Step 2: Write `e2e/fixtures.ts`**

```ts
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";

/** Playwright does not auto-load .env; read DATABASE_URL from env with a .env fallback. */
function databaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const env = readFileSync(".env", "utf8");
  const m = env.match(/^DATABASE_URL=['"]?([^'"\n]+)/m);
  if (!m) throw new Error("DATABASE_URL not found in process.env or .env");
  return m[1];
}

/** e2e-only client; NOT the app's server-only singleton. */
export const prisma = new PrismaClient({
  datasources: { db: { url: databaseUrl() } },
});

const DAY = 24 * 60 * 60 * 1000;
const daysFromNow = (n: number) => new Date(Date.now() + n * DAY);

/** Unique, greppable suffix so live-DB rows never collide. */
export function tag(): string {
  return `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

async function activeTerm() {
  return prisma.term.findFirstOrThrow({ where: { status: "ACTIVE" } });
}
async function dept(code: string) {
  return prisma.department.findUniqueOrThrow({ where: { code } });
}

/** Remove a person and every row that references it (run before the person delete). */
export async function cleanupPerson(personId: string): Promise<void> {
  await prisma.hipaaCertificate.deleteMany({ where: { personId } });
  await prisma.notification.deleteMany({ where: { personId } });
  await prisma.termMembership.deleteMany({ where: { personId } });
  await prisma.person.delete({ where: { id: personId } }).catch(() => {});
}

export async function seedComplianceMember(
  deptCode: string,
  opts: {
    status?: "COMPLIANT" | "EXPIRING_SOON" | "EXPIRED" | "DATE_UNKNOWN";
    kind?: "VOLUNTEER" | "DIRECTOR";
  } = {}
) {
  const status = opts.status ?? "COMPLIANT";
  const kind = opts.kind ?? "VOLUNTEER";
  const term = await activeTerm();
  const department = await dept(deptCode);
  const t = tag();
  const person = await prisma.person.create({
    data: { name: `E2E Member ${t}`, contactEmail: `${t}@example.test` },
  });
  await prisma.termMembership.create({
    data: { personId: person.id, termId: term.id, departmentId: department.id, kind, status: "ACTIVE" },
  });
  // Cert validity is completionDate + 365d. Offsets chosen to land in each status bucket.
  // Final offsets are tuned during the task against src/modules/volunteers/services/compliance.ts.
  const completion: Record<string, Date | null> = {
    COMPLIANT: daysFromNow(-10),
    EXPIRING_SOON: daysFromNow(-340),
    EXPIRED: daysFromNow(-400),
    DATE_UNKNOWN: null,
  };
  await prisma.hipaaCertificate.create({
    data: {
      personId: person.id,
      fileName: "e2e.pdf",
      storedName: `${t}.pdf`,
      size: 100,
      mimeType: "application/pdf",
      completionDate: completion[status],
      verifiedAt: new Date(), // verified so the status actually gates
    },
  });
  return { person, cleanup: () => cleanupPerson(person.id) };
}

export async function seedNotification(
  personId: string,
  opts: { type?: string; title?: string; body?: string; link?: string } = {}
) {
  const t = tag();
  const row = await prisma.notification.create({
    data: {
      personId,
      type: opts.type ?? "e2e",
      title: opts.title ?? `E2E notice ${t}`,
      body: opts.body ?? "An end-to-end test notification.",
      link: opts.link ?? null,
    },
  });
  return {
    id: row.id,
    cleanup: () => prisma.notification.delete({ where: { id: row.id } }).then(() => {}).catch(() => {}),
  };
}

export async function seedCourseWithPackage(
  opts: { title?: string; assignToAll?: boolean } = {}
) {
  const t = tag();
  const course = await prisma.course.create({
    data: {
      title: opts.title ?? `E2E Course ${t}`,
      isActive: true,
      assignToAll: opts.assignToAll ?? true,
      // Marks the course as having an ingested package so it is assignable/openable.
      scormEntryHref: "index.html",
      scormVersion: "1.2",
      scormUploadedAt: new Date(),
    },
  });
  return {
    course,
    cleanup: () =>
      prisma.course.delete({ where: { id: course.id } }).then(() => {}).catch(() => {}),
  };
}

export async function seedRhdAttending(
  opts: { scheduleName?: string; fullName?: string } = {}
) {
  const t = tag();
  const attending = await prisma.rhdAttending.create({
    data: {
      scheduleName: opts.scheduleName ?? `E2E Attending ${t}`,
      fullName: opts.fullName ?? `E2E Attending ${t}`,
      isActive: true,
    },
  });
  return {
    attending,
    cleanup: () =>
      prisma.rhdAttending.delete({ where: { id: attending.id } }).then(() => {}).catch(() => {}),
  };
}
```

- [ ] **Step 3: Write `e2e/_infra.spec.ts` (validates infra against the running app + DB)**

```ts
import { expect, test } from "@playwright/test";
import { loginAs } from "./auth";
import { seedComplianceMember } from "./fixtures";

test("infra: admin login + fixture create/cleanup round trip", async ({ page }) => {
  await loginAs(page, "admin");
  await expect(page).toHaveURL((url) => url.pathname === "/");

  const member = await seedComplianceMember("ITCM");
  expect(member.person.id).toBeTruthy();
  await member.cleanup();
});
```

- [ ] **Step 4: Run it (expect PASS - proves login, the e2e Prisma client, and cleanup all work)**

Run: `npx playwright test e2e/_infra.spec.ts`
Expected: 1 passed. If the fixture import fails on a missing model field, reconcile against `prisma/schema.prisma` before continuing - every later task depends on `fixtures.ts`.

- [ ] **Step 5: Commit**

```bash
git add e2e/auth.ts e2e/fixtures.ts e2e/_infra.spec.ts
git commit -m "test(e2e): shared auth + Prisma fixtures infra"
```

---

### Task 2: Unblock `e2e/volunteers.spec.ts`

The compliance/offboarding/epic/disciplinary tests fail because the seed has no ITCM members with certs. Provide them via `seedComplianceMember`, then act on the seeded member.

**Files:**
- Modify: `e2e/volunteers.spec.ts`
- Test: same file (it IS the test)

**Interfaces:**
- Consumes: `loginAs` (auth.ts), `seedComplianceMember`, `cleanupPerson` (fixtures.ts).

- [ ] **Step 1: Add fixtures + swap to the shared login**

Replace the file-local `devLogin` with an import from `./auth`. Add a managed ITCM member that exists for the data-dependent tests:

```ts
import { expect, test } from "@playwright/test";
import { devLogin } from "./auth";
import { seedComplianceMember } from "./fixtures";

let member: Awaited<ReturnType<typeof seedComplianceMember>>;

test.beforeEach(async () => {
  // An ITCM member with a verified cert so the compliance page renders a status badge
  // and the offboarding executor table has a flag-able row.
  member = await seedComplianceMember("ITCM", { status: "COMPLIANT" });
});

test.afterEach(async () => {
  await member.cleanup();
});
```

Keep the existing `confirmButtonClick` helper.

- [ ] **Step 2: Point the data-dependent tests at the seeded member**

For "Jack sees at least one status Badge" the `beforeEach` is sufficient (a badge now exists). For the offboarding round-trip, scope the row by `member.person.name` instead of an arbitrary member:

```ts
const row = page.locator("tr", { hasText: member.person.name });
await confirmButtonClick(row, "Flag");
// ...assert the executor table reflects the flag, then unflag to restore
await confirmButtonClick(row, "Unflag");
```

The epic and disciplinary round-trips already create their own state on `dev.volunteer`; if they fail only on a missing roster row, re-target them at `member.person.name` the same way.

- [ ] **Step 3: Run the spec, fix selectors against the running app until green**

Run: `npx playwright test e2e/volunteers.spec.ts`
Expected: all tests pass. Iterate on any selector drift (headings, button labels) by reading the rendered DOM via `--debug` or `page.pause()`; do not change app code.

- [ ] **Step 4: Commit**

```bash
git add e2e/volunteers.spec.ts
git commit -m "test(e2e): unblock volunteers spec with compliance fixtures"
```

---

### Task 3: Unblock `e2e/schedule.spec.ts`

The capacity/RHD-readiness/attendings tests fail because no department has capacity config and no RHD attending exists.

**Files:**
- Modify: `e2e/schedule.spec.ts`

**Interfaces:**
- Consumes: `devLogin` (auth.ts), `seedRhdAttending` (fixtures.ts).

- [ ] **Step 1: Swap to shared login; seed an RHD attending for the readiness/attendings tests**

```ts
import { devLogin } from "./auth";
import { seedRhdAttending } from "./fixtures";

let attending: Awaited<ReturnType<typeof seedRhdAttending>>;
test.beforeEach(async () => {
  attending = await seedRhdAttending();
});
test.afterEach(async () => {
  await attending.cleanup();
});
```

- [ ] **Step 2: Resolve the capacity-gating test against the real config source**

The capacity panel renders only for departments whose quota (`{ idealHeadcount, patientCapacityPerProvider }`) is configured. Determine where that quota is stored:

Run: `grep -rniE "idealHeadcount|patientCapacityPerProvider" src/modules/schedule src/platform`
Then either (a) seed the quota via a new `seedCapacityConfig(deptCode, quota)` builder added to `fixtures.ts` if it is a DB row, or (b) if it is a configurable setting, assert the test against a department that already has capacity config in the seed. Encode whichever the grep proves. Add the builder to `fixtures.ts` (and its `Produces` interface) if needed.

- [ ] **Step 3: Run the spec, fix selectors until green**

Run: `npx playwright test e2e/schedule.spec.ts`
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add e2e/schedule.spec.ts e2e/fixtures.ts
git commit -m "test(e2e): unblock schedule spec with RHD + capacity fixtures"
```

---

### Task 4: Unblock the remaining Phase 1 specs (`admin`, `my-info`, `login`, `theme`, `recruitment-training`)

These are smaller. Most failures are the duplicated `devLogin` plus minor data/selector drift.

**Files:**
- Modify: `e2e/admin.spec.ts`, `e2e/my-info.spec.ts`, `e2e/login.spec.ts`, `e2e/theme.spec.ts`, `e2e/recruitment-training.spec.ts`

**Interfaces:**
- Consumes: `devLogin`/`loginAs` (auth.ts); `seedComplianceMember` where a roster row is needed.

- [ ] **Step 1: Swap every file-local `devLogin` for `import { devLogin } from "./auth"`**

Delete the per-file copies. No behavior change intended by this step alone.

- [ ] **Step 2: Run each spec; fix the specific failure per file**

Run each and address the concrete failure:

```bash
npx playwright test e2e/admin.spec.ts
npx playwright test e2e/my-info.spec.ts
npx playwright test e2e/login.spec.ts
npx playwright test e2e/theme.spec.ts
npx playwright test e2e/recruitment-training.spec.ts
```

Likely fixes: `admin` email/people tables may need a row (use `seedComplianceMember` so a person exists in a managed dept); `recruitment-training` may carry the same `TypePicker`/quiz-builder drift already fixed in the other recruitment specs (drive the quiz builder via `getByRole("button", { name: /Add/ })` then the menu item, matching `recruitment.spec.ts`). `login`/`theme` are likely just the `devLogin` swap.

- [ ] **Step 3: Commit (one commit, all five files)**

```bash
git add e2e/admin.spec.ts e2e/my-info.spec.ts e2e/login.spec.ts e2e/theme.spec.ts e2e/recruitment-training.spec.ts e2e/fixtures.ts
git commit -m "test(e2e): unblock remaining Phase 1 specs on shared auth + fixtures"
```

- [ ] **Step 4: Verify the whole existing suite is green**

Run: `npx playwright test --grep-invert "_infra"`
Expected: 0 failures across all pre-existing specs. (The `_infra` spec is removed in the final task.)

---

### Task 5: Breadth - `e2e/smoke.spec.ts` route + RBAC matrix

One data-driven spec hitting every `(app)` page: loads for the allowed role, is denied for the wrong one.

**Files:**
- Create: `e2e/smoke.spec.ts`

**Interfaces:**
- Consumes: `loginAs` (auth.ts).

- [ ] **Step 1: Determine allowed/denied role per route**

For each route below, read its guard to set `allowed`/`denied`:

Run: `grep -rnE "requirePermission|requirePersonSession|EXEMPT|no-access" src/app/\(app\)`
Routes to cover (from the route inventory): `/`, `/admin`, `/admin/people`, `/admin/roles`, `/admin/terms`, `/admin/departments`, `/admin/subcommittees`, `/admin/audit`, `/admin/settings`, `/admin/email`, `/admin/email/campaigns`, `/admin/email/templates`, `/admin/itcm`, `/admin/notifications`, `/clinic`, `/clinic/avs`, `/learning`, `/learning/dashboard`, `/learning/manage`, `/my-info`, `/notifications`, `/recruitment`, `/schedule`, `/schedule/full`, `/schedule/attendings`, `/training`, `/volunteers`, `/volunteers/master`, `/volunteers/offboarding`, `/volunteers/epic`, `/volunteers/disciplinary`, `/volunteers/spanish-review`.

- [ ] **Step 2: Write the matrix spec**

```ts
import { expect, test } from "@playwright/test";
import { loginAs, type Role } from "./auth";

type RouteCase = { path: string; allowed: Role; deniedHeading?: RegExp; denied?: Role };

// allowed = a role that should see the page; denied = a role that should be bounced.
const ROUTES: RouteCase[] = [
  { path: "/admin", allowed: "admin", denied: "volunteer" },
  { path: "/volunteers", allowed: "admin", denied: "volunteer" },
  { path: "/clinic/avs", allowed: "admin" },
  { path: "/my-info", allowed: "volunteer" },
  // ...one row per route from Step 1
];

for (const r of ROUTES) {
  test(`smoke: ${r.path} loads for ${r.allowed}`, async ({ page }) => {
    await loginAs(page, r.allowed);
    const resp = await page.goto(r.path);
    expect(resp?.status(), `${r.path} HTTP status`).toBeLessThan(400);
    await expect(page).toHaveURL((url) => url.pathname === r.path);
    // No Next error boundary rendered.
    await expect(page.getByText(/Application error|Unhandled Runtime Error/i)).toHaveCount(0);
  });

  if (r.denied) {
    test(`smoke: ${r.path} denies ${r.denied}`, async ({ page }) => {
      await loginAs(page, r.denied!);
      await page.goto(r.path);
      // Guard either redirects to the hub or lands on /no-access.
      await expect(page).toHaveURL((url) => url.pathname === "/" || url.pathname === "/no-access");
    });
  }
}
```

- [ ] **Step 3: Run; correct any allowed/denied mismatch against the actual guard**

Run: `npx playwright test e2e/smoke.spec.ts`
Expected: all pass. A failure means the assumed role was wrong - fix the `ROUTES` row to match the guard, not the app.

- [ ] **Step 4: Commit**

```bash
git add e2e/smoke.spec.ts
git commit -m "test(e2e): route + RBAC smoke matrix over every app page"
```

---

### Task 6: Journey - clinic/AVS PDF generation

**Files:**
- Create: `e2e/clinic-avs.spec.ts`

**Interfaces:**
- Consumes: `loginAs` (auth.ts).

- [ ] **Step 1: Inspect the AVS form fields/buttons**

Run: `grep -rnE "name=\"|Download|Generate|button|español|Spanish" src/modules/clinic src/app/\(app\)/clinic/avs`
Note the required input names and the generate/download control (the PDF is client-side via `@react-pdf/renderer`).

- [ ] **Step 2: Write the journey (assert the download fires for EN and ES)**

```ts
import { expect, test } from "@playwright/test";
import { loginAs } from "./auth";

test("clinic AVS: fill form and download the summary (EN + ES)", async ({ page }) => {
  await loginAs(page, "admin");
  await page.goto("/clinic/avs");
  // Fill the minimum required fields discovered in Step 1, e.g.:
  // await page.fill('input[name="patientName"]', "Test Patient");
  const downloadEN = page.waitForEvent("download");
  await page.getByRole("button", { name: /download|generate/i }).first().click();
  expect((await downloadEN).suggestedFilename()).toMatch(/\.pdf$/i);
  // Switch to Spanish (toggle/select discovered in Step 1) and download again.
});
```

- [ ] **Step 3: Run; fill in exact field names/labels until green**

Run: `npx playwright test e2e/clinic-avs.spec.ts`
Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add e2e/clinic-avs.spec.ts
git commit -m "test(e2e): clinic AVS generate + download journey"
```

---

### Task 7: Journey - learning course completion

**Files:**
- Create: `e2e/learning.spec.ts`

**Interfaces:**
- Consumes: `loginAs` (auth.ts), `seedCourseWithPackage` (fixtures.ts).

- [ ] **Step 1: Write the journey**

The SCORM iframe runtime cannot be driven headlessly, so assert the catalog/dashboard surface around a fixture-ingested course, then mark completion at the DB/progress layer the app exposes.

```ts
import { expect, test } from "@playwright/test";
import { loginAs } from "./auth";
import { seedCourseWithPackage } from "./fixtures";

let course: Awaited<ReturnType<typeof seedCourseWithPackage>>;
test.beforeEach(async () => { course = await seedCourseWithPackage({ assignToAll: true }); });
test.afterEach(async () => { await course.cleanup(); });

test("learning: assigned course appears in the catalog and is openable", async ({ page }) => {
  await loginAs(page, "admin");
  await page.goto("/learning");
  await expect(page.getByText(course.course.title)).toBeVisible();
  await page.getByRole("link", { name: course.course.title }).click();
  await expect(page).toHaveURL((url) => url.pathname.includes("/learning/"));
  // Assert the SCORM iframe host or launch control is present.
  await expect(page.locator("iframe, [data-scorm]")).toBeVisible();
});
```

- [ ] **Step 2: Add a manage-side assertion**

```ts
test("learning manage: course shows in the management list", async ({ page }) => {
  await loginAs(page, "admin");
  await page.goto("/learning/manage");
  await expect(page.getByText(course.course.title)).toBeVisible();
});
```

- [ ] **Step 3: Run; adjust selectors until green**

Run: `npx playwright test e2e/learning.spec.ts`
Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add e2e/learning.spec.ts
git commit -m "test(e2e): learning catalog + manage journey"
```

---

### Task 8: Journey - notifications inbox

**Files:**
- Create: `e2e/notifications.spec.ts`

**Interfaces:**
- Consumes: `loginAs` (auth.ts), `seedNotification` (fixtures.ts), `prisma` (to resolve the admin person id).

- [ ] **Step 1: Write the journey**

```ts
import { expect, test } from "@playwright/test";
import { loginAs } from "./auth";
import { prisma, seedNotification } from "./fixtures";

test("notifications: bell badge + inbox row, then mark read", async ({ page }) => {
  const admin = await prisma.person.findUniqueOrThrow({
    where: { contactEmail: "j.carney@yale.edu" },
  });
  const notif = await seedNotification(admin.id, { title: "E2E unread" });
  try {
    await loginAs(page, "admin");
    await page.goto("/notifications");
    await expect(page.getByText("E2E unread")).toBeVisible();
    // Mark read via the row control discovered against the page, then assert it clears.
    await page.getByRole("button", { name: /mark.*read|read/i }).first().click();
    await expect(page.getByText(/no (unread|new) notifications/i)).toBeVisible();
  } finally {
    await notif.cleanup();
  }
});
```

- [ ] **Step 2: Run; adjust the mark-read selector until green**

Run: `npx playwright test e2e/notifications.spec.ts`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add e2e/notifications.spec.ts
git commit -m "test(e2e): notifications inbox + mark-read journey"
```

---

### Task 9: Journey - admin email campaign

**Files:**
- Create: `e2e/email-campaigns.spec.ts`

**Interfaces:**
- Consumes: `loginAs` (auth.ts).

- [ ] **Step 1: Inspect the campaign create flow**

Run: `grep -rnE "name=\"|audience|condition|Test send|Preview|Create campaign|button" src/app/\(app\)/admin/email/campaigns src/modules/admin`
Note the create form fields, the audience-condition control, and the preview/test-send button (test sends use sample "Sam").

- [ ] **Step 2: Write the journey**

```ts
import { expect, test } from "@playwright/test";
import { loginAs } from "./auth";

test("admin email: create a campaign with an audience condition and preview", async ({ page }) => {
  await loginAs(page, "admin");
  await page.goto("/admin/email/campaigns/new");
  await page.fill('input[name="name"]', `E2E Campaign ${Date.now()}`);
  // Set subject/body and one audience condition using the controls from Step 1.
  // Trigger the preview / test-send to sample "Sam" and assert the rendered preview is non-empty.
  await page.getByRole("button", { name: /preview|test send/i }).first().click();
  await expect(page.getByText(/Sam/)).toBeVisible();
});
```

- [ ] **Step 3: Run; fill exact fields until green**

Run: `npx playwright test e2e/email-campaigns.spec.ts`
Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add e2e/email-campaigns.spec.ts
git commit -m "test(e2e): admin email campaign create + preview journey"
```

---

### Task 10: Journey - get-started onboarding gate

**Files:**
- Create: `e2e/get-started.spec.ts`

**Interfaces:**
- Consumes: `devLogin` (auth.ts), `prisma` + a new fixture for an un-cleared person.

- [ ] **Step 1: Add `seedUnclearedVolunteer()` to `e2e/fixtures.ts`**

Create a person with an ACTIVE membership but no profile/HIPAA/training/learning clearance and a `@yale.edu` `contactEmail` (so dev login resolves them). Return `{ person, cleanup }`. Add it to the `fixtures.ts` `Produces` interface.

```ts
export async function seedUnclearedVolunteer() {
  const t = tag();
  const term = await activeTerm();
  const department = await dept("VADM");
  const person = await prisma.person.create({
    data: { name: `E2E Uncleared ${t}`, contactEmail: `uncleared-${t}@yale.edu` },
  });
  await prisma.termMembership.create({
    data: { personId: person.id, termId: term.id, departmentId: department.id, kind: "VOLUNTEER", status: "ACTIVE" },
  });
  return { person, cleanup: () => cleanupPerson(person.id) };
}
```

- [ ] **Step 2: Write the gate journey**

```ts
import { expect, test } from "@playwright/test";
import { devLogin } from "./auth";
import { seedUnclearedVolunteer } from "./fixtures";

test("get-started gate: an uncleared volunteer is held at /get-started", async ({ page }) => {
  const v = await seedUnclearedVolunteer();
  try {
    await page.goto("/login");
    await page.fill('input[name="email"]', v.person.contactEmail ?? "");
    await page.click('button:has-text("Dev sign in")');
    // Gate redirects an uncleared person away from the hub to /get-started.
    await page.waitForURL((url) => url.pathname.startsWith("/get-started"));
    await expect(page.getByRole("heading")).toBeVisible();
  } finally {
    await v.cleanup();
  }
});
```

Note: this test does not use `devLogin` (which asserts a landing on `/`); it logs in inline because the expected landing is `/get-started`.

- [ ] **Step 3: Run until green**

Run: `npx playwright test e2e/get-started.spec.ts`
Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add e2e/get-started.spec.ts e2e/fixtures.ts
git commit -m "test(e2e): onboarding gate holds an uncleared volunteer"
```

---

### Task 11: CI runs the whole suite + open the PR

**Files:**
- Modify: `.github/workflows/ci.yml`
- Delete: `e2e/_infra.spec.ts`

- [ ] **Step 1: Remove the temporary infra spec**

```bash
git rm e2e/_infra.spec.ts
```

- [ ] **Step 2: Replace the scoped spec list in the `e2e` job with the whole directory**

In `.github/workflows/ci.yml`, change the scoped run step to run the entire suite:

```yaml
      # Run the full e2e suite. Specs self-seed via the UI or e2e/fixtures.ts
      # (per-spec create-and-cleanup), so no extra fixtures step is needed.
      - run: npx playwright test
```

Update the comment block above it to drop the "scoped to four recruitment specs" note. Keep the postgres service, `migrate deploy`, `db:seed`, chromium install, `AUTH_SECRET`, and the `test-results/` artifact-on-failure.

- [ ] **Step 3: Run the full suite locally against a fresh seed**

```bash
npx playwright test
```
Expected: 0 failures. This mirrors what CI will do.

- [ ] **Step 4: Validate the workflow YAML**

Run: `ruby -ryaml -e 'YAML.load_file(".github/workflows/ci.yml"); puts "ok"'`
Expected: `ok`.

- [ ] **Step 5: Commit, push, open the PR**

```bash
git add .github/workflows/ci.yml
git commit -m "ci(e2e): run the full Playwright suite"
git push -u origin test/comprehensive-e2e
gh pr create --base test/e2e-in-ci --title "test(e2e): comprehensive coverage + full suite in CI" \
  --body "Adds shared e2e auth + Prisma fixtures, unblocks the previously-failing specs, adds a route/RBAC smoke matrix and key-journey specs (AVS, learning, notifications, email campaigns, onboarding gate), and runs the whole suite in CI. Stacked on #156; retarget to main once the e2e stack merges."
```

- [ ] **Step 6: Confirm CI is green on the PR**

Run: `gh pr checks --watch`
Expected: the `checks` and `e2e` jobs pass.

---

## Notes for the implementer

- **e2e TDD loop:** for each spec, write it, run it, read the actual rendered DOM for the failing selector (`page.pause()` / `--debug` / the `test-results/` trace), fix the selector, rerun. Never edit app code to make a test pass; if a test reveals a real app bug, stop and surface it.
- **Live DB:** every fixture row is uniquely tagged and cleaned up. If a run is interrupted, orphan rows are greppable by the `e2e-` prefix in `name`/`title`/`contactEmail` and safe to delete.
- **Local DB only:** confirm the worktree `.env` points DATABASE_URL at `localhost:5434` before running; never against Neon.
