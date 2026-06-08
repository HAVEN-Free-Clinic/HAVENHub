# Recruitment Review & Acceptance Design (Plan 11)

**Date:** 2026-06-08
**Status:** Approved (brainstorm) — Plan 11, the second sub-project of the Recruitment program
**Module id:** `recruitment` (active since Plan 10)
**Builds on:** Plan 10 foundation (`docs/superpowers/specs/2026-06-08-recruitment-design.md`). Branch `plan-11/recruitment-review` is stacked on `plan-10/recruitment-foundation`.

Plan 11 digitizes the **volunteer-track review & acceptance** step: department directors review applicants who chose their department and accept them in (with notes), SRR resolves multi-department conflicts and releases decisions, and accepted applicants receive an acceptance email. Modeled on the `HAVEN Volunteer Recruitment` base's `Acceptances` table (`appOq1yOiA1Lfzq8L` / `tblc15YeGhahLxeA9`): one acceptance = one applicant accepted into one department by an approving director, with optional free-text notes; ~70 such records per cycle; an applicant may be accepted by more than one department.

This plan is **VOLUNTEER-track only**. The Director track's interview-based review (panels, scored evaluations) is Plan 12.

---

## 1. Scope

In scope:
1. A reviewer surface (the Plan 10 applicants list + detail, extended) scoped by department.
2. Accept an applicant into a department, with optional notes; revoke an acceptance.
3. An SRR decisions surface: multi-department conflict resolution + batched decision release.
4. A notification-only acceptance email, released in a batch by SRR.

Out of scope (later plans):
- Final single-department **placement** and **roster promotion** → Plan 13.
- The onboarding **contract link** in the acceptance email → Plan 13 (email is notification-only here).
- Director-track **interviews** → Plan 12.
- **Rejection / waitlist** emails — not part of the Airtable process; non-accepted applicants simply aren't notified in Plan 11.

---

## 2. Review model (decided)

**Accept-with-notes**, matching the Airtable reality — no numeric scoring rubric. A director reviews an applicant's full application and either accepts them into a department (creating an `Acceptance` with optional notes) or does nothing. There is no per-applicant "decline" state in Plan 11; non-accepted applicants simply have no acceptance.

---

## 3. Data model

### New model: `Acceptance`

| Field | Type | Notes |
|-------|------|-------|
| `id` | String @id @default(cuid()) | |
| `applicationId` | String | FK → Application (onDelete: Cascade) |
| `departmentCode` | String | the department the applicant is accepted into; must be one of the cycle's `departments` |
| `approvedById` | String | FK → Person (the director who accepted); onDelete: Restrict |
| `notes` | String? | free-text, e.g. "We have at least one RN!" |
| `emailedAt` | DateTime? | set when the acceptance email is sent during decision release; null = not yet notified |
| `createdAt` / `updatedAt` | DateTime | |

- `@@unique([applicationId, departmentCode])` — one acceptance per applicant per department (blocks duplicates; multiple distinct departments allowed).
- `@@index([applicationId])`.
- Back-relations: `acceptances Acceptance[]` on `Application`; `recruitmentAcceptances Acceptance[] @relation("recruitmentAcceptanceApprover")` on `Person`.

### Derived state (no stored application status)

- An application is **accepted** iff it has ≥1 `Acceptance`.
- An application is **conflicted** iff its acceptances span >1 distinct `departmentCode`.

Keeping decisions derived (not a stored status enum) avoids a second source of truth; the `Acceptance` rows are authoritative.

---

## 4. Permissions & scope

### New permissions (added to the recruitment manifest's `permissions`)

- `recruitment.review` — review + accept/revoke applicants for departments the holder directs.
- `recruitment.review_all` — SRR/admin: review across all departments, view conflicts, release decisions.

The Plan 10 permissions (`recruitment.access`, `recruitment.manage_cycles`) are unchanged. A reviewing director needs `recruitment.access` (module entry) + `recruitment.review`. These are assigned through the existing RBAC editor.

### Scope resolution — `reviewScope(personId)`

Returns `{ all: boolean; departmentCodes: string[] }`:
- `all` = the person holds `recruitment.review_all` (checked via the platform RBAC `can(personId, "recruitment.review_all")`).
- `departmentCodes` = `manageableDepartmentIds(personId)` (from `src/platform/departments.ts`: active-term ACTIVE DIRECTOR memberships + one-hop `DepartmentDelegation`) mapped from department **ids** to **codes** via the `Department` table.

