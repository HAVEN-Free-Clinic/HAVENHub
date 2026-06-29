# Application Portal — Stage 1: Identity Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let applicants reach a portal at `/apply` by signing in with Yale SSO or an emailed magic link, with one unified identity resolver, without changing the existing apply flow.

**Architecture:** A small `portal-auth.ts` service issues single-use, hashed, expiring magic-link tokens (`ApplicantPortalToken`) and signs a lightweight HMAC applicant-session cookie. `getApplicantIdentity()` resolves the current applicant from either the NextAuth `Person` session or the cookie. A new `/apply` portal home shows a sign-in screen when anonymous, and (once identified) the open cycles to apply to.

**Tech Stack:** Next.js 16 (App Router, server components + actions, route handlers), Prisma/Postgres, `node:crypto` (HMAC/SHA-256, no new deps), NextAuth (existing), Vitest (node env), Tailwind v4.

**Spec:** `docs/superpowers/specs/2026-06-25-application-portal-design.md`. This plan is Stage 1 of 3 (identity → drafts → status). It is non-breaking: the existing `/apply/[slug]` one-shot flow is untouched until Stage 2.

## Global Constraints

- No em-dashes in user-facing copy or code comments. Use commas, parentheses, or colons.
- Product name "HAVEN Hub" (two words) in user-facing copy; identifiers stay `havenhub`.
- No new dependencies; use `node:crypto`.
- Secrets/config: `config.AUTH_SECRET` (HMAC key) and `config.APP_BASE_URL` from `@/platform/config`. Magic-link emails go through the existing queue (`queueEmail` from `@/platform/email/send`).
- Magic tokens: single-use (`usedAt`), ~30-min expiry, stored only as a SHA-256 hash; rate-limited per email.
- Applicant cookie `applicant_session`: httpOnly, secure, sameSite=lax, signed (HMAC over `{ email, exp }`), ~7-day expiry. Carries only the verified lowercased email.
- Strict identity scoping: everything downstream keys off the resolved `{ email, personId }`.
- Vitest runs `environment: "node"` (no DOM): logic + DB get automated tests; UI verified by `npm run typecheck`, `npm run lint`, `npm run build`, and manual. Run one file with `npx vitest run <path>`; tests use `resetDb()` from `@/platform/test/db`. After adding the migration, apply it to the test DB (Task 1).

---

