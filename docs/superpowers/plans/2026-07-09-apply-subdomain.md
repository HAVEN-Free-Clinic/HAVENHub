# Apply Portal Custom Subdomain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the public application portal from `apply.havenfreeclinic.org` (clean URLs like `apply.havenfreeclinic.org/<slug>`) using the existing single Next.js app, with all portal auth self-contained on that host so the hub login is untouched.

**Architecture:** A host check in `src/proxy.ts` rewrites the portal host onto the existing `/apply` route tree (URLs stay pretty; pass-throughs keep `/api`, `/login`, `/apply/*`, assets working). A `PORTAL_BASE_URL` env is the single source for the portal origin. Pure string helpers drive routing, link generation, and a host-safe magic-link base selection that never interpolates the raw `Host` header.

**Tech Stack:** Next.js 16 (App Router, `proxy.ts`, Node runtime), TypeScript, Auth.js/NextAuth (`trustHost: true`), Vitest, Zod, Prisma.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-09-apply-subdomain-design.md`.
- No em-dashes anywhere in code or copy (project rule + ESLint `no-em-dash`). Use commas, periods, or parentheses. Ellipsis `…` is allowed.
- Never derive a base URL by interpolating the request `Host` header (it is attacker-controllable, per `config.ts:39-42` and `portal-auth.ts:132-135`). The `Host` may only be compared for equality against a known configured value.
- Do not change the hub's NextAuth cookie config, do not add `AUTH_URL`, do not redirect `<hub>/apply`.
- Do not change the stored value or role of the `app.baseUrl` setting.
- TDD: write the failing test first, watch it fail, implement minimally, watch it pass, commit. Tests are colocated `*.test.ts` run with Vitest.
- Pure helpers must have no `next/*`, `prisma`, or `config` imports so they unit-test without a DB or request context.
- Run a single Vitest file with: `npx vitest run <path>`.

---

### Task 1: Pure portal routing + URL helpers

**Files:**
- Create: `src/modules/recruitment/services/portal-routing.ts`
- Test: `src/modules/recruitment/services/portal-routing.test.ts`

**Interfaces:**
- Produces:
  - `RESERVED_PORTAL_SLUGS: readonly string[]`
  - `hostFromUrl(url: string | undefined | null): string | null`
  - `isPortalPassThrough(pathname: string): boolean`
  - `rewriteToApply(pathname: string): string`
  - `isReservedSlug(slug: string): boolean`
  - `buildPortalUrl(portalBase: string | undefined, appBase: string, slug?: string): string`
  - `pickPortalEmailBase(requestHost: string | null, portalBase: string | undefined, appBase: string): string`

- [ ] **Step 1: Write the failing test**

Create `src/modules/recruitment/services/portal-routing.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  RESERVED_PORTAL_SLUGS,
  hostFromUrl,
  isPortalPassThrough,
  rewriteToApply,
  isReservedSlug,
  buildPortalUrl,
  pickPortalEmailBase,
} from "./portal-routing";

describe("hostFromUrl", () => {
  it("returns the host for a valid url", () => {
    expect(hostFromUrl("https://apply.havenfreeclinic.org")).toBe("apply.havenfreeclinic.org");
  });
  it("returns null for empty or invalid input", () => {
    expect(hostFromUrl(undefined)).toBeNull();
    expect(hostFromUrl("")).toBeNull();
    expect(hostFromUrl("not a url")).toBeNull();
  });
});

describe("isPortalPassThrough", () => {
  it("passes through app, auth, assets, and reserved first segments", () => {
    for (const p of ["/apply", "/apply/fall-2026", "/api/auth/callback/x", "/login", "/_next/x", "/brand/login-building.webp", "/favicon.ico"]) {
      expect(isPortalPassThrough(p)).toBe(true);
    }
  });
  it("does not pass through the root or a cycle slug", () => {
    expect(isPortalPassThrough("/")).toBe(false);
    expect(isPortalPassThrough("/fall-2026")).toBe(false);
  });
});

describe("rewriteToApply", () => {
  it("maps root to /apply and a slug under /apply", () => {
    expect(rewriteToApply("/")).toBe("/apply");
    expect(rewriteToApply("/fall-2026")).toBe("/apply/fall-2026");
  });
});

describe("isReservedSlug", () => {
  it("flags reserved words and clears normal slugs", () => {
    expect(isReservedSlug("api")).toBe(true);
    expect(isReservedSlug("LOGIN")).toBe(true);
    expect(isReservedSlug("fall-2026")).toBe(false);
  });
  it("keeps the reserved set aligned with pass-through first segments", () => {
    for (const s of RESERVED_PORTAL_SLUGS) expect(isPortalPassThrough(`/${s}`)).toBe(true);
  });
});

describe("buildPortalUrl", () => {
  it("uses the pretty form when a portal base is set", () => {
    expect(buildPortalUrl("https://apply.havenfreeclinic.org", "https://hub.example.org", "fall-2026"))
      .toBe("https://apply.havenfreeclinic.org/fall-2026");
    expect(buildPortalUrl("https://apply.havenfreeclinic.org/", "https://hub.example.org"))
      .toBe("https://apply.havenfreeclinic.org");
  });
  it("falls back to the /apply-prefixed hub path when no portal base", () => {
    expect(buildPortalUrl(undefined, "https://hub.example.org", "fall-2026"))
      .toBe("https://hub.example.org/apply/fall-2026");
    expect(buildPortalUrl(undefined, "https://hub.example.org/"))
      .toBe("https://hub.example.org/apply");
  });
});

describe("pickPortalEmailBase", () => {
  const portal = "https://apply.havenfreeclinic.org";
  const app = "https://hub.example.org";
  it("returns the portal base only when the request host matches it", () => {
    expect(pickPortalEmailBase("apply.havenfreeclinic.org", portal, app)).toBe(portal);
  });
  it("returns the app base for any other or missing host", () => {
    expect(pickPortalEmailBase("hub.example.org", portal, app)).toBe(app);
    expect(pickPortalEmailBase("evil.com", portal, app)).toBe(app);
    expect(pickPortalEmailBase(null, portal, app)).toBe(app);
    expect(pickPortalEmailBase("apply.havenfreeclinic.org", undefined, app)).toBe(app);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/recruitment/services/portal-routing.test.ts`
Expected: FAIL (cannot find module `./portal-routing`).

- [ ] **Step 3: Write minimal implementation**

Create `src/modules/recruitment/services/portal-routing.ts`:

```ts
/**
 * Pure string helpers for the public application portal's custom subdomain.
 * No next/prisma/config imports so they run in unit tests and in the proxy layer.
 *
 * The portal is served from a dedicated host (PORTAL_BASE_URL) that rewrites onto
 * the existing /apply route tree. These helpers decide what to rewrite, keep the
 * reserved-slug list in sync with the proxy pass-throughs, and build canonical
 * portal links.
 */

