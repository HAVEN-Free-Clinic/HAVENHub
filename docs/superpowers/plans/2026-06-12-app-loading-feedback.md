# App-wide Loading Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give users consistent visible feedback whenever the app is working — a global navigation progress bar, route-level loading screens, and a shared spinner used in buttons.

**Architecture:** Three layers on one shared primitive. (1) A branded `Spinner` SVG component, reused in the sign-in and submit buttons. (2) A global top progress bar (`@bprogress/next`) mounted in the root layout that shows on any navigation. (3) A `PageLoading` component dropped into `loading.tsx` files at the root and each heavy module segment, rendered as the Suspense fallback while a route streams.

**Tech Stack:** Next.js 16 App Router, React 19, Tailwind, Vitest (node environment), `@bprogress/next`.

---

## Conventions you must follow

- **Tests run in the `node` environment**, not jsdom. The vitest config only
  includes `src/**/*.test.ts` (NOT `.tsx`). There is no React Testing Library.
- **Component tests call the component as a plain function and inspect the
  returned React element's `.props`** — see `src/platform/ui/haven-logo.test.ts`
  for the established pattern. Example:
  ```ts
  const el = Spinner({ size: "lg" });
  expect(el.props.className).toContain("h-6");
  ```
- **Components that call React hooks cannot be unit-tested this way** (calling
  `useFormStatus()` outside a render throws "invalid hook call"). Those changes
  are verified with `npm run typecheck` and `npm run lint` instead. This matches
  the codebase: `submit-button.tsx` and `sign-in-button.tsx` have no tests today.
- Use the `cx(...)` class-join helper exported from
  `src/platform/ui/button.tsx`.
- Brand color is the CSS variable `--color-brand`. Loading UI must use it, never
  a hardcoded hex.
- Tailwind: animation is `animate-spin`; disable it under reduced motion with
  `motion-reduce:animate-none`.

## File Structure

New files:
- `src/platform/ui/spinner.tsx` — branded animated SVG spinner (decorative).
- `src/platform/ui/spinner.test.ts` — unit tests for Spinner.
- `src/platform/ui/page-loading.tsx` — centered spinner fallback for routes.
- `src/platform/ui/page-loading.test.ts` — unit tests for PageLoading.
- `src/platform/ui/top-progress-bar.tsx` — wraps `@bprogress/next` app bar.
- `src/platform/ui/top-progress-bar.test.ts` — smoke + color-prop test.
- `src/app/loading.tsx` — root catch-all loading screen.
- `src/app/schedule/loading.tsx`
- `src/app/learning/loading.tsx`
- `src/app/recruitment/loading.tsx`
- `src/app/admin/loading.tsx`
- `src/app/volunteers/loading.tsx`
- `src/app/clinic/loading.tsx`
- `src/app/my-info/loading.tsx`

Modified files:
- `src/app/layout.tsx` — mount `<TopProgressBar />`.
- `src/app/login/sign-in-button.tsx` — use `<Spinner />`.
- `src/platform/ui/submit-button.tsx` — use `<Spinner />`.
- `package.json` / lockfile — add `@bprogress/next`.

---

## Task 1: Spinner primitive

**Files:**
- Create: `src/platform/ui/spinner.tsx`
- Test: `src/platform/ui/spinner.test.ts`

