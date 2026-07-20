# Scheduling Term-Awareness — Spec 1: Staff Build-Ahead Foundation

Date: 2026-07-20
Status: Approved design, ready for implementation planning
Branch: `feat/next-term-scheduling` (stacked on `worktree-investigate+recruitment-training` / PR #343, the cross-term foundation)
Depends on: the cross-term model foundation (`getWorkingTerm`, `getNextTerm`, `getPersonTerms`) shipped in the cross-term slice.

## 1. Goal and shape

HAVEN builds the upcoming term's schedule ahead of the flip (in Summer, directors build Fall), but the entire schedule subsystem hard-resolves the single active term via `getActiveTerm()`, so the builder can only ever open the live term. This spec makes the **schedule builder** term-aware so a director or central scheduler can build (and later adjust) any in-flight term's schedule via an explicit **working term**, selected with a `?term=<id>` switcher.

This is **Spec 1 of a two-spec sequence** the product owner approved for the full "next-term scheduling" feature:
- **Spec 1 (this doc): staff build-ahead foundation.** The builder and its services become term-aware; the switcher offers live + next (editable) and archived (read-only); member-facing surfaces stay live-term (which keeps them safe, see 5).
- **Spec 2 (next): publish gate + member next-term self-service.** A publish/visibility model (which does not exist today) so directors release a built next-term schedule to members, after which member views/availability/swap-requests span the published next term.

Spec 2 depends on Spec 1's term-threading plus a publish concept, so this order is the real dependency chain, not padding.

### 1.1 Design decisions (locked)

- **Term model reused:** live term = the single `ACTIVE` term; next term = the single `PLANNING` term. The switcher also offers archived terms **read-only**. Editable is exactly `term.status !== "ARCHIVED"`.
- **Approach (mirrors the cross-term slice):** services receive an explicit `termId`; the page resolves the working term from `?term=` at the boundary. Services stop resolving `getActiveTerm()` internally.
- **Who builds (Q5=A):** continuing directors and central schedulers build ahead. Department scope stays derived from the active-term directorship (no shared `departments.ts`/RBAC changes). An incoming-only director building their own next-term department is a deferred follow-up.
- **Members stay live-term** in this spec. Member `/schedule`, the clinic-wide day view, and the reminder crons keep resolving `getActiveTerm()`, which preserves the no-leak property until Spec 2 adds a deliberate publish gate.

### 1.2 In scope

- Extend `getWorkingTerm` to resolve an archived term; derive `editable`.
- A `<TermSwitcher>` on the builder + a `?term=` search param on `/schedule/builder`.
- Thread the working term into `builderView` and the four write services; validate `dateKey` against the working term's clinic dates; hard-block writes to an `ARCHIVED` term.
- Builder page wiring: hrefs preserve `?term`, server actions carry the term, read-only UI for archived, requests panel shown only for the live term.

### 1.3 Out of scope (Spec 2, or deferred)

- Any member-facing next-term surface (`mySchedule`, `updateMyAvailability`, `createRequest`), the publish/visibility gate, and making the request/reminder services term-aware.
- The latent `schedule-reminders` cron bug (a next-term request's reminder routing to the active term's directors) cannot fire in Spec 1 (no next-term requests exist yet); it is carried into Spec 2.
- Incoming-only-director department scope (the shared `departments.ts` / RBAC term-awareness).
- The clinic-wide day view (`fullSchedule`) staying live-term.

## 2. Working-term resolution + the switcher

### 2.1 `getWorkingTerm` extension

`getWorkingTerm(selectedId?)` (`src/platform/terms/working-term.ts`) today resolves only the live or next term, falling back to the live term. Extend it so a `selectedId` that names any real term — including an `ARCHIVED` one — resolves to that term, still falling back to the live term for an unknown/empty id. Implementation: after the live/next check, look the id up (`prisma.term.findUnique`) and return it if found; otherwise the live term. The safe-fallback contract is preserved. React `cache()` wrapping stays.

### 2.2 Editability

The builder derives `editable = workingTerm.status !== "ARCHIVED"` from the resolved term. Live (`ACTIVE`) and next (`PLANNING`) are editable; archived is read-only. No separate flag or column is needed.

### 2.3 `<TermSwitcher>` component + route

A small control at the top of the builder lists: **Live** (default, no `?term`), **Next** (labeled, e.g. "Fall 2026 · building ahead") when a `PLANNING` term exists, and a bounded set of recent **Archived** terms (labeled read-only). It reuses the existing `buildTermOptions` labeling helper (`src/modules/admin/components/term-options.ts`), extended to include archived entries. Selecting a term navigates with `?term=<id>` — a plain link (RSC-friendly, shareable). With no `?term`, the working term is the live term and the switcher renders exactly as the builder does today.

`/schedule/builder` (`src/app/(app)/(schedule)/schedule/builder/page.tsx`) gains an optional `?term=<id>` search param alongside the existing `dept`/`date`/`view`/`mode`/`gmode`.

## 3. Threading the working term through the builder services

All in `src/modules/schedule/services/builder.ts`. Each of these stops calling `getActiveTerm()` and instead receives the resolved working `termId`:

### 3.1 `builderView`

`builderView(viewerPersonId, { departmentId, dateKey, now, termId })` loads the **working** term's roster (`TermMembership` for `termId`), clinic dates, and assignments. This is what shows Fall's roster and grid when Fall is selected. (Was `builder.ts:682`, currently resolves the active term.)

### 3.2 Write services

- `setAssignment(actor, { departmentId, dateKey, personId, role, reason?, termId })` (was `:167`)
- `toggleTag(actor, { departmentId, dateKey, personId, tag, termId })` (was `:286`)
- `setPatientsBooked(actor, { departmentId, dateKey, patientsBooked, termId })` (was `:332`)
- `upsertRhdClinic(actor, { dateKey, ..., termId })` (was `:490`)

Each loads the term by `termId` (for its `clinicDates`), validates `dateKey` against **that term's** clinic dates (not the active term's), and writes rows stamped with `termId`. Clinic dates are already settable on a `PLANNING` term today (`updateClinicDates` loads by id), so no change there.

