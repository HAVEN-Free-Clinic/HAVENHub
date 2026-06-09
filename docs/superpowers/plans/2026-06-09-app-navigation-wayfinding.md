# App Navigation & Wayfinding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a global module switcher and a breadcrumb trail across the app so users always know where they are and can escape upward or switch modules from any page.

**Architecture:** All navigation derives from the existing module registry (`src/platform/modules/registry.ts`). Pure functions compute the accessible-module list, the active-module test, and the breadcrumb trail (unit-tested in `node` vitest). Thin client components (`GlobalNav`, `Breadcrumbs`) wrap those functions with `usePathname`, and `AppShell` renders both so every page gets them with no per-page work.

**Tech Stack:** Next.js 16 App Router (React 19 server + client components), Tailwind v4, lucide-react, vitest (node env, `.test.ts`).

---

## Context for the implementer

- **Test environment is `node` and only matches `src/**/*.test.ts`** (see `vitest.config.ts`). There is no React Testing Library / jsdom. Therefore: test pure functions only. Client components are verified by `npm run build` + the manual checklist in the final task.
- `npx tsc --noEmit`, `npx eslint .`, and `npm run build` must stay green. The build needs env vars; a `.env` already exists in the worktree root for this purpose.
- The module registry shape (`src/platform/modules/types.ts`):
  ```ts
  export type ModuleNavItem = { label: string; href: string };
  export type ModuleManifest = {
    id: string; title: string; description: string;
    icon: ComponentType<{ className?: string }>;
    accessPermission?: string; permissions: string[];
    status: "active" | "coming-soon"; nav: ModuleNavItem[];
  };
  ```
- RBAC helpers (`src/platform/rbac/engine.ts`):
  `getEffectivePermissions(personId: string): Promise<Set<string>>` and
  `hasPermission(perms: Set<string>, permission: string): boolean`.
- `AppShell` is rendered by exactly five files: `src/app/page.tsx`,
  `src/app/my-info/page.tsx`, and the `schedule` / `admin` / `volunteers`
  layouts. Each already has a `person` object with `.personId`.

---

## File Structure

**New**
- `src/platform/modules/access.ts` — pure `canAccessModule`, `filterAccessibleModules`, `isModuleActive`, plus async `getAccessibleModules`. One responsibility: deciding which modules a user sees and which is active.
- `src/platform/modules/access.test.ts` — unit tests for the pure functions.
- `src/platform/ui/breadcrumb-trail.ts` — pure `buildBreadcrumbs`. One responsibility: turn a pathname + registry data into a crumb list.
- `src/platform/ui/breadcrumb-trail.test.ts` — unit tests.
- `src/platform/ui/breadcrumbs.tsx` — `Breadcrumbs` client component (thin wrapper).
- `src/platform/ui/global-nav.tsx` — `GlobalNav` client component (thin wrapper, hamburger on mobile).

**Modified**
- `src/platform/ui/app-shell.tsx` — becomes async; gains `personId`; renders `GlobalNav` + `Breadcrumbs`.
- `src/app/page.tsx` — pass `personId`; reuse `canAccessModule` for the tile filter.
- `src/app/my-info/page.tsx`, `src/app/schedule/layout.tsx`, `src/app/admin/layout.tsx`, `src/app/volunteers/layout.tsx` — pass `personId`.

**Intentional simplification (YAGNI):** the breadcrumb uses `flex-wrap` instead of JS-collapsing on mobile. Trails are at most four short crumbs, so wrapping is acceptable and avoids client state. The spec's "collapse to last one or two" is therefore not implemented; the global nav hamburger is the real responsive piece.

---

## Task 1: Pure access helpers

