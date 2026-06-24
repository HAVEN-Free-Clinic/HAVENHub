# Liquid Glass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adopt Apple's Liquid Glass material on HAVEN Hub's floating navigation/overlay layer — the sticky top bar, modals, and the combobox popover — while keeping all content surfaces solid and fully accessible.

**Architecture:** Two reusable CSS classes (`.glass-bar`, `.glass-panel`) defined once in `src/app/globals.css` under `@layer components`, with `html.dark` overrides and a mandatory reduced-transparency/contrast solid fallback. Three components swap their existing background classes for these. No logic changes.

**Tech Stack:** Next.js (App Router), Tailwind CSS v4 (`@import "tailwindcss"` + `@theme`), CSS `backdrop-filter`, Vitest for guard tests.

**Spec:** `docs/superpowers/specs/2026-06-14-liquid-glass-design.md`

**Apple guidance grounding it:** glass = the topmost navigation layer; *"avoid overcrowding or layering Liquid Glass elements on top of each other"* (so breadcrumbs/module tabs stay solid); *"avoid overusing... limit to the most important functional elements"*; expanded sheets *"transition to a more opaque appearance"* (so the modal panel leans opaque); test with reduced-transparency/motion.

---

## File Structure

- `src/app/globals.css` — **modify.** Add one `@layer components { … }` block: the glass classes, dark overrides, a11y fallback. Single source of truth.
- `src/platform/ui/app-shell.tsx` — **modify.** Header className: `.glass-bar`.
- `src/platform/ui/modal.tsx` — **modify.** Panel className: `.glass-panel`; scrim gains `backdrop-blur-sm`.
- `src/platform/ui/combobox.tsx` — **modify.** Popover `<ul>` className: `.glass-panel`.
- `src/platform/ui/glass.test.ts` — **create.** Guard test (in the style of `app-shell.importer.test.ts`) asserting the classes exist, the a11y fallback exists, the three surfaces use the classes, and breadcrumbs/module-nav do **not** (no glass-on-glass).

Untouched on purpose: `breadcrumbs.tsx`, `module-nav.tsx`, `select.tsx`, all content primitives.

---

## Task 1: Define the glass material in globals.css

**Files:**
- Modify: `src/app/globals.css` (append a new block at end of file)
- Test: `src/platform/ui/glass.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/platform/ui/glass.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("liquid glass material", () => {
  const css = read("src/app/globals.css");

  it("defines the .glass-bar and .glass-panel utility classes", () => {
    expect(css).toMatch(/\.glass-bar\b/);
    expect(css).toMatch(/\.glass-panel\b/);
  });

  it("uses backdrop-filter for the material", () => {
    expect(css).toMatch(/backdrop-filter:\s*blur/);
  });

  it("provides a solid fallback when transparency/contrast is reduced", () => {
    expect(css).toMatch(/prefers-reduced-transparency/);
    expect(css).toMatch(/prefers-contrast/);
    expect(css).toMatch(/forced-colors/);
  });

  it("adapts the material for dark mode", () => {
    expect(css).toMatch(/html\.dark\s+\.glass-(bar|panel)/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/platform/ui/glass.test.ts`
Expected: FAIL — assertions on `\.glass-bar` etc. fail because globals.css has no glass classes yet.

- [ ] **Step 3: Add the glass material to globals.css**

Append this block to the end of `src/app/globals.css`:

