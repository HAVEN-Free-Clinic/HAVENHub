# Member Magic-Link Login (non-Yale members) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an already-active member whose contact email is not `@yale.edu` sign in to the HAVEN Hub via a one-time emailed link, receiving a real `personId` NextAuth session identical to Yale SSO.

**Architecture:** A new unconditional NextAuth credentials provider `member-magic-link` whose `authorize` verifies and atomically consumes a hashed single-use token, then returns the resolved active Person. A new `MemberLoginToken` table and a `src/platform/auth/member-magic-link.ts` service (mirroring the hardened `portal-auth.ts`) issue/peek/verify tokens. A non-Yale form on `/login` plus a peek-then-confirm `/login/verify` page drive it. `requirePersonSession` and every RBAC gate stay untouched.

**Tech Stack:** Next.js 15 App Router (Server Components + inline server actions), NextAuth/Auth.js v5 (JWT sessions), Prisma + Postgres, Vitest, Playwright, the in-house email template engine + settings registry.

## Global Constraints

- **No em-dashes** in UI copy, code comments, or docs (use commas, colons, or parentheses). Jack reads em-dashes as AI-authored.
- **No `tailwind-merge`.** Follow existing class patterns. Canonical radii: cards `rounded-2xl`, controls `rounded-lg`. Hanken font only.
- **"HAVEN Hub"** is two words in prose/UI; identifiers stay `havenhub`.
- **The `member-magic-link` provider is registered UNCONDITIONALLY** (a plain array element, not behind the `NODE_ENV`/`DEMO_MODE` gate) so it works in production.
- **Token security is fixed:** 256-bit random token (`randomBytes(32).toString("base64url")`), only its SHA-256 hex hash stored, single-use via atomic `updateMany` claim (`count === 1`), 30-minute TTL, rate limit 3 per 15 minutes per email.
- **Enumeration-safe:** `requestMemberLoginLink` returns the same `"sent"` result for a match, a non-match, and a rate-limited request. Never reveal whether an email maps to an active member. The only distinct result is `"use-yale"` for `@yale.edu` addresses (the domain is public and reveals nothing about membership).
- **Email link base = the `app.baseUrl` setting** (`getSetting<string>("app.baseUrl")`), NOT `PORTAL_BASE_URL`/`pickPortalEmailBase` (those are apply-portal specific). Never derive the base from the request Host header.
- **Prisma migrations:** hand-name the migration dir with a UTC timestamp prefix `YYYYMMDDHHMMSS_name`. Run `prisma migrate dev` ONLY against the throwaway local Postgres (`postgresql://haven:haven_dev@localhost:5434/havenhub_test_mml`), NEVER Neon. The repo `.env` points every DB url (including `TEST_DATABASE_URL`) at shared Neon.
- **Vitest ignores `.env`.** Run DB-backed tests with an explicit per-worktree `TEST_DATABASE_URL` (e.g. `postgresql://haven:haven_dev@localhost:5434/havenhub_test_mml`) to avoid the shared-DB deadlock. Apply migrations to it with `prisma migrate deploy` first.
- **Before pushing, run the whole-repo `npm run lint`** (the pre-push and CI checks job lint the entire repo; typecheck + tests miss the eslint boundary).

---

### Task 1: `MemberLoginToken` model, migration, and test-DB truncation

**Files:**
- Modify: `prisma/schema.prisma` (append model at end of file, after `ApplicantPortalToken` ~L1684)
- Create: `prisma/migrations/20260716120000_add_member_login_token/migration.sql`
- Modify: `src/platform/test/db.ts` (add `"MemberLoginToken"` to the TRUNCATE list)

**Interfaces:**
- Produces: Prisma model `MemberLoginToken` with fields `id, emailLower, personId, tokenHash (@unique), expiresAt, usedAt?, createdAt`, accessed as `prisma.memberLoginToken`.

- [ ] **Step 1: Add the Prisma model.** Append to `prisma/schema.prisma` (immediately after the `ApplicantPortalToken` model):

```prisma
/// Single-use, hashed, expiring magic-link token for MEMBER hub login
/// (active members whose contactEmail is not a Yale address). Only the SHA-256
/// hash is stored; the raw token lives only in the emailed link. Bound to the
/// Person resolved at issue time; verify re-checks the member is still active.
model MemberLoginToken {
  id         String    @id @default(cuid())
  emailLower String
  personId   String
  tokenHash  String    @unique
  expiresAt  DateTime
  usedAt     DateTime?
  createdAt  DateTime  @default(now())

  @@index([emailLower])
  @@index([personId])
}
```

- [ ] **Step 2: Create the migration SQL** at `prisma/migrations/20260716120000_add_member_login_token/migration.sql` (use the current UTC timestamp for the dir name if 20260716120000 is in the past for you):

```sql
-- Single-use hashed magic-link tokens for non-Yale member hub login.
CREATE TABLE "MemberLoginToken" (
    "id" TEXT NOT NULL,
    "emailLower" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MemberLoginToken_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MemberLoginToken_tokenHash_key" ON "MemberLoginToken"("tokenHash");
CREATE INDEX "MemberLoginToken_emailLower_idx" ON "MemberLoginToken"("emailLower");
CREATE INDEX "MemberLoginToken_personId_idx" ON "MemberLoginToken"("personId");
```

- [ ] **Step 3: Add the table to `resetDb()`'s TRUNCATE list.** In `src/platform/test/db.ts`, find the `TRUNCATE "..." CASCADE` string that already lists `"ApplicantPortalToken"` and add `"MemberLoginToken"` to it (place it next to `"ApplicantPortalToken"`). Without this, the mirrored service tests will not isolate rows between cases.

- [ ] **Step 4: Apply the migration to the local test DB and regenerate this worktree's client.**

Run:
```bash
npx prisma generate
DATABASE_URL='postgresql://haven:haven_dev@localhost:5434/havenhub_test_mml' npx prisma migrate deploy
DATABASE_URL='postgresql://haven:haven_dev@localhost:5434/havenhub_test_mml' npx prisma migrate status
```
Expected: `prisma generate` succeeds (this worktree has its OWN real `node_modules`, so generating does not disturb other worktrees) and now the TS client exposes `prisma.memberLoginToken`. `migrate deploy` applies every migration (baseline through the new one) to the empty per-worktree DB, and `migrate status` reports "Database schema is up to date!". If it reports drift, resolve with `DATABASE_URL='postgresql://haven:haven_dev@localhost:5434/havenhub_test_mml' npx prisma migrate resolve --applied 20260716120000_add_member_login_token` then re-run `migrate deploy` (never `migrate reset`).

