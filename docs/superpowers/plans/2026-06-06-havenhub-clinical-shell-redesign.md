# HAVENHub Clinical Shell Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the generic slate card UI with a Clinical SaaS design system using Yale Blue (#00356b), Inter typography, a branded login split-panel, and a structured hub shell — matching havenfreeclinic.org brand identity.

**Architecture:** Design tokens live in `globals.css` as a Tailwind v4 `@theme` block; Inter is loaded via `next/font/google` in `layout.tsx`; a new `HavenMark` inline-SVG component provides the brand oval in both blue (chrome) and white (login) contexts; the AppShell gains a brand accent line, structured header, and optional term chip; hub and login pages are rewritten with the new visual system while preserving all logic and e2e-tested selectors.

**Tech Stack:** Next.js 16 (App Router, React Server Components), Tailwind CSS v4, `next/font/google` (Inter), Prisma (term query), Playwright (e2e + visual verification screenshots), Vitest (35 unit tests must still pass)

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/app/globals.css` | Modify | Add `@theme` block with Yale Blue tokens and font variable |
| `src/app/layout.tsx` | Modify | Load Inter via next/font, apply `${inter.variable} font-sans` on body |
| `src/platform/ui/haven-mark.tsx` | Create | Inline SVG brand oval component, `fill="currentColor"` |
| `src/app/icon.svg` | Create | Copy of `public/brand/haven-favicon.svg` for Next.js auto-favicon |
| `src/platform/ui/app-shell.tsx` | Modify | Brand accent line, structured header with mark+term chip, slim footer, `termLabel` prop |
| `src/app/hub/page.tsx` | Modify | Term query, new h1/h2 structure, active/coming-soon tile redesign |
| `src/app/login/page.tsx` | Modify | Two-panel split with plus-pattern left panel, restyled right panel |
| `src/app/welcome/page.tsx` | Modify | White card with HavenMark, outline sign-out button |
| `/tmp/havenhub-shots/` (runtime) | Create | Throwaway screenshot dir — NOT committed |

---

## Task 1: Design Tokens — globals.css

**Files:**
- Modify: `src/app/globals.css`

- [ ] **Step 1: Read current file**

The file currently contains only `@import "tailwindcss";`.

- [ ] **Step 2: Write the updated globals.css**

```css
@import "tailwindcss";