```css
/*
 * Liquid Glass — the floating navigation / control material (Apple-style).
 * Applied only to the topmost nav bar and floating overlays (modals, popovers),
 * never to content. `.glass-bar` = pinned horizontal bars (bottom-edge emphasis);
 * `.glass-panel` = floating overlays (full border, leans opaque per Apple's
 * "expanded sheets become more opaque"). Dark + accessibility overrides follow.
 */
@layer components {
  .glass-bar,
  .glass-panel {
    position: relative;
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.62), rgba(255, 255, 255, 0.45));
    -webkit-backdrop-filter: blur(18px) saturate(190%);
    backdrop-filter: blur(18px) saturate(190%);
  }

  /* Specular edge sheen. Sits behind real children (pointer-events: none). */
  .glass-bar::before,
  .glass-panel::before {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    pointer-events: none;
    background: linear-gradient(
      105deg,
      rgba(255, 255, 255, 0.5) 0%,
      rgba(255, 255, 255, 0) 22%,
      rgba(255, 255, 255, 0) 72%,
      rgba(255, 255, 255, 0.28) 100%
    );
  }

  .glass-bar {
    border-bottom: 1px solid rgba(255, 255, 255, 0.55);
    box-shadow:
      0 1px 0 rgba(255, 255, 255, 0.9) inset,
      0 6px 20px rgba(15, 23, 42, 0.1);
  }

  .glass-panel {
    /* Apple: expanded sheets lean opaque to keep focus. Higher alpha floor. */
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.9), rgba(255, 255, 255, 0.82));
    border: 1px solid rgba(255, 255, 255, 0.7);
    box-shadow:
      0 1px 0 rgba(255, 255, 255, 0.95) inset,
      0 12px 34px rgba(15, 23, 42, 0.18);
  }

  /* Dark mode: tint derived from the surface token so it tracks the theme. */
  html.dark .glass-bar,
  html.dark .glass-panel {
    background: linear-gradient(
      180deg,
      color-mix(in srgb, var(--color-surface) 65%, transparent),
      color-mix(in srgb, var(--color-surface) 55%, transparent)
    );
  }
  html.dark .glass-bar::before,
  html.dark .glass-panel::before {
    background: linear-gradient(
      105deg,
      rgba(255, 255, 255, 0.12) 0%,
      rgba(255, 255, 255, 0) 30%,
      rgba(255, 255, 255, 0) 80%,
      rgba(255, 255, 255, 0.08) 100%
    );
  }
  html.dark .glass-bar {
    border-bottom-color: rgba(255, 255, 255, 0.1);
    box-shadow:
      0 1px 0 rgba(255, 255, 255, 0.06) inset,
      0 6px 20px rgba(0, 0, 0, 0.4);
  }
  html.dark .glass-panel {
    background: linear-gradient(
      180deg,
      color-mix(in srgb, var(--color-surface) 92%, transparent),
      color-mix(in srgb, var(--color-surface) 86%, transparent)
    );
    border-color: rgba(255, 255, 255, 0.12);
    box-shadow:
      0 1px 0 rgba(255, 255, 255, 0.08) inset,
      0 12px 34px rgba(0, 0, 0, 0.5);
  }

  /*
   * Accessibility: drop translucency entirely and fall back to a solid surface
   * when the user reduces transparency, raises contrast, or uses forced colors.
   */
  @media (prefers-reduced-transparency: reduce),
    (prefers-contrast: more),
    (forced-colors: active) {
    .glass-bar,
    .glass-panel {
      background: var(--color-surface);
      -webkit-backdrop-filter: none;
      backdrop-filter: none;
    }
    .glass-bar::before,
    .glass-panel::before {
      display: none;
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/platform/ui/glass.test.ts`
Expected: PASS (4 passing).

- [ ] **Step 5: Commit**

```bash
git add src/app/globals.css src/platform/ui/glass.test.ts
git commit -m "feat(theme): add liquid glass material (glass-bar / glass-panel)"
```

---

## Task 2: Apply glass to the sticky top bar

**Files:**
- Modify: `src/platform/ui/app-shell.tsx:56`
- Test: `src/platform/ui/glass.test.ts`

- [ ] **Step 1: Add the failing assertion**

In `src/platform/ui/glass.test.ts`, add this block inside the `describe`:

```ts
  it("applies .glass-bar to the sticky app-shell header", () => {
    const shell = read("src/platform/ui/app-shell.tsx");
    expect(shell).toMatch(/<header[^>]*className="[^"]*\bglass-bar\b/);
    // The old ad-hoc frosted recipe should be gone.
    expect(shell).not.toContain("bg-surface/85");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/platform/ui/glass.test.ts`
Expected: FAIL — header still uses `bg-surface/85 backdrop-blur-md…`, not `glass-bar`.