The Spinner is a purely decorative SVG (`aria-hidden="true"`). Status semantics
live in its containers (button text / `PageLoading`'s `role="status"`), so the
Spinner itself never announces, avoiding duplicate/nested status regions.

- [ ] **Step 1: Write the failing test**

Create `src/platform/ui/spinner.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { Spinner } from "./spinner";

describe("Spinner", () => {
  it("is decorative (aria-hidden) and always spins, respecting reduced motion", () => {
    const el = Spinner({});
    expect(el.props["aria-hidden"]).toBe(true);
    expect(el.props.className).toContain("animate-spin");
    expect(el.props.className).toContain("motion-reduce:animate-none");
  });

  it("defaults to the medium size", () => {
    const el = Spinner({});
    expect(el.props.className).toContain("h-5");
    expect(el.props.className).toContain("w-5");
  });

  it("applies the requested size", () => {
    expect(Spinner({ size: "sm" }).props.className).toContain("h-4");
    expect(Spinner({ size: "lg" }).props.className).toContain("h-6");
  });

  it("merges a caller-provided className", () => {
    const el = Spinner({ className: "text-brand" });
    expect(el.props.className).toContain("text-brand");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/platform/ui/spinner.test.ts`
Expected: FAIL — `Failed to resolve import "./spinner"` / module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/platform/ui/spinner.tsx`:

```tsx
import { cx } from "./button";

type Size = "sm" | "md" | "lg";

const sizeClasses: Record<Size, string> = {
  sm: "h-4 w-4",
  md: "h-5 w-5",
  lg: "h-6 w-6",
};

type SpinnerProps = {
  /** Visual size. Defaults to "md". */
  size?: Size;
  /** Extra classes (e.g. to override color via text-*). */
  className?: string;
};

/**
 * Branded loading spinner. Purely decorative (aria-hidden) — give the
 * surrounding element status semantics (button text, or PageLoading's
 * role="status"). Inherits color from `currentColor`, so set text color on a
 * parent or via `className`. Honors prefers-reduced-motion.
 */
export function Spinner({ size = "md", className }: SpinnerProps) {
  return (
    <svg
      aria-hidden="true"
      className={cx("animate-spin motion-reduce:animate-none", sizeClasses[size], className)}
      viewBox="0 0 24 24"
      fill="none"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-90"
        fill="currentColor"
        d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z"
      />
    </svg>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/platform/ui/spinner.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/platform/ui/spinner.tsx src/platform/ui/spinner.test.ts
git commit -m "feat(ui): add branded Spinner primitive"
```

---

## Task 2: Reuse Spinner in the auth/submit buttons

No unit tests here — both components call `useFormStatus()`, which cannot run in
the node-env function-call test pattern. Verify with typecheck + lint. This is a
behavior-preserving refactor (sign-in) plus a small enhancement (submit button
gains a visible spinner alongside its existing pending label).

**Files:**
- Modify: `src/app/login/sign-in-button.tsx`
- Modify: `src/platform/ui/submit-button.tsx`

- [ ] **Step 1: Replace the inline SVG in sign-in-button**

In `src/app/login/sign-in-button.tsx`, add the import at the top with the other
imports:

```tsx
import { Spinner } from "@/platform/ui/spinner";
```

Then replace the entire inline `{pending && ( <svg ...>...</svg> )}` block with:

```tsx
      {pending && <Spinner size="sm" />}
```

Leave everything else (the `<button>`, classes, `aria-busy`, the
`{pending ? "Signing in…" : "Sign in with Yale"}` text) unchanged.

- [ ] **Step 2: Add a spinner to the submit button's pending state**

Replace the full contents of `src/platform/ui/submit-button.tsx` with:

```tsx
"use client";

import { useFormStatus } from "react-dom";
import type { ComponentProps } from "react";
import { Button } from "./button";
import { Spinner } from "./spinner";

type SubmitButtonProps = Omit<ComponentProps<typeof Button>, "type"> & {
  /** Label shown while the surrounding form's server action is pending. */
  pendingLabel?: string;
};

/**
 * Submit button that disables itself and swaps to a pending label (with a
 * spinner) while the surrounding <form>'s server action is in flight. Prevents
 * double-submits and gives users feedback that something is happening.
 *
 * Must be rendered inside a <form>; useFormStatus reads that form's state.
 */
export function SubmitButton({
  children,
  pendingLabel,
  disabled,
  ...rest
}: SubmitButtonProps) {
  const { pending } = useFormStatus();
  return (
    <Button {...rest} type="submit" disabled={pending || disabled} aria-busy={pending}>
      {pending ? (
        <span className="inline-flex items-center gap-2">
          <Spinner size="sm" />
          {pendingLabel ?? "Saving…"}
        </span>
      ) : (
        children
      )}
    </Button>
  );
}
```

- [ ] **Step 3: Verify types and lint pass**

Run: `npm run typecheck && npm run lint`
Expected: both succeed with no errors referencing these files.

- [ ] **Step 4: Confirm the spinner test suite still passes**

Run: `npx vitest run src/platform/ui/spinner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/login/sign-in-button.tsx src/platform/ui/submit-button.tsx
git commit -m "refactor(ui): use Spinner in sign-in and submit buttons"
```

---

## Task 3: PageLoading route fallback

**Files:**
- Create: `src/platform/ui/page-loading.tsx`
- Test: `src/platform/ui/page-loading.test.ts`

`PageLoading` is the visible body content while a route renders. It owns the
`role="status"` semantics and contains a large `Spinner`.

- [ ] **Step 1: Write the failing test**

Create `src/platform/ui/page-loading.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { PageLoading } from "./page-loading";
import { Spinner } from "./spinner";

// The element tree is small; walk children to find specific nodes.
function childrenOf(el: { props: { children?: unknown } }): unknown[] {
  const c = el.props.children;
  return Array.isArray(c) ? c.flat() : c == null ? [] : [c];
}

describe("PageLoading", () => {
  it("exposes a status region with a default label", () => {
    const el = PageLoading({});
    expect(el.props.role).toBe("status");
    expect(el.props["aria-label"]).toBe("Loading");
  });

  it("renders a large Spinner", () => {
    const el = PageLoading({});
    const kids = childrenOf(el);
    const spinner = kids.find(
      (k): k is { type: unknown; props: { size?: string } } =>
        typeof k === "object" && k !== null && (k as { type?: unknown }).type === Spinner,
    );
    expect(spinner).toBeTruthy();
    expect(spinner?.props.size).toBe("lg");
  });

  it("uses a provided label as the aria-label and shows it visibly", () => {
    const el = PageLoading({ label: "Loading schedule" });
    expect(el.props["aria-label"]).toBe("Loading schedule");
    // The visible label node is present somewhere in the subtree.
    const text = JSON.stringify(el);
    expect(text).toContain("Loading schedule");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/platform/ui/page-loading.test.ts`
Expected: FAIL — cannot resolve `./page-loading`.

- [ ] **Step 3: Write minimal implementation**

Create `src/platform/ui/page-loading.tsx`:

```tsx
import { Spinner } from "./spinner";

type PageLoadingProps = {
  /** Accessible + visible label. Defaults to "Loading". */
  label?: string;
};

/**
 * Centered loading screen for use as a route-level `loading.tsx` Suspense
 * fallback. Fills the available content area so the page doesn't collapse, and
 * is the single status region for the loading state (the Spinner inside is
 * decorative).
 */
export function PageLoading({ label = "Loading" }: PageLoadingProps) {
  return (
    <div
      role="status"
      aria-label={label}
      className="flex min-h-[40vh] flex-col items-center justify-center gap-3 text-brand"
    >
      <Spinner size="lg" />
      <p className="text-sm font-medium text-slate-500">{label}</p>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/platform/ui/page-loading.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/platform/ui/page-loading.tsx src/platform/ui/page-loading.test.ts
git commit -m "feat(ui): add PageLoading route fallback"
```

---

## Task 4: Global top progress bar

**Files:**
- Modify: `package.json` (add dependency)
- Create: `src/platform/ui/top-progress-bar.tsx`
- Test: `src/platform/ui/top-progress-bar.test.ts`
- Modify: `src/app/layout.tsx`

- [ ] **Step 1: Install the dependency**

Run: `npm install @bprogress/next@^3.2.12`
Expected: installs cleanly (peer deps next>=13, react>=18 are satisfied by
Next 16 / React 19). `package.json` now lists `@bprogress/next`.

- [ ] **Step 2: Verify the App Router export name**

The App Router progress bar is exported from `@bprogress/next/app`. Confirm the
exact export name before writing the component:

Run: `node -e "console.log(Object.keys(require('@bprogress/next/app')))"`
Expected: the list includes `AppProgressBar`. (If the name differs in this
version, use the one printed here in Step 4.)

- [ ] **Step 3: Write the failing test**

Create `src/platform/ui/top-progress-bar.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { TopProgressBar } from "./top-progress-bar";

describe("TopProgressBar", () => {
  it("renders without throwing", () => {
    expect(() => TopProgressBar()).not.toThrow();
    expect(TopProgressBar()).toBeTruthy();
  });

  it("paints the bar in the brand color", () => {
    const el = TopProgressBar();
    expect(el.props.color).toBe("var(--color-brand)");
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run src/platform/ui/top-progress-bar.test.ts`
Expected: FAIL — cannot resolve `./top-progress-bar`.

- [ ] **Step 5: Write minimal implementation**

Create `src/platform/ui/top-progress-bar.tsx` (use the export name confirmed in
Step 2):

```tsx
"use client";

import { AppProgressBar } from "@bprogress/next/app";

/**
 * Global navigation progress bar. Mounted once in the root layout, it shows a
 * thin bar in the brand color across the top of the viewport whenever a
 * navigation starts (Link click or router.push) and hides it when the new route
 * commits — giving instant "something is happening" feedback before the server
 * responds. Self-contained client state, so it is unaffected by the fact that
 * layouts do not re-render on soft navigation.
 */
export function TopProgressBar() {
  return (
    <AppProgressBar
      color="var(--color-brand)"
      height="3px"
      shallowRouting
      options={{ showSpinner: false }}
    />
  );
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run src/platform/ui/top-progress-bar.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Mount it in the root layout**

In `src/app/layout.tsx`, add the import alongside the other UI imports:

```tsx
import { TopProgressBar } from "@/platform/ui/top-progress-bar";
```

Then render it just before `<InactivityTracker ... />` inside `<body>`:

```tsx
        <style dangerouslySetInnerHTML={{ __html: brandStyleVars(brandColor) }} />
        <TopProgressBar />
        <InactivityTracker authenticated={!!session?.user} />
        {children}
```

- [ ] **Step 8: Verify types and lint pass**

Run: `npm run typecheck && npm run lint`
Expected: both succeed.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json src/platform/ui/top-progress-bar.tsx src/platform/ui/top-progress-bar.test.ts src/app/layout.tsx
git commit -m "feat(ui): global navigation progress bar"
```

---

## Task 5: Route-level loading screens

`loading.tsx` files are trivial wiring (one line each) verified by build, not
unit tests. A segment's `loading.tsx` is the Suspense fallback for that segment
and everything nested under it; the root file is the fallback for everything
else.

**Files:**
- Create: `src/app/loading.tsx`
- Create: `src/app/schedule/loading.tsx`
- Create: `src/app/learning/loading.tsx`
- Create: `src/app/recruitment/loading.tsx`
- Create: `src/app/admin/loading.tsx`
- Create: `src/app/volunteers/loading.tsx`
- Create: `src/app/clinic/loading.tsx`
- Create: `src/app/my-info/loading.tsx`

- [ ] **Step 1: Create the root loading screen**

Create `src/app/loading.tsx`:

```tsx
import { PageLoading } from "@/platform/ui/page-loading";

export default function Loading() {
  return <PageLoading />;
}
```

- [ ] **Step 2: Create the per-segment loading screens**

Create each of the following files. Use a label that names the area so screen
readers and users get specific feedback.

`src/app/schedule/loading.tsx`:

```tsx
import { PageLoading } from "@/platform/ui/page-loading";

export default function Loading() {
  return <PageLoading label="Loading schedule" />;
}
```

`src/app/learning/loading.tsx`:

```tsx
import { PageLoading } from "@/platform/ui/page-loading";

export default function Loading() {
  return <PageLoading label="Loading learning" />;
}
```

`src/app/recruitment/loading.tsx`:

```tsx
import { PageLoading } from "@/platform/ui/page-loading";

export default function Loading() {
  return <PageLoading label="Loading recruitment" />;
}
```

`src/app/admin/loading.tsx`:

```tsx
import { PageLoading } from "@/platform/ui/page-loading";

export default function Loading() {
  return <PageLoading label="Loading admin" />;
}
```

`src/app/volunteers/loading.tsx`:

```tsx
import { PageLoading } from "@/platform/ui/page-loading";

export default function Loading() {
  return <PageLoading label="Loading volunteers" />;
}
```

`src/app/clinic/loading.tsx`:

```tsx
import { PageLoading } from "@/platform/ui/page-loading";

export default function Loading() {
  return <PageLoading label="Loading" />;
}
```

`src/app/my-info/loading.tsx`:

```tsx
import { PageLoading } from "@/platform/ui/page-loading";

export default function Loading() {
  return <PageLoading label="Loading your info" />;
}
```

- [ ] **Step 3: Verify types pass**

Run: `npm run typecheck`
Expected: success.

- [ ] **Step 4: Verify the build picks up the loading files**

Run: `npm run build`
Expected: build completes successfully (Next compiles the new `loading.tsx`
Suspense boundaries with no errors).

- [ ] **Step 5: Commit**

```bash
git add src/app/loading.tsx src/app/schedule/loading.tsx src/app/learning/loading.tsx src/app/recruitment/loading.tsx src/app/admin/loading.tsx src/app/volunteers/loading.tsx src/app/clinic/loading.tsx src/app/my-info/loading.tsx
git commit -m "feat(ui): route-level loading screens for module segments"
```

---

## Task 6: Full verification pass

- [ ] **Step 1: Run the full unit test suite**

Run: `npm run test`
Expected: all tests pass (note: this also runs the existing integration tests,
which require the test database to be up — `npm run db:up` and
`npm run test:prepare` first if they are not).

- [ ] **Step 2: Typecheck and lint the whole project**

Run: `npm run typecheck && npm run lint`
Expected: both succeed.

- [ ] **Step 3: Manual smoke test in the browser**

Run: `npm run dev`, sign in, then:
- Navigate between modules (e.g. Schedule → Learning → Admin). Confirm the brand
  top bar appears immediately on each click and the centered spinner fills the
  body on slower routes.
- Submit a form that uses `SubmitButton`. Confirm the button shows the spinner +
  pending label while the action runs.
- Optionally enable "reduce motion" in the OS and confirm the spinner stops
  animating (the bar may still move).

---

## Self-review notes (for the implementer)

- Every spec requirement maps to a task: Spinner (T1), button reuse (T2),
  PageLoading + loading.tsx (T3, T5), top progress bar (T4), tests (T1/T3/T4),
  verification (T6).
- The Spinner is intentionally decorative (`aria-hidden`); status semantics live
  in `PageLoading` (`role="status"`) and in the buttons (text + `aria-busy`) to
  avoid duplicate announcements.
- If `@bprogress/next/app` exports the bar under a different name in the
  installed version, Step 2 of Task 4 surfaces the real name — use it.
