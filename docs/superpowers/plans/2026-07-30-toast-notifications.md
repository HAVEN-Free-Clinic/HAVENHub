# Toast Notification System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every action a transient, non-URL feedback channel, give client-only actions any feedback channel at all, and stop the session-expiry warning from being covered by the help bubble.

**Architecture:** One `<ToastViewport>` in the root layout. A flash reader classifies URL params by convention (`error` and `/Error$/`) plus an explicit registry for everything else, pops toasts, and strips exactly what it consumed. Pages then drop their inline `<Alert>` renders for those params. Server actions and their 158 redirect sites are not touched.

**Tech Stack:** Next.js App Router, React client components, Tailwind, Vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-30-toast-notifications-design.md`. Read it before Task 1, including the section on what the audit got wrong about the scale.
- Source findings: PR #474, items **R11**, **R12**, and **B6**. Jack chose on 2026-07-30 to do all three in one change rather than staging the migration.
- **No em-dashes anywhere, in prose or code.** CI enforces this via the `local/no-em-dash` eslint rule.
- **Never consume or strip a param the system does not own.** `status`, `page`, `q`, `tab`, `token`, `type`, `term`, `track`, `next`, `callbackUrl`, `view`, `mode`, `date`, `dept`, `assignee`, `priority`, `category`, `departmentId` are filters and modes. Eating one silently breaks a page's filtering with no error and no test failure unless you write one.
- **Do not modify any server action or any `redirect()` call site.** The consuming side changes; the producing side does not. If a task seems to require changing a redirect, stop and report.
- **A page must never render both a toast and its own inline `Alert` from the same param.** Every action would double-report.
- **`Alert` stays.** Form-bound validation keeps using it. This is a migration of page-level flash confirmations only.
- Lint with `npx eslint src e2e`. Plain `npm run lint` walks a gitignored design-system directory and produces noise. Run `npm run typecheck` before each commit.
- No `tailwind-merge`. This codebase uses a local `cx` helper (`src/platform/ui/cx.ts`).
- Tests need a database on :5434 that is **shared with every other worktree**. Check `pgrep -f "vitest run"` for a concurrent run before starting. Do NOT create a Postgres schema to isolate yourself: the schema-guard tests query `pg_indexes` filtered on table name but not schema name, so a second schema breaks them for every worktree.

## File structure

- Create: `src/platform/ui/toast/toast.tsx` (viewport, context, `useToast`)
- Create: `src/platform/ui/toast/flash.ts` (the param registry and classifier, pure, no React)
- Create: `src/platform/ui/toast/flash-reader.tsx` (the client component that reads, pops, strips)
- Create: tests alongside each
- Modify: `src/app/layout.tsx:63-71` (mount the viewport; it already hosts `InactivityTracker`)
- Modify: `src/platform/auth/inactivity.tsx:62` (share the bottom-center lane)
- Modify: the page inventory produced by Task 2

---

### Task 1: The classifier and its registry

**Files:**
- Create: `src/platform/ui/toast/flash.ts`
- Test: `src/platform/ui/toast/flash.test.ts`

**Interfaces:**
- Produces: a pure function that takes the URL's params and returns (a) the toasts to show, as `{ tone, message }[]`, and (b) the exact param names to strip. Tasks 3 and 4 consume it. Decide the exact signature and say why.

This is the security-critical piece, in the sense that getting it wrong silently breaks filtering across five pages. Build it first, pure and fully tested, before anything renders.

- [ ] **Step 1: Write the failing tests**

```
- "error" is claimed, error tone, message is the param's own value
- "rosterError", "rbacError", "senderError", "certError" are claimed by the /Error$/ convention
- "message" is claimed ONLY alongside "error", never alone
- "status", "page", "q", "tab", "token", "view", "mode", "date", "dept", "term", "track",
  "next", "callbackUrl", "type", "priority", "category", "assignee", "departmentId"
  are NOT claimed, individually asserted
