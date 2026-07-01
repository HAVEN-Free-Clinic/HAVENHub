# De-vibecode / Consistency Hardening, PR B (cosmetic) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the boilerplate-comment fingerprints (path-echo file headers, name-only banner comments, restate comments) plus a few tiny non-comment cleanups, all with zero behavior change.

**Architecture:** Almost entirely comment deletions. The two non-comment fixes (unwrap a single-statement transaction, replace a self-contradicting assertion) are output-equivalent. `git diff -w` is the safety net: for the comment tasks it should show only removed comment lines; the only non-whitespace code changes come from Task 2.

**Tech Stack:** Next.js App Router, TypeScript, Prisma, Vitest, ESLint flat config.

## Global Constraints

- No em-dashes (the `—` character) anywhere. This is now enforced by the `local/no-em-dash` ESLint rule added in PR A; `npm run lint` will fail if one is introduced.
- Product name "HAVEN Hub" (two words); identifiers stay `havenhub`.
- Zero behavior change: comment-only edits plus two output-equivalent refactors (Task 2). Existing tests must stay green.
- Do not run `prisma generate` in the worktree (shared cross-worktree client; CI regenerates). Local `tsc` may show pre-existing stale-client errors; "clean" means no new errors in changed files. DB-backed vitest cannot run in this worktree; CI is the gate. Non-DB unit tests run locally.
- Branch: `feat/devibe-cosmetic` (already created off the PR A tip `feat/devibe-consistency`). Commit after each task. The PR base is `feat/devibe-consistency`; GitHub auto-retargets to `main` when PR A merges.
- Verify with `npm run lint` and `npx tsc --noEmit` after each task.

---

### Task 1: Remove path-echo file-header comments

**Files (Modify): the 36 files whose line 1 is a `// src/...` comment echoing their own path:**
`src/app/(app)/notifications/page.tsx`, `src/app/(app)/recruitment/cycles/[id]/builder/{actions.test.ts,field-card.tsx,form-builder.tsx,options-editor.tsx,page.tsx,quiz/quiz-builder.tsx,section-card.tsx,sortable-list.tsx,type-picker.tsx}`, `src/app/api/cron/recruitment-drafts/route.ts`, `src/app/apply/[slug]/draft-actions.ts`, `src/app/apply/verify/route.ts`, `src/modules/recruitment/services/{drafts.ts,portal-auth.ts,portal-status.test.ts,portal-status.ts,renewal.test.ts,renewal.ts}`, `src/platform/cron.test.ts`, `src/platform/notifications/{channel.test.ts,channel.ts,identity.test.ts,identity.ts,inbox-actions.test.ts,inbox-schema.test.ts,inbox.test.ts,inbox.ts,notify.test.ts,notify.ts,render.test.ts,render.ts,send.test.ts,send.ts,teams-transport.test.ts,teams-transport.ts}`.

**Interfaces:** none (comment-only).

- [ ] **Step 1: Confirm the authoritative list**

Run: `rg -n '^// src/' src -g '*.ts' -g '*.tsx' | grep ':1:'`
Expected: the 36 files above (the `:1:` filter means the path-echo is the first line).

- [ ] **Step 2: Delete each path-echo header**

For each file, delete line 1 (the `// src/...` comment). If line 2 is then a blank line before the first import or statement, delete that blank line too so the file starts cleanly with real content. Change nothing else.

- [ ] **Step 3: Verify completeness and cleanliness**

Run: `rg -n '^// src/' src -g '*.ts' -g '*.tsx' | grep ':1:'` (expect no output).
Run: `git diff -w --stat` and confirm every changed file shows only removed lines (1 or 2 lines each), no code changes.
Run: `npm run lint` (green) and `npx tsc --noEmit` (no new errors in changed files).

- [ ] **Step 4: Commit**

```bash
git add src
git commit -m "style: drop path-echo file-header comments"
```

---

### Task 2: Targeted small cleanups

**Files:**
- Modify: `src/modules/admin/components/roles-panel.tsx` (empty banner near line 55)
- Modify: `src/platform/people.ts` (single-statement `$transaction` at line 79; check 179 and 250)
- Modify: `src/app/(app)/recruitment/cycles/[id]/builder/options-editor.tsx:23` (self-contradicting assertion)
- Modify: `src/modules/admin/services/itcm-pdf.ts:229-230` (duplicate comment)
- Modify (remove bare restate comments): `src/modules/admin/components/roster-panel.tsx:256`, `assignment-form.tsx:225`, `roles-panel.tsx:139`, `src/app/(app)/admin/email/page.tsx:268`, `admin/email/campaigns/[id]/page.tsx:232`, `volunteers/disciplinary/page.tsx:244`, `admin/terms/[id]/page.tsx:146`, `schedule/builder/page.tsx:383`, `volunteers/epic/page.tsx:119` (`// Fetch data`) and `:359` (`// Render`)

**Interfaces:** none consumed/produced; the two code refactors are output-equivalent.

- [ ] **Step 1: Remove the empty `// Sub-components` banner in roles-panel.tsx**

At `roles-panel.tsx` around line 55 there is a `// Sub-components` comment with no content beneath it before `// Main component` (around line 59). Remove the empty `// Sub-components` banner line(s). If `// Main component` has real component code beneath it and no sibling section remains, remove that now-orphaned `// Main component` label too (it labeled a split that no longer exists). Do not change any code.

- [ ] **Step 2: Unwrap single-statement transactions in people.ts (only where single-statement)**

