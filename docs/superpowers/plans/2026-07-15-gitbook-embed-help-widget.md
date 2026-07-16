# GitBook Embed Help Widget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a global "Help" launcher to the authenticated app shell that opens GitBook's Assistant + Search + Docs embed, authenticated with the same adaptive visitor JWT the app already mints, and lightly seeded with context from the current module.

**Architecture:** Extract the existing JWT-minting logic out of the docs redirect route into a shared `mintVisitorToken` helper. Add a JSON endpoint (`GET /api/gitbook/embed-token`) that returns `{ token, expiresAt }`. A client component (`HelpLauncher`) fetches that token, refreshes it before expiry, and renders `@gitbook/embed`'s `GitBookProvider` + `GitBookFrame` client-only. `AppShell` renders the launcher only when GitBook is configured.

**Tech Stack:** Next.js 16.2.7 (App Router, `proxy` convention), React 19.2.4, TypeScript, Zod-validated env, Vitest, `@gitbook/embed`, lucide-react, Tailwind v4.

## Global Constraints

- **Package manager: npm.** Add deps with `npm install`; the lockfile is `package-lock.json`.
- **Version floors:** Next.js `16.2.7`, React `19.2.4`. `ssr: false` dynamic imports are allowed only in Client Components.
- **File naming:** kebab-case (`visitor-token.ts`, `help-launcher.tsx`, `help-context.ts`), matching the codebase.
- **Icon:** use `CircleHelp` from lucide-react for the launcher. Do NOT use `LifeBuoy` (already the Support module's icon).
- **Adaptive claims are frozen.** Do not change `buildAdaptiveClaims`, the catalog, or `docs/gitbook/adaptive-schema.json`. These tests must stay green: `src/platform/gitbook/schema-artifact.test.ts`, `catalog.test.ts`, `adaptive-claims.test.ts`.
- **Redirect flow behavior is frozen.** After the Task 1 refactor, `src/app/api/gitbook/auth/route.test.ts` must pass unchanged.
- **API routes use `export const runtime = "nodejs"`** (they use `node:crypto`).
- **Feature is inert when unconfigured.** When `GITBOOK_JWT_KEY` or `GITBOOK_SITE_URL` is unset: the endpoints return 503 and the launcher does not render.
- **Tests are colocated** with the code (`foo.test.ts` next to `foo.ts`). Run all: `npm test`. Run one file: `npx vitest run <path>`.
- **Styling:** no `tailwind-merge`; reuse existing utility-class patterns and the `glass-panel` material (see `notification-bell.tsx`).
- **Prose/copy rule:** no em-dashes in any user-facing copy or comments.

## File Structure

- `src/platform/gitbook/visitor-token.ts` (new) — `mintVisitorToken`, `signJwt`, `base64url`. Single source of truth for the visitor JWT. Server-only.
- `src/platform/gitbook/visitor-token.test.ts` (new) — unit tests for minting.
- `src/app/api/gitbook/auth/route.ts` (modify) — delegate signing to `mintVisitorToken`; keep redirect + audit + `resolveTarget`.
- `src/app/api/gitbook/embed-token/route.ts` (new) — JSON token endpoint for the embed.
- `src/app/api/gitbook/embed-token/route.test.ts` (new) — 503 / 401 / 403 / 200 tests.
- `src/platform/ui/help/help-context.ts` (new) — pure `seedForPathname` / `moduleTitleForPath`. Client-safe, React-free.
- `src/platform/ui/help/help-context.test.ts` (new) — unit tests for seeding.
- `src/platform/ui/help/help-launcher.tsx` (new) — client component: button + panel + embed + token lifecycle.
- `src/platform/ui/app-shell.tsx` (modify) — render `HelpLauncher` conditionally; build + pass `moduleLabels`.
- `.env.example` (modify) — document `GITBOOK_JWT_KEY` + `GITBOOK_SITE_URL`.
- `package.json` / `package-lock.json` (modify) — add `@gitbook/embed`.

---

### Task 1: Shared `mintVisitorToken` helper + redirect-route refactor

**Files:**
- Create: `src/platform/gitbook/visitor-token.ts`
- Create (test): `src/platform/gitbook/visitor-token.test.ts`
- Modify: `src/app/api/gitbook/auth/route.ts`
- Unchanged, must stay green: `src/app/api/gitbook/auth/route.test.ts`

**Interfaces:**
- Consumes: `config.GITBOOK_JWT_KEY`; `getEffectivePermissions(personId)` from `@/platform/rbac/engine`; `buildAdaptiveClaims(perms, derived)` from `@/platform/gitbook/adaptive-claims`; `canManageAnyScheduleDept(personId)` from `@/modules/schedule/services/builder`; `canManageAnyRhdDept(personId)` from `@/modules/schedule/services/attendings`.
- Produces:
  - `type VisitorPerson = { id: string; name: string; contactEmail: string | null }`
  - `interface VisitorToken { token: string; expiresAt: number }` (`expiresAt` is epoch **milliseconds**)
  - `mintVisitorToken(person: VisitorPerson, opts?: { email?: string | null }): Promise<VisitorToken>`
  - `signJwt(claims: Record<string, unknown>, key: string): string`

- [ ] **Step 1: Write the failing test**

Create `src/platform/gitbook/visitor-token.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHmac } from "node:crypto";

// Config is a fixed object here (the helper only reads GITBOOK_JWT_KEY).
vi.mock("@/platform/config", () => ({
  config: { GITBOOK_JWT_KEY: "test-key", GITBOOK_SITE_URL: "https://docs.example.org" },
}));
// Keep the real (pure) hasPermission so buildAdaptiveClaims resolves; mock only the DB call.
vi.mock("@/platform/rbac/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/platform/rbac/engine")>();
  return { ...actual, getEffectivePermissions: vi.fn() };
});
vi.mock("@/modules/schedule/services/builder", () => ({ canManageAnyScheduleDept: vi.fn() }));
vi.mock("@/modules/schedule/services/attendings", () => ({ canManageAnyRhdDept: vi.fn() }));

import { getEffectivePermissions } from "@/platform/rbac/engine";
import { canManageAnyScheduleDept } from "@/modules/schedule/services/builder";
import { canManageAnyRhdDept } from "@/modules/schedule/services/attendings";
import { mintVisitorToken } from "./visitor-token";

const asMock = (f: unknown) => f as ReturnType<typeof vi.fn>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function decodePayload(token: string): Record<string, any> {
  const [, payload] = token.split(".");
  return JSON.parse(Buffer.from(payload, "base64url").toString());
}
function signatureVerifies(token: string, key: string): boolean {
  const [h, p, sig] = token.split(".");
  const expected = createHmac("sha256", key).update(`${h}.${p}`).digest("base64url");
  return sig === expected;
}

describe("mintVisitorToken", () => {
  beforeEach(() => vi.resetAllMocks());

  it("mints an HS256 token with `can` claims, email, and a 1h expiry", async () => {
    asMock(getEffectivePermissions).mockResolvedValue(new Set(["schedule.view"]));
    asMock(canManageAnyScheduleDept).mockResolvedValue(false);
    asMock(canManageAnyRhdDept).mockResolvedValue(false);

    const { token, expiresAt } = await mintVisitorToken(
      { id: "p1", name: "Jo", contactEmail: "jo@x.com" },
      { email: "fallback@x.com" }
    );

    expect(signatureVerifies(token, "test-key")).toBe(true);
    const payload = decodePayload(token);
    expect(payload.name).toBe("Jo");
    expect(payload.email).toBe("jo@x.com"); // contactEmail wins over the fallback
    expect(payload.can.schedule.view).toBe(true);
    expect(payload.can.admin.access).toBe(false);
    expect(payload.exp - payload.iat).toBe(3600);
    expect(expiresAt).toBe(payload.exp * 1000);
  });

  it("passes the data-driven schedule capability claims through and omits a null email", async () => {
    asMock(getEffectivePermissions).mockResolvedValue(new Set(["schedule.view"]));
    asMock(canManageAnyScheduleDept).mockResolvedValue(true);
    asMock(canManageAnyRhdDept).mockResolvedValue(false);

    const { token } = await mintVisitorToken({ id: "p2", name: "Dee", contactEmail: null });
    const payload = decodePayload(token);
    expect(payload.can.schedule.manages_any_dept).toBe(true);
    expect(payload.can.schedule.manages_any_rhd_dept).toBe(false);
    expect(payload.email).toBeUndefined(); // null contactEmail + no fallback -> key omitted
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/platform/gitbook/visitor-token.test.ts`
Expected: FAIL (cannot resolve `./visitor-token` / `mintVisitorToken` is not a function).

- [ ] **Step 3: Write the helper**

Create `src/platform/gitbook/visitor-token.ts`:

```ts
import { createHmac } from "node:crypto";
import { config } from "@/platform/config";
import { getEffectivePermissions } from "@/platform/rbac/engine";
import { buildAdaptiveClaims } from "@/platform/gitbook/adaptive-claims";
import { canManageAnyScheduleDept } from "@/modules/schedule/services/builder";
import { canManageAnyRhdDept } from "@/modules/schedule/services/attendings";

/** Person fields the visitor token needs. */
export type VisitorPerson = { id: string; name: string; contactEmail: string | null };

export interface VisitorToken {
  token: string;
  /** Epoch milliseconds when the token expires (iat + 1h). Convenient for client-side refresh scheduling. */
  expiresAt: number;
}

/** 1 hour, matching GitBook's reference backend. */
const TOKEN_TTL_SECONDS = 60 * 60;

function base64url(input: string): string {
  return Buffer.from(input).toString("base64url");
}

/** Sign an HS256 JWT with the key as a raw UTF-8 secret (GitBook-compatible, no jsonwebtoken dependency). */
export function signJwt(claims: Record<string, unknown>, key: string): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify(claims));
  const data = `${header}.${payload}`;
  const signature = createHmac("sha256", key).update(data).digest("base64url");
  return `${data}.${signature}`;
}

/**
 * Mint the adaptive visitor JWT for a signed-in, active person. Shared by the docs
 * redirect flow (/api/gitbook/auth) and the in-app embed token endpoint
 * (/api/gitbook/embed-token), so both issue byte-identical claims.
 *
 * The nested `can` claim is GitBook adaptive content (visitor.claims.can.<module>.<action>).
 * The two schedule Builder/Attendings leaves gate on a data-driven capability rather than a
 * permission string, so they are computed here and merged in via `derived`.
 *
 * Throws if GITBOOK_JWT_KEY is unset; callers translate that into a 503.
 */
export async function mintVisitorToken(
  person: VisitorPerson,
  opts: { email?: string | null } = {}
): Promise<VisitorToken> {
  const { GITBOOK_JWT_KEY } = config;
  if (!GITBOOK_JWT_KEY) {
    throw new Error("GITBOOK_JWT_KEY is not configured");
  }

  const [perms, managesAnyScheduleDept, managesAnyRhdDept] = await Promise.all([
    getEffectivePermissions(person.id),
    canManageAnyScheduleDept(person.id),
    canManageAnyRhdDept(person.id),
  ]);

  const now = Math.floor(Date.now() / 1000);
  const exp = now + TOKEN_TTL_SECONDS;
  const token = signJwt(
    {
      name: person.name,
      email: person.contactEmail ?? opts.email ?? undefined,
      iat: now,
      exp,
      ...buildAdaptiveClaims(perms, {
        "schedule.manages_any_dept": managesAnyScheduleDept,
        "schedule.manages_any_rhd_dept": managesAnyRhdDept,
      }),
    },
    GITBOOK_JWT_KEY
  );

  return { token, expiresAt: exp * 1000 };
}
```

- [ ] **Step 4: Run the helper test to verify it passes**

Run: `npx vitest run src/platform/gitbook/visitor-token.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Refactor the redirect route to use the helper**

Replace the entire contents of `src/app/api/gitbook/auth/route.ts` with:

```ts
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";
import { config } from "@/platform/config";
import { recordAudit } from "@/platform/audit";
import { mintVisitorToken } from "@/platform/gitbook/visitor-token";

/**
 * GET /api/gitbook/auth
 *
 * The "Login URL" for GitBook's custom visitor-authentication backend. GitBook
 * redirects an unauthenticated docs visitor here with a `location` query param
 * (the path within the site they were trying to reach). We require a signed-in,
 * active HAVEN person, mint the adaptive visitor JWT (see mintVisitorToken), and
 * redirect the visitor back to the published site with `?jwt_token=...`.
 *
 * Node runtime: mintVisitorToken uses node:crypto.
 */
export const runtime = "nodejs";

/**
 * Resolve the docs URL to return the visitor to. GitBook's `location` is a path
 * relative to the site base. We hard-assert the result stays on the configured
 * site origin so a crafted `location` can never turn this into an open redirect.
 */
function resolveTarget(siteUrl: string, location: string): URL {
  const base = siteUrl.replace(/\/+$/, "");
  const path = location.startsWith("/") ? location : `/${location}`;
  try {
    const target = new URL(`${base}${path}`);
    if (target.origin !== new URL(base).origin) return new URL(base);
    return target;
  } catch {
    return new URL(base);
  }
}

export async function GET(request: NextRequest): Promise<Response> {
  const { GITBOOK_JWT_KEY, GITBOOK_SITE_URL } = config;
  if (!GITBOOK_JWT_KEY || !GITBOOK_SITE_URL) {
    return new NextResponse("GitBook visitor authentication is not configured.", {
      status: 503,
    });
  }

  const location = new URL(request.url).searchParams.get("location") ?? "";

  // Require a signed-in, active person. Unauthenticated visitors are sent through
  // the normal Yale sign-in and returned here (with `location` intact) to finish.
  const session = await auth();
  if (!session?.personId) {
    const callbackUrl = `/api/gitbook/auth?location=${encodeURIComponent(location)}`;
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("callbackUrl", callbackUrl);
    return NextResponse.redirect(loginUrl);
  }
  const person = await getActivePerson(session.personId);
  if (!person) {
    return NextResponse.redirect(new URL("/welcome", request.url));
  }

  const { token } = await mintVisitorToken(person, { email: session.user?.email });

  await recordAudit({
    action: "gitbook.visitor_auth",
    entityType: "Auth",
    entityId: person.id,
    after: { location },
  });

  const target = resolveTarget(GITBOOK_SITE_URL, location);
  target.searchParams.set("jwt_token", token);
  return NextResponse.redirect(target.toString());
}
```

- [ ] **Step 6: Run the existing redirect-route test to confirm no behavior change**

Run: `npx vitest run src/app/api/gitbook/auth/route.test.ts`
Expected: PASS (2 tests, unchanged). The test mocks `@/platform/rbac/engine`, `@/modules/schedule/services/builder`, `@/modules/schedule/services/attendings`, and `@/platform/config`; `mintVisitorToken` imports those same specifiers, so the mocks still apply transitively.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/platform/gitbook/visitor-token.ts src/platform/gitbook/visitor-token.test.ts src/app/api/gitbook/auth/route.ts
git commit -m "refactor(gitbook): extract shared mintVisitorToken helper from redirect route"
```

---

### Task 2: `GET /api/gitbook/embed-token` JSON endpoint

**Files:**
- Create: `src/app/api/gitbook/embed-token/route.ts`
- Create (test): `src/app/api/gitbook/embed-token/route.test.ts`

**Interfaces:**
- Consumes: `mintVisitorToken` (Task 1); `auth()` from `@/platform/auth/auth`; `getActivePerson(personId)` from `@/platform/auth/match-person`; `config.GITBOOK_JWT_KEY` / `config.GITBOOK_SITE_URL`.
- Produces: `GET(): Promise<Response>` returning JSON `{ token: string; expiresAt: number }` with `Cache-Control: no-store` on success; 503 / 401 / 403 otherwise.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/gitbook/embed-token/route.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";

// Mutable config so we can simulate the unconfigured (503) case. vi.hoisted lets the
// vi.mock factory reference this object even though it is declared at top level.
const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {} as { GITBOOK_JWT_KEY?: string; GITBOOK_SITE_URL?: string },
}));