**Files:**
- Create: `src/platform/modules/access.ts`
- Test: `src/platform/modules/access.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/platform/modules/access.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  canAccessModule,
  filterAccessibleModules,
  isModuleActive,
  type NavModule,
} from "./access";
import type { ModuleManifest } from "./types";

function mod(overrides: Partial<ModuleManifest>): ModuleManifest {
  return {
    id: "x",
    title: "X",
    description: "",
    icon: () => null,
    permissions: [],
    status: "active",
    nav: [],
    ...overrides,
  };
}

describe("canAccessModule", () => {
  it("allows modules with no accessPermission", () => {
    expect(canAccessModule(mod({ accessPermission: undefined }), new Set())).toBe(true);
  });
  it("requires the permission when one is declared", () => {
    expect(canAccessModule(mod({ accessPermission: "admin.access" }), new Set())).toBe(false);
    expect(
      canAccessModule(mod({ accessPermission: "admin.access" }), new Set(["admin.access"])),
    ).toBe(true);
  });
});

describe("filterAccessibleModules", () => {
  it("maps active accessible modules to nav items and drops coming-soon", () => {
    const modules = [
      mod({ id: "schedule", title: "Clinic Schedule", accessPermission: "schedule.view" }),
      mod({ id: "my-info", title: "My Info", accessPermission: undefined }),
      mod({ id: "triage", title: "Triage", accessPermission: "triage.access", status: "coming-soon" }),
    ];
    const result = filterAccessibleModules(modules, new Set(["schedule.view"]));
    expect(result).toEqual<NavModule[]>([
      { id: "schedule", title: "Clinic Schedule", href: "/schedule" },
      { id: "my-info", title: "My Info", href: "/my-info" },
    ]);
  });
  it("drops active modules the user cannot access", () => {
    const modules = [mod({ id: "admin", title: "Admin", accessPermission: "admin.access" })];
    expect(filterAccessibleModules(modules, new Set())).toEqual([]);
  });
});

describe("isModuleActive", () => {
  it("matches exact and nested paths but not sibling prefixes", () => {
    expect(isModuleActive("/admin", "/admin")).toBe(true);
    expect(isModuleActive("/admin/people", "/admin")).toBe(true);
    expect(isModuleActive("/admin-tools", "/admin")).toBe(false);
    expect(isModuleActive("/schedule", "/admin")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/platform/modules/access.test.ts`
Expected: FAIL — `Failed to resolve import "./access"` / functions not defined.

- [ ] **Step 3: Write the implementation**

Create `src/platform/modules/access.ts`:

```ts
import { getEffectivePermissions, hasPermission } from "@/platform/rbac/engine";
import { MODULES } from "./registry";
import type { ModuleManifest } from "./types";

/** A module reduced to what the global nav needs (serializable, no icon). */
export type NavModule = { id: string; title: string; href: string };

/** True when the user may use this module (no permission required, or held). */
export function canAccessModule(
  mod: Pick<ModuleManifest, "accessPermission">,
  perms: Set<string>,
): boolean {
  return !mod.accessPermission || hasPermission(perms, mod.accessPermission);
}

/** Active modules the user can access, as nav items. Excludes coming-soon. */
export function filterAccessibleModules(
  modules: ModuleManifest[],
  perms: Set<string>,
): NavModule[] {
  return modules
    .filter((m) => m.status === "active" && canAccessModule(m, perms))
    .map((m) => ({ id: m.id, title: m.title, href: `/${m.id}` }));
}

/** Active-state test for a module link given the current pathname. */
export function isModuleActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Server entry point: resolve the signed-in user's accessible modules. */
export async function getAccessibleModules(personId: string): Promise<NavModule[]> {
  const perms = await getEffectivePermissions(personId);
  return filterAccessibleModules(MODULES, perms);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/platform/modules/access.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output (exit 0).

- [ ] **Step 6: Commit**

```bash
git add src/platform/modules/access.ts src/platform/modules/access.test.ts
git commit -m "feat(nav): accessible-module + active-state helpers"
```

---

## Task 2: Breadcrumb trail builder

**Files:**
- Create: `src/platform/ui/breadcrumb-trail.ts`
- Test: `src/platform/ui/breadcrumb-trail.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/platform/ui/breadcrumb-trail.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildBreadcrumbs, type BreadcrumbModule, type Crumb } from "./breadcrumb-trail";

const modules: BreadcrumbModule[] = [
  {
    id: "admin",
    title: "Admin",
    nav: [
      { label: "Overview", href: "/admin" },
      { label: "People", href: "/admin/people" },
      { label: "Terms", href: "/admin/terms" },
    ],
  },
  { id: "my-info", title: "My Info", nav: [] },
];

const HUB: Crumb = { label: "Hub", href: "/" };