### Task 1: Schema — ApplicantPortalToken

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_applicant_portal_token/migration.sql`
- Test: `src/modules/recruitment/services/portal-auth.test.ts`

**Interfaces:**
- Produces: `ApplicantPortalToken { id, emailLower, tokenHash @unique, expiresAt, usedAt?, createdAt }`.

- [ ] **Step 1: Add the model**

In `prisma/schema.prisma` add:

```prisma
/// Single-use, hashed, expiring magic-link token for the applicant portal.
/// Only the SHA-256 hash of the token is stored; the raw token lives only in
/// the emailed link.
model ApplicantPortalToken {
  id         String    @id @default(cuid())
  emailLower String
  tokenHash  String    @unique
  expiresAt  DateTime
  usedAt     DateTime?
  createdAt  DateTime  @default(now())

  @@index([emailLower])
}
```

- [ ] **Step 2: Write the migration**

`prisma migrate dev` cannot run in this non-interactive shell, so hand-author the SQL. Create `prisma/migrations/<timestamp>_applicant_portal_token/migration.sql` (use a timestamp lexically after the latest existing migration folder, format `YYYYMMDDHHMMSS`):

```sql
-- CreateTable
CREATE TABLE "ApplicantPortalToken" (
    "id" TEXT NOT NULL,
    "emailLower" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApplicantPortalToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ApplicantPortalToken_tokenHash_key" ON "ApplicantPortalToken"("tokenHash");

-- CreateIndex
CREATE INDEX "ApplicantPortalToken_emailLower_idx" ON "ApplicantPortalToken"("emailLower");
```

- [ ] **Step 3: Regenerate the client and apply to dev + test DBs**

Run: `npx prisma generate`
Then apply the migration to both DBs (dev + test):
Run: `npx prisma migrate deploy`
Run: `DATABASE_URL="${TEST_DATABASE_URL:-postgresql://haven:haven_dev@localhost:5434/havenhub_test}" DATABASE_URL_UNPOOLED="${TEST_DATABASE_URL:-postgresql://haven:haven_dev@localhost:5434/havenhub_test}" npx prisma migrate deploy`
Expected: "All migrations have been successfully applied" (or "No pending migrations"). If the dev DB is unreachable, run `npm run db:up` then retry; if still unreachable, report BLOCKED.

- [ ] **Step 4: Write the failing test (schema reachable)**

Create `src/modules/recruitment/services/portal-auth.test.ts`:

```ts
import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("stores a portal token and finds it by hash", async () => {
  await prisma.applicantPortalToken.create({
    data: { emailLower: "a@yale.edu", tokenHash: "abc", expiresAt: new Date(Date.now() + 1000) },
  });
  const found = await prisma.applicantPortalToken.findUnique({ where: { tokenHash: "abc" } });
  expect(found?.emailLower).toBe("a@yale.edu");
  expect(found?.usedAt).toBeNull();
});
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run src/modules/recruitment/services/portal-auth.test.ts`
Expected: PASS. (Fails with "Unknown arg `applicantPortalToken`" if the migration was not applied to the test DB; re-run Step 3's test-DB deploy.)

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/modules/recruitment/services/portal-auth.test.ts
git commit -m "feat(recruitment): ApplicantPortalToken model for magic-link auth"
```

---

### Task 2: Magic-link token service

**Files:**
- Create: `src/modules/recruitment/services/portal-auth.ts`
- Test: `src/modules/recruitment/services/portal-auth.test.ts` (add)

**Interfaces:**
- Consumes: `prisma`.
- Produces:
  - `issueMagicToken(email: string): Promise<string>` (returns the raw token; stores its hash).
  - `verifyMagicToken(rawToken: string): Promise<string | null>` (returns the emailLower on success, marks it used; null if missing/used/expired).

- [ ] **Step 1: Write the failing tests**

Add to `portal-auth.test.ts`:

```ts
import { issueMagicToken, verifyMagicToken } from "./portal-auth";

it("issues a token that verifies once and returns the email", async () => {
  const raw = await issueMagicToken("Reed@Yale.edu");
  expect(typeof raw).toBe("string");
  expect(await verifyMagicToken(raw)).toBe("reed@yale.edu"); // normalized
  expect(await verifyMagicToken(raw)).toBeNull(); // single-use
});

it("rejects an expired token", async () => {
  const raw = await issueMagicToken("x@yale.edu");
  // Expire it directly.
  const { createHash } = await import("node:crypto");
  const tokenHash = createHash("sha256").update(raw).digest("hex");
  await prisma.applicantPortalToken.update({ where: { tokenHash }, data: { expiresAt: new Date(Date.now() - 1000) } });
  expect(await verifyMagicToken(raw)).toBeNull();
});

it("rejects an unknown token", async () => {
  expect(await verifyMagicToken("not-a-real-token")).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/modules/recruitment/services/portal-auth.test.ts`
Expected: FAIL (cannot find `./portal-auth` exports).

- [ ] **Step 3: Implement the token service**

```ts
// src/modules/recruitment/services/portal-auth.ts
import { randomBytes, createHash } from "node:crypto";
import { prisma } from "@/platform/db";

const TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Create a single-use magic-link token for `email` and return the raw token
 *  (only its hash is stored). */
export async function issueMagicToken(email: string): Promise<string> {
  const emailLower = email.trim().toLowerCase();
  const raw = randomBytes(32).toString("base64url");
  await prisma.applicantPortalToken.create({
    data: { emailLower, tokenHash: hashToken(raw), expiresAt: new Date(Date.now() + TOKEN_TTL_MS) },
  });
  return raw;
}

/** Validate a raw token: returns the emailLower and marks it used, or null if
 *  it is unknown, already used, or expired. */
export async function verifyMagicToken(rawToken: string): Promise<string | null> {
  const token = await prisma.applicantPortalToken.findUnique({ where: { tokenHash: hashToken(rawToken) } });
  if (!token || token.usedAt || token.expiresAt < new Date()) return null;
  await prisma.applicantPortalToken.update({ where: { id: token.id }, data: { usedAt: new Date() } });
  return token.emailLower;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/modules/recruitment/services/portal-auth.test.ts`
Expected: PASS (all token tests + the Task 1 test).

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/services/portal-auth.ts src/modules/recruitment/services/portal-auth.test.ts
git commit -m "feat(recruitment): single-use magic-link token service"
```

---

### Task 3: Applicant cookie + identity resolver

**Files:**
- Modify: `src/modules/recruitment/services/portal-auth.ts`
- Test: `src/modules/recruitment/services/portal-auth.test.ts` (add a pure-crypto block)

**Interfaces:**
- Consumes: `config` from `@/platform/config`; `cookies` from `next/headers`; `auth` from `@/platform/auth/auth`.
- Produces:
  - `const APPLICANT_COOKIE = "applicant_session"`
  - `signApplicantCookie(email: string): string`
  - `readApplicantCookie(value: string | undefined): string | null` (returns emailLower or null)
  - `type ApplicantIdentity = { email: string; personId: string | null }`
  - `getApplicantIdentity(): Promise<ApplicantIdentity | null>`

- [ ] **Step 1: Write the failing tests (pure cookie round-trip)**

Add to `portal-auth.test.ts`:

```ts
import { signApplicantCookie, readApplicantCookie } from "./portal-auth";

it("signs and reads back a cookie email, rejecting tampering", () => {
  const cookie = signApplicantCookie("Reed@Yale.edu");
  expect(readApplicantCookie(cookie)).toBe("reed@yale.edu");
  expect(readApplicantCookie(cookie + "x")).toBeNull(); // tampered signature
  expect(readApplicantCookie(undefined)).toBeNull();
  expect(readApplicantCookie("garbage")).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/modules/recruitment/services/portal-auth.test.ts`
Expected: FAIL (exports missing).

- [ ] **Step 3: Implement cookie signing + identity resolver**

Append to `portal-auth.ts`:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { auth } from "@/platform/auth/auth";
import { config } from "@/platform/config";

export const APPLICANT_COOKIE = "applicant_session";
const COOKIE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function sign(data: string): string {
  return createHmac("sha256", config.AUTH_SECRET).update(data).digest("base64url");
}

/** Sign a `payload.signature` cookie carrying the verified email + expiry. */
export function signApplicantCookie(email: string): string {
  const payload = Buffer.from(JSON.stringify({ email: email.trim().toLowerCase(), exp: Date.now() + COOKIE_TTL_MS })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/** Validate the cookie and return its emailLower, or null if forged/expired. */
export function readApplicantCookie(value: string | undefined): string | null {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString()) as { email?: unknown; exp?: unknown };
    if (typeof parsed.email !== "string" || typeof parsed.exp !== "number" || parsed.exp < Date.now()) return null;
    return parsed.email;
  } catch {
    return null;
  }
}

export type ApplicantIdentity = { email: string; personId: string | null };

/** The current applicant: from the NextAuth Person session if signed in,
 *  otherwise from the signed applicant cookie, otherwise null. */
export async function getApplicantIdentity(): Promise<ApplicantIdentity | null> {
  const session = await auth();
  if (session?.personId && session.user?.email) {
    return { email: session.user.email.toLowerCase(), personId: session.personId };
  }
  const store = await cookies();
  const email = readApplicantCookie(store.get(APPLICANT_COOKIE)?.value);
  return email ? { email, personId: null } : null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/modules/recruitment/services/portal-auth.test.ts`
Expected: PASS. Then `npm run typecheck` (confirm `config.AUTH_SECRET` resolves; it is `z.string().min(1)` in `src/platform/config.ts`).

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/services/portal-auth.ts src/modules/recruitment/services/portal-auth.test.ts
git commit -m "feat(recruitment): applicant cookie + unified identity resolver"
```

---

### Task 4: Magic-link email + request + verify route

**Files:**
- Create: `src/modules/recruitment/services/portal-link-email.ts`
- Modify: `src/modules/recruitment/services/portal-auth.ts` (add `requestMagicLink`)
- Create: `src/app/apply/verify/route.ts`
- Test: `src/modules/recruitment/services/portal-auth.test.ts` (add)

**Interfaces:**
- Consumes: `issueMagicToken`; `queueEmail` from `@/platform/email/send`; `config` from `@/platform/config`; `prisma`.
- Produces:
  - `portalLinkEmail(input: { firstName?: string; url: string }): { subject: string; html: string }`
  - `requestMagicLink(email: string): Promise<void>` (rate-limited; issues a token and queues the email)
  - GET `/apply/verify?token=…&next=…` route handler (sets the cookie, redirects)

- [ ] **Step 1: Write the failing test**

Add to `portal-auth.test.ts`:

```ts
import { requestMagicLink } from "./portal-auth";

it("queues a magic-link email containing a verify URL and rate-limits", async () => {
  await requestMagicLink("reed@yale.edu");
  const emails = await prisma.emailLog.findMany();
  expect(emails).toHaveLength(1);
  expect(emails[0].toEmail).toBe("reed@yale.edu");
  expect(emails[0].template).toBe("recruitment.portal_link");
  expect(emails[0].html).toContain("/apply/verify?token=");

  // Rate limit: three more requests do not all send.
  await requestMagicLink("reed@yale.edu");
  await requestMagicLink("reed@yale.edu");
  await requestMagicLink("reed@yale.edu");
  const after = await prisma.emailLog.count();
  expect(after).toBeLessThanOrEqual(3); // capped, not 4+
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/modules/recruitment/services/portal-auth.test.ts`
Expected: FAIL (`requestMagicLink` missing).

- [ ] **Step 3: Implement the email helper**

```ts
// src/modules/recruitment/services/portal-link-email.ts
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Magic-link email body. Plain transactional HTML, matching the inline-html
 *  pattern used by the other recruitment emails. */
export function portalLinkEmail(input: { firstName?: string; url: string }): { subject: string; html: string } {
  const hi = input.firstName ? `Hi ${escapeHtml(input.firstName)},` : "Hi there,";
  return {
    subject: "Your HAVEN Hub application link",
    html: `<p>${hi}</p><p>Use this link to access your HAVEN Hub application. It expires in 30 minutes and can be used once.</p><p><a href="${escapeHtml(input.url)}">Open my application</a></p><p>If you did not request this, you can ignore this email.</p>`,
  };
}
```

- [ ] **Step 4: Implement `requestMagicLink`**

Append to `portal-auth.ts`:

```ts
import { queueEmail } from "@/platform/email/send";
import { portalLinkEmail } from "./portal-link-email";

const RATE_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RATE_MAX = 3;

/** Issue a magic-link token and email it, unless the email has already been
 *  sent RATE_MAX links in the last window (silently skip to avoid spam). */
export async function requestMagicLink(email: string): Promise<void> {
  const emailLower = email.trim().toLowerCase();
  const recent = await prisma.applicantPortalToken.count({
    where: { emailLower, createdAt: { gt: new Date(Date.now() - RATE_WINDOW_MS) } },
  });
  if (recent >= RATE_MAX) return;

  const raw = await issueMagicToken(emailLower);
  const url = `${config.APP_BASE_URL}/apply/verify?token=${encodeURIComponent(raw)}`;
  const mail = portalLinkEmail({ url });
  await queueEmail(prisma, { to: emailLower, subject: mail.subject, html: mail.html, template: "recruitment.portal_link" });
}
```

(`queueEmail(db, input)` takes the prisma client or a tx; passing `prisma` queues outside a transaction, which is correct here.)

- [ ] **Step 5: Implement the verify route**

```ts
// src/app/apply/verify/route.ts
import { NextResponse } from "next/server";
import { verifyMagicToken, signApplicantCookie, APPLICANT_COOKIE } from "@/modules/recruitment/services/portal-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safeNext(raw: string | null): string {
  // Only allow a same-origin, slash-rooted path (no open redirect).
  if (raw && /^\/[^/\\]/.test(raw)) return raw;
  return "/apply";
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  const next = safeNext(url.searchParams.get("next"));
  const email = token ? await verifyMagicToken(token) : null;
  if (!email) {
    return NextResponse.redirect(new URL("/apply?error=link", req.url));
  }
  const res = NextResponse.redirect(new URL(next, req.url));
  res.cookies.set({
    name: APPLICANT_COOKIE,
    value: signApplicantCookie(email),
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 7 * 24 * 60 * 60,
  });
  return res;
}
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run src/modules/recruitment/services/portal-auth.test.ts`
Expected: PASS.
Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/modules/recruitment/services/portal-link-email.ts src/modules/recruitment/services/portal-auth.ts "src/app/apply/verify/route.ts"
git commit -m "feat(recruitment): magic-link request + verify route"
```

---

### Task 5: Portal home + sign-in UI

**Files:**
- Create: `src/app/apply/page.tsx` (portal home)
- Create: `src/app/apply/portal-actions.ts` (server actions)
- Create: `src/app/apply/sign-in-form.tsx` (client form for the magic-link email)
- Test: none automated (node-env Vitest, no DOM); verify via typecheck/lint/build + manual.

**Interfaces:**
- Consumes: `getApplicantIdentity`, `requestMagicLink`, `APPLICANT_COOKIE` from `@/modules/recruitment/services/portal-auth`; `prisma`; `cookies` from `next/headers`; `Button`, `buttonClasses` from `@/platform/ui/button`; `Input` from `@/platform/ui/input`; `Alert` from `@/platform/ui/alert`.

- [ ] **Step 1: Create the server actions**

```ts
// src/app/apply/portal-actions.ts
"use server";
import { cookies } from "next/headers";
import { requestMagicLink, APPLICANT_COOKIE } from "@/modules/recruitment/services/portal-auth";

export async function requestMagicLinkAction(formData: FormData): Promise<{ ok: boolean }> {
  const email = String(formData.get("email") ?? "").trim();
  // Basic shape check; the email service normalizes + rate-limits.
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false };
  await requestMagicLink(email);
  return { ok: true };
}

export async function applicantSignOutAction(): Promise<void> {
  const store = await cookies();
  store.delete(APPLICANT_COOKIE);
}
```

- [ ] **Step 2: Create the sign-in form (client)**

```tsx
// src/app/apply/sign-in-form.tsx
"use client";
import { useState } from "react";
import { requestMagicLinkAction } from "./portal-actions";
import { Input } from "@/platform/ui/input";
import { Button } from "@/platform/ui/button";
import { Alert } from "@/platform/ui/alert";

export function SignInForm() {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(false);
    const res = await requestMagicLinkAction(new FormData(e.currentTarget));
    setPending(false);
    if (res.ok) setSent(true); else setError(true);
  }

  if (sent) {
    return <Alert tone="success">Check your email for a link to your application. It expires in 30 minutes.</Alert>;
  }

  return (
    <form onSubmit={onSubmit} className="space-y-2">
      <label className="block text-sm font-medium text-foreground" htmlFor="portal-email">Email</label>
      <Input id="portal-email" name="email" type="email" required placeholder="you@yale.edu" />
      {error && <p className="text-xs text-critical">Enter a valid email address.</p>}
      <Button type="submit" disabled={pending}>{pending ? "Sending…" : "Email me a link"}</Button>
    </form>
  );
}
```

- [ ] **Step 3: Create the portal home page**

```tsx
// src/app/apply/page.tsx
import Link from "next/link";
import { prisma } from "@/platform/db";
import { getApplicantIdentity } from "@/modules/recruitment/services/portal-auth";
import { applicantSignOutAction } from "./portal-actions";
import { SignInForm } from "./sign-in-form";
import { buttonClasses } from "@/platform/ui/button";
import { Alert } from "@/platform/ui/alert";

export const dynamic = "force-dynamic";

export default async function PortalHome({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const identity = await getApplicantIdentity();

  if (!identity) {
    return (
      <main className="mx-auto max-w-md px-6 py-16 space-y-6">
        <h1 className="text-2xl font-bold tracking-tight">Your HAVEN Hub application</h1>
        {error === "link" && <Alert tone="error">That link has expired or was already used. Request a new one below.</Alert>}
        <p className="text-sm text-muted-foreground">Sign in to start, continue, or check the status of an application.</p>
        <a href="/login?callbackUrl=/apply" className={buttonClasses("primary", "md")}>Sign in with Yale</a>
        <div className="border-t border-border-subtle pt-6">
          <p className="mb-2 text-sm text-muted-foreground">Or get a one-time link by email:</p>
          <SignInForm />
        </div>
      </main>
    );
  }

  const now = new Date();
  const openCycles = await prisma.recruitmentCycle.findMany({
    where: { status: "OPEN", AND: [{ OR: [{ opensAt: null }, { opensAt: { lte: now } }] }, { OR: [{ closesAt: null }, { closesAt: { gte: now } }] }] },
    select: { title: true, publicSlug: true },
    orderBy: { createdAt: "desc" },
  });

  return (
    <main className="mx-auto max-w-2xl px-6 py-10 space-y-8">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold tracking-tight">Your applications</h1>
        <form action={applicantSignOutAction}><button className="text-sm text-muted-foreground hover:text-foreground">Sign out</button></form>
      </div>
      <p className="text-sm text-muted-foreground">Signed in as {identity.email}.</p>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Open applications</h2>
        {openCycles.length === 0 && <p className="text-sm text-subtle-foreground">No applications are open right now.</p>}
        <ul className="space-y-2">
          {openCycles.map((c) => (
            <li key={c.publicSlug}>
              <Link href={`/apply/${c.publicSlug}`} className="flex items-center justify-between rounded-xl border border-border bg-surface px-4 py-3 text-sm hover:bg-muted">
                <span className="font-medium text-foreground">{c.title}</span>
                <span className="text-brand-fg">Start application</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
```

(Note: in Stage 2 this page also lists the applicant's own drafts/submitted applications; for Stage 1 it lists open cycles only.)

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: clean (lint errors confined to the pre-existing `HAVEN Free Clinic Design System/` folder are not yours).

Manual check (run skill or `npm run dev`): visit `/apply` signed out → see "Sign in with Yale" + the email form; submit an email → "check your email"; the queued email (visible in the `EmailLog` table or the dev mail transport) contains an `/apply/verify?token=…` link; opening it sets the cookie and lands on the portal showing open cycles; "Sign out" clears it. Signed-in members (SSO) see the portal directly.

- [ ] **Step 5: Commit**

```bash
git add "src/app/apply/page.tsx" "src/app/apply/portal-actions.ts" "src/app/apply/sign-in-form.tsx"
git commit -m "feat(recruitment): applicant portal home + sign-in"
```

---

## Self-Review Notes

- **Spec coverage (Stage 1 scope):** identity resolver (Task 3), magic-link tokens single-use/expiring/hashed (Tasks 1-2), rate-limited request + email + cookie-setting verify route (Task 4), portal sign-in + entry (Task 5). The cookie is httpOnly/secure/sameSite/signed; tokens store only a hash. Drafts, status, the `DRAFT` enum, `decisionsReleasedAt`, the orphan cron, and the identity-gated apply form are Stages 2-3 (out of this plan, by design).
- **Non-breaking:** Stage 1 adds `/apply` and `/apply/verify`; it does not touch `/apply/[slug]` or `submissions.ts`, so the current one-shot apply flow is unchanged.
- **Type consistency:** `ApplicantIdentity = { email, personId }`, `getApplicantIdentity`, `issueMagicToken`/`verifyMagicToken`, `signApplicantCookie`/`readApplicantCookie`, `APPLICANT_COOKIE`, and `requestMagicLink` are defined in Tasks 2-4 and consumed unchanged in Tasks 4-5.
- **Security:** the verify route only allows a same-origin slash-rooted `next` (no open redirect); the cookie uses `timingSafeEqual`; tokens are single-use and hashed; requests are rate-limited.
- **Deploy note for execution:** `config.AUTH_SECRET` must be set in every environment (it already is, since NextAuth uses it). The magic-link email relies on the existing email drain cron being active.