- [ ] **Step 5: Verify the table exists.**

Run:
```bash
DATABASE_URL='postgresql://haven:haven_dev@localhost:5434/havenhub_test_mml' npx prisma db execute --stdin <<'SQL'
SELECT to_regclass('"MemberLoginToken"') IS NOT NULL AS exists;
SQL
```
Expected: prints a row with `exists = t` (or the command succeeds with no error).

- [ ] **Step 6: Commit.**

```bash
git add prisma/schema.prisma prisma/migrations/20260716120000_add_member_login_token/migration.sql src/platform/test/db.ts
git commit -m "feat(auth): add MemberLoginToken model + migration"
```

---

### Task 2: Kill-switch setting `auth.memberMagicLinkEnabled`

**Files:**
- Modify: `src/platform/settings/registry.ts` (add one entry to the `SETTINGS` array)
- Test: `src/platform/settings/member-magic-link-setting.test.ts`

**Interfaces:**
- Produces: setting key `"auth.memberMagicLinkEnabled"` (boolean, default `true`), read with `getSetting<boolean>("auth.memberMagicLinkEnabled")`.

- [ ] **Step 1: Write the failing test** at `src/platform/settings/member-magic-link-setting.test.ts`:

```ts
import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { getSetting, setSetting } from "@/platform/settings/service";

beforeEach(async () => {
  await resetDb();
});
afterEach(async () => {
  await resetDb();
});

it("defaults auth.memberMagicLinkEnabled to true and honors an override", async () => {
  expect(await getSetting<boolean>("auth.memberMagicLinkEnabled")).toBe(true);
  await setSetting("auth.memberMagicLinkEnabled", false, null);
  expect(await getSetting<boolean>("auth.memberMagicLinkEnabled")).toBe(false);
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `TEST_DATABASE_URL='postgresql://haven:haven_dev@localhost:5434/havenhub_test_mml' npx vitest run src/platform/settings/member-magic-link-setting.test.ts`
Expected: FAIL (getSetting throws "Unregistered setting key: auth.memberMagicLinkEnabled").

- [ ] **Step 3: Register the setting.** In `src/platform/settings/registry.ts`, add this entry to the `SETTINGS` array (place it after the `app.baseUrl` entry). `z` and `config` are already imported in this file:

```ts
  define<boolean>({
    key: "auth.memberMagicLinkEnabled",
    category: "Operations",
    label: "Member email sign-in links",
    help: "Allow active members whose contact email is not a Yale address to sign in with a one-time link emailed to them. Yale members always use Sign in with Yale.",
    input: { type: "boolean" },
    schema: z.boolean(),
    envDefault: () => true,
    secret: false,
  }),
```

Note: `category: "Operations"` groups it in the auto-rendered `/admin/settings` form. If the registry has no existing "Operations" category and you prefer to reuse one, any existing category string works (categories are derived from the entries); a new heading is also fine.

- [ ] **Step 4: Run the test to verify it passes.**

Run: `TEST_DATABASE_URL='postgresql://haven:haven_dev@localhost:5434/havenhub_test_mml' npx vitest run src/platform/settings/member-magic-link-setting.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/platform/settings/registry.ts src/platform/settings/member-magic-link-setting.test.ts
git commit -m "feat(auth): add auth.memberMagicLinkEnabled kill-switch setting"
```

---

### Task 3: Email template `auth.member_login_link`

**Files:**
- Modify: `src/platform/email/templates/types.ts` (extend `TemplateGroup` union with `"auth"`)
- Create: `src/platform/email/templates/auth.ts` (`authDescriptors`)
- Modify: `src/platform/email/templates/registry.ts` (import + spread `authDescriptors`)
- Modify: `src/platform/email/sender-rules.ts` (add `{ group: "auth", label: "Authentication" }` to `SENDER_CATEGORIES`)
- Test: `src/platform/email/templates/auth-template.test.ts`

**Interfaces:**
- Produces: template key `"auth.member_login_link"` with variables `firstName`, `loginUrl`, renderable via `renderEmail("auth.member_login_link", { firstName, loginUrl })`.

- [ ] **Step 1: Write the failing test** at `src/platform/email/templates/auth-template.test.ts`:

```ts
import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { renderEmail } from "@/platform/email/templates/renderEmail";
import { getDescriptor } from "@/platform/email/templates/registry";

beforeEach(async () => {
  await resetDb();
});
afterEach(async () => {
  await resetDb();
});