- a URL carrying both a flash param and a filter param claims only the flash and strips only it
- "saved=1" is claimed, success tone, with the registry's message
- "sent" and "skipped" together produce ONE toast, not two, and strip both
- an unknown param is not claimed
```

The filter list is asserted **one name at a time, not as a loop over an array**. A loop that iterates the same array the implementation uses proves nothing. Write them out.

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run src/platform/ui/toast/flash.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the convention plus registry**

Two mechanisms, in this order:

1. **Convention.** A param named exactly `error`, or matching `/Error$/`, is an error-tone flash whose message is its own decoded value. This covers all 121 `error` sites and the whole suffixed-error family with zero registration. `message` is consumed and stripped with `error` when both are present, as `error=validation`'s detail payload (see `admin/notifications/page.tsx:94-99`).
2. **Registry.** An explicit table for everything else. Each entry owns one *or more* param names, a tone, and a function from those values to a message. Anything not matched by the convention and not in the registry is left completely alone.

Seed the registry with the entries Task 2's inventory confirms. Start with `saved` mapping to "Saved." and the `sent`+`skipped` pair from `recruitment/cycles/[id]/decisions/page.tsx:36-40`:

> Released {sent} acceptance email(s); skipped {skipped} conflicted applicant(s).

**Do not add a registry entry for a param you have not opened and confirmed.** The candidate list was built by pattern matching and over-matches: `count` in `incidents/page.tsx` is a word in a code comment, not a param.

- [ ] **Step 4: Run and watch them pass**

Run: `npx vitest run src/platform/ui/toast/flash.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx eslint src && npm run typecheck
git add -A src
git commit -m "feat(ui): classify flash params for the toast system"
```

---

### Task 2: The page inventory

**Files:**
- Create: a working inventory file under `docs/superpowers/` or the SDD workspace (your choice, say which)

**Interfaces:**
- Produces: the definitive list of pages to convert, each with the params it reads and a ruling. Tasks 5 and 6 work from it. Task 1's registry is completed from it.

No production code in this task. It exists because 57 candidate pages with 30 candidate param names is too much for a later task to also be discovering while it edits.

- [ ] **Step 1: Enumerate**

Find every page or component that reads a search param **and** renders an `<Alert>` from it. Start from these two commands and then verify by opening files, because both over-match:

```bash
grep -rl "searchParams" src/app --include='page.tsx'
grep -rln "<Alert" src/app src/modules
```

- [ ] **Step 2: Rule on each**

For every param on every page, record one of three rulings:

- **TOAST**: a page-level flash confirmation. The page drops its inline render; the param goes in the registry or is covered by the convention.
- **INLINE**: form-bound validation tied to a specific field. Stays exactly as it is. "Enter a valid email address" belongs next to the input.
- **NOT A FLASH**: a filter, a mode, or a false positive from the grep. Never claimed, never stripped.

Record the file, the param, the ruling, and for TOAST entries the exact current message text, since Task 1's registry may need it.

- [ ] **Step 3: Report the shape before anyone edits**

Report the counts per ruling and, specifically, **any param you could not confidently rule on**. A param you are unsure about is NOT A FLASH until someone confirms otherwise; the permissive mistake breaks filtering silently and the conservative one just leaves an inline alert in place.

Also flag any page rendering an `Alert` from a param that is *also* used as a filter on the same page, since that is the case most likely to produce a wrong ruling.

- [ ] **Step 4: Commit the inventory**

```bash
git add -A docs
git commit -m "docs: inventory the flash-alert pages for the toast migration"
```

---

### Task 3: The toast primitive and viewport

**Files:**
- Create: `src/platform/ui/toast/toast.tsx`
- Test: `src/platform/ui/toast/toast.test.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `<ToastViewport>`, a provider, and `useToast()`. Tasks 4 and 6 consume `useToast()`.

- [ ] **Step 1: Build the viewport and hook**

Requirements, all from the spec:

- Bottom-center placement, fixed, above the app but not fighting the help bubble's corner.
- Solid brand-dark pill in both themes. **Tone is carried by the leading icon, not a filled background.** This is already the stated principle in `src/platform/ui/alert.tsx:31-40`; read it and match it.
- Success and info auto-dismiss at about four seconds. **Error and warning persist until dismissed** and carry a close button. All are click-dismissible.
- Three visible at once, the rest queued.
- Polite live region for success and info, assertive for error, mirroring `alert.tsx:52`.
- `prefers-reduced-motion` respected.