### 3.3 The read-only guard (enforces the archived-read-only decision)

Every schedule-mutating write rejects a write whose target term is `ARCHIVED` by throwing a typed `ScheduleStateError` — a server-side guard, not merely a hidden button. So a stale tab or a hand-crafted request cannot mutate a closed term. This covers the four `termId`-threaded services above **and** `setAvailabilityOverride` (which derives its term from the membership row): each checks the resolved term's status before writing. Live and next write normally; archived is hard-blocked.

### 3.4 Already term-safe (no `termId` threading)

`setAvailabilityOverride` and `acknowledgeAvailability` resolve the term from the membership row, so they need no `termId` parameter and work unchanged once `builderView` hands them the working term's roster. `setAvailabilityOverride` additionally gains the archived guard from 3.3; `acknowledgeAvailability` only stamps an acknowledgement and is left unguarded. The RHD attending roster (`createAttending`/`updateAttending`) is a term-agnostic global list, so it takes no term at all.

### 3.5 Department scope (unchanged; Q5=A)

`manageableScheduleDepartmentIds` still resolves managed departments from the active-term directorship. A continuing director or central scheduler building the next term's department X passes because department X is a single shared entity across terms. An incoming-only director is the deferred follow-up. No shared `departments.ts` / RBAC changes in this spec.

## 4. The builder page

`src/app/(app)/(schedule)/schedule/builder/page.tsx`:

- **Resolve once:** read `sp.term`, call `getWorkingTerm(sp.term)`, derive `editable`, pass `termId` into `builderView`. Render `<TermSwitcher>` at the top.
- **Hrefs preserve `?term`:** add `term` to the set the page rebuilds URLs from (`dept`/`date`/`view`/`mode`/`gmode`), so switching department/date/view keeps the working term. The default/live term omits `term`, so live-term URLs are byte-identical to today.
- **Server actions carry the term where the service needs it:** the term-scoped writes — assign, unassign, toggle-tag, patients-booked, RHD clinic — get the resolved `termId` threaded into their service calls. The availability-override and acknowledge actions are already term-safe (they derive the term from the membership row, which belongs to the working term's roster once `builderView` loads it), and add-attending manages a term-agnostic global roster, so none of those three needs `termId`. The Section 3.3 guard is the hard backstop for the term-scoped writes (and the override).
- **Read-only UI when archived:** when `!editable`, hide the write controls (assign/unassign, tag toggles, patient-count input, RHD clinic edit, availability override) and show a "Viewing **{term}** — archived, read-only" banner. The grid still renders for reference.
- **Requests panel only for the live term:** shift-swap requests stay live-term in this spec (no next-term requests exist yet). The builder's pending-requests / approve / deny panel renders only when the working term is the live term; otherwise it is absent. The `listDepartmentRequests` / `approveRequest` / `denyRequest` calls stay live-term and are only invoked in that case.

**Out of this spec's page scope:** the clinic-wide day view (`fullSchedule`) and member `/schedule` (`mySchedule`) stay live-term.

## 5. The no-leak property (and a carried bug)

There is no draft/published concept anywhere in the schema or code. Today the only thing preventing a half-built Fall schedule from appearing in a member's `/schedule` is that member-facing reads resolve `getActiveTerm()` and filter assignments by it, so Fall rows (a different `termId`) do not match. This spec **keeps every member-facing read and both reminder crons on `getActiveTerm()`**, so that protection holds unchanged. Spec 2 replaces it with a deliberate publish gate before any member surface spans the next term.

The `schedule-reminders` cron (`src/app/api/cron/schedule-reminders/route.ts`) queries `PENDING` `ShiftRequest` rows with no term filter and routes reminders via `requestApproverRecipients` (active-term directors). This is a latent wrong-term-routing bug, but it **cannot fire in Spec 1** because no next-term requests can be created (member request creation stays live-term). It is carried into Spec 2, where next-term requests become real.

## 6. Edge cases

- **Invalid/stale `?term`:** `getWorkingTerm` falls back to the live term (safe).
- **Archived term selected:** read-only UI; any write throws server-side.
- **No next term:** the switcher shows Live (plus archived); building-ahead is simply not offered.
- **Building a next term whose department has no promoted roster yet:** `builderView` shows an empty grid (correct — nobody has been promoted into that term yet).
- **Incoming-only director:** sees no manageable departments for the next term (the documented Q5=A deferral).

## 7. Rollout and migration

No schema change, no backfill. Fully backward-compatible: with no `?term`, the working term is the live term and every path behaves as today; with no `PLANNING` term (the steady state), building-ahead is not offered. Safe to ship on its own. Blast radius: one `getWorkingTerm` extension, five service signatures gaining `termId`, one switcher component, and the builder page wiring.

## 8. Testing

- **Unit (the real safety net):**
  - `getWorkingTerm` resolves an archived term by id and falls back to live for an unknown id; `editable` derivation (`ACTIVE`/`PLANNING` editable, `ARCHIVED` not).
  - Each write service (`setAssignment`, `toggleTag`, `setPatientsBooked`, `upsertRhdClinic`) validates `dateKey` against the **working** term's clinic dates and **rejects a write to an `ARCHIVED` term** (the read-only guard — the key new test).
  - `builderView` loads the working term's roster + assignments for a `PLANNING` term, and collapses to today's output when the working term is the live term.
- **Backward-compat:** with one `ACTIVE` term and no `?term`, the builder services behave exactly as before.
- **Page wiring** (RSC, no unit test): verified by `tsc` + full `npm run lint`; the switch-term / build / read-only-archived flow is Playwright/manual (noted, since e2e cannot run locally here).

## 9. Done criteria

- A director/scheduler can select the next (`PLANNING`) term in the builder and build its schedule — roster, clinic dates, assignments, tags, patient counts, RHD clinic — while a different term is live, with all rows stamped to the working term.
- Selecting an archived term renders read-only; every write to an archived term is rejected server-side.
- With no `?term` (or only one term in flight), the builder behaves identically to today.
- Member `/schedule`, the clinic-wide day view, and the reminder crons still resolve the active term, so no next-term schedule leaks to members.
- Existing tests pass; new tests cover the working-term resolution, the read-only guard, and `builderView` for a next term.