it("registers auth.member_login_link with firstName + loginUrl and renders both", async () => {
  const descriptor = getDescriptor("auth.member_login_link");
  expect(descriptor).toBeDefined();
  expect(descriptor?.variables.map((v) => v.name).sort()).toEqual(["firstName", "loginUrl"]);

  const mail = await renderEmail("auth.member_login_link", {
    firstName: "Sam",
    loginUrl: "https://hub.example.org/login/verify?token=abc",
  });
  expect(mail.subject).toContain("sign-in link");
  expect(mail.html).toContain("Sam");
  expect(mail.html).toContain('href="https://hub.example.org/login/verify?token=abc"');
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `TEST_DATABASE_URL='postgresql://haven:haven_dev@localhost:5434/havenhub_test_mml' npx vitest run src/platform/email/templates/auth-template.test.ts`
Expected: FAIL (`getDescriptor` returns undefined; `renderEmail` throws "Unknown email template: auth.member_login_link").

- [ ] **Step 3: Extend the `TemplateGroup` union.** In `src/platform/email/templates/types.ts`, add `"auth"` to the union:

```ts
export type TemplateGroup = "recruitment" | "compliance" | "epic" | "campaign" | "layout" | "support" | "shift" | "incidents" | "auth";
```

- [ ] **Step 4: Create the descriptor file** `src/platform/email/templates/auth.ts`:

```ts
import type { TemplateDescriptor } from "./types";

export const authDescriptors: TemplateDescriptor[] = [
  {
    key: "auth.member_login_link",
    name: "Login link (magic link)",
    category: "transactional",
    group: "auth",
    variables: [
      { name: "firstName", label: "Recipient first name", sampleValue: "Sam" },
      {
        name: "loginUrl",
        label: "Sign-in link URL",
        sampleValue: "https://hub.havenfreeclinic.com/login/verify?token=abc",
      },
    ],
    defaultSubject: "Your HAVEN Hub sign-in link",
    defaultBody:
      '<p>Hi {{ firstName }},</p><p>Use this link to sign in to HAVEN Hub. It expires in 30 minutes and can be used once.</p><p><a href="{{ loginUrl }}">Sign in to HAVEN Hub</a></p><p>If you did not request this, you can ignore this email.</p>',
  },
];
```

- [ ] **Step 5: Register it in the registry.** In `src/platform/email/templates/registry.ts`, add the import next to the other category imports and spread it into the `ALL` array:

```ts
import { authDescriptors } from "./auth";
```
and inside `const ALL: TemplateDescriptor[] = [ ... ]` add:
```ts
  ...authDescriptors,
```

- [ ] **Step 6: Add the sender category.** In `src/platform/email/sender-rules.ts`, add to the `SENDER_CATEGORIES` array:

```ts
  { group: "auth", label: "Authentication" },
```
(This lets admins set a category-level From address and keeps any exhaustive `TemplateGroup` handling complete.)

- [ ] **Step 7: Run the test to verify it passes.**

Run: `TEST_DATABASE_URL='postgresql://haven:haven_dev@localhost:5434/havenhub_test_mml' npx vitest run src/platform/email/templates/auth-template.test.ts`
Expected: PASS.

- [ ] **Step 8: Run the registry test to confirm no regressions.**

Run: `TEST_DATABASE_URL='postgresql://haven:haven_dev@localhost:5434/havenhub_test_mml' npx vitest run src/platform/email/templates/registry.test.ts`
Expected: PASS (unique keys, every descriptor has a group).

- [ ] **Step 9: Commit.**

```bash
git add src/platform/email/templates/types.ts src/platform/email/templates/auth.ts src/platform/email/templates/registry.ts src/platform/email/sender-rules.ts src/platform/email/templates/auth-template.test.ts
git commit -m "feat(auth): add auth.member_login_link email template"
```

---

### Task 4: `safeLoginPath` open-redirect helper

**Files:**
- Create: `src/platform/auth/safe-next.ts`
- Test: `src/platform/auth/safe-next.test.ts`

**Interfaces:**
- Produces: `export function safeLoginPath(raw: string | null | undefined): string` — returns a same-origin slash-rooted path (`pathname + search`) or `"/"`.

- [ ] **Step 1: Write the failing test** at `src/platform/auth/safe-next.test.ts`:

```ts
import { expect, it } from "vitest";
import { safeLoginPath } from "./safe-next";

it("accepts same-origin slash-rooted paths and rejects the rest", () => {
  expect(safeLoginPath("/dashboard")).toBe("/dashboard");
  expect(safeLoginPath("/incidents?tab=open")).toBe("/incidents?tab=open");
  expect(safeLoginPath(null)).toBe("/");
  expect(safeLoginPath("")).toBe("/");
  expect(safeLoginPath("//evil.com")).toBe("/");
  expect(safeLoginPath("/\\evil.com")).toBe("/");
  expect(safeLoginPath("https://evil.com/x")).toBe("/");
  expect(safeLoginPath("javascript:alert(1)")).toBe("/");
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `npx vitest run src/platform/auth/safe-next.test.ts`
Expected: FAIL ("Cannot find module './safe-next'").

- [ ] **Step 3: Implement the helper** at `src/platform/auth/safe-next.ts`:

```ts
import { config } from "@/platform/config";

/**
 * A same-origin, slash-rooted destination or the "/" default. Parsing against
 * APP_BASE_URL with the WHATWG URL API rejects absolute URLs and the
 * protocol-relative / backslash tricks ("//evil.com", "/\evil.com") a naive
 * string check misses. Shared by the login page, the member login-link email,
 * and the member verify page so the redirect can never become an open redirect.
 */
export function safeLoginPath(raw: string | null | undefined): string {
  if (!raw) return "/";
  try {
    const base = new URL(config.APP_BASE_URL);
    const target = new URL(raw, base);
    if (target.origin === base.origin && /^\/[^/\\]/.test(target.pathname)) {
      return target.pathname + target.search;
    }
  } catch {
    // Malformed input: fall through to the default.
  }
  return "/";
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `npx vitest run src/platform/auth/safe-next.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/platform/auth/safe-next.ts src/platform/auth/safe-next.test.ts
git commit -m "feat(auth): add safeLoginPath open-redirect guard for hub logins"
```

---

### Task 5: Token service (`issue` / `peek` / `verify`)

**Files:**
- Create: `src/platform/auth/member-magic-link.ts` (token trio only in this task)
- Test: `src/platform/auth/member-magic-link.test.ts`

**Interfaces:**
- Consumes: `prisma.memberLoginToken` (Task 1).
- Produces:
  - `export async function issueMemberToken(personId: string, email: string): Promise<string>`
  - `export async function peekMemberToken(rawToken: string): Promise<{ email: string; name: string } | null>`
  - `export async function verifyAndConsumeMemberToken(rawToken: string): Promise<{ personId: string } | null>`

- [ ] **Step 1: Write the failing tests** at `src/platform/auth/member-magic-link.test.ts`:

```ts
import { afterEach, beforeEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import {
  issueMemberToken,
  peekMemberToken,
  verifyAndConsumeMemberToken,
} from "./member-magic-link";

beforeEach(async () => {
  await resetDb();
});
afterEach(async () => {
  await resetDb();
});

async function seedMember(overrides: { contactEmail: string; status?: "ACTIVE" | "OFFBOARDED"; name?: string }) {
  return prisma.person.create({
    data: {
      name: overrides.name ?? "Casey Rivera",
      contactEmail: overrides.contactEmail,
      status: overrides.status ?? "ACTIVE",
    },
  });
}

it("issues a token that verifies once to the bound personId (single-use)", async () => {
  const person = await seedMember({ contactEmail: "casey@example.org" });
  const raw = await issueMemberToken(person.id, "casey@example.org");
  expect(await verifyAndConsumeMemberToken(raw)).toEqual({ personId: person.id });
  expect(await verifyAndConsumeMemberToken(raw)).toBeNull(); // single-use
});

it("peek reveals name + email without consuming the token", async () => {
  const person = await seedMember({ contactEmail: "casey@example.org", name: "Casey Rivera" });
  const raw = await issueMemberToken(person.id, "casey@example.org");
  expect(await peekMemberToken(raw)).toEqual({ email: "casey@example.org", name: "Casey Rivera" });
  // Still consumable afterwards:
  expect(await verifyAndConsumeMemberToken(raw)).toEqual({ personId: person.id });
});

it("rejects an expired token", async () => {
  const person = await seedMember({ contactEmail: "casey@example.org" });
  const raw = await issueMemberToken(person.id, "casey@example.org");
  const tokenHash = createHash("sha256").update(raw).digest("hex");
  await prisma.memberLoginToken.update({ where: { tokenHash }, data: { expiresAt: new Date(Date.now() - 1000) } });
  expect(await verifyAndConsumeMemberToken(raw)).toBeNull();
  expect(await peekMemberToken(raw)).toBeNull();
});

it("is single-use under concurrent verification (no TOCTOU)", async () => {
  const person = await seedMember({ contactEmail: "race@example.org" });
  const raw = await issueMemberToken(person.id, "race@example.org");
  const results = await Promise.all([verifyAndConsumeMemberToken(raw), verifyAndConsumeMemberToken(raw)]);
  const won = results.filter((r) => r !== null);
  expect(won).toEqual([{ personId: person.id }]);
});

it("rejects when the member has been offboarded after issue", async () => {
  const person = await seedMember({ contactEmail: "casey@example.org" });
  const raw = await issueMemberToken(person.id, "casey@example.org");
  await prisma.person.update({ where: { id: person.id }, data: { status: "OFFBOARDED" } });
  expect(await verifyAndConsumeMemberToken(raw)).toBeNull();
});

it("rejects when the member's contactEmail changed after issue", async () => {
  const person = await seedMember({ contactEmail: "casey@example.org" });
  const raw = await issueMemberToken(person.id, "casey@example.org");
  await prisma.person.update({ where: { id: person.id }, data: { contactEmail: "new@example.org" } });
  expect(await verifyAndConsumeMemberToken(raw)).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `TEST_DATABASE_URL='postgresql://haven:haven_dev@localhost:5434/havenhub_test_mml' npx vitest run src/platform/auth/member-magic-link.test.ts`
Expected: FAIL ("Cannot find module './member-magic-link'").

- [ ] **Step 3: Implement the token trio** at `src/platform/auth/member-magic-link.ts`:

```ts
import { randomBytes, createHash } from "node:crypto";
import { prisma } from "@/platform/db";

const TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes
const YALE_DOMAIN = "@yale.edu";

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Create a single-use member-login token bound to `personId` and return the
 *  raw token (only its hash is stored). */
export async function issueMemberToken(personId: string, email: string): Promise<string> {
  const emailLower = email.trim().toLowerCase();
  const raw = randomBytes(32).toString("base64url");
  await prisma.memberLoginToken.create({
    data: {
      emailLower,
      personId,
      tokenHash: hashToken(raw),
      expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
    },
  });
  return raw;
}

/** Validate a raw token WITHOUT consuming it. Returns the member's email + name
 *  for the confirm screen, else null. Peek-then-confirm defeats login-CSRF: a
 *  forwarded link shows whose account it signs into before the user commits. */
export async function peekMemberToken(rawToken: string): Promise<{ email: string; name: string } | null> {
  const token = await prisma.memberLoginToken.findFirst({
    where: { tokenHash: hashToken(rawToken), usedAt: null, expiresAt: { gt: new Date() } },
    select: { personId: true, emailLower: true },
  });
  if (!token) return null;
  const person = await prisma.person.findFirst({
    where: { id: token.personId, status: "ACTIVE" },
    select: { name: true, contactEmail: true },
  });
  if (!person?.contactEmail || person.contactEmail.toLowerCase() !== token.emailLower) return null;
  return { email: token.emailLower, name: person.name };
}

/** Atomically claim a raw token (single-use, TOCTOU-safe) and re-check the bound
 *  member is still ACTIVE, non-Yale, and their contactEmail still matches.
 *  Returns { personId } or null. */
export async function verifyAndConsumeMemberToken(rawToken: string): Promise<{ personId: string } | null> {
  const tokenHash = hashToken(rawToken);
  // The WHERE clause matches only an unused, unexpired row; a row-level lock
  // means exactly one concurrent caller flips usedAt, closing the TOCTOU race.
  const claimed = await prisma.memberLoginToken.updateMany({
    where: { tokenHash, usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date() },
  });
  if (claimed.count !== 1) return null;
  const token = await prisma.memberLoginToken.findUnique({
    where: { tokenHash },
    select: { personId: true, emailLower: true },
  });
  if (!token || token.emailLower.endsWith(YALE_DOMAIN)) return null;
  const person = await prisma.person.findFirst({
    where: { id: token.personId, status: "ACTIVE" },
    select: { id: true, contactEmail: true },
  });
  if (!person?.contactEmail || person.contactEmail.toLowerCase() !== token.emailLower) return null;
  return { personId: person.id };
}
```

Note: if a transitive import pulls `next/headers` and Vitest errors on it, add `vi.mock("next/headers", () => ({ headers: vi.fn(async () => ({ get: vi.fn(() => null) })), cookies: vi.fn(async () => ({ get: vi.fn(), set: vi.fn() })) }));` at the top of the test file (as `portal-auth.test.ts` does). This service does not import `next/headers` directly, so the mock is usually unnecessary.

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `TEST_DATABASE_URL='postgresql://haven:haven_dev@localhost:5434/havenhub_test_mml' npx vitest run src/platform/auth/member-magic-link.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit.**

```bash
git add src/platform/auth/member-magic-link.ts src/platform/auth/member-magic-link.test.ts
git commit -m "feat(auth): member-login token issue/peek/verify service"
```

---

### Task 6: `requestMemberLoginLink` (guarded issuer)

**Files:**
- Modify: `src/platform/auth/member-magic-link.ts` (append the issuer + helpers)
- Test: `src/platform/auth/member-magic-link.request.test.ts`

**Interfaces:**
- Consumes: `issueMemberToken` (Task 5), `getSetting` (`@/platform/settings/service`), `renderEmail` (`@/platform/email/templates/renderEmail`), `queueEmail` (`@/platform/email/send`), `safeLoginPath` (Task 4).
- Produces:
  - `export type MemberLinkRequest = "sent" | "use-yale" | "disabled"`
  - `export async function requestMemberLoginLink(email: string, next?: string | null): Promise<MemberLinkRequest>`

- [ ] **Step 1: Write the failing tests** at `src/platform/auth/member-magic-link.request.test.ts`:

```ts
import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { setSetting } from "@/platform/settings/service";
import { requestMemberLoginLink } from "./member-magic-link";

beforeEach(async () => {
  await resetDb();
});
afterEach(async () => {
  await resetDb();
});

async function seedActive(contactEmail: string, name = "Casey Rivera") {
  return prisma.person.create({ data: { name, contactEmail, status: "ACTIVE" } });
}

it("emails an active non-Yale member a /login/verify link addressed to their contactEmail", async () => {
  const person = await seedActive("casey@example.org", "Casey Rivera");
  const result = await requestMemberLoginLink("Casey@Example.org");
  expect(result).toBe("sent");

  const emails = await prisma.emailLog.findMany();
  expect(emails).toHaveLength(1);
  expect(emails[0].toEmail).toBe("casey@example.org");
  expect(emails[0].template).toBe("auth.member_login_link");
  expect(emails[0].personId).toBe(person.id);
  expect(emails[0].html).toContain("/login/verify?token=");
  expect(emails[0].html).toContain("Casey"); // greeted by first name from Person.name
});

it("is a silent no-op for an unknown email (no enumeration)", async () => {
  const result = await requestMemberLoginLink("nobody@example.org");
  expect(result).toBe("sent");
  expect(await prisma.emailLog.count()).toBe(0);
  expect(await prisma.memberLoginToken.count()).toBe(0);
});

it("is a silent no-op for an offboarded member", async () => {
  await prisma.person.create({ data: { name: "Gone", contactEmail: "gone@example.org", status: "OFFBOARDED" } });
  expect(await requestMemberLoginLink("gone@example.org")).toBe("sent");
  expect(await prisma.emailLog.count()).toBe(0);
});

it("refuses a Yale address with use-yale and sends nothing", async () => {
  await seedActive("reed@yale.edu");
  expect(await requestMemberLoginLink("reed@yale.edu")).toBe("use-yale");
  expect(await prisma.emailLog.count()).toBe(0);
  expect(await prisma.memberLoginToken.count()).toBe(0);
});

it("rate-limits to 3 links per 15 minutes per email", async () => {
  await seedActive("casey@example.org");
  await requestMemberLoginLink("casey@example.org");
  await requestMemberLoginLink("casey@example.org");
  await requestMemberLoginLink("casey@example.org");
  await requestMemberLoginLink("casey@example.org");
  expect(await prisma.emailLog.count()).toBeLessThanOrEqual(3);
});

it("returns disabled and sends nothing when the kill-switch is off", async () => {
  await seedActive("casey@example.org");
  await setSetting("auth.memberMagicLinkEnabled", false, null);
  expect(await requestMemberLoginLink("casey@example.org")).toBe("disabled");
  expect(await prisma.emailLog.count()).toBe(0);
});

it("builds the link from the configurable app.baseUrl setting", async () => {
  await seedActive("casey@example.org");
  await setSetting("app.baseUrl", "https://hub.havenfreeclinic.org", null);
  await requestMemberLoginLink("casey@example.org");
  const mail = await prisma.emailLog.findFirstOrThrow({ where: { template: "auth.member_login_link" } });
  expect(mail.html).toContain("https://hub.havenfreeclinic.org/login/verify?token=");
  expect(mail.html).not.toContain("http://localhost:3000/login/verify");
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `TEST_DATABASE_URL='postgresql://haven:haven_dev@localhost:5434/havenhub_test_mml' npx vitest run src/platform/auth/member-magic-link.request.test.ts`
Expected: FAIL (`requestMemberLoginLink` is not exported).

- [ ] **Step 3: Append the issuer.** Add these imports to the top of `src/platform/auth/member-magic-link.ts`:

```ts
import { getSetting } from "@/platform/settings/service";
import { queueEmail } from "@/platform/email/send";
import { renderEmail } from "@/platform/email/templates/renderEmail";
import { safeLoginPath } from "@/platform/auth/safe-next";
```
and append to the bottom of the file:

```ts
const RATE_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RATE_MAX = 3;

function firstNameFromName(name: string): string {
  const first = name.trim().split(/\s+/)[0];
  return first || "there";
}

export type MemberLinkRequest = "sent" | "use-yale" | "disabled";

/** Guarded issuer: honors the kill-switch, refuses Yale addresses, rate-limits,
 *  resolves an ACTIVE Person by contactEmail, and emails a one-time
 *  /login/verify link. Returns "sent" for a match, a non-match, AND a
 *  rate-limited request, so it never reveals whether an email is a member. */
export async function requestMemberLoginLink(email: string, next?: string | null): Promise<MemberLinkRequest> {
  const enabled = await getSetting<boolean>("auth.memberMagicLinkEnabled");
  if (!enabled) return "disabled";

  const emailLower = email.trim().toLowerCase();
  if (emailLower.endsWith(YALE_DOMAIN)) return "use-yale";

  const recent = await prisma.memberLoginToken.count({
    where: { emailLower, createdAt: { gt: new Date(Date.now() - RATE_WINDOW_MS) } },
  });
  if (recent >= RATE_MAX) return "sent";

  const person = await prisma.person.findFirst({
    where: { contactEmail: { equals: emailLower, mode: "insensitive" }, status: "ACTIVE" },
    select: { id: true, name: true, contactEmail: true },
  });
  // Silent no-op: never reveal whether an email maps to an active member.
  if (!person?.contactEmail || person.contactEmail.toLowerCase().endsWith(YALE_DOMAIN)) {
    return "sent";
  }

  const raw = await issueMemberToken(person.id, emailLower);
  const base = await getSetting<string>("app.baseUrl");
  const safeNext = safeLoginPath(next);
  const nextParam = safeNext === "/" ? "" : `&next=${encodeURIComponent(safeNext)}`;
  const loginUrl = `${base}/login/verify?token=${encodeURIComponent(raw)}${nextParam}`;
  const mail = await renderEmail("auth.member_login_link", {
    firstName: firstNameFromName(person.name),
    loginUrl,
  });
  await queueEmail(prisma, {
    to: person.contactEmail,
    subject: mail.subject,
    html: mail.html,
    template: "auth.member_login_link",
    personId: person.id,
  });
  return "sent";
}
```

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `TEST_DATABASE_URL='postgresql://haven:haven_dev@localhost:5434/havenhub_test_mml' npx vitest run src/platform/auth/member-magic-link.request.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit.**

```bash
git add src/platform/auth/member-magic-link.ts src/platform/auth/member-magic-link.request.test.ts
git commit -m "feat(auth): guarded requestMemberLoginLink issuer"
```

---

### Task 7: Wire the `member-magic-link` NextAuth provider

**Files:**
- Modify: `src/platform/auth/auth.ts` (add provider + widen `signIn` guard + add `jwt` branch)

**Interfaces:**
- Consumes: `verifyAndConsumeMemberToken` (Task 5), `recordAudit` (already imported in `auth.ts`).
- Produces: a working `signIn("member-magic-link", { token, redirectTo })` that stamps `token.personId` and records an `auth.member_login` audit event.

- [ ] **Step 1: Add the import.** In `src/platform/auth/auth.ts`, add near the existing `./match-person` import:

```ts
import { verifyAndConsumeMemberToken } from "./member-magic-link";
```

- [ ] **Step 2: Register the provider UNCONDITIONALLY.** In the `providers` array, after the `...(config.NODE_ENV !== "production" || config.DEMO_MODE ? [ ... ] : [])` spread and before the array's closing `],`, add this plain element (not behind any gate):

```ts
    Credentials({
      id: "member-magic-link",
      name: "Member Magic Link",
      credentials: { token: { label: "Token", type: "text" } },
      // Verifies + consumes a single-use member-login token. Security lives
      // entirely here and in the /login/verify peek-then-confirm step, so the
      // provider is safe to register in production.
      async authorize(credentials) {
        const token = credentials?.token as string | undefined;
        if (!token) return null;
        const result = await verifyAndConsumeMemberToken(token);
        if (!result) return null;
        return { id: result.personId };
      },
    }),
```

- [ ] **Step 3: Widen the `signIn` callback guard.** Change the first line of the `signIn` callback from:

```ts
      if (account?.provider === "credentials") return true; // authorize() validated
```
to:
```ts
      if (account?.provider === "credentials" || account?.provider === "member-magic-link") return true; // authorize() validated
```

- [ ] **Step 4: Add the `jwt` personId branch.** In the `jwt` callback, the existing block is:

```ts
        if (account.provider === "credentials" && user) {
          token.personId = user.id;
          personId = user.id ?? null;
        } else {
```
Insert a new `else if` between them so it reads:

```ts
        if (account.provider === "credentials" && user) {
          token.personId = user.id;
          personId = user.id ?? null;
        } else if (account.provider === "member-magic-link" && user) {
          token.personId = user.id;
          personId = user.id ?? null;
          await recordAudit({
            action: "auth.member_login",
            entityType: "Auth",
            actorPersonId: user.id ?? null,
            entityId: user.id ?? null,
          });
        } else {
```

(The shared `if (personId) { ... captureEvent("user_signed_in") ... }` block below is provider-agnostic and fires automatically with `properties.provider === "member-magic-link"`. The session callback already copies `token.personId` onto the session. No change to `next-auth.d.ts` or the route handler.)

- [ ] **Step 5: Typecheck.**

Run: `npx tsc --noEmit`
Expected: no errors (behavioral coverage comes from the e2e in Task 10 and the manual smoke in Task 11; inline NextAuth providers cannot be unit-tested in isolation).

- [ ] **Step 6: Commit.**

```bash
git add src/platform/auth/auth.ts
git commit -m "feat(auth): register member-magic-link provider + jwt personId branch"
```

---

### Task 8: `/login` non-Yale form (server action + client form + page insertion)

**Files:**
- Create: `src/app/login/login-actions.ts`
- Create: `src/app/login/member-sign-in-form.tsx`
- Modify: `src/app/login/page.tsx` (read kill-switch; render the form after the Entra block)

**Interfaces:**
- Consumes: `requestMemberLoginLink` (Task 6), `captureEvent`, `getSetting`.
- Produces: `requestMemberLoginLinkAction(formData): Promise<{ status: "sent" | "invalid" | "use-yale" }>`, `<MemberSignInForm callbackUrl={string} />`.

- [ ] **Step 1: Create the server action** `src/app/login/login-actions.ts`:

```ts
"use server";
import { requestMemberLoginLink } from "@/platform/auth/member-magic-link";
import { captureEvent } from "@/platform/posthog/capture";

export type MemberLinkActionResult = { status: "sent" | "invalid" | "use-yale" };

export async function requestMemberLoginLinkAction(formData: FormData): Promise<MemberLinkActionResult> {
  const email = String(formData.get("email") ?? "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { status: "invalid" };
  const next = String(formData.get("callbackUrl") ?? "").trim() || null;
  const result = await requestMemberLoginLink(email, next);
  await captureEvent({
    distinctId: email,
    event: "member_login_link_requested",
    properties: { result },
  });
  // Map "disabled" to the neutral "sent" so a direct POST cannot detect the toggle.
  return { status: result === "use-yale" ? "use-yale" : "sent" };
}
```

- [ ] **Step 2: Create the client form** `src/app/login/member-sign-in-form.tsx`:

```tsx
"use client";
import { useState } from "react";
import { requestMemberLoginLinkAction } from "./login-actions";
import { Input, Field } from "@/platform/ui/input";
import { Button } from "@/platform/ui/button";
import { Alert } from "@/platform/ui/alert";

export function MemberSignInForm({ callbackUrl }: { callbackUrl: string }) {
  const [state, setState] = useState<"idle" | "sent" | "invalid" | "use-yale">("idle");
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    try {
      const res = await requestMemberLoginLinkAction(new FormData(e.currentTarget));
      setState(res.status);
    } catch {
      setState("invalid");
    } finally {
      setPending(false);
    }
  }

  if (state === "sent") {
    return (
      <Alert tone="success">
        If that email belongs to an active member, we have sent a sign-in link. It expires in 30 minutes.
      </Alert>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <input type="hidden" name="callbackUrl" value={callbackUrl} />
      {state === "invalid" && (
        <p className="rounded-xl border border-critical/20 bg-critical/5 px-3 py-2 text-sm text-critical">
          Enter a valid email address.
        </p>
      )}
      {state === "use-yale" && (
        <p className="rounded-xl border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-warning">
          That is a Yale email. Use &ldquo;Sign in with Yale&rdquo; above.
        </p>
      )}
      <Field label="Email">
        <Input id="member-email" name="email" type="email" required placeholder="you@example.com" />
      </Field>
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Sending…" : "Email me a sign-in link"}
      </Button>
    </form>
  );
}
```

Note: `Alert tone="success"` is confirmed used by `apply/sign-in-form.tsx`. The invalid/use-yale banners reuse the exact `critical`/`warning` classes from `login/page.tsx`. If `Alert` also supports `tone="warning"`/`tone="error"`, you may swap the inline `<p>`s for `<Alert>` for consistency.

- [ ] **Step 3: Insert the form into `login/page.tsx`.** Add the import next to `SignInButton`:

```ts
import { MemberSignInForm } from "./member-sign-in-form";
```
Add the kill-switch read to the existing `Promise.all` (change the destructure to include it):

```ts
  const [appName, support, memberLinkEnabled] = await Promise.all([
    getSetting<string>("branding.appName"),
    getSupportContact(),
    getSetting<boolean>("auth.memberMagicLinkEnabled"),
  ]);
```
Then, immediately AFTER the Entra `{config.AZURE_AD_CLIENT_ID ? (<form>...</form>) : (<p>...not configured</p>)}` block (which ends around line 126) and BEFORE the `{support.email && ...}` support-link block, insert:

```tsx
        {memberLinkEnabled && (
          <div className="mt-6 border-t border-border-subtle pt-6">
            <p className="text-sm text-muted-foreground">
              Not a Yale affiliate? Get a one-time sign-in link by email.
            </p>
            <div className="mt-3">
              <MemberSignInForm callbackUrl={safeCallbackUrl} />
            </div>
          </div>
        )}
```

- [ ] **Step 4: Typecheck + lint the new files.**

Run: `npx tsc --noEmit && npx eslint src/app/login/login-actions.ts src/app/login/member-sign-in-form.tsx src/app/login/page.tsx`
Expected: no errors.

- [ ] **Step 5: Commit.**

```bash
git add src/app/login/login-actions.ts src/app/login/member-sign-in-form.tsx src/app/login/page.tsx
git commit -m "feat(auth): non-Yale sign-in-link form on /login"
```

---

### Task 9: `/login/verify` peek-then-confirm page

**Files:**
- Create: `src/app/login/verify/page.tsx`

**Interfaces:**
- Consumes: `peekMemberToken` (Task 5), `safeLoginPath` (Task 4), `signIn` (`@/platform/auth/auth`), `SubmitButton`, `HavenLogo`, `buttonClasses`, `buildPageMetadata`.

- [ ] **Step 1: Create the page** `src/app/login/verify/page.tsx`:

```tsx
import { redirect } from "next/navigation";
import Link from "next/link";
import { AuthError } from "next-auth";
import { signIn } from "@/platform/auth/auth";
import { peekMemberToken } from "@/platform/auth/member-magic-link";
import { safeLoginPath } from "@/platform/auth/safe-next";
import { HavenLogo } from "@/platform/ui/haven-logo";
import { buttonClasses } from "@/platform/ui/button";
import { SubmitButton } from "@/platform/ui/submit-button";
import { buildPageMetadata } from "@/platform/branding/metadata";

export const dynamic = "force-dynamic";

export function generateMetadata() {
  return buildPageMetadata({ title: "Confirm sign-in" });
}

/**
 * Member magic-link verification with an explicit confirmation step. The GET
 * only peeks the token (does not consume it) and shows "sign in as <name>?".
 * The session is established only when the member confirms, which consumes the
 * token via signIn("member-magic-link"). This defeats a login-CSRF where an
 * attacker forwards a link issued for their own address to a victim.
 */
export default async function MemberVerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; next?: string }>;
}) {
  const sp = await searchParams;
  const token = sp.token ?? "";
  const next = safeLoginPath(sp.next ?? null);
  const peeked = token ? await peekMemberToken(token) : null;

  async function confirmAction(formData: FormData) {
    "use server";
    const rawToken = String(formData.get("token") ?? "");
    const confirmedNext = safeLoginPath((formData.get("next") as string | null) ?? null);
    try {
      await signIn("member-magic-link", { token: rawToken, redirectTo: confirmedNext });
    } catch (error) {
      // signIn throws NEXT_REDIRECT on success (re-throw it); only translate auth failures.
      if (error instanceof AuthError) {
        redirect(`/login?error=${error.type}&callbackUrl=${encodeURIComponent(confirmedNext)}`);
      }
      throw error;
    }
  }

  return (
    <div className="relative flex min-h-dvh items-center justify-center bg-canvas p-6">
      <div className="glass-panel relative z-10 w-full max-w-sm rounded-2xl p-8 shadow-xl">
        <HavenLogo className="mx-auto h-10 w-auto" />
        {!peeked ? (
          <div className="mt-6 text-center">
            <h1 className="text-lg font-semibold text-foreground">This link is invalid or expired</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Sign-in links can be used once and expire after 30 minutes. Request a new one to continue.
            </p>
            <Link href="/login" className={buttonClasses("primary", "md", "mt-6 w-full")}>
              Back to sign in
            </Link>
          </div>
        ) : (
          <div className="mt-6 text-center">
            <h1 className="text-lg font-semibold text-foreground">Confirm sign-in</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              You are about to sign in as{" "}
              <strong className="text-foreground">{peeked.name}</strong> ({peeked.email}). If that is not
              you, do not continue.
            </p>
            <form action={confirmAction} className="mt-6">
              <input type="hidden" name="token" value={token} />
              <input type="hidden" name="next" value={next} />
              <SubmitButton className="w-full" pendingLabel="Signing in…">
                Continue
              </SubmitButton>
            </form>
            <Link href="/login" className={buttonClasses("outline", "md", "mt-3 w-full")}>
              This is not me
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
```

Note: `/login` has no shared `layout.tsx`, so this page renders its own centered glass card. `bg-canvas`, `glass-panel`, and `buttonClasses(variant, size, extra)` are all existing patterns (the 3-arg `buttonClasses` is used by `apply/page.tsx`). If `HavenLogo` does not accept `className`, wrap it in a `<div className="flex justify-center">` instead.

- [ ] **Step 2: Typecheck + lint.**

Run: `npx tsc --noEmit && npx eslint src/app/login/verify/page.tsx`
Expected: no errors.

- [ ] **Step 3: Commit.**

```bash
git add src/app/login/verify/page.tsx
git commit -m "feat(auth): /login/verify peek-then-confirm member sign-in page"
```

---

### Task 10: End-to-end test (request -> verify -> confirm -> hub)

**Files:**
- Create: an e2e spec under the repo's existing Playwright e2e directory (e.g. `e2e/member-magic-link.spec.ts` — confirm the exact dir + fixture helpers by reading a sibling spec first).

**Interfaces:**
- Consumes: the repo's existing e2e seeding + Playwright fixtures; `prisma.emailLog` for reading the issued token.

- [ ] **Step 1: Study an existing e2e spec.** Read one existing spec in the e2e directory (and its shared fixtures/seed helpers) to learn: how the test app/server is started, how a `Person` is seeded, and how the base URL is referenced. This is required because the seed + fixture API is repo-specific. Do not guess it.

- [ ] **Step 2: Write the e2e** mirroring the sibling spec's conventions. The flow to assert:

```ts
// Pseudocode shape — adapt seeding + fixture imports to match the sibling spec.
import { test, expect } from "<repo e2e fixtures>";
import { prisma } from "@/platform/db";

test("non-Yale active member signs in via emailed link", async ({ page }) => {
  // 1. Seed an ACTIVE Person with a non-Yale contactEmail (via the repo's seed helper).
  const email = "e2e-member@example.org";
  // ... create Person { name: "E2E Member", contactEmail: email, status: "ACTIVE" } and any
  //     membership/role the sibling spec uses to land on the hub ...

  // 2. Request the link from /login.
  await page.goto("/login");
  await page.getByLabel("Email").last().fill(email); // the member form, not the dev form
  await page.getByRole("button", { name: /Email me a sign-in link/i }).click();
  await expect(page.getByText(/we have sent a sign-in link/i)).toBeVisible();

  // 3. Read the raw token out of the issued EmailLog (the raw token is in the link href).
  const log = await prisma.emailLog.findFirstOrThrow({
    where: { template: "auth.member_login_link", toEmail: email },
    orderBy: { createdAt: "desc" },
  });
  const url = /\/login\/verify\?token=[^"'&]+/.exec(log.html)?.[0];
  expect(url).toBeTruthy();

  // 4. Visit the verify link, confirm.
  await page.goto(url!);
  await expect(page.getByText(/Confirm sign-in/i)).toBeVisible();
  await expect(page.getByText(email)).toBeVisible();
  await page.getByRole("button", { name: /Continue/i }).click();

  // 5. Land in the hub (not /login, not /welcome).
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page).not.toHaveURL(/\/welcome/);
});
```

Add a second assertion path if cheap: a `@yale.edu` entry shows the "use Sign in with Yale" message and queues no email.

- [ ] **Step 3: Run the e2e.** Use the repo's e2e command (check `package.json` scripts, e.g. `npm run test:e2e` or `npx playwright test e2e/member-magic-link.spec.ts`). Expected: PASS. If the runner needs a fresh DB, follow the sibling spec's setup.

- [ ] **Step 4: Commit.**

```bash
git add e2e/member-magic-link.spec.ts
git commit -m "test(auth): e2e member magic-link sign-in flow"
```

---

### Task 11: Full verification + finish

**Files:** none (verification only)

- [ ] **Step 1: Typecheck the whole repo.**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 2: Run the full unit suite** against the local test DB.

Run: `TEST_DATABASE_URL='postgresql://haven:haven_dev@localhost:5434/havenhub_test_mml' npx vitest run`
Expected: all pass. (If a pre-existing flake appears, e.g. the known `inbox.test.ts` createdAt-tie ordering flake, re-run to confirm it is unrelated.)

- [ ] **Step 3: Lint the WHOLE repo** (required before push; CI lints).

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 4: Production build** (catches server/client boundary + RSC issues that dev hides).

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 5: Manual smoke** (drive the real flow). Start the dev server, seed/confirm an active non-Yale member, go to `/login`, request a link, pull the link from the `EmailLog` (or the email monitor at `/admin/email`), open `/login/verify`, confirm, and verify you land in the hub. Then confirm a `@yale.edu` entry shows the "use Sign in with Yale" message and toggling `auth.memberMagicLinkEnabled` off in `/admin/settings` hides the form.

- [ ] **Step 6: Finish the branch.** Invoke the `superpowers:finishing-a-development-branch` skill to choose merge / PR / cleanup. Ensure `npm run lint`, tests, typecheck, and build are all green first, and that the migration has NOT been run against Neon (only the local throwaway DB).

---

## Self-Review

**Spec coverage** (against `docs/superpowers/specs/2026-07-16-member-magic-link-login-design.md`):
- §5.2 data model -> Task 1. §5.3 service (issue/peek/verify/request) -> Tasks 5, 6. §5.4 provider + jwt -> Task 7. §5.5 UI (`/login` form + `/login/verify`) -> Tasks 8, 9. §5.6 email template -> Task 3. §5.7 kill-switch -> Task 2. §6 security (single-use, TTL, peek-then-confirm, enumeration-safe, verify-time re-checks) -> Tasks 5, 6, 9 tests. §8 testing (unit + e2e) -> Tasks 5, 6, 10. `safeLoginPath` (implied by §5.3/§5.5 open-redirect handling) -> Task 4. All covered.
- One clarification vs the spec's §9 file list: the spec suggested the client form might be colocated; this plan puts it in `member-sign-in-form.tsx` + a dedicated `login-actions.ts` server-action file (cleaner separation, mirrors the apply portal). No behavior change.

**Placeholder scan:** Task 10 (e2e) intentionally begins by reading a sibling spec because the seed/fixture API is repo-specific and was not extracted; its assertions and DB-read are concrete. Every other task has complete, runnable code and exact commands. No "TBD"/"add validation"/"similar to Task N".

**Type consistency:** `verifyAndConsumeMemberToken(raw): Promise<{ personId: string } | null>` (Task 5) is what Task 7's `authorize` calls and returns `{ id: result.personId }`. `requestMemberLoginLink(email, next?): Promise<"sent"|"use-yale"|"disabled">` (Task 6) is what Task 8's action calls, mapping `"disabled"->"sent"`. `peekMemberToken(raw): Promise<{ email; name } | null>` (Task 5) is what Task 9 renders. `safeLoginPath` (Task 4) is used by Tasks 6 and 9. Template key `"auth.member_login_link"` and setting key `"auth.memberMagicLinkEnabled"` are spelled identically across Tasks 2, 3, 6, 8. Consistent.
