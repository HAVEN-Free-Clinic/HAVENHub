# Settings Phase 2a — App Name + Brand Color Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the application name and primary brand color editable from /admin/settings, with the brand color overriding the Tailwind `--color-brand` variables at runtime.

**Architecture:** Two registry entries (`branding.appName` text, `branding.brandColor` color) plus a new `color` input type on the auto-rendered settings page. The root layout resolves both: `generateMetadata` reads the name; an injected `<style>` overrides `--color-brand` and derives the 4 shade variants with CSS `color-mix()`. User-facing "HAVEN Hub" strings read the name via `getSetting`.

**Tech Stack:** Next.js 16 App Router (Server Components, generateMetadata), Tailwind v4 `@theme` CSS variables, Zod, Vitest. Builds on Phase 0/1 settings: `getSetting`/`setSetting`/`getCategory` (`@/platform/settings/service`), `SETTINGS`/`define`/`SettingInput` (`@/platform/settings/registry`).

**Spec:** `docs/superpowers/specs/2026-06-09-settings-phase-2a-app-name-and-colors-design.md`

**Branch:** `feat/admin-configurable-settings` (same as Phase 0/1, PR #20). Do NOT create a branch.

**Environment:** Run DB tests with plain `npx vitest run <path>` (test DB at localhost:5434 up; never set DATABASE_URL or use `--env-file`). There is an UNRELATED uncommitted WIP change in `src/platform/auth/inactivity.tsx` with one pre-existing eslint error — do NOT touch/stage/commit it; `git add` only the listed files; ignore that single lint error.

---

## File Structure

- Modify `src/platform/settings/registry.ts` — add `color` to `SettingInput`; add 2 `branding.*` entries.
- Modify `src/app/admin/settings/page.tsx` — render a `color` input branch.
- Create `src/platform/ui/brand-style.ts` — `brandStyleVars(hex)` helper.
- Modify `src/app/layout.tsx` — `generateMetadata` (app name) + injected brand `<style>`.
- Modify `src/app/login/page.tsx`, `src/app/admin/page.tsx`, `src/app/admin/people/new/page.tsx` — app-name reads.
- Tests alongside.

---

## Task 1: Registry `color` type + branding entries + settings page color input

**Files:**
- Modify: `src/platform/settings/registry.ts`
- Modify: `src/app/admin/settings/page.tsx`
- Test: `src/platform/settings/service.test.ts` (extend)

- [ ] **Step 1: Write a failing resolver test**

Append to `src/platform/settings/service.test.ts`:

```ts
describe("phase 2a branding settings", () => {
  it("resolves branding.appName default then DB override", async () => {
    expect(await getSetting<string>("branding.appName")).toBe("HAVEN Hub");
    await prisma.setting.create({ data: { key: "branding.appName", value: "Clinic Hub" } });
    _resetSettingsCache();
    expect(await getSetting<string>("branding.appName")).toBe("Clinic Hub");
  });

  it("resolves branding.brandColor default", async () => {
    expect(await getSetting<string>("branding.brandColor")).toBe("#00356b");
  });

  it("falls back to the default when a stored brand color is not a hex", async () => {
    await prisma.setting.create({ data: { key: "branding.brandColor", value: "red" } });
    _resetSettingsCache();
    expect(await getSetting<string>("branding.brandColor")).toBe("#00356b");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/platform/settings/service.test.ts -t "branding settings"`
Expected: FAIL — `Unregistered setting key: branding.appName`.

- [ ] **Step 3: Add the `color` input type**

In `src/platform/settings/registry.ts`, add a `color` variant to the `SettingInput` union (place it after the `boolean` line):

```ts
export type SettingInput =
  | { type: "number"; min?: number; max?: number }
  | { type: "text" }
  | { type: "textarea" }
  | { type: "boolean" }
  | { type: "color" }
  | { type: "select"; options: { value: string; label: string }[] };
```

- [ ] **Step 4: Add the two registry entries**

Append to the `SETTINGS` array in `registry.ts`:

```ts
  define<string>({
    key: "branding.appName",
    category: "Branding",
    label: "Application name",
    help: "Shown in the browser tab, on the sign-in screen, and in admin copy.",
    input: { type: "text" },
    schema: z.string().min(1),
    envDefault: () => "HAVEN Hub",
    secret: false,
  }),
  define<string>({
    key: "branding.brandColor",
    category: "Branding",
    label: "Primary brand color",
    help: "Main brand color. Buttons, links, and accents derive from it; shade variants are computed automatically.",
    input: { type: "color" },
    schema: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Must be a 6-digit hex color like #00356b"),
    envDefault: () => "#00356b",
    secret: false,
  }),
```

- [ ] **Step 5: Run the resolver test to verify it passes**

Run: `npx vitest run src/platform/settings/service.test.ts -t "branding settings"`
Expected: PASS (3 tests). The existing registry test ("every envDefault satisfies its own schema") also now covers both new defaults.

- [ ] **Step 6: Render the `color` input on the settings page**

In `src/app/admin/settings/page.tsx`, in the input-render chain, add a `color` branch. Change the `textarea` branch's trailing `) : (` so a `color` case precedes the final text/number `else`:

```tsx
                  ) : s.input.type === "textarea" ? (
                    <textarea id={s.key} name={s.key} defaultValue={String(s.value)} className="border rounded px-2 py-1 w-full" />
                  ) : s.input.type === "color" ? (
                    <input
                      id={s.key}
                      name={s.key}
                      type="color"
                      defaultValue={String(s.value)}
                      className="h-9 w-16 rounded border"
                    />
                  ) : (
```

(The Phase 0 `coerce()` already returns the raw string for any non-number/boolean input, so a color value round-trips correctly through the existing server action — no coerce change needed.)

- [ ] **Step 7: Verify types, lint, settings tests**

Run: `npm run typecheck` → clean.
Run: `npm run lint` → no new errors (ignore the pre-existing inactivity.tsx error).
Run: `npx vitest run src/platform/settings`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/platform/settings/registry.ts src/app/admin/settings/page.tsx src/platform/settings/service.test.ts
git commit -m "feat(settings): branding.appName and branding.brandColor settings with a color input"
```

---

## Task 2: Brand-style helper + runtime app-name/color in the root layout

**Files:**
- Create: `src/platform/ui/brand-style.ts`
- Test: `src/platform/ui/brand-style.test.ts`
- Modify: `src/app/layout.tsx`

- [ ] **Step 1: Write the failing helper test**

Create `src/platform/ui/brand-style.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { brandStyleVars } from "./brand-style";

describe("brandStyleVars", () => {
  it("sets --color-brand to the given hex", () => {
    expect(brandStyleVars("#00356b")).toContain("--color-brand:#00356b;");
  });

  it("derives the four shade variants with color-mix", () => {
    const css = brandStyleVars("#123456");
    expect(css).toContain("--color-brand-hover:color-mix(in srgb, #123456 88%, black);");
    expect(css).toContain("--color-brand-deep:color-mix(in srgb, #123456 75%, black);");
    expect(css).toContain("--color-brand-light:color-mix(in srgb, #123456 18%, white);");
    expect(css).toContain("--color-brand-faint:color-mix(in srgb, #123456 6%, white);");
  });

  it("wraps the declarations in a :root rule", () => {
    expect(brandStyleVars("#000000").startsWith(":root{")).toBe(true);
    expect(brandStyleVars("#000000").endsWith("}")).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/platform/ui/brand-style.test.ts`
Expected: FAIL — cannot resolve `./brand-style`.

- [ ] **Step 3: Write the helper**

Create `src/platform/ui/brand-style.ts`:

```ts
/**
 * Build a `:root` CSS rule that overrides the brand color variables from a single
 * admin-chosen hex. Shade variants are derived with CSS color-mix() so the browser
 * computes them (no JS color math). The caller passes a value already validated to
 * #rrggbb by the settings schema, so the interpolation is injection-safe.
 */
export function brandStyleVars(hex: string): string {
  return (
    ":root{" +
    `--color-brand:${hex};` +
    `--color-brand-hover:color-mix(in srgb, ${hex} 88%, black);` +
    `--color-brand-deep:color-mix(in srgb, ${hex} 75%, black);` +
    `--color-brand-light:color-mix(in srgb, ${hex} 18%, white);` +
    `--color-brand-faint:color-mix(in srgb, ${hex} 6%, white);` +
    "}"
  );
}
```

- [ ] **Step 4: Run the helper test to verify it passes**

Run: `npx vitest run src/platform/ui/brand-style.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire the layout to app name + brand color**

`src/app/layout.tsx` currently exports a static `metadata` const and renders the body. Replace the `metadata` const with an async `generateMetadata`, and inject the brand style. The full new file:

```tsx
import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Inter } from "next/font/google";
import { auth } from "@/platform/auth/auth";
import { InactivityTracker } from "@/platform/auth/inactivity";
import { getSetting } from "@/platform/settings/service";
import { brandStyleVars } from "@/platform/ui/brand-style";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export async function generateMetadata(): Promise<Metadata> {
  const name = await getSetting<string>("branding.appName");
  return {
    title: name,
    description: `The unified platform for ${name}`,
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [session, brandColor] = await Promise.all([
    auth(),
    getSetting<string>("branding.brandColor"),
  ]);

  return (
    <html lang="en">
      <body className={`${inter.variable} min-h-screen bg-slate-50 font-sans text-slate-900 antialiased`}>
        <style dangerouslySetInnerHTML={{ __html: brandStyleVars(brandColor) }} />
        <InactivityTracker authenticated={!!session?.user} />
        {children}
      </body>
    </html>
  );
}
```

Notes: the `<style>` sits at the top of `<body>`, after the head stylesheet in document order, so its `:root` override wins the cascade. `dangerouslySetInnerHTML` avoids React escaping the CSS braces; the value is schema-validated `#rrggbb`.

- [ ] **Step 6: Verify**

Run: `npm run typecheck` → clean.
Run: `npm run lint` → no new errors.
Run: `npx vitest run src/platform/ui/brand-style.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/platform/ui/brand-style.ts src/platform/ui/brand-style.test.ts src/app/layout.tsx
git commit -m "feat(settings): runtime brand color override and dynamic app-name metadata"
```

---

## Task 3: App name in login + admin page copy

**Files:**
- Modify: `src/app/login/page.tsx:75` ("Sign in to HAVEN Hub")
- Modify: `src/app/admin/page.tsx:59` (description)
- Modify: `src/app/admin/people/new/page.tsx:44` (description)

- [ ] **Step 1: Migrate the login heading**

`src/app/login/page.tsx` is an async server component. Near the top of the component body (after `const { error } = await searchParams;`), resolve the name (add `import { getSetting } from "@/platform/settings/service";` to the imports):

```ts
  const appName = await getSetting<string>("branding.appName");
```

Then change line 75:

```tsx
            Sign in to HAVEN Hub
```

to:

```tsx
            Sign in to {appName}
```

(Leave the "HAVEN Free Clinic" mobile-band copy as-is — that is the organization name, not the app name.)

- [ ] **Step 2: Migrate the admin overview description**

`src/app/admin/page.tsx` is an async server component (`AdminOverviewPage`). Add the import `import { getSetting } from "@/platform/settings/service";` if absent, resolve the name near the top of the component:

```ts
  const appName = await getSetting<string>("branding.appName");
```

Change line 59:

```tsx
        description="HAVEN Hub operations: people, terms, roles, audit, and sync."
```

to:

```tsx
        description={`${appName} operations: people, terms, roles, audit, and sync.`}
```

- [ ] **Step 3: Migrate the new-person description**

`src/app/admin/people/new/page.tsx` is an async server component (`NewPersonPage`). Add the `getSetting` import if absent and resolve the name near the top of the component body (before the returned JSX):

```ts
  const appName = await getSetting<string>("branding.appName");
```

Change line 44:

```tsx
        description="Create a new person in HAVEN Hub. They will not be linked to Airtable until a sync is run."
```

to:

```tsx
        description={`Create a new person in ${appName}. They will not be linked to Airtable until a sync is run.`}
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck` → clean.
Run: `npm run lint` → no new errors.
Run: `grep -rn "HAVEN Hub" src/app --include="*.tsx" | grep -v "//"` — expect no remaining user-facing "HAVEN Hub" literals in `src/app` page JSX (matches in comments are fine).

- [ ] **Step 5: Commit**

```bash
git add src/app/login/page.tsx src/app/admin/page.tsx src/app/admin/people/new/page.tsx
git commit -m "feat(settings): read app name from settings on login and admin pages"
```

---

## Task 4: Full verification

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: PASS (all suites incl. the new branding + brand-style tests).

- [ ] **Step 2: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: typecheck clean; lint shows ONLY the pre-existing `src/platform/auth/inactivity.tsx` error (unrelated WIP), no new errors.

- [ ] **Step 3: Production build**

Run: `npm run build`
Expected: succeeds; `/admin/settings` present in the route manifest.

- [ ] **Step 4: Manual smoke (optional)**

`npm run dev`, sign in as Platform Admin, open `/admin/settings` → a **Branding** group with "Application name" (text) and "Primary brand color" (color swatch). Change the name → the browser tab title and the login heading reflect it. Change the brand color → primary buttons, links, and `text-brand`/`bg-brand` accents recolor, and hover/light/deep shades follow.

- [ ] **Step 5: Final commit (if anything uncommitted)**

```bash
git add -A -- ':!src/platform/auth/inactivity.tsx'
git commit -m "chore(settings): Phase 2a verification" || echo "nothing to commit"
```

---

## Notes for the implementer

- **No `config.ts` change.** `branding.*` have no env vars; their seed defaults are literals in the registry (the registry contract allows a literal `envDefault`).
- **Cascade:** the injected body `<style>` must come after the head stylesheet (it does, by document order) for the `:root` override to win. Do not move it into `<head>` (Next manages head; body placement is reliable and global for `:root`).
- **Injection safety:** never relax the `branding.brandColor` hex regex — it is the guard that keeps arbitrary CSS out of the injected `<style>`. The resolver also falls back to the default on a schema mismatch.
- **Scope:** only the product-name strings change. Organization names ("HAVEN Free Clinic", "Yale School of Medicine") and email-template branding (separately admin-editable) are out of scope.
