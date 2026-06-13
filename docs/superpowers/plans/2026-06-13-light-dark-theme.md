# Light / Dark / System Theming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each user choose Light, Dark, or System appearance — persisted to their `Person` record, with an admin default — backed by a semantic CSS-variable token layer that the whole app flips on a `.dark` class.

**Architecture:** A small hand-rolled theme module (no `next-themes`) keeps the **DB per-user preference** authoritative; a mirror cookie + server-rendered `<html class>` plus one blocking inline script deliver no-flash theming. `globals.css` gains semantic color tokens (light defaults + a `.dark` override block); ~104 `.tsx` files are swept from hardcoded `slate-*/white` utilities to those tokens.

**Tech Stack:** Next.js 16 (App Router, server components), React 19, Tailwind **v4** (`@theme`), Prisma/Postgres, Zod, NextAuth (JWT), Vitest, Playwright, `lucide-react`.

---

## Color token mapping reference

The sweep tasks (Tasks 9–16) all apply this single authoritative mapping. Tokens are defined in Task 2. Light values equal today's slate hex so light mode is visually equivalent (adjacent shades that collapse — e.g. 600/700 — differ imperceptibly; that consolidation is intended).

| Current utility (any prefix: `bg-`/`text-`/`border-`/`divide-`/`ring-`/`from-`/`to-`/`hover:` etc.) | New token utility |
| --- | --- |
| `*-white` **on a neutral surface** (card/panel bg, body) | `*-surface` |
| `*-slate-50` | `*-muted` |
| `*-slate-100` | `*-muted-strong` |
| `*-slate-200` (as background fill) | `*-muted-strong` |
| `text-slate-900`, `text-slate-800` | `text-foreground` |
| `text-slate-700`, `text-slate-600` | `text-foreground-soft` |
| `text-slate-500` | `text-muted-foreground` |
| `text-slate-400`, `text-slate-300` | `text-subtle-foreground` |
| `border-slate-200` | `border-border` |
| `border-slate-300`, `border-slate-400` | `border-border-strong` |
| `border-slate-100` | `border-border-subtle` |
| `divide-slate-100` | `divide-border-subtle` |
| `text-brand` | `text-brand-fg` (lifted brand for legibility on dark; see Task 2) |

**Do NOT auto-convert (leave as-is — judgment exceptions):**

- `text-white` / `border-white` that sits on a **brand/colored** background (e.g. the avatar gradient, primary `bg-brand` buttons, the `bg-gradient-to-br from-brand` avatar). White-on-brand must stay white in both themes. Only convert `*-white` when it is a neutral *surface* (card/panel/body background).
- `bg-slate-900` / `bg-slate-800` used as an intentionally-dark chip in light mode (rare: 2 occurrences). Inspect each; usually leave as-is.
- Any `slate-*` used inside the `.dark {}` block itself (Task 2).

