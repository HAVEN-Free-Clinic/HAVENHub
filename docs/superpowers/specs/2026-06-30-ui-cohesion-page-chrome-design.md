# UI Cohesion, Phase 3: Page Chrome (headers)

Date: 2026-06-30
Status: Design (awaiting review)
Part of: App-wide UI cohesion initiative (4 phases). Phase 1 (Forms) merged; Phase 2 (Surfaces) on PR #168.

## Problem

Two page-chrome inconsistencies, plus one related dark-mode bug:

1. **Page headers drift.** 57 pages use `<PageHeader>` (`h1 text-2xl font-bold tracking-tight` + description + action slot), but ~7 app pages hand-roll an `<h1>` at divergent sizes: training is `text-[26px]`, the schedule pages are `text-2xl font-bold mb-1` / `text-2xl font-bold`, the home greeting is `text-3xl` (a personalized hero).
2. **Section headings sprawl into two families with four duplicated helpers.** An eyebrow/label family dominates (`text-sm font-semibold uppercase tracking-wider text-muted-foreground`, ~35) with scattered `text-xs` weight variants, plus a non-uppercase subsection-title family (`text-base/lg font-semibold`, ~10). Four near-identical local helper components already exist: `SectionHead` (training) and three separate `SectionHeading` copies (assignment-form, roster-panel, roles-panel).
3. **Issue #112 (dark-mode):** the home next-shift hero is a fixed brand gradient (`from-brand to-brand-deep ... text-white`) that does not theme-flip, but four secondary elements use `text-brand-light`, which DOES flip in dark mode to a near-black navy, rendering them dark-on-dark (~1.2:1 contrast).

Content width and vertical rhythm are NOT a problem: `AppShell` already wraps every app page in `<main className="mx-auto w-full max-w-6xl px-6 py-10">`, and the module layouts uniformly use `mt-8`. Per-page `max-w-*` values are intentional inner form/prose constraints. No work there.

## Goal

One canonical `PageHeader` for app page titles and one `SectionHeader` primitive (two levels) for section headings, replacing the hand-rolled h1s and the four duplicated helpers; and fix #112's dark-mode contrast on the next-shift hero. One Phase 3 PR.

## Non-goals (other phases / out of scope)