> `manageableDepartmentIds` returns department **ids**; cycles store department **codes**. The service maps ids→codes once via `prisma.department.findMany`.

### Authorization rules

- A reviewer may **accept into** department `D` iff `scope.all` OR `D ∈ scope.departmentCodes`.
- A dept-scoped reviewer's **queue** = applications whose `departmentChoices ∩ scope.departmentCodes ≠ ∅`. A `review_all` reviewer's queue = every application in the cycle.
- A dept-scoped reviewer may accept an applicant only into a department the applicant **ranked** (in `departmentChoices`) and within scope. A `review_all` reviewer may accept into **any** of the cycle's departments (this is the flexible-placement valve for SRR; the Airtable "Switch departments?" / flexibility fields).
- All authorization is enforced **server-side** in the service layer; pages only reflect.

---

## 5. Reviewer surface (extends Plan 10 pages)

### Applicants list — `/recruitment/cycles/[id]/applicants` (extended)

- Computes `reviewScope(viewer)`. `review_all` and the cycle manager (`manage_cycles`) see every application; a dept-scoped director sees only applications intersecting their `departmentCodes`. A viewer with none of review/review_all/manage_cycles sees an empty list.
- Each row shows an **acceptance-state badge**: none ("—"), accepted ("Accepted: SRHD"), or conflicted ("Conflict: SRHD + MDIC").
- A department filter is available to `review_all` viewers.

### Application detail — `/recruitment/cycles/[id]/applicants/[applicationId]` (extended)

- Renders the answers using the Plan 10 visible-section rendering.
- Adds an **accept panel**:
  - An **Accept into department** control. The dropdown lists departments the viewer may accept into: for a dept-scoped director, the intersection of `scope.departmentCodes` and the applicant's `departmentChoices`; for `review_all`, all `cycle.departments`. Optional **notes** textarea.
  - The application's existing **acceptances** (department, approving director name, notes, emailed?), each with a **Revoke** control where permitted.
- Server actions (each re-checks authorization server-side):
  - `acceptApplicantAction(cycleId, applicationId, formData)` → `acceptApplicant(applicationId, departmentCode, approvedById, notes)`.
  - `revokeAcceptanceAction(cycleId, acceptanceId)` → `revokeAcceptance(acceptanceId, actorId)`.

---

## 6. Conflicts, decision release & email

### Decisions surface — `/recruitment/cycles/[id]/decisions` (new, gated `recruitment.review_all`)

- **Conflicts panel:** every conflicted application (acceptances in >1 department), each showing the accepting departments + directors + notes, so SRR resolves by revoking the extra acceptance(s) (SRR holds `review_all`, so revoke works even post-email).
- **Release summary:** counts of accepted / unnotified / conflicted / already-emailed, with a **Release decisions** button.

### Pure engine — `findAcceptanceConflicts(acceptances)`

Input: `{ applicationId: string; departmentCode: string }[]`. Output: the set of `applicationId`s whose acceptances span >1 distinct `departmentCode`. Pure, unit-tested.

### Service — `releaseDecisions(cycleId, actorId)` (requires `review_all`)

1. Authorize: actor holds `recruitment.review_all` (else `RecruitmentAuthError`).
2. Load the cycle's acceptances. Compute conflicts via `findAcceptanceConflicts`.
3. Select acceptances where `emailedAt IS NULL` **and** the application is **not** conflicted (exactly one accepting department).
4. For each selected acceptance, in a transaction: `queueEmail(tx, acceptanceEmail(...))` and set `emailedAt = now`.
5. Record audit `recruitment.release` with `{ sent, skippedConflicted }`. Return `{ sent, skippedConflicted }`.

Idempotent: a re-run only sends acceptances still `emailedAt IS NULL` (newly accepted, or newly un-conflicted after SRR resolves). Conflicted applications are never emailed until resolved.

### Acceptance email — `src/modules/recruitment/email/templates/acceptance.ts`