- [ ] **Step 3: Swap the header className**

In `src/platform/ui/app-shell.tsx`, change the header line (currently):

```tsx
      <header className="sticky top-0 z-30 border-b border-border bg-surface/85 backdrop-blur-md backdrop-saturate-150">
```

to:

```tsx
      <header className="glass-bar sticky top-0 z-30">
```

(The `.glass-bar` class supplies the translucent background, blur, bottom border, and shadow, replacing `border-b border-border bg-surface/85 backdrop-blur-md backdrop-saturate-150`. The `h-0.5 bg-brand` accent line directly above the header is unchanged.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/platform/ui/glass.test.ts`
Expected: PASS (5 passing).

- [ ] **Step 5: Commit**

```bash
git add src/platform/ui/app-shell.tsx src/platform/ui/glass.test.ts
git commit -m "feat(theme): glass-bar on the sticky top navigation bar"
```

---

## Task 3: Apply glass to the modal panel and blur the scrim

**Files:**
- Modify: `src/platform/ui/modal.tsx:77` (scrim) and `src/platform/ui/modal.tsx:88` (panel)
- Test: `src/platform/ui/glass.test.ts`

- [ ] **Step 1: Add the failing assertion**

In `src/platform/ui/glass.test.ts`, add inside the `describe`:

```ts
  it("uses .glass-panel for the modal and blurs its scrim", () => {
    const modal = read("src/platform/ui/modal.tsx");
    expect(modal).toContain("glass-panel");
    expect(modal).toContain("backdrop-blur-sm");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/platform/ui/glass.test.ts`
Expected: FAIL — modal.tsx has neither `glass-panel` nor `backdrop-blur-sm`.

- [ ] **Step 3: Update the scrim and panel**

In `src/platform/ui/modal.tsx`, change the scrim wrapper (currently):

```tsx
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" /* fixed dark scrim: must not theme-flip */
```

to (add `backdrop-blur-sm`, keep the fixed dark tint and comment):

```tsx
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4" /* fixed dark scrim: must not theme-flip */
```

Then change the panel (currently):

```tsx
        className="flex max-h-[90vh] w-full max-w-4xl flex-col rounded-2xl border border-border bg-surface shadow-xl outline-none"
```

to (replace `border border-border bg-surface shadow-xl` with `glass-panel`; keep `rounded-2xl` so the corners and the `border-radius: inherit` sheen stay rounded):

```tsx
        className="flex max-h-[90vh] w-full max-w-4xl flex-col rounded-2xl glass-panel outline-none"
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/platform/ui/glass.test.ts`
Expected: PASS (6 passing).

- [ ] **Step 5: Commit**

```bash
git add src/platform/ui/modal.tsx src/platform/ui/glass.test.ts
git commit -m "feat(theme): glass-panel modal with blurred scrim"
```

---

## Task 4: Apply glass to the combobox popover

**Files:**
- Modify: `src/platform/ui/combobox.tsx:116`
- Test: `src/platform/ui/glass.test.ts`

- [ ] **Step 1: Add the failing assertion**

In `src/platform/ui/glass.test.ts`, add inside the `describe`:

```ts
  it("uses .glass-panel for the combobox popover", () => {
    expect(read("src/platform/ui/combobox.tsx")).toContain("glass-panel");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/platform/ui/glass.test.ts`
Expected: FAIL — combobox.tsx popover still uses `border border-border bg-surface … shadow-lg`.

- [ ] **Step 3: Swap the popover className**

In `src/platform/ui/combobox.tsx`, change the `<ul>` (currently):

```tsx
          className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-xl border border-border bg-surface py-1 shadow-lg"
```

to (replace `border border-border bg-surface … shadow-lg` with `glass-panel`; keep `rounded-xl`, `overflow-auto`, sizing, and `py-1`):

```tsx
          className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-xl glass-panel py-1"
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/platform/ui/glass.test.ts`
Expected: PASS (7 passing).

- [ ] **Step 5: Commit**

```bash
git add src/platform/ui/combobox.tsx src/platform/ui/glass.test.ts
git commit -m "feat(theme): glass-panel combobox popover"
```

---

## Task 5: Guard against glass-on-glass (negative test)

**Files:**
- Test: `src/platform/ui/glass.test.ts`

- [ ] **Step 1: Add the failing assertion**

In `src/platform/ui/glass.test.ts`, add inside the `describe`:

```ts
  it("does NOT glass the breadcrumbs or module tabs (Apple: no layering glass)", () => {
    expect(read("src/platform/ui/breadcrumbs.tsx")).not.toMatch(/glass-(bar|panel)/);
    expect(read("src/platform/ui/module-nav.tsx")).not.toMatch(/glass-(bar|panel)/);
  });
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run src/platform/ui/glass.test.ts`
Expected: PASS immediately (8 passing) — breadcrumbs.tsx and module-nav.tsx were never modified. This test locks that in so a future change can't silently stack glass under the header.

- [ ] **Step 3: Commit**

```bash
git add src/platform/ui/glass.test.ts
git commit -m "test(theme): guard against glass-on-glass on secondary nav"
```

---

## Task 6: Full suite + typecheck + lint

**Files:** none (verification only)

- [ ] **Step 1: Run the glass guard test**

Run: `npx vitest run src/platform/ui/glass.test.ts`
Expected: PASS (8 passing).

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. (If the project exposes a script, `npm run typecheck` is equivalent.)

- [ ] **Step 3: Lint the touched files**

Run: `npx next lint --file src/platform/ui/app-shell.tsx --file src/platform/ui/modal.tsx --file src/platform/ui/combobox.tsx`
Expected: no errors. (Fallback: `npm run lint`.)

- [ ] **Step 4: Commit any fixes** (only if Steps 2–3 required changes)

```bash
git add -A
git commit -m "chore(theme): typecheck/lint fixes for liquid glass"
```

---

## Task 7: Manual visual verification (light / dark / reduced-transparency)

**Files:** none (manual verification). Use the `superpowers:verification-before-completion` discipline — capture evidence, don't assume.

- [ ] **Step 1: Start the dev server**

Run (background): `npm run dev`
Wait until it reports the local URL (typically `http://localhost:3000`).

- [ ] **Step 2: Verify light theme**

Log in (DEMO_MODE), open a page that shows the header, a modal (e.g. the HIPAA cert viewer at `/clinic` flows or any confirm modal), and a combobox (e.g. an admin form using `Combobox`). Confirm: the top bar is frosted with a visible specular edge and content blurs beneath it on scroll; the modal panel is legible (opaque-leaning) over a blurred scrim; the combobox popover reads as glass. Screenshot each.

- [ ] **Step 3: Verify dark theme**

Toggle the theme (ThemeToggle in the header) to dark. Re-check the same three surfaces. Confirm the glass tint is dark (derived from surface), text stays AA-legible, and borders/highlights are subtle, not blown out. Screenshot.

- [ ] **Step 4: Verify the accessibility fallback**

Enable reduced transparency at the OS level (macOS: System Settings → Accessibility → Display → Reduce transparency), reload. Confirm all three surfaces become **solid** `--color-surface` with no blur, borders/shadows intact, fully legible. Screenshot. Then turn it back off.

- [ ] **Step 5: Report**

Summarize with the screenshots: light, dark, and reduced-transparency all correct, or list any visual issues to fix before merge.

---

## Self-Review notes

- **Spec coverage:** material spec → Task 1; top bar → Task 2; modal+scrim → Task 3; combobox → Task 4; "stays solid / no glass-on-glass" → Task 5 (negative guard); a11y fallback → Task 1 CSS + Task 7 manual; dark mode → Task 1 CSS + Task 7 manual; testing (guard + manual) → Tasks 1–7. No spec requirement is unmapped.
- **Class names consistent:** `.glass-bar` (header) and `.glass-panel` (modal, combobox) are used identically across CSS, components, and tests.
- **No placeholders:** every code step shows the exact before/after.
- **Scope held:** breadcrumbs, module-nav, select, and content primitives are explicitly untouched and guarded.