- Forms (Phase 1, merged), Surfaces/Cards (Phase 2, #168).
- Non-form raw buttons, focus-ring unification, lint guardrail (Phase 4).
- Content max-width / vertical rhythm (already centralized; verify-only).
- The home greeting hero and home next-shift hero stay distinct (deliberate heroes, not standard page titles); #112 fixes the hero's contrast without converting it.
- Auth/public pages outside the app shell (login, welcome, apply, onboard, get-started) and the centered `no-access` error page keep their standalone layouts.

## The design

### New primitive: `SectionHeader` (`src/platform/ui/section-header.tsx`)

```tsx
import type { ReactNode } from "react";

function cx(...parts: (string | undefined | false | null)[]): string {
  return parts.filter(Boolean).join(" ");
}

type SectionHeaderLevel = "eyebrow" | "title";

const levelClasses: Record<SectionHeaderLevel, string> = {
  // Small uppercase label above a group (the dominant section style).
  eyebrow: "text-sm font-semibold uppercase tracking-wider text-muted-foreground",
  // Larger non-uppercase subsection heading.
  title: "text-base font-semibold text-foreground",
};

/**
 * Section heading under a page's PageHeader. `eyebrow` is the small uppercase
 * label; `title` is the larger non-uppercase subsection heading. Renders an h2;
 * pass margin (e.g. mb-4) via className, the component sets no outer spacing.
 */
export function SectionHeader({
  level = "eyebrow",
  className,
  children,
}: {
  level?: SectionHeaderLevel;
  className?: string;
  children: ReactNode;
}) {
  return <h2 className={cx(levelClasses[level], className)}>{children}</h2>;
}
```

- Renders `<h2>` for both levels (a section heading beneath the page `h1`). Sets no margin; callers pass `mb-*` via `className` (about 10 current eyebrows bake `mb-4`).
- `eyebrow` is the dominant uppercase-muted style; `title` is the non-uppercase `text-base font-semibold` subsection style.

### `PageHeader` consolidation (adopt as-is, unmodified)

- Migrate plain app-page `<h1>`s to `<PageHeader>`: `training/page.tsx` (`text-[26px]` to the standard scale); the clinic pages (`clinic`, `clinic/avs`) if their title is plain.
- Schedule pages (`schedule`, `schedule/full`, `schedule/builder`) pair a title/selected-date with date-navigation controls. Use `<PageHeader title=... action={<dateControls/>}/>` where the structure fits the title+action shape. Where a date-nav header does not fit that model, keep the custom layout but normalize its `<h1>` to PageHeader's exact classes (`text-2xl font-bold tracking-tight`, drop `mb-1`) so the title size matches app-wide.
- Excluded (kept distinct): the home greeting hero, the home next-shift hero, the centered `no-access` page, and all auth/public pages.

### Issue #112 fix (home next-shift hero)

In `src/app/(app)/page.tsx`, the next-shift hero is `<div className="... bg-gradient-to-br from-brand to-brand-deep ... text-white">`. Replace `text-brand-light` with the non-flipping `text-white/70` on the four elements that currently go dark-on-dark in dark mode:
- the "Your next shift" eyebrow,
- the "days away"/"day away" caption,
- the Stethoscope icon,
- the Repeat icon.

This matches the get-started left rail's white/opacity treatment on the same gradient. `text-brand-light` is used nowhere else, so it becomes unused (leaving the token definition in `globals.css` is harmless; not removing it keeps this change minimal). The hero's eyebrow stays hand-rolled (it is an on-brand eyebrow, not the muted `SectionHeader` eyebrow).

## Migration scope

### In
- Create `SectionHeader` + `section-header.test.ts`.
- Replace the 4 local helpers (`SectionHead`, 3x `SectionHeading`) and their call sites with `<SectionHeader>`.
- Migrate the eyebrow family (~35 dominant + the `text-xs` weight variants) to `level="eyebrow"`, and the ~10 non-uppercase subsection titles to `level="title"`. Pass any baked `mb-*` through `className`.
- Migrate the hand-rolled app-page `<h1>`s per the PageHeader rules above.
- Apply the #112 contrast fix.

### Out (leave hand-rolled)
- The 5 brand-colored eyebrows (`text-brand-fg` / the on-brand next-shift "Your next shift"): a `className` text-color override on `SectionHeader` is Tailwind same-property ordering-unreliable (same hazard as Phase 2 borders), and a reliable `tone` prop would exceed the agreed two-level shape. Deliberate brand accents; leave them (or fold into Phase 4).
- Home heroes, no-access, auth/public pages (per non-goals).

## Testing and verification

- `section-header.test.ts` (house style: call `SectionHeader(...)` as a function, assert on `el.props`): eyebrow default has `uppercase`/`tracking-wider`/`text-muted-foreground`; title has `text-base`/`font-semibold` and NOT `uppercase`; renders `h2`; merges a caller `className`.
- Migrations are presentational: preserve heading text, element nesting, and surrounding markup. Per-file: `git diff` review, then `npx tsc --noEmit`.
- `npm run lint`, `npx tsc --noEmit`, `next build` (compile) gate the branch. New test touches no DB.
- The #112 fix is verifiable by inspection (token swap on a fixed-brand surface); confirm dark-on-dark is gone in a dark-mode visual pass at QA.

## Risks and mitigations

- **Heading-semantics shift:** rendering `<h2>` where an eyebrow was a `<span>`/`<p>` adds it to the heading outline (generally more correct). If a specific eyebrow must not be a heading, leave it; note any such case.
- **Stale shared Prisma client:** this branch sits on the merged-main state, so `tsc` shows pre-existing stale-client errors unrelated to this work; CI regenerates. Do not `prisma generate` in the worktree.
- **PageHeader/schedule fit:** the date-nav headers may not map cleanly to title+action; the fallback (normalize the h1 classes, keep layout) avoids forcing an awkward fit.

## Branch and PR

- Branch `feat/ui-cohesion-page-chrome`, stacked on `feat/ui-cohesion-surfaces` (Phase 2, #168). PR base set to that branch; GitHub auto-retargets to `main` when #168 merges.

## Open questions

None blocking. The 5 brand-colored eyebrows are deliberately left for a later tone-aware pass rather than risking an unreliable className override now.
