# UI Cohesion, Phase 2: Surfaces / Cards

Date: 2026-06-30
Status: Design (awaiting review)
Part of: App-wide UI cohesion initiative (4 phases). Phase 1 (Forms) is on PR #166.

## Problem

The `Card` primitive (`src/platform/ui/card.tsx`) is under-adopted. A fresh inventory of the post-merge branch found:

- ~37 hand-rolled `rounded-2xl border bg-surface` divs that should be `<Card>` (they lose the shadow/border/hover consistency the primitive guarantees).
- ~10 compact `rounded-xl bg-surface` surfaces that recur as two patterns: nested sub-panels (`p-3`) and dense list rows (`px-4 py-3`), each styled slightly differently.
- A padding spread on these surfaces beyond the canonical `p-5`: `p-6`, `p-[18px]`, `px-[22px]`, `px-5 py-4`, plus `p-8`/`p-10`/`px-6 py-16` on empty-state containers.

This is the same drift-and-under-adoption pattern Phase 1 addressed for forms, now for surfaces.

## Goal

Migrate hand-rolled `bg-surface` content surfaces onto the `Card` primitive (extended with a compact size variant), so radius, border, shadow, and hover behavior are consistent app-wide. One Phase 2 PR.

## Non-goals (other phases / out of scope)

- Form control migration (Phase 1, done).
- Page headers and section-heading consolidation (Phase 3).
- Non-form raw buttons, focus rings, lint guardrail (Phase 4).
- Non-`bg-surface` surfaces: `bg-muted` / `bg-muted/30` muted sub-panels, `glass-panel` (the deliberate Liquid Glass material on modals/nav/popovers), brand-tinted tiles. These are intentional treatments, not drift.
- Overlays (dropdown/popover menus, toasts), icon/avatar tiles, and embed (iframe) frames. These are not content cards.

## The design

### Card API (mirror the `buttonClasses` + `Button` pattern)

Many compact surfaces are clickable `<Link>` / `<a>` / `<button>` rows, which cannot be a `<Card>` (it renders a `<div>`). So extract a class helper that any element can use, exactly as `button.tsx` already does with `buttonClasses` + `Button`.

```tsx
// src/platform/ui/card.tsx
import type { ComponentProps } from "react";

function cx(...parts: (string | undefined | false | null)[]): string {
  return parts.filter(Boolean).join(" ");
}

type CardSize = "default" | "compact";

const interactiveClasses =
  "transition-[transform,box-shadow,border-color] duration-150 " +
  "hover:-translate-y-0.5 hover:border-border-strong hover:shadow-md";

/**
 * Canonical surface classes. `default` is the 16px-radius, soft-shadow content
 * card; `compact` is a 12px-radius, shadowless surface for dense list rows and
 * nested sub-panels. Use this directly on a Link/button/a when the surface must
 * be a clickable element; use the `Card` component for the common div case.
 */
export function cardClasses({
  size = "default",
  pad = true,
  interactive = false,
}: { size?: CardSize; pad?: boolean; interactive?: boolean } = {}): string {
  return cx(
    "border border-border bg-surface",
    size === "compact" ? "rounded-xl" : "rounded-2xl shadow-sm",
    pad && (size === "compact" ? "p-3" : "p-5"),
    interactive && interactiveClasses,
  );
}

type CardProps = ComponentProps<"div"> & {
  size?: CardSize;
  /** Adds the hover-lift used on clickable tiles. */
  interactive?: boolean;
  /** Toggles the default inset (p-5 default, p-3 compact). Set false to manage padding via className. */
  pad?: boolean;
};

export function Card({ size = "default", interactive = false, pad = true, className, ...rest }: CardProps) {
  return <div {...rest} className={cx(cardClasses({ size, pad, interactive }), className)} />;
}
```

Decisions baked in:
- `default` keeps today's exact look (`rounded-2xl border-border bg-surface shadow-sm`, `p-5`). Existing `<Card>` callers are unaffected.
- `compact` is `rounded-xl border-border bg-surface`, `p-3`, **no shadow** (these surfaces are usually nested or dense, where a shadow reads as noise / shadow-on-shadow). `interactive` still adds the hover-lift (including `hover:shadow-md`) when needed.
- `pad` and `interactive` behave as today.
- A caller needing a different inset (list rows `px-4 py-3`, empty states `p-8`/`px-6 py-16`, a lighter `border-border-subtle`) passes `pad={false}` (or accepts the default) plus a className override, exactly like Phase 1 forms did with one-off layout.

