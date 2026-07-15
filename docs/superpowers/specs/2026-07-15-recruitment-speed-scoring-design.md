# Recruitment "Speed Score" (Easy Grader): Design

**Date:** 2026-07-15
**Branch:** `feat/recruitment-speed-scoring`
**Author:** Jack C (with Claude)

## Goal

A fast, keyboard-driven modal that lets a committee reviewer burn through applicants in a
recruitment cycle: each applicant's whole application is condensed onto one page; the reviewer
reads it, presses **1–5**, and is bumped straight to the next unscored applicant. No page loads
between applicants.

This is a UI layer on top of the existing committee-scoring pipeline (PR #292 / #293). It adds
**no new Prisma models and no schema migration.**

## What it builds on (existing, reused verbatim)

| Concern | Existing thing | File |
|---|---|---|
| Score store | `CommitteeScore`: `score Int` (1–5), `comments`, `@@unique([applicationId, scorerId])` (idempotent upsert) | `prisma/schema.prisma` (~1347) |
| Write path | `submitCommitteeScore(applicationId, scorerId, score, comments)`: validates 1–5, blocks self-scoring, requires `recruitment.score` OR `recruitment.review_all`, audits | `src/modules/recruitment/services/committee-scoring.ts:13` |
| Score summary | `committeeScoreSummary(applicationId)` → `{ average, count, scores[] }` | same file `:48` |
| Review queue | `listApplicantsForReview(cycleId, viewerId)`: a scorer sees every SUBMITTED app in the cycle | `src/modules/recruitment/services/review.ts:68` |
| Access rule | `canViewApplication(app, { scope, managesCycles, canScore })`, `reviewScope(personId)` | `src/modules/recruitment/services/review.ts` |
| Full application load | `getApplication(id)` → app + applicant + `cycle.sections` (APPLICATION purpose, ordered fields) | `src/modules/recruitment/services/submissions.ts:378` |
| Section visibility + type labels | `visibleSections(sections, ctx)`, `applicantTypeLabel(type)`, `scopeForApplicantType` | `src/modules/recruitment/engine/visibility.ts` |
| Field `visibleWhen` gate | `isFieldVisible(visibleWhen, answers)`, `visibleFields(fields, answers)` | `src/modules/recruitment/engine/field-visibility.ts` |
| File serving (auth'd, inline allowlist) | `GET /api/recruitment/applications/[applicationId]/files/[key]?inline=1` | `src/app/api/recruitment/applications/[applicationId]/files/[key]/route.ts` |
| Inline PDF/image preview pattern | `CertificateViewer` (Modal + iframe, mounted only while open) | `src/modules/my-info/components/certificate-viewer.tsx` |
| Modal shell (focus trap, Esc, scroll lock, portal, a11y) | `Modal` | `src/platform/ui/modal.tsx` |
| Primitives | `Card`, `Badge`, `Alert`, `Button`, `Spinner`, `Input`/`Textarea`/`Field`: via `@/platform/ui/*`, classes joined with `cx` (no tailwind-merge) | `src/platform/ui/` |

## Approved decisions

1. **Launch point:** a **"Speed score" button on the cycle's applicant list page**
   (`.../cycles/[id]/applicants/page.tsx`). It opens the modal over the current roster. Cycle-scoped,
   reuses the queue. (No new nav tab, no new route.)
2. **Queue behavior:** **start on the first unscored applicant; skip already-scored ones by default.**
   A header **"show scored"** toggle expands the queue to all applicants so a reviewer can navigate
   back and overwrite a prior score. Reaching the end shows a **done summary**.
3. **Comments:** **optional and non-blocking.** Press 1–5 to score+advance instantly; an optional
   comment field is present but never required. The comment is sent with the score.
4. **Documents:** **expand on demand.** Text answers are always visible; each uploaded file is a
   button that expands an inline PDF/image preview (the `CertificateViewer` pattern) when the
   reviewer wants it.
5. **Data loading:** **Approach B: lazy + prefetch-next.** The page passes only a lightweight queue
   (name + my-score) as props. A bound server action fetches the *current* applicant on open and
   *prefetches the next* into a small client-side cache, so advancing stays instant while initial
   open is cheap. Files are never in the payload (fetched via the `/api` route only on expand).
6. **"At a glance" layout is type-based, not key-based.** Fields are zoned by `FieldType`, never by
   hardcoded keys, so the layout survives per-cycle form customization:
   - scalar fields (`SHORT_TEXT`, `SINGLE_SELECT`, `MULTI_SELECT`, `CHECKBOX`, `EMAIL`, `PHONE`,
     `NUMBER`, `DATE`, `DEPARTMENT_CHOICE`, `SUBCOMMITTEE_RANK`) → dense two-column grid ("At a glance")
   - `LONG_TEXT` → full-width essays
   - `FILE` → the Documents zone

## Architecture & data flow

```
applicants/page.tsx (server)
  ├─ listApplicantsForReview(cycleId, viewerId)   (select extended with scorerId)
  ├─ derive lightweight queue: SpeedScoreItem[] { applicationId, name, typeLabel, myScore }
  │     (viewer's own application filtered out)
  └─ if canScore: render <SpeedScoreLauncher queue onScore onLoad cycleId />   (client)
        └─ <SpeedScoreModal>   (client)
             ├─ buildSpeedScoreQueue(items, { includeScored }) → { queue, initialIndex }  (pure)
             ├─ Map<applicationId, ReviewApplicationView> cache + prefetch-next
             ├─ onLoad(applicationId)  ─────▶ loadReviewApplicationAction (server action)
             │                                  └─ loadReviewApplication(applicationId, viewerId)
             │                                       (canViewApplication + view-model build)
             ├─ 1–5 ─▶ onScore(applicationId, score, comment) ─▶ speedScoreAction (server action)
             │                                  └─ submitCommitteeScore(...)  (existing)
             └─ DocumentPreview → iframe src=/api/.../files/[key]?inline=1
```

### View model (serializable; crosses the server→client boundary)

Built server-side so option **labels are resolved** and hidden fields are dropped: the client never
sees raw machine values or the option lists (also sidesteps the "use client" plain-data proxy gotcha).

```ts
// src/modules/recruitment/services/speed-score.ts  (plain .ts, NOT "use client")
export type ReviewFieldView = {
  key: string;
  label: string;
  kind: "scalar" | "essay" | "file";
  displayValue: string;                 // resolved option label(s), joined; "" when unanswered
  file?: {
    key: string;
    fileName: string;
    inlineHref: string;                 // /api/recruitment/applications/{id}/files/{key}?inline=1
    inlinePreviewable: boolean;         // mime in the route's inline allowlist
  } | null;
};
export type ReviewSectionView = { title: string; fields: ReviewFieldView[] };
export type ReviewApplicationView = {
  applicationId: string;
  name: string;
  email: string;
  typeLabel: string;                    // New | Renewal | Transfer
  departmentChoices: string[];          // resolved labels for the header chips (shown ONLY in the header)
  sections: ReviewSectionView[];        // order preserved; each field carries its `kind`
};
```

**Rendering:** the modal **flattens fields across all sections** and buckets them into the three
kind-zones from the approved mockup (scalar→"At a glance", essay→"Essays", file→"Documents").
Section `title` may be used as a secondary sub-heading within the Essays zone for context. The
`DEPARTMENT_CHOICE` field is **omitted from the body grid**: department preferences appear only as
header chips (from `departmentChoices`) to avoid duplication.

```ts
// (types, continued)

export type SpeedScoreItem = {
  applicationId: string;
  name: string;
  typeLabel: string;
  myScore: number | null;
};
```

`loadReviewApplication(applicationId, viewerId)`:
1. `getApplication(applicationId)`; `notFound`-equivalent → return `{ error }`.
2. Enforce `canViewApplication(app, { scope: reviewScope(viewerId), managesCycles, canScore })`
   (defense in depth; mirrors the detail page and the file route).
3. `visibleSections(...)` then per field `isFieldVisible(f.visibleWhen, answers)` to drop hidden ones.
4. Resolve each value to `displayValue`:
   - `SINGLE_SELECT`/`MULTI_SELECT` → map machine value(s) to `f.options` labels (`{value,label}`),
     fall back to the raw value if unmatched.
   - `DEPARTMENT_CHOICE` → from `Application.departmentChoices` (hoisted column, not `answers`).
   - `SUBCOMMITTEE_RANK` → from `Application.subcommitteeRanking` (resolve subcommittee names).
   - `FILE` → build the `file` ref (`fileName`, `inlineHref`, `inlinePreviewable` from mime allowlist).
   - else → `String(value)` / `array.join(", ")`, `""` when absent.
5. Zone by `kind` (LONG_TEXT→essay, FILE→file, else scalar).

### Pure queue helper (unit-tested)

```ts
// src/modules/recruitment/engine/speed-score-queue.ts
export function buildSpeedScoreQueue(
  items: SpeedScoreItem[],
  opts: { includeScored: boolean },
): { queue: SpeedScoreItem[]; initialIndex: number };
```
- `includeScored=false` → queue = items with `myScore == null`, roster order; `initialIndex = 0`.
- `includeScored=true`  → queue = all items, roster order; `initialIndex` = first unscored, else 0.
- Self-application filtering happens upstream (page), but the helper is total on whatever it's given.
- `initialIndex` is `0` for an empty queue (modal opens straight to the done/"all caught up" state).

### Server actions (thin wrappers; `"use server"`)

Added to `src/app/(app)/recruitment/cycles/[id]/applicants/actions.ts`:

```ts
export async function speedScoreAction(
  applicationId: string, score: number, comments: string | null,
): Promise<{ error?: string }>;                 // requirePersonSession → submitCommitteeScore; NO redirect

export async function loadReviewApplicationAction(
  applicationId: string,
): Promise<{ view: ReviewApplicationView } | { error: string }>;   // requirePersonSession → loadReviewApplication
```

Unlike the existing `committeeScoreAction` (which `redirect`/`revalidatePath`s the detail page), these
return plain result objects (the `CertificateViewer` pattern) so the modal stays open.

## Interaction model

**Keyboard**
- `1`–`5`: set the current applicant's score and auto-advance to the next unscored item in the
  current queue. Suppressed while the comment field is focused (so typing "3" in a note doesn't score).
- `←` / `→`: move to prev / next item **without** scoring (revise or skip). Suppressed while the
  comment field is focused (arrows move the caret there).
- `Esc`: close the modal (handled by the `Modal` primitive; returns focus to the launch button).

**Score + advance (v1: await-then-advance).** On 1–5: read current `applicationId` + comment; call
`speedScoreAction` inside `useTransition`; on `{ error }` show an inline `<Alert tone="error">` and do
**not** advance; on success, update that item's local `myScore`, clear the comment, and advance to the
next unscored index (or the done state). A subtle "Saving…" indicator shows during the transition. The
next card is already prefetched, so the only added latency is the score write. *(Optimistic advance +
background submit is a possible later enhancement; v1 favors correctness and simplicity.)*

**Prefetch-next.** On open, fetch `queue[initialIndex]` and prefetch `queue[initialIndex+1]`. On any
move, if the target isn't cached, fetch it (inline `Spinner` in the body) and prefetch the following
item. A request token guards against stale responses being applied out of order.

**"Show scored" toggle.** Flips `includeScored`; the queue is rebuilt via `buildSpeedScoreQueue`, the
current applicant is preserved where possible, and already-scored cards render with the prior score
preloaded/highlighted (pressing a number overwrites + advances).

**Done state.** When no unscored item remains in the current queue, the body swaps to a summary:
"You scored N of M. All caught up," with buttons to review scored (turns the toggle on) or close.

## Modal layout

Large `Modal` variant (see "Modal primitive change"):

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Jane Doe [New]                         3 of 27 unscored  [ ] show scored  ✕│
│ jane.doe@yale.edu · Prefs: VADM, INTP                                      │
├──────────────────────────────────────────────────────────────────────────┤
│ AT A GLANCE                                                                │
│ Yale affiliation  Yale College      Grad year   2027                       │
│ Spanish           Conversational    Availability Sat 9/6, 9/20             │
│ ...                                                                        │
│ ESSAYS                                                                     │
│ <field label as heading>                                                   │
│   <full readable answer text>                                              │
│ DOCUMENTS                                                                  │
│ [▸ Resume.pdf]  [▸ Cover letter.pdf]         (click to expand inline)      │
├──────────────────────────────────────────────────────────────────────────┤
│ Score [1][2][3][4][5]     Comment (optional) [__________________] Saving…  │
│ Press 1–5 to score & advance · ← → move · Esc close                        │
└──────────────────────────────────────────────────────────────────────────┘
```
Header, body (scrollable), and footer are the three flex rows. Score buttons reflect the current
selection and are also click targets (mouse parity with the keyboard).

## Files

**New**
- `src/modules/recruitment/engine/speed-score-queue.ts`: pure `buildSpeedScoreQueue` + `SpeedScoreItem` re-export.
- `src/modules/recruitment/services/speed-score.ts`: `loadReviewApplication`, the view-model types, and value→label resolution.
- `src/modules/recruitment/components/speed-score-launcher.tsx` (`"use client"`): the button + open state.
- `src/modules/recruitment/components/speed-score-modal.tsx` (`"use client"`): the modal (queue nav, cache, prefetch, keyboard, scoring, done state).
- `src/modules/recruitment/components/document-preview.tsx` (`"use client"`): expand-on-demand file preview (extracted from the `CertificateViewer` pattern; reusable).

**Modified**
- `src/platform/ui/modal.tsx`: add `size?: "default" | "large"` (`default` = current `max-w-4xl`; `large` = `max-w-6xl`). No behavior change otherwise.
- `src/modules/recruitment/services/review.ts`: extend `listApplicantsForReview`'s `committeeScores` select from `{ score: true }` to `{ score: true, scorerId: true }` (roster page unaffected).
- `src/app/(app)/recruitment/cycles/[id]/applicants/page.tsx`: compute `myScore` per row, filter out the viewer's own application, and render `<SpeedScoreLauncher>` when `canScore`.
- `src/app/(app)/recruitment/cycles/[id]/applicants/actions.ts`: add `speedScoreAction` and `loadReviewApplicationAction`.

## Permissions & security

- The launcher button renders only when `canScore = scope.all || can(personId, "recruitment.score")`
  (same rule the detail page uses).
- `speedScoreAction` → `submitCommitteeScore` re-checks `recruitment.score`/`review_all` and blocks
  self-scoring; the queue also pre-filters the viewer's own application so they never land on an
  un-scoreable card.
- `loadReviewApplicationAction` → `loadReviewApplication` re-enforces `canViewApplication`.
- File previews go through the existing auth'd `/api/.../files/[key]` route (inline mime allowlist,
  `nosniff`, locked CSP, DB-derived object key: no traversal). No new file exposure.

## Edge cases

- **Empty queue / all scored:** modal opens directly to the done state.
- **Score error mid-run** (app withdrawn, permission changed): `<Alert>` shown, no advance.
- **Typing a comment:** number/arrow shortcuts suppressed while the comment field is focused.
- **Overwrite:** scoring an already-scored card (via "show scored") updates in place (upsert) and advances.
- **Stale fetch:** request-token guard drops out-of-order `onLoad` responses.
- **Cycle with hidden conditional fields:** dropped via `isFieldVisible` (fixes a gap the detail page has today).

## Testing

- **Unit (vitest):** `speed-score-queue.test.ts`: unscored-only vs include-scored, roster order,
  first-unscored `initialIndex`, empty-queue index 0.
- **Service (vitest, DB):** `speed-score.test.ts`: `loadReviewApplication` resolves option labels,
  drops `visibleWhen`-hidden fields, zones by kind, builds file refs, and enforces `canViewApplication`
  (out-of-scope viewer → error). Run with a **per-worktree `TEST_DATABASE_URL` pointing at the local
  throwaway pg (`havenhub_test`), never Neon** (repo `.env` points test URLs at shared Neon).
- **E2E (Playwright):** open a cycle's applicants → click "Speed score" → press `1`–`5` → assert it
  advances and the score persists (roster "Committee avg" reflects it) → toggle "show scored" →
  `Esc` closes. Mirrors the existing recruitment apply specs; runs in the serial CI suite.

## Out of scope (YAGNI)

- No new nav tab or `/recruitment/score` route (chose the list-page button).
- No schema change, no new permission.
- No director-track / interview-evaluation speed mode (this is committee 1–5 scoring only).
- No optimistic advance in v1 (listed as a possible enhancement).
- No bulk "score all N as X" action.