Read each `$transaction` at `people.ts` lines 79, 179, 250. For any whose callback body is a SINGLE statement (one `await tx.<model>.<op>(...)` whose result is returned), unwrap it to a plain `await prisma.<model>.<op>(...)`. For example if line 79 is:

```ts
const person = await prisma.$transaction(async (tx) => {
  return tx.person.create({ data: {...} });
});
```

replace with:

```ts
const person = await prisma.person.create({ data: {...} });
```

If a `$transaction` callback contains MORE THAN ONE statement (multiple writes that must be atomic), LEAVE it untouched and note that in the report. Output-equivalent for the single-statement case (a one-statement transaction is a no-op wrapper).

- [ ] **Step 3: Fix the self-contradicting assertion in options-editor.tsx:23**

Current line 23:

```ts
onChange(orderedIds.map((id) => options.find((o) => o.value === id)!).filter(Boolean));
```

Replace with a `flatMap` that does not both assert non-null and then filter null:

```ts
onChange(orderedIds.flatMap((id) => {
  const found = options.find((o) => o.value === id);
  return found ? [found] : [];
}));
```

Output-equivalent: same options in `orderedIds` order, ids with no matching option skipped. Confirm the surrounding `onChange` type still accepts the resulting array (it did before; the element type is unchanged).

- [ ] **Step 4: Remove the duplicate comment in itcm-pdf.ts**

Lines 229 and 230 are both `// Section III: Person info`. Delete one (keep a single occurrence). Leave line 246 (`// Section III: always-fixed fields`) as-is (it labels a different block).

- [ ] **Step 5: Remove bare restate comments**

Delete the bare `// Render` comments at the 8 locations listed in Files and the `// Fetch data` comment at `volunteers/epic/page.tsx:119` (plus the `// Render` at `volunteers/epic/page.tsx:359`). These restate the obvious structure and add nothing. Remove only the comment line (and a resulting doubled blank line if one results). Do not remove a comment that carries real information (only the bare one-word `// Render` / `// Fetch data` labels).

- [ ] **Step 6: Verify**

Run: `git diff -w` and confirm the ONLY non-whitespace code changes are the people.ts unwrap(s) and the options-editor flatMap; everything else is comment removal.
Run: `npm run lint` (green), `npx tsc --noEmit` (no new errors in changed files).
The `people.ts` and `options-editor.tsx` changes have DB-backed / component tests that are CI-verified in this worktree; confirm output-equivalence by reading. If a pure non-DB test covers options-editor, run it: `npx vitest run <that file>`.

- [ ] **Step 7: Commit**

```bash
git add src
git commit -m "refactor: unwrap single-statement tx, fix filter, drop restate/duplicate comments"
```

---

### Task 3: Remove name-only banner comments

**Files (Modify): the subset of the ~80 files containing `// -----` banners where a banner only restates the single declaration below it.** The worst offenders (per the scan) are `src/modules/volunteers/services/epic.ts`, `src/modules/schedule/services/builder.ts`, `src/modules/schedule/services/requests.ts`, `src/modules/admin/services/itcm.ts`; banners are spread across `src/platform/**`, `src/modules/**`, and `src/app/**`.

**Interfaces:** none (comment-only).

- [ ] **Step 1: Enumerate the banner files**

Run: `rg -l '^// -{10,}' src -g '*.ts' -g '*.tsx'` (about 80 files).

- [ ] **Step 2: Remove name-only banners; keep meaningful section dividers**

A "banner" is a `// ----------------...` divider line, often surrounding a label line. Apply this exact rule to each banner:

- REMOVE the banner (the divider line(s) and its label) when the label is just a single symbol name (or a trivial restatement of it) that matches the declaration immediately below it. Examples to remove: a `// createTicket` label (with or without surrounding dashes) directly above `export function createTicket(...)`; a bare `// -----` divider that only separates one function from the next with no grouping label.
- KEEP the banner when its label names a SECTION that groups MULTIPLE declarations or conveys non-obvious structure. Examples to keep: `// LogTransport` / `// GraphTransport` dividers in `platform/email/transport.ts` that separate distinct classes; labels like `// Public API`, `// Types`, `// Helpers`, `// Internal` that head a group of several declarations.
- When uncertain whether a banner is meaningful, KEEP it. The goal is removing noise, not restructuring files.

Remove only comment lines; never change code. If removing a banner leaves a doubled blank line, collapse it to one.

- [ ] **Step 3: Verify no code changed**

Run: `git diff -w` for this task's changes and confirm it is EMPTY (all changes are comment/whitespace only; a non-empty `-w` diff means a code line was touched, which must be reverted).
Run: `npm run lint` (green) and `npx tsc --noEmit` (no new errors in changed files).

- [ ] **Step 4: Commit**

```bash
git add src
git commit -m "style: drop name-only banner comments, keep meaningful section dividers"
```

---

## Final verification (whole branch)

- `npm run lint` green (em-dash rule + controls rule pass).
- `npx tsc --noEmit` no new errors in changed files.
- `git diff -w feat/devibe-consistency..HEAD` shows non-whitespace changes ONLY from Task 2 (the people.ts unwrap and options-editor flatMap); Tasks 1 and 3 are comment/whitespace only.
- Non-DB unit tests still green; DB-backed tests CI-verified.

## Self-review notes (coverage check)

- Spec workstream E: path-echo headers (Task 1), name-only banners keeping meaningful dividers (Task 3), empty banner + single-statement transaction + self-contradicting assertion + duplicate comment + restate comments (Task 2).
- CAUTION carried from PR A final review: `listAttendings` in `schedule/services/attendings.ts` is LIVE (used by `schedule/attendings/page.tsx`); this plan does not touch it and must not.