describe("buildBreadcrumbs", () => {
  it("returns Hub alone (current) on the hub root", () => {
    expect(buildBreadcrumbs("/", modules)).toEqual([{ label: "Hub" }]);
  });
  it("module root: Hub > Module(current)", () => {
    expect(buildBreadcrumbs("/admin", modules)).toEqual([HUB, { label: "Admin" }]);
  });
  it("section page: Hub > Module > Section(current)", () => {
    expect(buildBreadcrumbs("/admin/people", modules)).toEqual([
      HUB,
      { label: "Admin", href: "/admin" },
      { label: "People" },
    ]);
  });
  it("new page: Hub > Module > Section > New(current)", () => {
    expect(buildBreadcrumbs("/admin/people/new", modules)).toEqual([
      HUB,
      { label: "Admin", href: "/admin" },
      { label: "People", href: "/admin/people" },
      { label: "New" },
    ]);
  });
  it("detail id page: trail ends at the section link, no leaf", () => {
    expect(buildBreadcrumbs("/admin/people/abc123", modules)).toEqual([
      HUB,
      { label: "Admin", href: "/admin" },
      { label: "People", href: "/admin/people" },
    ]);
  });
  it("detail id page with leafLabel: appends the supplied name (option B)", () => {
    expect(buildBreadcrumbs("/admin/people/abc123", modules, "Jane Doe")).toEqual([
      HUB,
      { label: "Admin", href: "/admin" },
      { label: "People", href: "/admin/people" },
      { label: "Jane Doe" },
    ]);
  });
  it("module with no sections: Hub > Module(current)", () => {
    expect(buildBreadcrumbs("/my-info", modules)).toEqual([HUB, { label: "My Info" }]);
  });
  it("unknown module: just the Hub escape", () => {
    expect(buildBreadcrumbs("/nope", modules)).toEqual([HUB]);
  });
  it("ignores a trailing slash", () => {
    expect(buildBreadcrumbs("/admin/people/", modules)).toEqual([
      HUB,
      { label: "Admin", href: "/admin" },
      { label: "People" },
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/platform/ui/breadcrumb-trail.test.ts`
Expected: FAIL — cannot resolve `./breadcrumb-trail`.

- [ ] **Step 3: Write the implementation**

Create `src/platform/ui/breadcrumb-trail.ts`:

```ts
import type { ModuleManifest } from "@/platform/modules/types";

/** A single breadcrumb. The current page's crumb omits `href`. */
export type Crumb = { label: string; href?: string };

/** Registry data the breadcrumb needs (serializable, no icon). */
export type BreadcrumbModule = Pick<ModuleManifest, "id" | "title" | "nav">;

/**
 * Build a breadcrumb trail from a pathname and the module registry.
 *
 * Root is always "Hub" (/). On the hub itself the trail is just "Hub" (current).
 * For detail pages the trail ends at the parent section (the escape link) unless
 * `leafLabel` is supplied (option B), in which case it is appended as the
 * current crumb. A trailing `new` segment becomes a "New" crumb.
 */
export function buildBreadcrumbs(
  pathname: string,
  modules: BreadcrumbModule[],
  leafLabel?: string,
): Crumb[] {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return [{ label: "Hub" }];

  const hub: Crumb = { label: "Hub", href: "/" };
  const segments = path.split("/").filter(Boolean);
  const mod = modules.find((m) => m.id === segments[0]);
  if (!mod) return [hub];

  const moduleHref = `/${mod.id}`;
  if (segments.length === 1) {
    // At the module root: module is the current page.
    return [hub, { label: mod.title }];
  }

  const crumbs: Crumb[] = [hub, { label: mod.title, href: moduleHref }];

  // Exact section match → that section is the current page.
  const section = mod.nav.find((n) => n.href === path);
  if (section) {
    crumbs.push({ label: section.label });
    return crumbs;
  }

  // Deeper than a section (a detail id or "new"): link the parent section.
  const parentSection = mod.nav
    .filter((n) => n.href !== moduleHref && path.startsWith(`${n.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0];
  if (parentSection) {
    crumbs.push({ label: parentSection.label, href: parentSection.href });
  }

  const last = segments[segments.length - 1];
  if (last === "new") {
    crumbs.push({ label: "New" });
  } else if (leafLabel) {
    crumbs.push({ label: leafLabel });
  }
  // Otherwise (dynamic id, option A): no leaf; the section link is the escape.

  return crumbs;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/platform/ui/breadcrumb-trail.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/platform/ui/breadcrumb-trail.ts src/platform/ui/breadcrumb-trail.test.ts
git commit -m "feat(nav): breadcrumb trail builder"
```

---

## Task 3: Breadcrumbs client component

**Files:**
- Create: `src/platform/ui/breadcrumbs.tsx`

This is a thin wrapper (no unit test — verified by build + manual checklist). It owns its own bar chrome and renders nothing on the hub root, so `AppShell` never shows an empty bar.

- [ ] **Step 1: Write the component**

Create `src/platform/ui/breadcrumbs.tsx`:

```tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { buildBreadcrumbs, type BreadcrumbModule } from "./breadcrumb-trail";

export function Breadcrumbs({
  modules,
  leafLabel,
}: {
  modules: BreadcrumbModule[];
  leafLabel?: string;
}) {
  const pathname = usePathname();
  const crumbs = buildBreadcrumbs(pathname, modules, leafLabel);

  // Nothing useful to show on the hub root (just "Hub").
  if (crumbs.length <= 1) return null;

  return (
    <div className="border-b border-slate-200 bg-white">
      <nav aria-label="Breadcrumb" className="mx-auto max-w-6xl px-6 py-2">
        <ol className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
          {crumbs.map((crumb, i) => {
            const isLast = i === crumbs.length - 1;
            return (
              <li key={`${crumb.label}-${i}`} className="flex items-center gap-1.5">
                {crumb.href && !isLast ? (
                  <Link
                    href={crumb.href}
                    className="rounded-sm transition-colors hover:text-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                  >
                    {crumb.label}
                  </Link>
                ) : (
                  <span
                    aria-current={isLast ? "page" : undefined}
                    className={isLast ? "font-medium text-slate-700" : undefined}
                  >
                    {crumb.label}
                  </span>
                )}
                {!isLast && (
                  <span aria-hidden className="text-slate-300">
                    &rsaquo;
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </nav>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output (exit 0).

- [ ] **Step 3: Commit**

```bash
git add src/platform/ui/breadcrumbs.tsx
git commit -m "feat(nav): Breadcrumbs component"
```

---

## Task 4: GlobalNav client component

**Files:**
- Create: `src/platform/ui/global-nav.tsx`

Thin wrapper around `isModuleActive`. Desktop: inline links. Mobile: a hamburger button toggling a dropdown.

- [ ] **Step 1: Write the component**

Create `src/platform/ui/global-nav.tsx`:

```tsx
"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { isModuleActive, type NavModule } from "@/platform/modules/access";

function linkClasses(active: boolean): string {
  return active
    ? "rounded-md px-2.5 py-1.5 text-sm font-medium text-brand bg-brand-faint"
    : "rounded-md px-2.5 py-1.5 text-sm font-medium text-slate-500 hover:text-slate-900 hover:bg-slate-50 transition-colors";
}

export function GlobalNav({ items }: { items: NavModule[] }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  if (items.length === 0) return null;

  return (
    <>
      {/* Desktop: inline links */}
      <nav aria-label="Modules" className="hidden items-center gap-1 sm:flex">
        {items.map((m) => {
          const active = isModuleActive(pathname, m.href);
          return (
            <Link
              key={m.id}
              href={m.href}
              aria-current={active ? "page" : undefined}
              className={linkClasses(active)}
            >
              {m.title}
            </Link>
          );
        })}
      </nav>

      {/* Mobile: hamburger + dropdown */}
      <div className="sm:hidden">
        <button
          type="button"
          aria-label="Open navigation menu"
          aria-expanded={open}
          aria-controls="global-nav-mobile"
          onClick={() => setOpen((v) => !v)}
          className="inline-flex h-9 w-9 items-center justify-center rounded-md text-slate-600 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
        >
          {open ? <X aria-hidden className="h-5 w-5" /> : <Menu aria-hidden className="h-5 w-5" />}
        </button>
        {open && (
          <nav
            id="global-nav-mobile"
            aria-label="Modules"
            className="absolute left-0 right-0 top-14 z-20 border-b border-slate-200 bg-white shadow-sm"
          >
            <div className="mx-auto flex max-w-6xl flex-col gap-1 px-6 py-3">
              {items.map((m) => {
                const active = isModuleActive(pathname, m.href);
                return (
                  <Link
                    key={m.id}
                    href={m.href}
                    aria-current={active ? "page" : undefined}
                    onClick={() => setOpen(false)}
                    className={`block ${linkClasses(active)}`}
                  >
                    {m.title}
                  </Link>
                );
              })}
            </div>
          </nav>
        )}
      </div>
    </>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output (exit 0).

- [ ] **Step 3: Commit**

```bash
git add src/platform/ui/global-nav.tsx
git commit -m "feat(nav): GlobalNav component with mobile hamburger"
```

---

## Task 5: Wire GlobalNav + Breadcrumbs into AppShell

**Files:**
- Modify: `src/platform/ui/app-shell.tsx`

The current file (for reference):

```tsx
import type { ReactNode } from "react";
import Link from "next/link";
import { signOut } from "@/platform/auth/auth";
import { HavenLogo } from "./haven-logo";

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
            <Link href="/" className="flex items-center hover:opacity-80 transition-opacity">
              <HavenLogo className="h-8 text-brand" />
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

- [ ] **Step 1: Replace the whole file**

Replace `src/platform/ui/app-shell.tsx` with:

```tsx
import type { ReactNode } from "react";
import Link from "next/link";
import { signOut } from "@/platform/auth/auth";
import { MODULES } from "@/platform/modules/registry";
import { getAccessibleModules } from "@/platform/modules/access";
import { HavenLogo } from "./haven-logo";
import { GlobalNav } from "./global-nav";
import { Breadcrumbs } from "./breadcrumbs";
import type { BreadcrumbModule } from "./breadcrumb-trail";

export async function AppShell({
  userName,
  termLabel,
  personId,
  children,
}: {
  userName: string | null;
  termLabel?: string | null;
  personId: string;
  children: ReactNode;
}) {
  const navModules = await getAccessibleModules(personId);
  const breadcrumbModules: BreadcrumbModule[] = MODULES.map((m) => ({
    id: m.id,
    title: m.title,
    nav: m.nav,
  }));

  return (
    <div className="min-h-screen flex flex-col">
      {/* Brand accent line */}
      <div className="h-0.5 bg-brand" />

      <header className="relative border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-6 h-14">
          <div className="flex items-center gap-2">
            <Link href="/" aria-label="Go to hub home" className="flex items-center hover:opacity-80 transition-opacity">
              <HavenLogo className="h-8 text-brand" />
            </Link>
            {termLabel && (
              <span className="ml-1 rounded-full bg-brand-faint px-2.5 py-0.5 text-xs font-medium text-brand">
                {termLabel}
              </span>
            )}
          </div>

          <div className="flex-1">
            <GlobalNav items={navModules} />
          </div>

          <div className="flex items-center gap-4">
            <span className="hidden text-sm text-slate-600 sm:inline">{userName}</span>
            <form
              action={async () => {
                "use server";
                await signOut({ redirectTo: "/login" });
              }}
            >
              <button
                type="submit"
                className="text-sm font-medium text-slate-500 hover:text-slate-900 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <Breadcrumbs modules={breadcrumbModules} />

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

Notes: the desktop layout now flexes logo / nav / actions across the bar; `relative` on `<header>` anchors the mobile dropdown (which uses `top-14`, matching the `h-14` bar). `userName` is hidden below `sm` to make room for the hamburger.

- [ ] **Step 2: Typecheck (expect errors in the 5 callers — that is the next task)**

Run: `npx tsc --noEmit`
Expected: errors only of the form `Property 'personId' is missing` in `src/app/page.tsx`, `src/app/my-info/page.tsx`, and the three layouts. No other errors.

- [ ] **Step 3: Commit**

```bash
git add src/platform/ui/app-shell.tsx
git commit -m "feat(nav): render GlobalNav + Breadcrumbs in AppShell"
```

---

## Task 6: Pass `personId` from all five callers; share the tile filter

**Files:**
- Modify: `src/app/page.tsx`
- Modify: `src/app/my-info/page.tsx`
- Modify: `src/app/schedule/layout.tsx`
- Modify: `src/app/admin/layout.tsx`
- Modify: `src/app/volunteers/layout.tsx`

- [ ] **Step 1: Hub page — pass personId and reuse `canAccessModule`**

In `src/app/page.tsx`:

1. Add the import (near the other `@/platform/modules` import):
   ```ts
   import { canAccessModule } from "@/platform/modules/access";
   ```
2. Replace the tile filter:
   ```ts
   const visible = MODULES.filter(
     (m) =>
       m.status === "coming-soon" || // roadmap is visible to everyone (spec §8)
       !m.accessPermission || // open to any signed-in matched person (e.g. my-info)
       hasPermission(permissions, m.accessPermission)
   );
   ```
   with:
   ```ts
   const visible = MODULES.filter(
     (m) =>
       m.status === "coming-soon" || // roadmap is visible to everyone (spec §8)
       canAccessModule(m, permissions)
   );
   ```
3. Add `personId` to the `AppShell` open tag:
   ```tsx
   <AppShell userName={person.name} termLabel={activeTerm?.name ?? null} personId={person.personId}>
   ```
4. If `hasPermission` is now unused, remove it from its import. Run `npx eslint src/app/page.tsx` and follow what it reports (it flags unused imports).

- [ ] **Step 2: my-info page — pass personId**

In `src/app/my-info/page.tsx`, change:
```tsx
<AppShell userName={person.name} termLabel={activeTerm?.name ?? null}>
```
to:
```tsx
<AppShell userName={person.name} termLabel={activeTerm?.name ?? null} personId={person.personId}>
```

- [ ] **Step 3: Three module layouts — pass personId**

In each of `src/app/schedule/layout.tsx`, `src/app/admin/layout.tsx`, `src/app/volunteers/layout.tsx`, change:
```tsx
<AppShell userName={person.name} termLabel={activeTerm?.name ?? null}>
```
to:
```tsx
<AppShell userName={person.name} termLabel={activeTerm?.name ?? null} personId={person.personId}>
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output (exit 0).

- [ ] **Step 5: Lint**

Run: `npx eslint src/app src/platform/ui src/platform/modules`
Expected: clean (fix any unused-import flagged by Step 1.4).

- [ ] **Step 6: Commit**

```bash
git add src/app/page.tsx src/app/my-info/page.tsx src/app/schedule/layout.tsx src/app/admin/layout.tsx src/app/volunteers/layout.tsx
git commit -m "feat(nav): supply personId to AppShell from all callers"
```

---

## Task 7: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Unit tests for the new pure logic**

Run: `npx vitest run src/platform/modules/access.test.ts src/platform/ui/breadcrumb-trail.test.ts`
Expected: PASS (15 tests total).

- [ ] **Step 2: Typecheck + lint**

Run: `npx tsc --noEmit && npx eslint .`
Expected: no output / clean.

- [ ] **Step 3: Production build**

Run: `npm run build`
Expected: `✓ Compiled successfully`, TypeScript finished, all routes listed, no errors. (The worktree `.env` supplies build-time env vars.)

- [ ] **Step 4: Manual checklist (dev server)**

Run: `npm run dev`, sign in, and verify:
- Hub `/`: global module links show in the header; no breadcrumb bar (correct — Hub is the root). Hamburger appears at ~375px and opens/closes the module list.
- `/admin`: breadcrumb reads `Hub › Admin`; Admin is highlighted in the global nav; section tabs still present below the breadcrumb.
- `/admin/people`: breadcrumb `Hub › Admin › People` (People not a link); clicking `Admin` returns to the overview.
- `/admin/people/new`: breadcrumb `Hub › Admin › People › New`; clicking `People` returns to the list.
- `/admin/people/<id>` (open a person): breadcrumb `Hub › Admin › People` with `People` clickable; the person's name is the page H1.
- `/my-info`: breadcrumb `Hub › My Info`; My Info highlighted.
- Switch from Admin to Volunteers using the global nav without going through the hub.
- At 375/768/1024/1440px: no horizontal overflow; hamburger only below `sm`; desktop nav inline at/above `sm`.
- A user lacking `admin.access` does not see Admin in the global nav.

- [ ] **Step 5: Final commit (if any checklist fixes were needed)**

```bash
git add -A
git commit -m "fix(nav): wayfinding polish from manual checklist"
```

---

## Self-Review (completed by plan author)

- **Spec coverage:** global module switcher (Tasks 1,4,5,6) ✓; breadcrumb trail (Tasks 2,3,5) ✓; section tabs unchanged ✓; registry as single source via `getAccessibleModules`/`canAccessModule` shared with hub (Tasks 1,6) ✓; mobile hamburger (Task 4) ✓; option-A leaf with `leafLabel` hook for option B (Task 2) ✓; accessibility landmarks/`aria-current`/`aria-expanded` (Tasks 3,4,5) ✓; testing of trail + filter (Tasks 1,2) ✓.
- **Deviation from spec:** breadcrumb mobile collapse replaced with `flex-wrap` (documented under File Structure, YAGNI).
- **Type consistency:** `NavModule` (access.ts) used by `GlobalNav` and `getAccessibleModules`; `BreadcrumbModule`/`Crumb` (breadcrumb-trail.ts) used by `Breadcrumbs` and `AppShell`; `personId: string` prop matches `PersonSession.personId` at all five call sites.
- **Placeholder scan:** none — every code step contains complete code.