### Migration scope (in)

1. **Top-level cards** (~37 `rounded-2xl bg-surface` divs) to `<Card>`. Hover-lift ones (`hover:-translate-y-0.5 ... hover:shadow-md`) to `interactive`.
2. **Compact nested panels** (`rounded-xl p-3`: `recruitment/.../builder/field-card.tsx`, `quiz/quiz-builder.tsx`, `section-card.tsx` sub-grid) to `<Card size="compact">`. Preserve `border-border-subtle` via className where it was intentionally lighter.
3. **Compact list rows** (`rounded-xl px-4 py-3`: `apply/page.tsx` links, `recruitment/cycles/[id]/emails/page.tsx` list) to `cardClasses({ size: "compact" })` on the existing `<Link>` / `<a>`, with `px-4 py-3` via className and their existing `hover:bg-muted` preserved (a list-hover, distinct from the `interactive` lift).
4. **bg-surface empty-state containers** (`p-8`/`p-10`/`px-6 py-16` centered-message cards) to `<Card>` with the large padding as a className override.

### Exclusion rule (out)

Convert only `bg-surface` content surfaces. Leave hand-rolled, by this rule:
- Not `bg-surface`: `bg-muted` / `bg-muted/30` (e.g. the recruitment builder section wrapper), `glass-panel`, brand-tinted (`bg-brand/*`).
- Positioned overlays: dropdown/popover menus (`builder/type-picker.tsx`, combobox dropdown), toasts (`platform/auth/inactivity.tsx`) which use `shadow-lg` + `fixed`/`absolute`.
- Icon/avatar tiles: `app/(app)/clinic-channel-card.tsx` (`h-10 w-10` icon container).
- Embed frames: the template `preview.tsx` iframe wrapper (`h-[34rem]`).

Anything genuinely ambiguous is flagged during migration, not guessed.

## Testing and verification

- New `src/platform/ui/card.test.ts` (house style: call `cardClasses(...)` / `Card(...)` as functions, assert on the class string / `el.props`): default has `rounded-2xl` + `shadow-sm` + `p-5`; compact has `rounded-xl` + `p-3` and NOT `shadow-sm`/`rounded-2xl`; `pad: false` drops the inset; `interactive` adds the hover-lift; `Card` merges a caller className.
- Migrations are presentational only: preserve element type, `href`, `onClick`, `key`, children, and any data attributes. Per-task: `git diff` review confirms no behavior wiring changed, then `npx tsc --noEmit`.
- `npm run lint`, `npx tsc --noEmit`, and `next build` (compile) gate the branch. The DB-dependent vitest suite needs a local Postgres; the new `card.test.ts` touches no DB.
- Deferred to QA (needs a running app): a light + dark visual pass across the migrated surfaces.

## Risks and mitigations

- **False positives** (a non-card surface converted): mitigated by the explicit exclusion rule and per-surface judgment, with ambiguous cases flagged.
- **Polymorphic surfaces** (clickable rows that are Link/button/a): handled by `cardClasses` used directly on the element, not forcing a `<div>`.
- **Shadow-on-shadow / look changes** on compact surfaces: compact defaults to no shadow; visual pass confirms nested surfaces read correctly in light and dark.
- **Stale shared Prisma client**: this branch sits on the merged-main state, so local `tsc` shows pre-existing stale-client errors unrelated to this work; CI regenerates the client. Do not `prisma generate` in the worktree.

## Branch and PR

- Branch `feat/ui-cohesion-surfaces`, stacked on `feat/ui-cohesion-forms` (Phase 1, #166), which already has main merged in. PR base set to `feat/ui-cohesion-forms`; GitHub auto-retargets to `main` when #166 merges. Avoids re-resolving the P1/P2 file overlaps.

## Open questions

None blocking. Empty-state large-padding surfaces use `<Card>` + a className padding override rather than a named padding preset (a full preset system was explicitly out of scope).