**Per-task verification grep** (run inside the task's file set; should return only the documented exceptions):

```bash
grep -rnE "(bg|text|border|ring|from|to|divide|placeholder|shadow|outline)-(white|black|slate-[0-9]+|gray-[0-9]+)" <paths>
```

---

## Task 1: Theme module (constants + pure helpers)

**Files:**
- Create: `src/platform/ui/theme.ts`
- Test: `src/platform/ui/theme.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/platform/ui/theme.test.ts
import { describe, expect, it } from "vitest";
import {
  THEME_VALUES,
  THEME_COOKIE,
  isThemePreference,
  resolvePreference,
  effectiveClass,
  buildNoFlashScript,
} from "./theme";

describe("theme constants", () => {
  it("exposes the three preference values", () => {
    expect(THEME_VALUES).toEqual(["light", "dark", "system"]);
  });
});

describe("isThemePreference", () => {
  it("accepts valid values and rejects others", () => {
    expect(isThemePreference("dark")).toBe(true);
    expect(isThemePreference("system")).toBe(true);
    expect(isThemePreference("blue")).toBe(false);
    expect(isThemePreference(null)).toBe(false);
  });
});

describe("resolvePreference", () => {
  it("prefers the person value", () => {
    expect(resolvePreference("dark", "light")).toBe("dark");
  });
  it("falls back to the admin default when person is null", () => {
    expect(resolvePreference(null, "dark")).toBe("dark");
  });
  it("falls back to system when both are absent", () => {
    expect(resolvePreference(null, null)).toBe("system");
  });
  it("ignores an invalid person value", () => {
    expect(resolvePreference("nope", "light")).toBe("light");
  });
});

describe("effectiveClass", () => {
  it("returns 'dark' for explicit dark regardless of OS", () => {
    expect(effectiveClass("dark", false)).toBe("dark");
  });
  it("returns '' for explicit light regardless of OS", () => {
    expect(effectiveClass("light", true)).toBe("");
  });
  it("follows the OS for system", () => {
    expect(effectiveClass("system", true)).toBe("dark");
    expect(effectiveClass("system", false)).toBe("");
  });
});

describe("buildNoFlashScript", () => {
  it("references the data attribute and toggles the dark class for system", () => {
    const js = buildNoFlashScript();
    expect(js).toContain("data-theme-pref");
    expect(js).toContain("prefers-color-scheme: dark");
    expect(js).toContain("classList.toggle('dark'");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/platform/ui/theme.test.ts`
Expected: FAIL — `Cannot find module './theme'`.

- [ ] **Step 3: Write the module**

```ts
// src/platform/ui/theme.ts

/** The three values a theme preference may take. */
export const THEME_VALUES = ["light", "dark", "system"] as const;
export type ThemePreference = (typeof THEME_VALUES)[number];

/** Cookie that mirrors the user's preference so the server can render no-flash. */
export const THEME_COOKIE = "theme-pref";

/** The `<html>` attribute carrying the resolved preference for the inline script. */
export const THEME_ATTR = "data-theme-pref";

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === "string" && (THEME_VALUES as readonly string[]).includes(value);
}

/** Person preference (DB) wins; else the admin default; else "system". */
export function resolvePreference(
  personPref: string | null | undefined,
  adminDefault: string | null | undefined,
): ThemePreference {
  if (isThemePreference(personPref)) return personPref;
  if (isThemePreference(adminDefault)) return adminDefault;
  return "system";
}

/** The class to put on <html>: "dark" or "" (light). System resolves via the OS flag. */
export function effectiveClass(pref: ThemePreference, prefersDark: boolean): "dark" | "" {
  if (pref === "dark") return "dark";
  if (pref === "light") return "";
  return prefersDark ? "dark" : "";
}

/**
 * The blocking inline <head> script. Explicit light/dark are already applied
 * server-side via the <html> class, so this only needs to resolve "system"
 * against the OS before first paint.
 */
export function buildNoFlashScript(): string {
  return (
    "(function(){try{" +
    "var p=document.documentElement.getAttribute('" + THEME_ATTR + "');" +
    "if(p==='system'){" +
    "var d=window.matchMedia('(prefers-color-scheme: dark)').matches;" +
    "document.documentElement.classList.toggle('dark',d);" +
    "}}catch(e){}})();"
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/platform/ui/theme.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/platform/ui/theme.ts src/platform/ui/theme.test.ts
git commit -m "feat(theme): pure theme resolution module + no-flash script builder"
```

---

## Task 2: Semantic token layer in globals.css

**Files:**
- Modify: `src/app/globals.css`

No unit test (CSS); verified by build + later visual checks. Tailwind v4 generates `bg-*/text-*/border-*` utilities from each `--color-*` name, and because plain `@theme` emits `var(--color-*)` references (proven by `brandStyleVars` overriding `--color-brand` at runtime), overriding the same names under `html.dark` flips every derived utility.

- [ ] **Step 1: Add the semantic tokens to the `@theme` block**

In `src/app/globals.css`, inside the existing `@theme { ... }` (after the `--color-canvas` line), add:

```css
  /* Semantic neutral roles. Light values equal today's slate/white hex so the
     existing UI is visually unchanged; the .dark block below overrides them. */
  --color-surface: #ffffff;          /* was bg-white (neutral surfaces) */
  --color-muted: #f8fafc;            /* slate-50  */
  --color-muted-strong: #f1f5f9;     /* slate-100 */
  --color-foreground: #0f172a;       /* slate-900 */
  --color-foreground-soft: #334155;  /* slate-700 */
  --color-muted-foreground: #64748b; /* slate-500 */
  --color-subtle-foreground: #94a3b8;/* slate-400 */
  --color-border: #e2e8f0;           /* slate-200 */
  --color-border-strong: #cbd5e1;    /* slate-300 */
  --color-border-subtle: #f1f5f9;    /* slate-100 */
  /* Brand used as text/icon color. Light = brand; lifted in dark for legibility. */
  --color-brand-fg: var(--color-brand);
```

- [ ] **Step 2: Add the `.dark` override block**

At the end of `src/app/globals.css`, append:

```css
/*
 * Dark theme. Activated by the `dark` class on <html> (set server-side for an
 * explicit light/dark preference, or by the inline no-flash script for system).
 * Values are tuned for WCAG AA body-text contrast on the surface/canvas pair.
 */
html.dark {
  --color-canvas: #020617;            /* slate-950 page base */
  --color-surface: #0f172a;           /* slate-900 raised surface */
  --color-muted: #1e293b;             /* slate-800 */
  --color-muted-strong: #334155;      /* slate-700 */
  --color-foreground: #f1f5f9;        /* slate-100 */
  --color-foreground-soft: #cbd5e1;   /* slate-300 */
  --color-muted-foreground: #94a3b8;  /* slate-400 */
  --color-subtle-foreground: #64748b; /* slate-500 */
  --color-border: #334155;            /* slate-700 */
  --color-border-strong: #475569;     /* slate-600 */
  --color-border-subtle: #1e293b;     /* slate-800 */

  /* Brand tints become dark-tinted surfaces; brand text is lifted to read on dark.
     color-mix keeps these tracking the admin-chosen brand hue. */
  --color-brand-fg: color-mix(in srgb, var(--color-brand) 55%, white);
  --color-brand-faint: color-mix(in srgb, var(--color-brand) 22%, #0b1220);
  --color-brand-light: color-mix(in srgb, var(--color-brand) 30%, #0b1220);
}

/* Tell the UA which native scheme to use (form controls, scrollbars). */
html:not(.dark) { color-scheme: light; }
html.dark { color-scheme: dark; }
```

- [ ] **Step 3: Verify the build compiles the new utilities**

Run: `npx next build --no-lint 2>&1 | tail -20` *(or, faster:)* `npx tsc --noEmit`
Expected: no CSS/build error. (A full `next build` is slow; the goal here is only that globals.css parses — if `next build` is impractical mid-plan, defer to Task 8's dev-server smoke check.)

- [ ] **Step 4: Commit**

```bash
git add src/app/globals.css
git commit -m "feat(theme): semantic color token layer with .dark overrides"
```

---

## Task 3: Add `themePreference` to Person + migration

**Files:**
- Modify: `prisma/schema.prisma` (the `Person` model)
- Create: `prisma/migrations/<timestamp>_add_person_theme_preference/migration.sql` (generated)

- [ ] **Step 1: Add the field**

In `prisma/schema.prisma`, in `model Person`, add near the other scalar profile fields (e.g. after `yaleAffiliation`):

```prisma
  /// UI appearance preference: null = use the app default (ui.defaultTheme).
  /// One of "light" | "dark" | "system". Stored as a string (not an enum) to
  /// match the settings registry's string select and avoid a Prisma enum migration.
  themePreference           String?
```

- [ ] **Step 2: Generate and apply the migration**

Ensure the dev DB is up (`npm run db:up` if needed), then:

Run: `npx prisma migrate dev --name add_person_theme_preference`
Expected: creates the migration, applies it, regenerates the client. Output ends with "Your database is now in sync".

- [ ] **Step 3: Verify the client typechecks the new field**

Run: `npx tsc --noEmit`
Expected: PASS (no errors).

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(theme): add Person.themePreference column"
```

---

## Task 4: Register the `ui.defaultTheme` admin setting

**Files:**
- Modify: `src/platform/settings/registry.ts`
- Modify: `src/platform/settings/registry.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/platform/settings/registry.test.ts` (match the existing describe style in that file):

```ts
import { SETTINGS } from "./registry";

describe("ui.defaultTheme setting", () => {
  const def = SETTINGS.find((s) => s.key === "ui.defaultTheme");

  it("is registered as a select", () => {
    expect(def).toBeDefined();
    expect(def!.input).toEqual({
      type: "select",
      options: [
        { value: "light", label: "Light" },
        { value: "dark", label: "Dark" },
        { value: "system", label: "System (follow device)" },
      ],
    });
  });

  it("defaults to system", () => {
    expect(def!.envDefault()).toBe("system");
  });

  it("rejects values outside light/dark/system", () => {
    expect(def!.schema.safeParse("system").success).toBe(true);
    expect(def!.schema.safeParse("blue").success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/platform/settings/registry.test.ts`
Expected: FAIL — `def` is undefined.

- [ ] **Step 3: Add the setting**

In `src/platform/settings/registry.ts`, add to the `SETTINGS` array (place it near the branding entries):

```ts
  define<"light" | "dark" | "system">({
    key: "ui.defaultTheme",
    category: "Branding",
    label: "Default appearance",
    help: "The theme used for users who have not chosen one, and for signed-out pages. Users can override this for themselves.",
    input: { type: "select", options: [
      { value: "light", label: "Light" },
      { value: "dark", label: "Dark" },
      { value: "system", label: "System (follow device)" },
    ] },
    schema: z.enum(["light", "dark", "system"]),
    envDefault: () => "system",
    secret: false,
  }),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/platform/settings/registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/platform/settings/registry.ts src/platform/settings/registry.test.ts
git commit -m "feat(theme): admin ui.defaultTheme setting"
```

---

## Task 5: `setThemePreference` server action

**Files:**
- Create: `src/platform/ui/theme-actions.ts`
- Test: `src/platform/ui/theme-actions.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/platform/ui/theme-actions.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";

const update = vi.fn();
const cookieSet = vi.fn();
const requirePersonSession = vi.fn();

vi.mock("@/platform/db", () => ({ prisma: { person: { update } } }));
vi.mock("@/platform/auth/session", () => ({ requirePersonSession: () => requirePersonSession() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: cookieSet }) }));

import { setThemePreference } from "./theme-actions";

beforeEach(() => {
  update.mockReset();
  cookieSet.mockReset();
  requirePersonSession.mockReset();
  requirePersonSession.mockResolvedValue({ personId: "p1", name: "Sam", email: null });
});

describe("setThemePreference", () => {
  it("persists a valid preference and mirrors it to a cookie", async () => {
    await setThemePreference("dark");
    expect(update).toHaveBeenCalledWith({ where: { id: "p1" }, data: { themePreference: "dark" } });
    expect(cookieSet).toHaveBeenCalledWith(
      expect.objectContaining({ name: "theme-pref", value: "dark" }),
    );
  });

  it("rejects an invalid preference without touching the DB", async () => {
    await expect(setThemePreference("rainbow" as never)).rejects.toThrow();
    expect(update).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/platform/ui/theme-actions.test.ts`
Expected: FAIL — `Cannot find module './theme-actions'`.

- [ ] **Step 3: Write the action**

```ts
// src/platform/ui/theme-actions.ts
"use server";

import { cookies } from "next/headers";
import { prisma } from "@/platform/db";
import { requirePersonSession } from "@/platform/auth/session";
import { isThemePreference, THEME_COOKIE, type ThemePreference } from "./theme";

/** Persist the signed-in user's theme choice and mirror it to the no-flash cookie. */
export async function setThemePreference(pref: ThemePreference): Promise<void> {
  if (!isThemePreference(pref)) throw new Error(`Invalid theme preference: ${String(pref)}`);
  const { personId } = await requirePersonSession();
  await prisma.person.update({ where: { id: personId }, data: { themePreference: pref } });
  const store = await cookies();
  store.set({
    name: THEME_COOKIE,
    value: pref,
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/platform/ui/theme-actions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/platform/ui/theme-actions.ts src/platform/ui/theme-actions.test.ts
git commit -m "feat(theme): setThemePreference server action"
```

---

## Task 6: `ThemeToggle` client component

**Files:**
- Create: `src/platform/ui/theme-toggle.tsx`

No unit test (presentational client component exercised by the Task 17 e2e). Cycles light → dark → system; optimistically updates `<html>` + cookie, then calls the server action.

- [ ] **Step 1: Write the component**

```tsx
// src/platform/ui/theme-toggle.tsx
"use client";

import { useState, useTransition } from "react";
import { Sun, Moon, Monitor } from "lucide-react";
import { THEME_ATTR, THEME_COOKIE, type ThemePreference } from "./theme";
import { setThemePreference } from "./theme-actions";

const NEXT: Record<ThemePreference, ThemePreference> = {
  light: "dark",
  dark: "system",
  system: "light",
};

const ICON = { light: Sun, dark: Moon, system: Monitor } as const;
const LABEL = { light: "Light", dark: "Dark", system: "System" } as const;

function applyToDocument(pref: ThemePreference) {
  const root = document.documentElement;
  root.setAttribute(THEME_ATTR, pref);
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const dark = pref === "dark" || (pref === "system" && prefersDark);
  root.classList.toggle("dark", dark);
  document.cookie = `${THEME_COOKIE}=${pref};path=/;max-age=${60 * 60 * 24 * 365};samesite=lax`;
}

export function ThemeToggle({ initial }: { initial: ThemePreference }) {
  const [pref, setPref] = useState<ThemePreference>(initial);
  const [, startTransition] = useTransition();
  const Icon = ICON[pref];

  function cycle() {
    const next = NEXT[pref];
    setPref(next);
    applyToDocument(next); // optimistic, instant
    startTransition(() => {
      void setThemePreference(next);
    });
  }

  return (
    <button
      type="button"
      onClick={cycle}
      aria-label={`Theme: ${LABEL[pref]}. Click to change.`}
      title={`Theme: ${LABEL[pref]}`}
      className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
    >
      <Icon aria-hidden className="h-4.5 w-4.5" />
    </button>
  );
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/platform/ui/theme-toggle.tsx
git commit -m "feat(theme): ThemeToggle header control"
```

---

## Task 7: `ThemeListener` client component (live system updates)

**Files:**
- Create: `src/platform/ui/theme-listener.tsx`

Keeps the `dark` class correct while the preference is `system` and the OS scheme changes mid-session. Renders nothing.

- [ ] **Step 1: Write the component**

```tsx
// src/platform/ui/theme-listener.tsx
"use client";

import { useEffect } from "react";
import { THEME_ATTR } from "./theme";

/** When the active preference is "system", track live OS color-scheme changes. */
export function ThemeListener() {
  useEffect(() => {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    function sync() {
      if (document.documentElement.getAttribute(THEME_ATTR) === "system") {
        document.documentElement.classList.toggle("dark", mql.matches);
      }
    }
    mql.addEventListener("change", sync);
    return () => mql.removeEventListener("change", sync);
  }, []);
  return null;
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/platform/ui/theme-listener.tsx
git commit -m "feat(theme): ThemeListener for live system scheme changes"
```

---

## Task 8: Wire the root layout (resolution + no-flash) and mount the toggle

**Files:**
- Modify: `src/app/layout.tsx`
- Modify: `src/platform/ui/app-shell.tsx`

- [ ] **Step 1: Resolve the preference and emit the no-flash markup in the root layout**

Edit `src/app/layout.tsx`. Add imports:

```ts
import { cookies } from "next/headers";
import { prisma } from "@/platform/db";
import { ThemeListener } from "@/platform/ui/theme-listener";
import {
  resolvePreference,
  buildNoFlashScript,
  THEME_ATTR,
  THEME_COOKIE,
  type ThemePreference,
} from "@/platform/ui/theme";
```

Replace the body of `RootLayout` so it resolves the preference and renders `<html>` with the class/attr + inline script. The current function fetches `session` and `brandColor`; extend it:

```tsx
export default async function RootLayout({ children }: { children: ReactNode }) {
  const [session, brandColor, adminDefault] = await Promise.all([
    auth(),
    getSetting<string>("branding.brandColor"),
    getSetting<string>("ui.defaultTheme"),
  ]);

  // Person preference wins; cookie is a fast hint when there is no session.
  let personPref: string | null = null;
  if (session?.personId) {
    const person = await prisma.person.findUnique({
      where: { id: session.personId },
      select: { themePreference: true },
    });
    personPref = person?.themePreference ?? null;
  } else {
    personPref = (await cookies()).get(THEME_COOKIE)?.value ?? null;
  }

  const pref: ThemePreference = resolvePreference(personPref, adminDefault);
  // Explicit light/dark render the class now (zero flash); system is resolved
  // before paint by the inline script against the OS.
  const htmlClass = pref === "dark" ? "dark" : "";

  return (
    <html lang="en" className={htmlClass} suppressHydrationWarning {...{ [THEME_ATTR]: pref }}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: buildNoFlashScript() }} />
      </head>
      <body className={`${hanken.variable} min-h-screen bg-canvas font-sans text-foreground antialiased`}>
        <style dangerouslySetInnerHTML={{ __html: brandStyleVars(brandColor) }} />
        <ThemeListener />
        <TopProgressBar>
          <InactivityTracker authenticated={!!session?.user} />
          {children}
        </TopProgressBar>
      </body>
    </html>
  );
}
```

Note the body class change: `text-slate-900` → `text-foreground`.

- [ ] **Step 2: Pass the resolved preference into the shell and render the toggle**

The `ThemeToggle` needs its initial value. `AppShell` is the signed-in header; it already receives `personId`. Add a `themePreference` prop and render the toggle in the header user area.

In `src/platform/ui/app-shell.tsx`:

Add import:

```ts
import { ThemeToggle } from "./theme-toggle";
import type { ThemePreference } from "./theme";
```

Add to the props type and signature (`themePreference: ThemePreference`), then place the toggle in the right-hand controls cluster, before the Sign out form:

```tsx
          <div className="flex items-center gap-3">
            <ThemeToggle initial={themePreference} />
            <div className="hidden items-center gap-2.5 sm:flex">
```

- [ ] **Step 3: Supply `themePreference` where `AppShell` is rendered**

Find the AppShell call site:

Run: `grep -rn "<AppShell" src/`

At that call site (the authenticated layout), resolve the value the same way and pass it. Add (near where `personId`/session is obtained there):

```tsx
import { prisma } from "@/platform/db";
import { getSetting } from "@/platform/settings/service";
import { resolvePreference } from "@/platform/ui/theme";
// ...
const [person, adminDefault] = await Promise.all([
  prisma.person.findUnique({ where: { id: personId }, select: { themePreference: true } }),
  getSetting<string>("ui.defaultTheme"),
]);
const themePreference = resolvePreference(person?.themePreference ?? null, adminDefault);
// pass: <AppShell ... themePreference={themePreference}>
```

(If the call site already loads the person, reuse that query instead of adding one.)

- [ ] **Step 4: Smoke-test in the dev server**

Run: `npm run dev` and open the app.
Verify:
- Signed in, header shows the theme button; clicking cycles Sun → Moon → Monitor and the whole UI flips instantly with no flash.
- Reload after choosing Dark: page loads already dark, no white flash.
- Set System; toggle the OS appearance — the app follows.

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit`
Expected: PASS.

```bash
git add src/app/layout.tsx src/platform/ui/app-shell.tsx <appshell-call-site>
git commit -m "feat(theme): wire root layout no-flash resolution and header toggle"
```

---

## Tasks 9–16: Token migration sweep

Each sweep task applies the **Color token mapping reference** (top of this plan) to a file set, honoring the listed exceptions. After editing, run the verification grep over that set (should show only documented exceptions), then `npx tsc --noEmit`, then commit. Do a quick visual pass in the running dev app in both light and dark for the touched screens.

> Method for each task: for every file in the set, replace each hardcoded `slate-*`/neutral-`white` utility per the mapping (preserving any `hover:`/`focus:`/`sm:` variant prefix — e.g. `hover:border-slate-300` → `hover:border-border-strong`). Leave white-on-brand and intentional dark chips per the exceptions.

### Task 9: Primitives (highest leverage — most surfaces inherit)

**Files (set):** `src/platform/ui/card.tsx`, `button.tsx`, `input.tsx`, `select.tsx`, `checkbox.tsx`, `combobox.tsx`, `badge.tsx`, `alert.tsx`, `modal.tsx`, `table.tsx`, `stat-card.tsx`, `pagination.tsx`, `page-header.tsx`, `page-loading.tsx`

- [ ] **Step 1:** Apply the mapping across the set. Example (`card.tsx`): `border-slate-200 bg-white` → `border-border bg-surface`; `hover:border-slate-300` → `hover:border-border-strong`.
- [ ] **Step 2:** `grep -rnE "(bg|text|border|ring|from|to|divide|placeholder|shadow|outline)-(white|black|slate-[0-9]+|gray-[0-9]+)" src/platform/ui/card.tsx src/platform/ui/button.tsx src/platform/ui/input.tsx src/platform/ui/select.tsx src/platform/ui/checkbox.tsx src/platform/ui/combobox.tsx src/platform/ui/badge.tsx src/platform/ui/alert.tsx src/platform/ui/modal.tsx src/platform/ui/table.tsx src/platform/ui/stat-card.tsx src/platform/ui/pagination.tsx src/platform/ui/page-header.tsx src/platform/ui/page-loading.tsx` → only documented exceptions remain (e.g. `text-white` on `bg-brand` in `button.tsx`).
- [ ] **Step 3:** `npx tsc --noEmit` → PASS.
- [ ] **Step 4:** Commit: `git commit -am "refactor(theme): migrate UI primitives to semantic tokens"`

### Task 10: Shell, nav, and global chrome

**Files (set):** `src/platform/ui/app-shell.tsx`, `global-nav.tsx`, `module-nav.tsx`, `breadcrumbs.tsx`, `src/platform/auth/inactivity.tsx`. Also migrate `text-brand` → `text-brand-fg` across these (active nav, term chip).

- [ ] **Step 1:** Apply the mapping + `text-brand`→`text-brand-fg` across the set. Keep the avatar `bg-gradient-to-br from-brand to-brand-deep text-white` unchanged (white-on-brand).
- [ ] **Step 2:** Verification grep over the set → only exceptions remain.
- [ ] **Step 3:** `npx tsc --noEmit` → PASS.
- [ ] **Step 4:** Commit: `git commit -am "refactor(theme): migrate app shell and navigation to tokens"`

### Task 11: Admin (app segment + module)

**Files (set):** all `.tsx` under `src/app/admin/` and `src/modules/admin/` containing the target utilities (≈26 files). Find them: `grep -rlE "(bg|text|border)-(white|black|slate-[0-9]+|gray-[0-9]+)" src/app/admin src/modules/admin --include="*.tsx"`.

- [ ] **Step 1:** Apply the mapping across the set (including `text-brand`→`text-brand-fg` where present).
- [ ] **Step 2:** Verification grep over `src/app/admin src/modules/admin` → only exceptions remain.
- [ ] **Step 3:** `npx tsc --noEmit` → PASS.
- [ ] **Step 4:** Commit: `git commit -am "refactor(theme): migrate admin to semantic tokens"`

### Task 12: Recruitment

**Files (set):** `grep -rlE "(bg|text|border)-(white|black|slate-[0-9]+|gray-[0-9]+)" src/app/recruitment src/modules/recruitment --include="*.tsx"` (≈13 files).

- [ ] **Step 1:** Apply mapping. **Step 2:** Verification grep. **Step 3:** `npx tsc --noEmit`. **Step 4:** Commit: `git commit -am "refactor(theme): migrate recruitment to semantic tokens"`

### Task 13: Learning

**Files (set):** `grep -rlE "(bg|text|border)-(white|black|slate-[0-9]+|gray-[0-9]+)" src/app/learning src/modules/learning --include="*.tsx"` (≈7 files).

- [ ] **Step 1:** Apply mapping. **Step 2:** Verification grep. **Step 3:** `npx tsc --noEmit`. **Step 4:** Commit: `git commit -am "refactor(theme): migrate learning to semantic tokens"`

### Task 14: Schedule + Volunteers

**Files (set):** `grep -rlE "(bg|text|border)-(white|black|slate-[0-9]+|gray-[0-9]+)" src/app/schedule src/app/volunteers src/modules/schedule --include="*.tsx"` (≈15 files). Watch the schedule builder's dense tables for contrast in dark.

- [ ] **Step 1:** Apply mapping. **Step 2:** Verification grep. **Step 3:** `npx tsc --noEmit`. **Step 4:** Commit: `git commit -am "refactor(theme): migrate schedule and volunteers to semantic tokens"`

### Task 15: My-info, onboarding, get-started

**Files (set):** `grep -rlE "(bg|text|border)-(white|black|slate-[0-9]+|gray-[0-9]+)" src/app/my-info src/app/get-started src/app/onboard src/modules/my-info src/modules/onboarding --include="*.tsx"`.

- [ ] **Step 1:** Apply mapping. **Step 2:** Verification grep. **Step 3:** `npx tsc --noEmit`. **Step 4:** Commit: `git commit -am "refactor(theme): migrate my-info and onboarding to semantic tokens"`

### Task 16: Auth + remaining top-level pages

**Files (set):** `grep -rlE "(bg|text|border)-(white|black|slate-[0-9]+|gray-[0-9]+)" src/app/login src/app/welcome src/app/apply src/app/training src/app/page.tsx src/app/not-found.tsx --include="*.tsx"` plus any stragglers from a repo-wide grep. The login/welcome pages are signed-out — confirm they honor the admin default theme (they have no session, so the cookie/admin-default path in Task 8 applies).

- [ ] **Step 1:** Apply mapping. **Step 2:** Verification grep. **Step 3:** `npx tsc --noEmit`. **Step 4:** Commit: `git commit -am "refactor(theme): migrate auth and remaining pages to semantic tokens"`

---

## Task 17: End-to-end theme test

**Files:**
- Create: `e2e/theme.spec.ts`

Follow the existing Playwright patterns in `e2e/` (auth/setup helpers, base URL). Inspect a sibling spec first for the sign-in helper.

- [ ] **Step 1: Read an existing e2e for the login helper**

Run: `ls e2e && sed -n '1,40p' e2e/$(ls e2e | grep -m1 spec)`

- [ ] **Step 2: Write the test**

```ts
// e2e/theme.spec.ts
import { test, expect } from "@playwright/test";
// Reuse the project's existing sign-in helper/fixture (match the sibling spec
// found in Step 1). Pseudo-marked here as signIn(page).

test("user can switch to dark and it persists across reload", async ({ page }) => {
  await signIn(page); // replace with the real helper from Step 1
  await page.goto("/");

  const html = page.locator("html");
  const toggle = page.getByRole("button", { name: /Theme:/ });

  // Default (system or light) — drive to an explicit dark.
  // Click until the label reports Dark.
  for (let i = 0; i < 3; i++) {
    if (/Dark/.test((await toggle.getAttribute("aria-label")) ?? "")) break;
    await toggle.click();
  }
  await expect(html).toHaveClass(/dark/);

  await page.reload();
  await expect(html).toHaveClass(/dark/); // DB-backed, no flash to light
});

test("system preference follows the emulated OS scheme", async ({ page }) => {
  await signIn(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  const toggle = page.getByRole("button", { name: /Theme:/ });
  for (let i = 0; i < 3; i++) {
    if (/System/.test((await toggle.getAttribute("aria-label")) ?? "")) break;
    await toggle.click();
  }
  await expect(page.locator("html")).toHaveClass(/dark/);

  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).not.toHaveClass(/dark/);
});
```

- [ ] **Step 3: Run the e2e**

Run: `npx playwright test e2e/theme.spec.ts`
Expected: PASS (both tests).

- [ ] **Step 4: Commit**

```bash
git add e2e/theme.spec.ts
git commit -m "test(theme): e2e for toggle persistence and system tracking"
```

---

## Task 18: Final verification

- [ ] **Step 1: Repo-wide residual check**

Run:
```bash
grep -rnE "(bg|text|border|ring|from|to|divide)-(white|black|slate-[0-9]+|gray-[0-9]+)" src --include="*.tsx"
```
Expected: only the documented exceptions (white-on-brand surfaces; the ≤2 intentional dark chips; anything inside `globals.css` is not `.tsx`). Triage each remaining hit — convert if it is a neutral surface, otherwise leave and note why.

- [ ] **Step 2: Full unit suite**

Run: `npx vitest run`
Expected: all pass (baseline was 1432; new theme/registry tests add to that).

- [ ] **Step 3: Typecheck + lint**

Run: `npx tsc --noEmit && npx eslint .`
Expected: clean.

- [ ] **Step 4: Visual sweep**

In the dev app, toggle Light/Dark/System and walk the main areas (dashboard, admin settings, schedule builder, recruitment, learning, a modal, a table). Confirm: legible text contrast, visible borders, brand chips/links readable, no white flashes of un-migrated surfaces.

- [ ] **Step 5: Final commit (if any visual fixes were needed)**

```bash
git commit -am "fix(theme): contrast and residual surface fixes from visual sweep"
```

---

## Notes for the executor

- **Tailwind v4 token mechanics:** plain `@theme` emits utilities as `var(--color-NAME)`, so the `html.dark` overrides in Task 2 flip everything. Do **not** convert the `@theme` block to `@theme inline` — that would inline values and break the dark overrides.
- **`text-white` is the main trap.** It is correct on brand/colored backgrounds and must stay. Only the *surface* `white` (card/panel/body backgrounds) becomes `bg-surface`. When unsure, check what is behind the element.
- **Light mode must stay visually equivalent.** Token light values equal today's hex; the only deltas are adjacent slate shades that intentionally collapse (e.g. 600→700-valued `foreground-soft`), which are imperceptible.
- **No-flash contract:** explicit light/dark never flash (server-rendered class); only `system` relies on the inline script, which runs before paint in `<head>`.