/**
 * First path segments the proxy must NOT rewrite onto /apply, which therefore
 * cannot be used as a cycle's public slug (a slug of "api" would produce a public
 * link that collides with a pass-through and 404s for the applicant).
 */
export const RESERVED_PORTAL_SLUGS = [
  "apply",
  "api",
  "login",
  "brand",
  "verify",
  "favicon",
  "_next",
] as const;

/** Parse the host (with port, if any) from a URL string; null if empty/invalid. */
export function hostFromUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** True when a portal-host request should be served as-is (not rewritten to /apply). */
export function isPortalPassThrough(pathname: string): boolean {
  // Static files (a dot in the final segment): /brand/x.webp, /favicon.ico, /robots.txt.
  const lastSegment = pathname.split("/").pop() ?? "";
  if (lastSegment.includes(".")) return true;
  const first = pathname.split("/").filter(Boolean)[0];
  if (!first) return false; // "/" is rewritten to the portal home
  return (RESERVED_PORTAL_SLUGS as readonly string[]).includes(first);
}

/** Map a portal-host pathname onto the /apply tree. "/" -> "/apply"; "/x" -> "/apply/x". */
export function rewriteToApply(pathname: string): string {
  return pathname === "/" ? "/apply" : `/apply${pathname}`;
}

/** True when a would-be cycle slug collides with a proxy pass-through word. */
export function isReservedSlug(slug: string): boolean {
  return (RESERVED_PORTAL_SLUGS as readonly string[]).includes(slug.toLowerCase());
}