vi.mock("@/platform/config", () => ({ config: mockConfig }));
vi.mock("@/platform/auth/auth", () => ({ auth: vi.fn() }));
vi.mock("@/platform/auth/match-person", () => ({ getActivePerson: vi.fn() }));
vi.mock("@/platform/gitbook/visitor-token", () => ({ mintVisitorToken: vi.fn() }));

import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";
import { mintVisitorToken } from "@/platform/gitbook/visitor-token";

const asMock = (f: unknown) => f as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetAllMocks();
  mockConfig.GITBOOK_JWT_KEY = "test-key";
  mockConfig.GITBOOK_SITE_URL = "https://docs.example.org";
});

describe("GET /api/gitbook/embed-token", () => {
  it("503 when GitBook is not configured", async () => {
    mockConfig.GITBOOK_JWT_KEY = undefined;
    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(503);
  });

  it("401 when not authenticated", async () => {
    asMock(auth).mockResolvedValue(null);
    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(401);
    expect(mintVisitorToken).not.toHaveBeenCalled();
  });

  it("403 when the session has no active person", async () => {
    asMock(auth).mockResolvedValue({ personId: "p1", user: { email: "j@x.com" } });
    asMock(getActivePerson).mockResolvedValue(null);
    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(403);
  });

  it("200 returns { token, expiresAt } with no-store", async () => {
    asMock(auth).mockResolvedValue({ personId: "p1", user: { email: "j@x.com" } });
    asMock(getActivePerson).mockResolvedValue({ id: "p1", name: "Jo", contactEmail: "jo@x.com" });
    asMock(mintVisitorToken).mockResolvedValue({ token: "a.b.c", expiresAt: 1234 });

    const { GET } = await import("./route");
    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ token: "a.b.c", expiresAt: 1234 });
    expect(mintVisitorToken).toHaveBeenCalledWith(
      { id: "p1", name: "Jo", contactEmail: "jo@x.com" },
      { email: "j@x.com" }
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/gitbook/embed-token/route.test.ts`
Expected: FAIL (cannot resolve `./route`).

- [ ] **Step 3: Write the endpoint**

Create `src/app/api/gitbook/embed-token/route.ts`:

```ts
import { NextResponse } from "next/server";
import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";
import { config } from "@/platform/config";
import { mintVisitorToken } from "@/platform/gitbook/visitor-token";

/**
 * GET /api/gitbook/embed-token
 *
 * Issues the adaptive visitor JWT for the in-app GitBook embed (the Help launcher).
 * Unlike /api/gitbook/auth (which 302-redirects into the docs site), this returns the
 * token as JSON so a client component can pass it to <GitBookFrame visitor={{ token }} />.
 * Same claims, same 1h TTL. No per-request audit: the panel opens/refreshes frequently,
 * and the redirect flow already audits real doc visits.
 *
 * Node runtime: mintVisitorToken uses node:crypto.
 */
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const { GITBOOK_JWT_KEY, GITBOOK_SITE_URL } = config;
  if (!GITBOOK_JWT_KEY || !GITBOOK_SITE_URL) {
    return NextResponse.json({ error: "GitBook embed is not configured." }, { status: 503 });
  }

  const session = await auth();
  if (!session?.personId) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const person = await getActivePerson(session.personId);
  if (!person) {
    return NextResponse.json({ error: "No active person." }, { status: 403 });
  }

  const { token, expiresAt } = await mintVisitorToken(person, { email: session.user?.email });
  return NextResponse.json({ token, expiresAt }, { headers: { "Cache-Control": "no-store" } });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/api/gitbook/embed-token/route.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/gitbook/embed-token/route.ts src/app/api/gitbook/embed-token/route.test.ts
git commit -m "feat(gitbook): JSON embed-token endpoint for the in-app help widget"
```

---

### Task 3: Pure context-seeding module

**Files:**
- Create: `src/platform/ui/help/help-context.ts`
- Create (test): `src/platform/ui/help/help-context.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `interface HelpSeed { greeting: { title: string; subtitle: string }; suggestions: string[]; moduleTitle: string | null }`
  - `moduleTitleForPath(pathname: string, moduleLabels: Record<string, string>): string | null`
  - `seedForPathname(pathname: string, moduleLabels: Record<string, string>): HelpSeed`

- [ ] **Step 1: Write the failing test**

Create `src/platform/ui/help/help-context.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { moduleTitleForPath, seedForPathname } from "./help-context";

const LABELS = { recruitment: "Recruitment", schedule: "Clinic Schedule" };

describe("moduleTitleForPath", () => {
  it("maps the first path segment to a module title", () => {
    expect(moduleTitleForPath("/recruitment/cycles/123", LABELS)).toBe("Recruitment");
  });
  it("returns null for the root or an unknown segment", () => {
    expect(moduleTitleForPath("/", LABELS)).toBeNull();
    expect(moduleTitleForPath("/nope/here", LABELS)).toBeNull();
  });
});

describe("seedForPathname", () => {
  it("seeds a module-specific greeting and suggestions when the module is known", () => {
    const seed = seedForPathname("/recruitment", LABELS);
    expect(seed.moduleTitle).toBe("Recruitment");
    expect(seed.greeting.title).toContain("Recruitment");
    expect(seed.suggestions.some((s) => s.includes("Recruitment"))).toBe(true);
  });
  it("falls back to a generic greeting off any known module", () => {
    const seed = seedForPathname("/", LABELS);
    expect(seed.moduleTitle).toBeNull();
    expect(seed.greeting.title).toBe("How can we help?");
    expect(seed.suggestions.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/platform/ui/help/help-context.test.ts`
Expected: FAIL (cannot resolve `./help-context`).

- [ ] **Step 3: Write the module**

Create `src/platform/ui/help/help-context.ts`:

```ts
/**
 * Derive the current module from a pathname and build the GitBook assistant's greeting
 * and suggested questions. Pure and React-free so it is unit-testable and reusable.
 *
 * `moduleLabels` maps a top-level route segment (== module id, e.g. "recruitment") to its
 * human title (e.g. "Recruitment"), built server-side from MODULES and passed to the client.
 */
export interface HelpSeed {
  greeting: { title: string; subtitle: string };
  suggestions: string[];
  moduleTitle: string | null;
}

const GENERIC_GREETING = {
  title: "How can we help?",
  subtitle: "Search the docs or ask a question.",
};

const GENERIC_SUGGESTIONS = ["How do I use HAVEN Hub?", "Where do I update my info?"];

/** The module title for a pathname's first segment, or null when unknown / at the root. */
export function moduleTitleForPath(
  pathname: string,
  moduleLabels: Record<string, string>
): string | null {
  const segment = pathname.split("/").filter(Boolean)[0];
  if (!segment) return null;
  return moduleLabels[segment] ?? null;
}

/** Greeting + suggestions seeded from the current module (generic fallback off a module). */
export function seedForPathname(
  pathname: string,
  moduleLabels: Record<string, string>
): HelpSeed {
  const moduleTitle = moduleTitleForPath(pathname, moduleLabels);
  if (!moduleTitle) {
    return { greeting: GENERIC_GREETING, suggestions: GENERIC_SUGGESTIONS, moduleTitle: null };
  }
  return {
    greeting: {
      title: `${moduleTitle} help`,
      subtitle: `Ask about ${moduleTitle} or search the docs.`,
    },
    suggestions: [`How does ${moduleTitle} work?`, `What can I do in ${moduleTitle}?`],
    moduleTitle,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/platform/ui/help/help-context.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/platform/ui/help/help-context.ts src/platform/ui/help/help-context.test.ts
git commit -m "feat(help): pure module-context seeding for the GitBook help widget"
```

---

### Task 4: Install `@gitbook/embed` + build the `HelpLauncher` client component

**Files:**
- Modify: `package.json`, `package-lock.json` (via `npm install`)
- Create: `src/platform/ui/help/help-launcher.tsx`

**Interfaces:**
- Consumes: `GET /api/gitbook/embed-token` (Task 2); `seedForPathname` (Task 3); `GitBookProvider` / `GitBookFrame` from `@gitbook/embed/react`.
- Produces: `HelpLauncher({ siteURL, moduleLabels }: { siteURL: string; moduleLabels: Record<string, string> })` — a client component. Consumed by Task 5.

- [ ] **Step 1: Install the package**

Run: `npm install @gitbook/embed`
Expected: `@gitbook/embed` added to `dependencies` in `package.json`; `package-lock.json` updated.

- [ ] **Step 2: Verify the package's exported API**

Run: `cat node_modules/@gitbook/embed/package.json` (inspect the `exports` map for a `./react` entry) and locate its React type declarations:
`find node_modules/@gitbook/embed -name "*.d.ts" | head -20`, then read the React entry's `.d.ts`.

Confirm the exported names and props used in Step 3: `GitBookProvider` (prop `siteURL`), `GitBookFrame` (props `visitor`, `tabs`, `greeting`, `suggestions`, `colorScheme`, `className`). If any name or prop differs in the installed version, adjust Step 3's component to match the real types before writing the test-less component (there is no unit test for this file; typecheck in Step 4 is the gate, so the props must match the shipped types exactly).

- [ ] **Step 3: Write the client component**

Create `src/platform/ui/help/help-launcher.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { CircleHelp, X } from "lucide-react";
import { seedForPathname } from "./help-context";

// The embed touches window/document, so load it client-only.
const GitBookProvider = dynamic(
  () => import("@gitbook/embed/react").then((m) => m.GitBookProvider),
  { ssr: false }
);
const GitBookFrame = dynamic(
  () => import("@gitbook/embed/react").then((m) => m.GitBookFrame),
  { ssr: false }
);

/** Re-fetch the visitor token this many ms before it expires. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

type TokenState = { token: string; expiresAt: number } | null;

export function HelpLauncher({
  siteURL,
  moduleLabels,
}: {
  siteURL: string;
  moduleLabels: Record<string, string>;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [tokenState, setTokenState] = useState<TokenState>(null);
  const [error, setError] = useState<string | null>(null);
  const [colorScheme, setColorScheme] = useState<"light" | "dark">("light");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadToken = useCallback(async () => {
    try {
      const res = await fetch("/api/gitbook/embed-token", { cache: "no-store" });
      if (!res.ok) {
        setError(
          res.status === 401 ? "Please sign in to view help." : "Help is unavailable right now."
        );
        setTokenState(null);
        return;
      }
      const json = (await res.json()) as { token: string; expiresAt: number };
      setError(null);
      setTokenState(json);
    } catch {
      setError("Help is unavailable right now.");
      setTokenState(null);
    }
  }, []);

  // Toggling is an event handler (not render/effect), so reading the DOM here is safe and
  // avoids the react-hooks set-state-in-effect rule. Every open re-fetches a fresh token.
  function toggle() {
    const next = !open;
    setOpen(next);
    if (next) {
      setColorScheme(
        document.documentElement.classList.contains("dark") ? "dark" : "light"
      );
      void loadToken();
    }
  }

  // While open with a token, schedule a refresh shortly before it expires. The timeout
  // callback (not the effect body) triggers the async reload, so this is not a
  // synchronous setState-in-effect.
  useEffect(() => {
    if (!open || !tokenState) return;
    const delay = Math.max(0, tokenState.expiresAt - Date.now() - REFRESH_SKEW_MS);
    timer.current = setTimeout(() => void loadToken(), delay);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [open, tokenState, loadToken]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const seed = seedForPathname(pathname ?? "/", moduleLabels);

  return (
    <>
      <button
        type="button"
        onClick={toggle}
        aria-label="Help and documentation"
        aria-haspopup="dialog"
        aria-expanded={open}
        className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
      >
        <CircleHelp aria-hidden className="h-4 w-4" />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Help and documentation"
          className="fixed inset-x-0 bottom-0 z-50 sm:inset-x-auto sm:bottom-4 sm:right-4"
        >
          <div className="glass-panel flex h-[80vh] w-full flex-col overflow-hidden rounded-t-2xl sm:h-[600px] sm:w-[400px] sm:rounded-2xl">
            <div className="flex items-center justify-between border-b border-border-subtle px-4 py-2.5">
              <span className="text-sm font-semibold text-foreground">Help</span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close help"
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
              >
                <X aria-hidden className="h-4 w-4" />
              </button>
            </div>
            <div className="min-h-0 flex-1">
              {error ? (
                <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
                  {error}
                </div>
              ) : tokenState ? (
                <GitBookProvider siteURL={siteURL}>
                  <GitBookFrame
                    visitor={{ token: tokenState.token }}
                    tabs={["assistant", "search", "docs"]}
                    greeting={seed.greeting}
                    suggestions={seed.suggestions}
                    colorScheme={colorScheme}
                    className="h-full w-full"
                  />
                </GitBookProvider>
              ) : (
                <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
                  Loading…
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 4: Typecheck (the gate for this file)**

Run: `npm run typecheck`
Expected: no errors. If the `@gitbook/embed` types reject any prop, reconcile against the types you read in Step 2 and re-run.

- [ ] **Step 5: Lint the new component**

Run: `npx eslint src/platform/ui/help/help-launcher.tsx`
Expected: no errors (in particular no `react-hooks/set-state-in-effect` or purity violations).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/platform/ui/help/help-launcher.tsx
git commit -m "feat(help): GitBook embed HelpLauncher client component"
```

---

### Task 5: Wire `HelpLauncher` into the app shell + document env

**Files:**
- Modify: `src/platform/ui/app-shell.tsx`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `HelpLauncher` (Task 4); `config.GITBOOK_SITE_URL` / `config.GITBOOK_JWT_KEY`; `MODULES` (already imported in app-shell).
- Produces: the launcher rendered in the toolbar right cluster (between `ThemeToggle` and `NotificationBell`) only when GitBook is configured.

- [ ] **Step 1: Add the config + HelpLauncher imports**

In `src/platform/ui/app-shell.tsx`, add these imports alongside the existing ones (note `config` and the new component; `MODULES` is already imported at the top):

```ts
import { config } from "@/platform/config";
import { HelpLauncher } from "./help/help-launcher";
```

- [ ] **Step 2: Build the module-label map**

In `AppShell`, right after the existing `const breadcrumbModules: BreadcrumbModule[] = MODULES.map(...)` block, add:

```ts
// Top-level route segment (== module id) -> human title, for the Help widget's
// context seeding. Built here so the client never imports the server registry.
const moduleLabels = Object.fromEntries(MODULES.map((m) => [m.id, m.title]));
const gitbookEnabled = Boolean(config.GITBOOK_SITE_URL && config.GITBOOK_JWT_KEY);
```

- [ ] **Step 3: Render the launcher in the right cluster**

In the toolbar's right-cluster `div` (`<div className="flex shrink-0 items-center gap-2 sm:gap-3">`), insert the launcher between `<ThemeToggle initial={resolvedTheme} />` and `<NotificationBell />`:

```tsx
            <ThemeToggle initial={resolvedTheme} />
            {gitbookEnabled && (
              <HelpLauncher siteURL={config.GITBOOK_SITE_URL as string} moduleLabels={moduleLabels} />
            )}
            <NotificationBell />
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Document the env vars**

In `.env.example`, immediately after the existing `PORTAL_BASE_URL=` line, add:

```bash

# GitBook docs visitor authentication + in-app Help widget. When BOTH are set, the docs
# redirect flow (/api/gitbook/auth) and the in-app Help launcher are enabled; when either is
# unset the endpoints respond 503 and the Help button does not render.
#   GITBOOK_JWT_KEY  -- per-site signing key from GitBook (Site > Audience > Custom).
#   GITBOOK_SITE_URL -- the PUBLISHED site URL, matching exactly the site the embed serves
#                       (e.g. https://docs.havenfreeclinic.org).
GITBOOK_JWT_KEY=
GITBOOK_SITE_URL=
```

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: PASS. In particular the GitBook suite (`visitor-token`, `auth/route`, `embed-token/route`, `help-context`) and the frozen adaptive suite (`schema-artifact`, `catalog`, `adaptive-claims`) are all green.

- [ ] **Step 7: Lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 8: Manual verification**

If `GITBOOK_JWT_KEY` + `GITBOOK_SITE_URL` are available locally, add them to `.env`, run `npm run dev`, sign in, and confirm: the `CircleHelp` button appears in the toolbar; clicking it opens the panel; the GitBook Assistant/Search/Docs frame loads authenticated (no GitBook sign-in prompt); the greeting reflects the current module (e.g. open it under `/recruitment`). If the GitBook env is not available locally, instead confirm the gating: with the vars unset the button does not render and `curl -i localhost:3000/api/gitbook/embed-token` returns 401 (signed out) or 503 (unset). Note in the PR which path was used.

- [ ] **Step 9: Commit**

```bash
git add src/platform/ui/app-shell.tsx .env.example
git commit -m "feat(help): mount GitBook help launcher in the app shell (config-gated)"
```

---

## Notes for the implementer

- **`GITBOOK_SITE_URL` must be the published URL the embed serves from.** The embed's `siteURL` must match exactly. The repo's config comment shows a `gitbook.io` base while the public host is `docs.havenfreeclinic.org`. Confirm the production value points at whatever GitBook serves the embed from; a mismatch makes the frame fail to load.
- **External GitBook dashboard prerequisites (not code):** embedding and the AI Assistant must be enabled on the site/plan, and if GitBook enforces an embed-origin allowlist, the app origin must be added. Visitor/adaptive auth is already configured for the redirect flow; the embed reuses the same key and claims.
- **CSP:** there is no app-wide CSP today, so the embed iframe is not blocked. If one is added later, allowlist the GitBook embed origin(s) in `frame-src` / `connect-src` / `script-src`.
- **No render test for `HelpLauncher`** by design: the testable logic lives in `help-context.ts` (Task 3). The component is verified by typecheck + lint + manual run, to avoid a brittle test against the third-party frame.

## Self-Review

- **Spec coverage:** shared mint helper (Task 1) ✓; embed-token endpoint with 503/401/403/200 (Task 2) ✓; light context-seeding, no page map (Task 3) ✓; SSR-safe client widget with assistant/search/docs tabs, token refresh, toolbar placement next to the bell (Tasks 4-5) ✓; config gating + `.env.example` (Task 5) ✓; `GITBOOK_SITE_URL` reconciliation + GitBook prereqs + CSP note (Notes) ✓; frozen adaptive schema + unchanged redirect behavior (Global Constraints + Task 1 Step 6) ✓; testing across all new units (Tasks 1-3, 5 Step 6) ✓.
- **Placeholder scan:** none; every code step contains complete code and exact commands.
- **Type consistency:** `VisitorToken`/`VisitorPerson`/`mintVisitorToken` defined in Task 1 and consumed with matching shapes in Task 2; `{ token, expiresAt }` shape consistent across endpoint, test, and `HelpLauncher`; `HelpSeed`/`seedForPathname`/`moduleTitleForPath` defined in Task 3 and consumed in Task 4; `HelpLauncher({ siteURL, moduleLabels })` signature matches the Task 5 call site.