Use the local `cx` helper (`src/platform/ui/cx.ts`). **There is no `tailwind-merge` in this codebase.**

- [ ] **Step 2: Test the behavior that matters**

```
- a success toast auto-dismisses; an error toast does not
- an error toast renders a close button and dismisses on click
- with four queued, three are visible
- the live region is polite for success and assertive for error
```

Follow `src/platform/ui/combobox.test.tsx`, which is the component test in this repo that drives state changes rather than rendering static markup. Read it before choosing an approach.

Timers: use vitest's fake timers for the auto-dismiss test rather than a real four-second wait.

- [ ] **Step 3: Commit**

```bash
npx eslint src && npm run typecheck
git add -A src
git commit -m "feat(ui): add the toast viewport and useToast hook"
```

---

### Task 4: Mount it, and give the inactivity warning the same lane

**Files:**
- Modify: `src/app/layout.tsx:63-71`
- Create: `src/platform/ui/toast/flash-reader.tsx`
- Modify: `src/platform/auth/inactivity.tsx:59-75`

**Interfaces:**
- Consumes: Task 1's classifier, Task 3's viewport and hook.

- [ ] **Step 1: Mount the viewport in the ROOT layout**

`src/app/layout.tsx`, beside `InactivityTracker`, **not** in `AppShell`. Two reasons, both load-bearing, and worth a comment in the file:

- Flash params exist outside the `(app)` group. `login/page.tsx`, `login/verify`, `apply/page.tsx`, `apply/verify`, `apply/[slug]`, and three `get-started` pages all carry them, and `AppShell` does not wrap those.
- `.glass-bar`'s `backdrop-filter` creates a containing block that breaks `fixed` children. That is why `HelpLauncher` is already mounted outside the toolbar (`app-shell.tsx:126-131`). The root layout is outside every glass container by construction.

- [ ] **Step 2: Build the flash reader**

A client component that reads the URL, feeds the params to Task 1's classifier, pops a toast per claimed group, then strips **exactly** the claimed names with `router.replace`, preserving every other param.

Preserving the rest is the whole ballgame: a reader that rebuilds the URL from only what it recognises would drop every filter on the page.

Guard against re-firing on re-render, not just on refresh.

- [ ] **Step 3: Move the inactivity warning into the shared lane**

`inactivity.tsx:62` is `fixed bottom-4 right-4 z-50`. Move it into the same bottom-center lane as the toast viewport, stacked so the two can never overlap.

**Leave `HelpLauncher` alone.** It keeps the bottom-right corner it already owns. That is the entire point of R12: the collision is resolved by moving the warning, not by nudging the bubble.

Keep `role="alert"`. It is telling someone they are about to be signed out.

- [ ] **Step 4: Verify in a browser**

Environment: copy `.env.local` from another worktree; it is gitignored, never commit it. Start your own dev server with `run_in_background: true` and confirm it answers with curl before driving it. Use Playwright MCP; the Chrome extension is not connected.

Confirm: a flash param pops a toast and disappears from the URL; a refresh does not re-fire it; a page with a filter param keeps the filter after the strip. If you cannot reach a page that produces a flash, say so and rely on the unit tests rather than burning the task.

- [ ] **Step 5: Commit**

```bash
npx eslint src && npm run typecheck
git add -A src
git commit -m "feat(ui): mount the toast viewport and share a lane with the inactivity warning"
```

---

### Task 5: Convert the error-family pages

**Files:**
- Modify: the TOAST-ruled pages from Task 2's inventory whose params are claimed by the `/Error$/` convention or named `error`

**Interfaces:**
- Consumes: Task 2's inventory, and the system from Tasks 1, 3, 4.

Split from Task 6 because the convention-claimed params need no registry work, so this task is purely deletion, while Task 6's needs messages moved.

- [ ] **Step 1: Remove the inline renders**

For each page: delete the `<Alert>` render driven by the claimed param, and the now-unused param read, destructure, and type entry. Leave every other param and every INLINE-ruled alert untouched.

**Delete, do not comment out.** And do not "helpfully" convert an INLINE-ruled alert while you are in the file.

- [ ] **Step 2: Prove no page double-reports**