/**
 * Canonical public application URL. With a portal base set, the pretty form
 * (`${portalBase}/${slug}`) which the proxy rewrites to /apply/<slug>. Without one
 * (pre-launch), the working hub path (`${appBase}/apply/${slug}`).
 */
export function buildPortalUrl(portalBase: string | undefined, appBase: string, slug?: string): string {
  if (portalBase) {
    const base = portalBase.replace(/\/+$/, "");
    return slug ? `${base}/${slug}` : base;
  }
  const base = appBase.replace(/\/+$/, "");
  return slug ? `${base}/apply/${slug}` : `${base}/apply`;
}

/**
 * Choose the base URL for a magic-link email. Returns the portal base ONLY when
 * the request host equals the portal host, else the app base. The host is used
 * for an equality check against a known value, never interpolated into the URL,
 * so a spoofed Host cannot redirect the emailed link. Both return values are
 * trusted, configured deploy values.
 */
export function pickPortalEmailBase(
  requestHost: string | null,
  portalBase: string | undefined,
  appBase: string,
): string {
  if (portalBase && requestHost && hostFromUrl(portalBase) === requestHost) return portalBase;
  return appBase;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/recruitment/services/portal-routing.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/services/portal-routing.ts src/modules/recruitment/services/portal-routing.test.ts
git commit -m "feat(recruitment): pure portal routing and URL helpers"
```

---

### Task 2: PORTAL_BASE_URL env + portalUrl() wrapper

**Files:**
- Modify: `src/platform/config.ts` (env schema, after `APP_BASE_URL` at ~line 42)
- Create: `src/modules/recruitment/services/portal-url.ts`

**Interfaces:**
- Consumes: `buildPortalUrl` (Task 1), `getSetting` (`@/platform/settings/service`), `config` (`@/platform/config`).
- Produces: `config.PORTAL_BASE_URL: string | undefined`; `portalUrl(slug?: string): Promise<string>`.

- [ ] **Step 1: Add the env var**

In `src/platform/config.ts`, immediately after the `APP_BASE_URL` line (~42), add:

```ts
    // Public origin of the application portal's custom subdomain (e.g.
    // https://apply.havenfreeclinic.org). Optional: when unset the portal stays
    // at <APP_BASE_URL>/apply and no host rewrite happens. Deploy-time value,
    // never derived from the request Host header.
    PORTAL_BASE_URL: z.string().url().optional(),
```

- [ ] **Step 2: Write the async wrapper**

Create `src/modules/recruitment/services/portal-url.ts`:

```ts
import { config } from "@/platform/config";
import { getSetting } from "@/platform/settings/service";
import { buildPortalUrl } from "./portal-routing";

/**
 * Absolute, shareable public application URL for a cycle (or the portal home).
 * Uses PORTAL_BASE_URL when configured (pretty subdomain form), otherwise the
 * <app.baseUrl>/apply hub path so links keep working before the subdomain is live.
 */
export async function portalUrl(slug?: string): Promise<string> {
  const appBase = await getSetting<string>("app.baseUrl");
  return buildPortalUrl(config.PORTAL_BASE_URL, appBase, slug);
}
```

- [ ] **Step 3: Verify it typechecks**

Run: `npx tsc --noEmit`
Expected: no errors. (`buildPortalUrl` behavior is already covered by Task 1's tests; this task only adds the env field and a thin async wrapper.)

- [ ] **Step 4: Commit**

```bash
git add src/platform/config.ts src/modules/recruitment/services/portal-url.ts
git commit -m "feat: PORTAL_BASE_URL env and portalUrl() link helper"
```

---

### Task 3: Host-based rewrite in the proxy

**Files:**
- Modify: `src/proxy.ts`
- Test: `src/proxy.test.ts`

**Interfaces:**
- Consumes: `hostFromUrl`, `isPortalPassThrough`, `rewriteToApply` (Task 1); `NextRequest`, `NextResponse` (`next/server`).
- Produces: `resolveProxy(request: NextRequest, portalHost: string | null): NextResponse`; unchanged export `proxy(request)` and `config`.

- [ ] **Step 1: Write the failing test**

Create `src/proxy.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { resolveProxy } from "./proxy";

const PORTAL_HOST = "apply.havenfreeclinic.org";

function req(host: string, path: string): NextRequest {
  return new NextRequest(`https://${host}${path}`, { headers: { host } });
}

describe("resolveProxy", () => {
  it("rewrites the portal root and slugs onto /apply", () => {
    expect(resolveProxy(req(PORTAL_HOST, "/"), PORTAL_HOST).headers.get("x-middleware-rewrite"))
      .toContain("/apply");
    const slug = resolveProxy(req(PORTAL_HOST, "/fall-2026"), PORTAL_HOST);
    expect(slug.headers.get("x-middleware-rewrite")).toContain("/apply/fall-2026");
  });

  it("preserves the query string on rewrite", () => {
    const res = resolveProxy(req(PORTAL_HOST, "/fall-2026?type=renewal"), PORTAL_HOST);
    expect(res.headers.get("x-middleware-rewrite")).toContain("/apply/fall-2026?type=renewal");
  });

  it("passes through auth, api, existing /apply, and assets on the portal host", () => {
    for (const p of ["/login", "/api/auth/callback/x", "/apply/fall-2026", "/brand/login-building.webp"]) {
      expect(resolveProxy(req(PORTAL_HOST, p), PORTAL_HOST).headers.get("x-middleware-rewrite")).toBeNull();
    }
  });

  it("never rewrites on a non-portal host", () => {
    expect(resolveProxy(req("hub.example.org", "/fall-2026"), PORTAL_HOST).headers.get("x-middleware-rewrite")).toBeNull();
    expect(resolveProxy(req("hub.example.org", "/fall-2026"), null).headers.get("x-middleware-rewrite")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/proxy.test.ts`
Expected: FAIL (`resolveProxy` is not exported).

- [ ] **Step 3: Rewrite `src/proxy.ts`**

Replace the whole file with:

```ts
import { NextResponse, type NextRequest } from "next/server";
import { hostFromUrl, isPortalPassThrough, rewriteToApply } from "@/modules/recruitment/services/portal-routing";

/**
 * Per-request proxy (Next 16 renamed `middleware` to `proxy`; Node runtime).
 *
 * 1. Stamps the incoming pathname into a header so server components (the
 *    onboarding gate in requirePersonSession) can read the current path.
 * 2. On the application-portal host (PORTAL_BASE_URL), rewrites clean portal
 *    URLs onto the existing /apply route tree, so apply.havenfreeclinic.org/<slug>
 *    serves /apply/<slug> without exposing the prefix. Auth, api, existing
 *    /apply/* paths, and static assets pass through untouched.
 *
 * The matcher below already excludes api/_next/image/favicon at the data/asset
 * layer; the pass-through check guards the remaining routes on the portal host.
 */
export function resolveProxy(request: NextRequest, portalHost: string | null): NextResponse {
  const headers = new Headers(request.headers);
  headers.set("x-pathname", request.nextUrl.pathname);

  const host = request.headers.get("host");
  if (portalHost && host === portalHost && !isPortalPassThrough(request.nextUrl.pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = rewriteToApply(request.nextUrl.pathname);
    return NextResponse.rewrite(url, { request: { headers } });
  }

  return NextResponse.next({ request: { headers } });
}

export function proxy(request: NextRequest): NextResponse {
  return resolveProxy(request, hostFromUrl(process.env.PORTAL_BASE_URL));
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/proxy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/proxy.ts src/proxy.test.ts
git commit -m "feat: rewrite the apply-portal host onto /apply in proxy"
```

---

### Task 4: Host-safe magic-link base in portal-auth

**Files:**
- Modify: `src/modules/recruitment/services/portal-auth.ts` (imports at 45-48 and 111-114; `requestMagicLink` body at ~131-142)

**Interfaces:**
- Consumes: `pickPortalEmailBase` (Task 1), `config.PORTAL_BASE_URL` (Task 2), `headers` (`next/headers`), `getSetting`.

- [ ] **Step 1: Add the `headers` import**

In `src/modules/recruitment/services/portal-auth.ts`, change the `next/headers` import at line 46 from:

```ts
import { cookies } from "next/headers";
```

to:

```ts
import { cookies, headers } from "next/headers";
```

- [ ] **Step 2: Import the selector near the other magic-link imports**

After line 114 (`import { safeNextPath, PORTAL_HOME } from "./portal-next";`), add:

```ts
import { pickPortalEmailBase } from "./portal-routing";
```

- [ ] **Step 3: Select the base by host, not by a single setting**

In `requestMagicLink`, replace this block (currently ~132-136):

```ts
  // Resolve the public base URL through the admin-configurable setting (a trusted
  // deploy/admin value, never the request Host header), matching every other
  // outbound-email link. Using config.APP_BASE_URL directly here meant the magic
  // link alone ignored a configured custom domain and emitted the raw env value.
  const baseUrl = await getSetting<string>("app.baseUrl");
```

with:

```ts
  // Pick the base URL for the emailed link between two trusted, configured values:
  // the portal subdomain when the applicant is verifiably ON it, else the hub base.
  // The request Host is only compared for equality against the known portal host,
  // never interpolated, so a spoofed Host cannot point the link elsewhere. This
  // keeps the applicant's cookie (set by /apply/verify) on the host they are using.
  const appBase = await getSetting<string>("app.baseUrl");
  const requestHost = (await headers()).get("host");
  const baseUrl = pickPortalEmailBase(requestHost, config.PORTAL_BASE_URL, appBase);
```

(The following lines that build `url` from `${baseUrl}/apply/verify?...` are unchanged.)

- [ ] **Step 4: Verify typecheck and the existing portal-auth suite still pass**

Run: `npx tsc --noEmit && npx vitest run src/modules/recruitment/services/portal-auth.test.ts`
Expected: no type errors; the existing portal-auth tests pass. (The selection logic itself is covered by `pickPortalEmailBase` tests in Task 1.)

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/services/portal-auth.ts
git commit -m "feat(recruitment): send magic links on the host the applicant is using"
```

---

### Task 5: Reject reserved slugs at cycle creation

**Files:**
- Modify: `src/app/(app)/recruitment/actions.ts` (`createCycleAction`, ~16-28)

**Interfaces:**
- Consumes: `isReservedSlug` (Task 1).

- [ ] **Step 1: Import the guard**

In `src/app/(app)/recruitment/actions.ts`, add to the imports (after line 10):

```ts
import { isReservedSlug } from "@/modules/recruitment/services/portal-routing";
```

- [ ] **Step 2: Reject a reserved slug alongside the existing validation**

In `createCycleAction`, replace:

```ts
  const slug = slugify(String(formData.get("publicSlug") || title));
  if (!title || !slug) {
    redirect(`/recruitment/cycles/new?error=${encodeURIComponent("Title is required.")}`);
  }
```

with:

```ts
  const slug = slugify(String(formData.get("publicSlug") || title));
  if (!title || !slug) {
    redirect(`/recruitment/cycles/new?error=${encodeURIComponent("Title is required.")}`);
  }
  if (isReservedSlug(slug)) {
    redirect(`/recruitment/cycles/new?error=${encodeURIComponent(`"${slug}" is a reserved word. Choose a different public link.`)}`);
  }
```

- [ ] **Step 3: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. (`isReservedSlug` is covered by Task 1's tests.)

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/recruitment/actions.ts"
git commit -m "feat(recruitment): reject reserved words as cycle public slugs"
```

---

### Task 6: Cycle admin "Public link" uses the portal URL

**Files:**
- Modify: `src/app/(app)/recruitment/cycles/[id]/page.tsx` (line 50)

**Interfaces:**
- Consumes: `portalUrl` (Task 2). The page is already an async server component.

- [ ] **Step 1: Import the helper**

Add to the imports at the top of `src/app/(app)/recruitment/cycles/[id]/page.tsx`:

```ts
import { portalUrl } from "@/modules/recruitment/services/portal-url";
```

- [ ] **Step 2: Resolve the absolute portal URL**

Replace line 50:

```ts
  const applyUrl = `/apply/${cycle.publicSlug}`;
```

with:

```ts
  const applyUrl = await portalUrl(cycle.publicSlug);
```

(The existing `href={applyUrl}` and display usages at lines 88-92 and 105 now show the full, copyable `apply.havenfreeclinic.org/<slug>` URL.)

- [ ] **Step 3: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/recruitment/cycles/[id]/page.tsx"
git commit -m "feat(recruitment): show the subdomain URL as the cycle public link"
```

---

### Task 7: Document the env + full verification

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Add `PORTAL_BASE_URL` to `.env.example`**

After the `# --- Auth ---` block (after the `AZURE_AD_TENANT_ID=` line), add:

```bash

# --- Public URLs -------------------------------------------------------------
# Custom subdomain for the public application portal. When set, the portal is
# served from this origin (e.g. https://apply.havenfreeclinic.org/<slug>) via a
# host rewrite in src/proxy.ts, and shareable public links use it. Leave unset to
# keep the portal at <app>/apply. Deploy-time value; never from the request Host.
# Also add the Entra redirect URI <PORTAL_BASE_URL>/api/auth/callback/microsoft-entra-id
# in Azure, and confirm AUTH_URL / NEXTAUTH_URL is NOT pinned (rely on trustHost).
PORTAL_BASE_URL=
```

- [ ] **Step 2: Full verification**

Run: `npx tsc --noEmit && npx eslint src/proxy.ts "src/app/(app)/recruitment/actions.ts" "src/app/(app)/recruitment/cycles/[id]/page.tsx" src/modules/recruitment/services/portal-routing.ts src/modules/recruitment/services/portal-url.ts src/modules/recruitment/services/portal-auth.ts && npx vitest run src/modules/recruitment/services/portal-routing.test.ts src/proxy.test.ts src/modules/recruitment/services/portal-auth.test.ts`
Expected: no type errors, no lint errors, all listed tests pass.

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "docs: document PORTAL_BASE_URL and the subdomain deploy steps"
```

---

## Post-implementation (owner: Jack, out-of-band)

Not code; do these to switch the subdomain on (see spec "Rollout"):
1. Vercel: attach `apply.havenfreeclinic.org` to the project (reported done); set `PORTAL_BASE_URL=https://apply.havenfreeclinic.org`.
2. Azure/Entra: add redirect URI `https://apply.havenfreeclinic.org/api/auth/callback/microsoft-entra-id`.
3. Confirm `AUTH_URL` / `NEXTAUTH_URL` is not host-pinned in Vercel env.
4. Smoke test on the subdomain: new-applicant magic-link flow and returning Yale-SSO flow both complete; the cycle "Public link" shows the subdomain URL.

## Self-Review (author checklist, done)

- Spec coverage: routing rewrite (Task 3), PORTAL_BASE_URL + portalUrl (Task 2), self-contained magic link (Tasks 1+4), Yale SSO on subdomain (no code change needed; verified in spec, exercised in post-impl smoke test), slug reservation (Tasks 1+5), shared public link (Task 6), env/docs + AUTH_URL preflight (Task 7 + post-impl). Hub `/apply` still works (proxy only acts on the portal host; no redirect added).
- Placeholder scan: none.
- Type consistency: helper names/signatures identical across Tasks 1-6 (`hostFromUrl`, `isPortalPassThrough`, `rewriteToApply`, `isReservedSlug`, `buildPortalUrl`, `pickPortalEmailBase`, `portalUrl`, `resolveProxy`).