@theme {
  --color-brand: #00356b;        /* Yale Blue — canonical, from havenfreeclinic.org */
  --color-brand-hover: #0a4a8c;
  --color-brand-deep: #002347;
  --color-brand-light: #d6e8f7;
  --color-brand-faint: #f0f5fb;

  --color-success: #16a34a;
  --color-warning: #d97706;
  --color-critical: #dc2626;
  --color-info: #2563eb;

  --font-sans: var(--font-inter), ui-sans-serif, system-ui, sans-serif;
}
```

Write that exact content to `src/app/globals.css` (replacing the single-line original).

- [ ] **Step 3: Verify lint passes**

```bash
cd /Users/jcarney/Documents/Code-Projects/HAVENHub && npm run lint
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/app/globals.css
git commit -m "feat: add Yale Blue design tokens and Inter font variable to Tailwind @theme"
```

---

## Task 2: Inter Font — layout.tsx

**Files:**
- Modify: `src/app/layout.tsx`

- [ ] **Step 1: Update layout.tsx**

Replace the contents of `src/app/layout.tsx` with:

```tsx
import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Inter } from "next/font/google";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata: Metadata = {
  title: "HAVENHub",
  description: "HAVEN Free Clinic — unified platform",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className={`${inter.variable} min-h-screen bg-slate-50 font-sans text-slate-900 antialiased`}>
        {children}
      </body>
    </html>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/jcarney/Documents/Code-Projects/HAVENHub && npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/layout.tsx
git commit -m "feat: load Inter via next/font and wire --font-inter CSS variable to body"
```

---

## Task 3: HavenMark Component

**Files:**
- Create: `src/platform/ui/haven-mark.tsx`

The oval mark SVG is at `public/brand/haven-mark.svg`. Its key paths:
- Viewbox: `0 0 73.6439 76`
- Oval: `<path d="M36.8223 1.2373C56.4385 1.23748 72.4062 17.6597 72.4062 38C72.4062 58.3403 56.4385 74.7625 36.8223 74.7627C17.2059 74.7627 1.2373 58.3405 1.2373 38C1.2373 17.6595 17.2059 1.2373 36.8223 1.2373Z" stroke="currentColor" stroke-width="2.47477"/>`
- Text: `<text x="36.8" y="38" text-anchor="middle" dominant-baseline="central" font-family="Poppins, sans-serif" font-weight="600" font-size="11" fill="currentColor" letter-spacing="0.3">HAVEN</text>`

Note: The original SVG uses `stroke="#00356b"` and `fill="#00356b"` for text. We replace all hardcoded colors with `currentColor` so CSS controls the color (blue in chrome, white on login panel).

- [ ] **Step 1: Create the component file**

```tsx
// src/platform/ui/haven-mark.tsx

export function HavenMark({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 73.6439 76"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <path
        d="M36.8223 1.2373C56.4385 1.23748 72.4062 17.6597 72.4062 38C72.4062 58.3403 56.4385 74.7625 36.8223 74.7627C17.2059 74.7627 1.2373 58.3405 1.2373 38C1.2373 17.6595 17.2059 1.2373 36.8223 1.2373Z"
        stroke="currentColor"
        strokeWidth="2.47477"
      />
      <text
        x="36.8"
        y="38"
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily="Poppins, sans-serif"
        fontWeight="600"
        fontSize="11"
        fill="currentColor"
        letterSpacing="0.3"
      >
        HAVEN
      </text>
    </svg>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/jcarney/Documents/Code-Projects/HAVENHub && npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/platform/ui/haven-mark.tsx
git commit -m "feat: add HavenMark inline SVG component with currentColor theming"
```

---

## Task 4: Favicon

**Files:**
- Create: `src/app/icon.svg` (copy of `public/brand/haven-favicon.svg`)

Next.js App Router automatically serves `src/app/icon.svg` as the favicon without any metadata config.

- [ ] **Step 1: Copy the favicon file**

```bash
cp /Users/jcarney/Documents/Code-Projects/HAVENHub/public/brand/haven-favicon.svg \
   /Users/jcarney/Documents/Code-Projects/HAVENHub/src/app/icon.svg
```

The favicon SVG content is:
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <style>
    :root { color: #000; }
    @media (prefers-color-scheme: dark) { :root { color: #fff; } }
  </style>
  <circle cx="50" cy="50" r="44" fill="none" stroke="currentColor" stroke-width="4" />
  <text x="50" y="51" text-anchor="middle" dominant-baseline="central"
        font-family="-apple-system, BlinkMacSystemFont, 'Helvetica Neue', Helvetica, Arial, sans-serif"
        font-weight="900" font-size="22" letter-spacing="0.5" fill="currentColor">HAVEN</text>
</svg>
```

- [ ] **Step 2: Commit**

```bash
git add src/app/icon.svg
git commit -m "feat: add HAVEN favicon SVG as src/app/icon.svg for Next.js auto-serve"
```

---

## Task 5: App Shell Redesign

**Files:**
- Modify: `src/platform/ui/app-shell.tsx`

The new shell has:
- 2px `bg-brand` top accent line
- White header `border-b border-slate-200` with `max-w-6xl mx-auto px-6 h-14`
  - Left: HavenMark + "HAVENHub" text + optional term chip
  - Right: user name + sign-out form (quiet styles)
- New optional prop: `termLabel?: string | null`
- Main: `mx-auto max-w-6xl px-6 py-10`
- Footer: `mx-auto max-w-6xl px-6 py-8 text-xs text-slate-400`

- [ ] **Step 1: Rewrite app-shell.tsx**

```tsx
// src/platform/ui/app-shell.tsx
import type { ReactNode } from "react";
import Link from "next/link";
import { signOut } from "@/platform/auth/auth";
import { HavenMark } from "./haven-mark";

export function AppShell({
  userName,
  termLabel,
  children,
}: {
  userName: string | null;
  termLabel?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen flex flex-col">
      {/* Brand accent line */}
      <div className="h-0.5 bg-brand" />

      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 h-14">
          <div className="flex items-center gap-2">
            <Link href="/hub" className="flex items-center gap-2 hover:opacity-80 transition-opacity">
              <HavenMark className="h-7 w-auto text-brand" />
              <span className="font-semibold tracking-tight">HAVENHub</span>
            </Link>
            {termLabel && (
              <span className="ml-1 rounded-full bg-brand-faint px-2.5 py-0.5 text-xs font-medium text-brand">
                {termLabel}
              </span>
            )}
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm text-slate-600">{userName}</span>
            <form
              action={async () => {
                "use server";
                await signOut({ redirectTo: "/login" });
              }}
            >
              <button
                type="submit"
                className="text-sm font-medium text-slate-500 hover:text-slate-900 transition-colors"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl px-6 py-10 flex-1">
        {children}
      </main>

      <footer className="border-t border-slate-100">
        <div className="mx-auto max-w-6xl px-6 py-8 text-xs text-slate-400">
          HAVEN Free Clinic · Yale University
        </div>
      </footer>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/jcarney/Documents/Code-Projects/HAVENHub && npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Run unit tests**

```bash
cd /Users/jcarney/Documents/Code-Projects/HAVENHub && npm test
```

Expected: 35 passing.

- [ ] **Step 4: Commit**

```bash
git add src/platform/ui/app-shell.tsx
git commit -m "feat: redesign AppShell with brand accent line, HavenMark, term chip, slim footer"
```

---

## Task 6: Hub Page Redesign

**Files:**
- Modify: `src/app/hub/page.tsx`

Key requirements:
- Keep `requirePersonSession()` + `getEffectivePermissions` + `hasPermission` filter — no changes to logic.
- Add active term fetch via `prisma.term.findFirst({ where: { status: "ACTIVE" }, orderBy: { startDate: "desc" } })`.
- Pass `termLabel` to AppShell.
- `<h1>` must match `/Welcome/` regex for e2e test (`getByRole("heading", { name: /Welcome/ })`).
- `<h2 className="...">Modules</h2>` visible above grid (not sr-only).
- Active tiles: white card `rounded-lg border border-slate-200 bg-white p-5 transition hover:border-brand/40 hover:shadow-sm`, icon in `bg-brand-faint` chip, wrapped in `<Link aria-label={...}>`.
- Coming-soon tiles: same structure but icon chip `bg-slate-100 text-slate-400`, title `text-slate-600`, pill badge on title row, desc `text-slate-400`. No dashed border, no opacity.

- [ ] **Step 1: Rewrite hub page.tsx**

```tsx
// src/app/hub/page.tsx
import Link from "next/link";
import { requirePersonSession } from "@/platform/auth/session";
import { getEffectivePermissions, hasPermission } from "@/platform/rbac/engine";
import { MODULES } from "@/platform/modules/registry";
import { AppShell } from "@/platform/ui/app-shell";
import { prisma } from "@/platform/db";

export default async function HubPage() {
  const person = await requirePersonSession();
  // One permission fetch per render; tiles filter in memory (never can() in a loop).
  const permissions = await getEffectivePermissions(person.personId);
  const activeTerm = await prisma.term.findFirst({
    where: { status: "ACTIVE" },
    orderBy: { startDate: "desc" },
  });

  const visible = MODULES.filter(
    (m) =>
      m.status === "coming-soon" || // roadmap is visible to everyone (spec §8)
      hasPermission(permissions, m.accessPermission)
  );

  return (
    <AppShell userName={person.name} termLabel={activeTerm?.name ?? null}>
      <h1 className="text-2xl font-semibold tracking-tight">
        Welcome{person.name ? `, ${person.name}` : ""}
      </h1>
      <p className="mt-1 text-sm text-slate-500">
        HAVEN Free Clinic{activeTerm ? ` · ${activeTerm.name}` : ""}
      </p>

      <h2 className="mt-10 text-xs font-semibold uppercase tracking-wider text-slate-400">
        Modules
      </h2>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {visible.map((m) => {
          const Icon = m.icon;

          if (m.status === "active") {
            return (
              <Link
                key={m.id}
                href={`/${m.id}`}
                aria-label={`Open ${m.title}`}
                className="rounded-lg border border-slate-200 bg-white p-5 transition hover:border-brand/40 hover:shadow-sm block"
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-md bg-brand-faint">
                  <Icon aria-hidden className="h-5 w-5 text-brand" />
                </div>
                <p className="mt-4 font-medium">{m.title}</p>
                <p className="mt-1 text-sm leading-relaxed text-slate-500">{m.description}</p>
              </Link>
            );
          }

          return (
            <div
              key={m.id}
              className="rounded-lg border border-slate-200 bg-white p-5"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-md bg-slate-100">
                <Icon aria-hidden className="h-5 w-5 text-slate-400" />
              </div>
              <div className="mt-4 flex items-center gap-2">
                <p className="font-medium text-slate-600">{m.title}</p>
                <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                  Coming soon
                </span>
              </div>
              <p className="mt-1 text-sm leading-relaxed text-slate-400">{m.description}</p>
            </div>
          );
        })}
      </div>
    </AppShell>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/jcarney/Documents/Code-Projects/HAVENHub && npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Run unit tests**

```bash
cd /Users/jcarney/Documents/Code-Projects/HAVENHub && npm test
```

Expected: 35 passing.

- [ ] **Step 4: Commit**

```bash
git add src/app/hub/page.tsx
git commit -m "feat: redesign hub page with Clinical SaaS tile system and active term chip"
```

---

## Task 7: Login Page Redesign

**Files:**
- Modify: `src/app/login/page.tsx`

Key requirements (must preserve for e2e):
- `input[name="email"]` — keep `name="email"` attribute
- Button with exact text `"Dev sign in"` — keep exact text
- Keep all server actions, session redirect, Entra conditional, NODE_ENV guard

New design:
- `min-h-screen lg:grid lg:grid-cols-[45%_1fr]`
- Left panel: `bg-brand hidden lg:flex flex-col justify-between p-10 relative overflow-hidden` with plus-sign SVG pattern overlay
- Right panel: centered column, `w-full max-w-sm` inner

- [ ] **Step 1: Rewrite login page.tsx**

```tsx
// src/app/login/page.tsx
import { redirect } from "next/navigation";
import { auth, signIn } from "@/platform/auth/auth";
import { config } from "@/platform/config";
import { HavenMark } from "@/platform/ui/haven-mark";

export default async function LoginPage() {
  const session = await auth();
  if (session?.personId) redirect("/hub");

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[45%_1fr]">
      {/* Left brand panel — desktop only */}
      <div className="hidden lg:flex bg-brand text-white flex-col justify-between p-10 relative overflow-hidden">
        {/* Plus-sign motif overlay */}
        <svg
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 h-full w-full"
          xmlns="http://www.w3.org/2000/svg"
        >
          <defs>
            <pattern
              id="plus-pattern"
              x="0"
              y="0"
              width="24"
              height="24"
              patternUnits="userSpaceOnUse"
            >
              {/* Horizontal bar of + */}
              <rect x="10" y="11" width="4" height="2" fill="white" />
              {/* Vertical bar of + */}
              <rect x="11" y="10" width="2" height="4" fill="white" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#plus-pattern)" opacity="0.06" />
        </svg>

        {/* Top: mark */}
        <div className="relative z-10">
          <HavenMark className="h-10 w-auto text-white" />
        </div>

        {/* Bottom: copy */}
        <div className="relative z-10">
          <p className="text-2xl font-semibold tracking-tight leading-snug">
            One platform for the clinic.
          </p>
          <p className="mt-2 text-sm text-white/70">
            Scheduling, volunteer management, and compliance — in one place.
          </p>
          <p className="mt-8 text-xs text-white/50">HAVEN Free Clinic · Yale University</p>
        </div>
      </div>

      {/* Mobile top band */}
      <div className="flex lg:hidden items-center gap-3 bg-brand px-6 py-4 text-white">
        <HavenMark className="h-7 w-auto text-white" />
        <span className="font-semibold tracking-tight">HAVENHub</span>
      </div>

      {/* Right panel */}
      <div className="flex items-center justify-center p-8">
        <div className="w-full max-w-sm">
          <h1 className="text-xl font-semibold tracking-tight">Sign in to HAVENHub</h1>
          <p className="mt-1 text-sm text-slate-500">Use your Yale account to continue.</p>

          {config.AZURE_AD_CLIENT_ID ? (
            <form
              className="mt-6"
              action={async () => {
                "use server";
                await signIn("microsoft-entra-id", { redirectTo: "/hub" });
              }}
            >
              <button
                type="submit"
                className="w-full rounded-md bg-brand px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
              >
                Sign in with Yale
              </button>
            </form>
          ) : (
            <p className="mt-6 rounded-md border border-warning/30 bg-amber-50 px-3 py-2 text-sm text-warning">
              Entra ID is not configured (AZURE_AD_* unset).
            </p>
          )}

          {config.NODE_ENV !== "production" && (
            <form
              className="mt-8 border-t border-slate-100 pt-6"
              action={async (formData: FormData) => {
                "use server";
                await signIn("credentials", {
                  email: formData.get("email"),
                  redirectTo: "/hub",
                });
              }}
            >
              <label
                className="text-xs font-medium uppercase tracking-wide text-slate-400"
                htmlFor="email"
              >
                Local development
              </label>
              <input
                id="email"
                name="email"
                type="email"
                required
                placeholder="j.carney@yale.edu"
                className="mt-2 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/15 outline-none"
              />
              <button
                type="submit"
                className="mt-3 w-full rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
              >
                Dev sign in
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/jcarney/Documents/Code-Projects/HAVENHub && npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Run unit tests**

```bash
cd /Users/jcarney/Documents/Code-Projects/HAVENHub && npm test
```

Expected: 35 passing.

- [ ] **Step 4: Commit**

```bash
git add src/app/login/page.tsx
git commit -m "feat: redesign login page with Yale Blue split panel, plus-pattern, and Clinical SaaS styles"
```

---

## Task 8: Welcome Page Restyle

**Files:**
- Modify: `src/app/welcome/page.tsx`

- [ ] **Step 1: Rewrite welcome page.tsx**

```tsx
// src/app/welcome/page.tsx
import { signOut } from "@/platform/auth/auth";
import { HavenMark } from "@/platform/ui/haven-mark";

export default function WelcomePage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
        <HavenMark className="h-10 w-auto text-brand" />
        <h1 className="mt-4 text-xl font-semibold tracking-tight">Welcome to HAVEN Free Clinic</h1>
        <p className="mt-3 text-sm leading-relaxed text-slate-600">
          You signed in successfully, but we couldn&apos;t find you in our records.
          If you&apos;re a current member, contact the IT team so we can fix your
          record. If you&apos;d like to join HAVEN, keep an eye out for the next
          recruitment cycle.
        </p>
        <form
          className="mt-6"
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/login" });
          }}
        >
          <button
            type="submit"
            className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
          >
            Sign out
          </button>
        </form>
      </div>
    </main>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/jcarney/Documents/Code-Projects/HAVENHub && npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Run unit tests**

```bash
cd /Users/jcarney/Documents/Code-Projects/HAVENHub && npm test
```

Expected: 35 passing.

- [ ] **Step 4: Commit**

```bash
git add src/app/welcome/page.tsx
git commit -m "feat: restyle welcome page with HavenMark, Clinical SaaS card, outline sign-out"
```

---

## Task 9: Full Verification + E2E + Visual Screenshots

**Files:**
- No committed files in this task — visual script is throwaway

- [ ] **Step 1: Run full lint + typecheck + unit tests**

```bash
cd /Users/jcarney/Documents/Code-Projects/HAVENHub && npm run lint && npm run typecheck && npm test
```

Expected: lint clean, typecheck clean, 35 tests passing.

- [ ] **Step 2: Run e2e tests**

```bash
cd /Users/jcarney/Documents/Code-Projects/HAVENHub && npm run e2e
```

Expected: 2 passed. Selectors preserved: `input[name="email"]`, `button:has-text("Dev sign in")`, `getByRole("heading", { name: /Welcome/ })`.

- [ ] **Step 3: Create screenshot directory**

```bash
mkdir -p /tmp/havenhub-shots
```

- [ ] **Step 4: Write throwaway Playwright screenshot script**

Create `/tmp/havenhub-visual.ts` (NOT committed, lives in /tmp):

```typescript
import { chromium } from "@playwright/test";

(async () => {
  const browser = await chromium.launch();

  // Login desktop
  const desktopCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const desktopPage = await desktopCtx.newPage();
  await desktopPage.goto("http://localhost:3000/login");
  await desktopPage.waitForLoadState("networkidle");
  await desktopPage.screenshot({ path: "/tmp/havenhub-shots/login-desktop.png", fullPage: false });

  // Login mobile
  const mobileCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mobilePage = await mobileCtx.newPage();
  await mobilePage.goto("http://localhost:3000/login");
  await mobilePage.waitForLoadState("networkidle");
  await mobilePage.screenshot({ path: "/tmp/havenhub-shots/login-mobile.png", fullPage: false });

  // Dev login + hub screenshot
  await desktopPage.fill('input[name="email"]', "j.carney@yale.edu");
  await desktopPage.click('button:has-text("Dev sign in")');
  await desktopPage.waitForURL("**/hub");
  await desktopPage.waitForLoadState("networkidle");
  await desktopPage.screenshot({ path: "/tmp/havenhub-shots/hub.png", fullPage: false });

  // Welcome page
  await desktopPage.goto("http://localhost:3000/welcome");
  await desktopPage.waitForLoadState("networkidle");
  await desktopPage.screenshot({ path: "/tmp/havenhub-shots/welcome.png", fullPage: false });

  await browser.close();
  console.log("Screenshots saved to /tmp/havenhub-shots/");
})();
```

- [ ] **Step 5: Run screenshot script**

```bash
cd /Users/jcarney/Documents/Code-Projects/HAVENHub && npx tsx /tmp/havenhub-visual.ts
```

Expected: 4 PNGs written to `/tmp/havenhub-shots/`. Confirm dev server is up on :3000 first.

- [ ] **Step 6: Visually inspect screenshots**

View each screenshot. Confirm:
- `login-desktop.png`: Yale Blue left panel with oval HAVEN mark (white), plus-pattern visible at ~6% opacity, right panel has "Sign in to HAVENHub" heading, dev form visible below separator
- `login-mobile.png`: Slim blue top band with mark + "HAVENHub", right panel fills the screen
- `hub.png`: 2px blue accent top line, white header with oval mark + "HAVENHub" text, tile grid (all coming-soon with `bg-slate-100` chips), "Modules" h2 label above grid
- `welcome.png`: White card centered on slate-50, HAVEN oval mark in Yale Blue, heading, copy, outline sign-out button

If anything looks wrong (spacing/contrast/logo), fix the relevant file and reshoot.

---

## Task 10: Final Commit

- [ ] **Step 1: Check git status**

```bash
cd /Users/jcarney/Documents/Code-Projects/HAVENHub && git status
```

Expected changed/new files: `src/app/globals.css`, `src/app/layout.tsx`, `src/platform/ui/haven-mark.tsx`, `src/app/icon.svg`, `src/platform/ui/app-shell.tsx`, `src/app/hub/page.tsx`, `src/app/login/page.tsx`, `src/app/welcome/page.tsx`. Also `public/brand/` (untracked brand assets).

The `/tmp/havenhub-visual.ts` script should NOT be staged (it's in /tmp, outside the repo).

- [ ] **Step 2: Stage all intended files and commit**

```bash
cd /Users/jcarney/Documents/Code-Projects/HAVENHub && git add -A && git commit -m "feat: HAVEN-branded clinical design system (Yale Blue, Inter, branded login, structured hub)"
```

- [ ] **Step 3: Verify commit**

```bash
cd /Users/jcarney/Documents/Code-Projects/HAVENHub && git status && git log --oneline -5
```

Expected: working tree clean, new commit at top.

---

## Self-Review Checklist

### Spec Coverage

| Spec Item | Task |
|---|---|
| `@theme` design tokens in globals.css | Task 1 |
| Inter via next/font, `--font-inter` variable | Task 2 |
| HavenMark inline SVG component | Task 3 |
| `src/app/icon.svg` favicon | Task 4 |
| AppShell: 2px accent line, structured header, term chip prop, slim footer | Task 5 |
| Hub: active term query, `<h1>Welcome...`, `<h2>Modules</h2>` visible, active/coming-soon tile styles | Task 6 |
| Login: two-panel split, plus-pattern, Yale Blue Entra button, amber warning restyled, dev form preserved | Task 7 |
| Welcome: white card, HavenMark, outline sign-out | Task 8 |
| lint + typecheck + 35 unit tests + 2 e2e + visual screenshots | Task 9 |
| Final commit with exact message | Task 10 |

### Critical Selectors Preserved for E2E

- `input[name="email"]` — name attribute kept in Task 7 ✓
- `button:has-text("Dev sign in")` — exact text "Dev sign in" kept in Task 7 ✓
- `getByRole("heading", { name: /Welcome/ })` — `<h1>Welcome...</h1>` kept in Task 6 ✓
- `getByText("Clinic Schedule")` — module title from registry (unchanged) ✓
- `getByText("Volunteer Management")` — module title from registry (unchanged) ✓

### Type Consistency

- `AppShell` props: `{ userName: string | null; termLabel?: string | null; children: ReactNode }` — used consistently in Tasks 5 and 6 ✓
- `HavenMark` props: `{ className?: string }` — used consistently in Tasks 3, 5, 7, 8 ✓
- `prisma` imported from `@/platform/db` in hub page (allowed by spec) ✓

### Potential Issues

1. **Term model `status` field**: The `prisma.term.findFirst({ where: { status: "ACTIVE" } })` query assumes the Prisma schema has `status` as a string/enum with value `"ACTIVE"`. Confirmed in the schema (`model Term` has `status` field). If the enum type requires `TermStatus.ACTIVE`, adjust accordingly — check `prisma/schema.prisma` for the enum definition before writing the hub page.

2. **`border-brand/40` opacity syntax**: Tailwind v4 supports opacity modifiers on custom CSS variables. If this causes a build warning, replace with `border-brand` and remove the opacity.

3. **`bg-brand-faint` / `bg-brand-light`**: These are defined in the `@theme` block as `--color-brand-faint` and `--color-brand-light`. In Tailwind v4, custom theme colors are accessible as `bg-brand-faint` etc. — verify the build output if tiles don't show the faint blue.

4. **`focus-visible:ring-brand/15`**: Same opacity syntax concern. Fallback: `focus-visible:ring-brand`.
