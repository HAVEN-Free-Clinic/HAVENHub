# Spanish self-report + interpreter verification: Phases 2 and 3

- **Date:** 2026-06-28
- **Builds on:** Phase 1 (PR #127). The data model (`spanishSelfReported`, `spanishVerified`, `spanishVerifiedAt`, `spanishVerifiedById`, `licensedRN`) and the queue predicate (`src/platform/spanish-review.ts`: `needsSpanishReview`, `spanishReviewWhere`) already exist.
- **Status:** Approved design. Phases 2 and 3 are independent and land as further commits on the same branch / PR #127.

## Context

Phase 1 split the legacy `spanishSpeaking` boolean and made only interpreter-verified Spanish count for scheduling, but nothing yet lets the interpreting department record a verification, and nothing yet captures the self-report at intake. Existing Spanish-speakers were migrated to self-reported-but-unverified, so the queue already has a population waiting. Phase 2 gives the interpreting department a surface to work that queue; Phase 3 feeds the queue from recruitment onboarding.

## Decisions (locked during brainstorming)

1. **Phase 2 access:** a new dedicated permission `volunteers.verify_spanish`, surfaced as a tab in the Volunteers module. Granted by an admin (via `/admin/roles`) to whoever does interpreting assessments. Not folded into compliance; not admin-only.
2. **Phase 2 queue is clinic-wide:** the interpreting department assesses anyone's Spanish regardless of which clinical department they volunteer in. Do NOT scope by the viewer's own department.
3. **Recording an assessment always stamps `spanishVerifiedAt`** (for a yes OR a no), which is deliberately different from Phase 1's admin-form override (where clearing "verified" returns the person to the queue).
4. **Phase 3 capture lives in recruitment onboarding:** the token-gated onboarding contract, mapped to the Person at promotion. Self-reporting Spanish makes the promoted person enter the Phase 2 queue automatically. RN stays self-report only.

---

# Phase 2: interpreting-department Spanish review surface

## Permission

Add `volunteers.verify_spanish` to the Volunteers module's `permissions` in `src/platform/modules/registry.ts`. Adding the string makes it selectable in the roles editor; it is checked at runtime and needs no migration (permission strings are not stored; only role grants are, and those are set through the admin UI).

Intended operational setup (admin's job, documented not coded): create an "Interpreting Verifier" role granting `volunteers.view` (Volunteers module access) plus `volunteers.verify_spanish`, and assign it to the Interpreting department (its active directors inherit it) or to specific people. Platform Admin already has it via `*`.

## Surface

- Route: `src/app/(app)/volunteers/spanish-review/page.tsx`, a new tab in the Volunteers module.
- Page gate: `requirePermission("volunteers.verify_spanish")`. The Volunteers layout already gates module access on `volunteers.view`.
- Nav: add `{ label: "Spanish review", href: "/volunteers/spanish-review", permission: "volunteers.verify_spanish" }` to the Volunteers module `nav` in the registry, so the tab is filtered out for everyone who lacks the permission (matching the per-item nav filtering pattern).

## Queue query and list helper

Add a thin query helper to `src/platform/spanish-review.ts`:

```
listSpanishReviewQueue(): Promise<Array<{ id: string; name: string; netId: string | null; contactEmail: string | null }>>
```

It runs `prisma.person.findMany({ where: spanishReviewWhere(), orderBy: { name: "asc" }, select: { id, name, netId, contactEmail } })`. Clinic-wide; no department filter.

The page renders a table (Name, NetID, Email, Actions). Empty state: "No one is awaiting Spanish review."

## The assessment mutation (the subtle piece)

Add to `src/platform/spanish-review.ts`:

```
recordSpanishAssessment(actorPersonId: string, personId: string, verified: boolean): Promise<Person>
```

Behavior:
- Loads the person; throws `PersonNotFoundError` (reuse from `@/platform/people`) if missing.
- Updates `spanishVerified = verified`, and ALWAYS `spanishVerifiedAt = new Date()`, `spanishVerifiedById = actorPersonId`.
- Writes an audit row `action: "person.spanish_assess"` with `before`/`after` for `spanishVerified` and `spanishVerifiedAt`.

This is intentionally different from `updatePersonFields`' override stamping: an assessment records a result, so a "no" still stamps `verifiedAt` and removes the person from the queue (they will not reappear). Phase 1's admin-form checkbox keeps its own override semantics (clearing verified returns to the queue); both write the same columns and the queue predicate (`verifiedAt IS NULL`) reconciles them.

## Page actions

Two server actions on the page, each re-gating with `requirePermission("volunteers.verify_spanish")`, reading `personId` from the form, calling `recordSpanishAssessment(actor, personId, true|false)`, then redirecting back to `/volunteers/spanish-review`:
- **Verify** -> `verified = true` (counts for scheduling, leaves the queue).
- **Not verified** -> `verified = false` (assessed-as-no, leaves the queue, does not count).

Each row is a small form posting the person id, with a Verify button and a Not-verified button.

## Testing (Phase 2)

In `src/platform/spanish-review.test.ts`:
- `recordSpanishAssessment(actor, id, true)` sets `spanishVerified=true`, stamps `verifiedAt`+`verifiedById`, writes one `person.spanish_assess` audit; the person no longer matches `spanishReviewWhere()`.
- `recordSpanishAssessment(actor, id, false)` sets `spanishVerified=false`, STILL stamps `verifiedAt`+`verifiedById` (assessed-no), and the person no longer matches `spanishReviewWhere()`.
- `recordSpanishAssessment` on a missing id rejects with `PersonNotFoundError`.
- `listSpanishReviewQueue()` returns exactly the self-reported-unverified people, ordered by name, and excludes assessed (yes or no) people.

The page itself (server component + actions) is verified by `npm run typecheck` plus a manual check; there is no page test harness.

---

# Phase 3: recruitment onboarding capture

## Schema

Add to the `OnboardingContract` model in `prisma/schema.prisma`, in the style of the existing `worksWithYnhh` boolean:

```prisma
spanishSelfReported Boolean @default(false)
licensedRN          Boolean @default(false)
```

Migration: add the two columns (default false). No backfill.

**Migration drift warning (same as Phase 1):** `prisma migrate dev` in this repo sweeps unrelated pre-existing drift (an `Application.subcommitteeRanking DROP DEFAULT` and five `Training VolunteerTraining_* -> Training_*` constraint renames) into any generated migration. Generate with `--create-only`, then strip the migration.sql to ONLY the two `OnboardingContract ADD COLUMN` statements before applying.

## Capture (applicant-facing)

- `src/app/onboard/[token]/onboard-form.tsx`: add a small "Background" fieldset with two checkboxes, `name="spanishSelfReported"` ("Do you speak Spanish with patients?") and `name="licensedRN"` ("Are you a licensed RN?").
- `src/app/onboard/[token]/actions.ts`: extract `spanishSelfReported: bool("spanishSelfReported")` and `licensedRN: bool("licensedRN")` into the `ContractSubmission` input.
- `src/modules/recruitment/services/onboarding.ts`: add `spanishSelfReported: boolean` and `licensedRN: boolean` to the `ContractSubmission` type, and persist them in `submitContract`'s `onboardingContract.update` data. These are optional (unchecked = false); no new validation.

## Promotion mapping (the key correctness points)

In `src/modules/recruitment/services/promotion.ts`:
- **Create-new-person branch:** add `spanishSelfReported: contract.spanishSelfReported` and `licensedRN: contract.licensedRN`.
- **Update-existing-person branch:** add `spanishSelfReported: person.spanishSelfReported || contract.spanishSelfReported` and `licensedRN: person.licensedRN || contract.licensedRN` (OR semantics so an existing `true` is never lost on reactivation).
- **Do NOT set `spanishVerified`.** It stays its default `false`. A recruited Spanish speaker is therefore self-reported-but-unverified and matches `spanishReviewWhere()` immediately, entering the Phase 2 queue. This is the intended hand-off: recruitment feeds the queue, the interpreting department verifies.
- The field is `spanishSelfReported`, NOT the dropped `spanishSpeaking`.

## What does not change

The recruiter onboarding-review page (`recruitment/cycles/[id]/onboarding/page.tsx`) shows contract status only, not field values, so no display change. RN has no verification workflow.

## Testing (Phase 3)

- `src/modules/recruitment/services/onboarding.test.ts`: a submitted contract with the two checkboxes set persists `spanishSelfReported=true` and `licensedRN=true`; unchecked defaults to false.
- `src/modules/recruitment/services/promotion.test.ts`: promoting a contract with `spanishSelfReported=true, licensedRN=true` yields a Person with those fields true, `spanishVerified=false`, and the person matches `spanishReviewWhere()` (in the queue). A separate case: a contract with both false yields a Person not in the queue.

---

# Out of scope (both phases)

- Notifications when a verification is recorded (the `notify()` dispatcher exists; deferred).
- Department context columns in the queue list (Name/NetID/Email only for now).
- A recruiter-facing display of the new contract fields.
- Any RN verification workflow.
- Seeding `volunteers.verify_spanish` into a system role (admin grants it via a custom role).