A repo-wide check, not a per-page one: no page should still render an `<Alert>` from a param the registry or convention claims. Write it as a test if you can express it, and report the result either way.

- [ ] **Step 3: Commit**

```bash
npx eslint src && npm run typecheck
git add -A src
git commit -m "refactor(ui): move page-level error alerts to toasts"
```

---

### Task 6: Convert the success-family pages

**Files:**
- Modify: the remaining TOAST-ruled pages from Task 2's inventory
- Modify: `src/platform/ui/toast/flash.ts` (registry entries)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Move each message into the registry**

These are the shape-2 and shape-3 params: the page currently hardcodes or composes the text. For each, add a registry entry carrying the *exact* current message, then delete the page's render.

**Copy the existing strings verbatim.** Do not reword them while migrating. A migration that also rewrites copy is two changes wearing one coat, and the reviewer cannot tell which was intended.

Where a message genuinely depends on page-local data that the URL does not carry, do NOT force it into the registry: leave the page composing it and have it call `useToast()` directly. Say which pages you did this for and why.

- [ ] **Step 2: Re-run the double-report check from Task 5 Step 2**

- [ ] **Step 3: Commit**

```bash
npx eslint src && npm run typecheck
git add -A src
git commit -m "refactor(ui): move page-level success alerts to toasts"
```

---

### Task 7: Whole-branch check

- [ ] **Step 1: Prove no filter param was eaten**

For each of `status`, `page`, `q`, `tab`, `token`, `view`, `mode`, `date`, `dept`, `term`, `track`, `next`, `callbackUrl`, `type`, `priority`, `category`, `assignee`, `departmentId`: confirm it is neither claimed by the convention nor present in the registry, and that the pages using it still read it. Report as a list, not as a claim that it is clean.

This is the failure mode with no symptom other than a page quietly not filtering.

- [ ] **Step 2: Full unit suite**

```bash
npx vitest run
```

`main` carries one known flaky test, `review.test.ts > listAcceptances`, a `createdAt`-tie ordering flake. It is not yours. Anything else in a file this branch touched is.

- [ ] **Step 3: Lint and typecheck**

```bash
npx eslint src e2e && npm run typecheck
```

- [ ] **Step 4: Check the e2e suite**

Playwright cannot run locally. Read the specs and report whether any asserts on an inline alert whose page this branch converted, or on a URL still carrying a flash param. **Report; do not edit specs speculatively.** `e2e/` asserting on text that now appears in a toast rather than an inline alert is the most likely break.

---

## Self-review notes

**Spec coverage.** Spec section 1 (viewport placement) is Task 4 Step 1. Section 2 (convention plus registry) is Task 1. Section 3 (strip what you consume) is Task 4 Step 2. Section 4 (`useToast`) is Task 3. Sections 5 and 6 (dismissal policy and visual) are Task 3 Step 1. Section 7 (the shared lane) is Task 4 Step 3. Section 8 (the migration rule) is Tasks 2, 5, and 6. The spec's testing list is distributed across Tasks 1, 3, and 7, with the filter-preservation requirement appearing three times on purpose: as unit assertions in Task 1, as a preservation test in Task 4, and as a whole-branch sweep in Task 7.

**Ordering.** Task 1 is first and pure, because it is the piece whose failure mode is silent. Task 2 produces the data Tasks 5 and 6 need and completes Task 1's registry, so it comes before any page edit but does not block Task 3. Tasks 5 and 6 are split by whether the param needs a registry entry, which is also the split between pure deletion and copy movement.

**Two steps hand a judgment call to the implementer with the information to settle it:** Task 2 Step 2 (the per-page TOAST / INLINE / NOT A FLASH ruling, with the explicit instruction that uncertainty resolves to NOT A FLASH) and Task 6 Step 1 (whether a message belongs in the registry or stays page-composed behind `useToast`).

**The riskiest thing in this plan is a permissive classifier**, so Task 1's tests name each filter param individually rather than looping an array, and Task 7 Step 1 re-checks them at the branch level. A loop over the same list the implementation uses would pass no matter what.

**Not covered: changing any redirect site.** The spec scopes the producing side out entirely, and the Global Constraints tell a task to stop and report if it seems to need one.