`acceptanceEmail({ firstName, cycleTitle, departmentName }) → { subject, html }`. Notification-only:
> Subject: "You've been accepted to HAVEN — {departmentName}"
> Body: "Congratulations {firstName} — you've been accepted into **{departmentName}** for {cycleTitle}. We'll follow up shortly with onboarding next steps."

`template: "recruitment.acceptance"`. Recipient = the applicant's email. The onboarding/contract link is intentionally **absent** (Plan 13 wires it). User-supplied values (`firstName`, `departmentName`) are HTML-escaped before interpolation (same `escapeHtml` discipline as the Plan 10 confirmation email).

---

## 7. Services & files

- `src/modules/recruitment/engine/conflicts.ts` — `findAcceptanceConflicts` (+ test).
- `src/modules/recruitment/services/review.ts` — `reviewScope`, `listApplicantsForReview`, `acceptApplicant`, `revokeAcceptance` (+ test).
- `src/modules/recruitment/services/decisions.ts` — `listConflicts`, `releaseSummary`, `releaseDecisions` (+ test).
- `src/modules/recruitment/email/templates/acceptance.ts` — `acceptanceEmail` (+ test).
- `src/app/recruitment/cycles/[id]/applicants/page.tsx` + `[applicationId]/page.tsx` — extended with scope + accept panel.
- `src/app/recruitment/cycles/[id]/applicants/actions.ts` — accept/revoke actions (new).
- `src/app/recruitment/cycles/[id]/decisions/page.tsx` + `actions.ts` — SRR decisions surface (new).
- `src/platform/modules/registry.ts` — add the two permissions + a "Decisions" nav entry.
- `prisma/schema.prisma` + migration — the `Acceptance` model and back-relations.
- `src/platform/test/db.ts` — add `"Acceptance"` to the `resetDb()` TRUNCATE list.

### Typed errors

- `RecruitmentAuthError` — actor lacks scope for the department / action.
- `AcceptanceError` — wrong track (non-VOLUNTEER cycle), department not in cycle, or other invariant violation.

---

## 8. Error handling

- **Accept out of scope** → `RecruitmentAuthError` → inline "You can't accept applicants for that department."
- **Duplicate acceptance** (same application+department) → unique violation mapped to a friendly "Already accepted into that department."
- **Revoke after email by a dept director** → blocked (`RecruitmentAuthError`): only `review_all` may revoke an already-emailed acceptance.
- **Release with conflicts** → conflicted applications are skipped and reported in the summary; not an error.
- **Wrong track** (attempt to use the volunteer review surface on a DIRECTOR cycle) → `AcceptanceError`; the page shows a "Director-track review is handled separately" notice.

---

## 9. Testing

**Engine (pure, unit):** `findAcceptanceConflicts` — empty, single-department (no conflict), multi-department (conflict), multiple applications mixed.

**Services (integration, real DB):**
- `reviewScope` — director memberships + one-hop delegation, id→code mapping, `review_all` flag.
- `listApplicantsForReview` — dept-scoped filtering vs `review_all` full view.
- `acceptApplicant` — happy path; out-of-scope rejected; non-VOLUNTEER cycle rejected; department-not-in-cycle rejected; duplicate rejected; audit written.
- `revokeAcceptance` — in-scope revoke; post-email revoke blocked for a director but allowed for `review_all`.
- `releaseDecisions` — sends only `emailedAt IS NULL` non-conflicted acceptances, stamps `emailedAt`, queues one email each; idempotent re-run sends nothing new; conflicted applications skipped + counted; requires `review_all`.

**e2e (Playwright):** as an SRR (`j.carney@yale.edu`), open a published volunteer cycle with submitted applicants, accept one into a department, open Decisions, release → assert an acceptance email is queued; create a two-department conflict and assert it surfaces in the conflicts panel and is skipped on release.

---

## 10. Done-criteria

- `Acceptance` model + migration; `recruitment.review` / `recruitment.review_all` permissions live in the registry; "Decisions" nav entry present.
- A department director sees only their department's applicants and can accept/revoke within scope; SRR sees all and can place flexibly.
- Multi-department acceptances are allowed and surfaced as conflicts; SRR resolves by revoking.
- SRR releases decisions; accepted, non-conflicted, un-notified applicants get one acceptance email each; re-running is idempotent.
- Unit + integration + e2e tests green; CI (lint incl. module-boundary, typecheck, tests) passes.
