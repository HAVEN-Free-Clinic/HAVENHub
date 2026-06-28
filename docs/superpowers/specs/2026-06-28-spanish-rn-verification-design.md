# Spanish-speaking / Licensed RN: self-report and interpreter verification

- **Date:** 2026-06-28
- **Issue:** [#68](https://github.com/HAVEN-Free-Clinic/HAVENHub/issues/68) (Add-person form's Spanish-speaking / Licensed RN checkboxes are silently ignored on create)
- **Status:** Approved design. Phase 1 specced in detail; Phases 2 and 3 sketched (each gets its own spec -> plan -> build cycle).

## Problem

`PersonForm` renders `spanishSpeaking` and `licensedRN` checkboxes and is reused for create and edit. The edit path reads and saves them, but the create path (`admin/people/new/page.tsx`) never reads the two checkboxes and `createPersonRecord` (`platform/people.ts`) never writes them. An admin who checks either box when adding a new person gets no error and no saved value, and must re-open the person and re-save via the edit form. Because `spanishSpeaking` feeds clinical scheduling (RHD Spanish-coverage counts and schedule-builder badges), a newly added Spanish-speaking volunteer is silently mis-flagged.

That is the literal bug. The larger direction (set during brainstorming) reframes it:

- These two flags were seeded once from Airtable. Going forward they are sourced from the onboarding form, where volunteers self-report whether they are a licensed RN or speak Spanish.
- Spanish ability is not self-certifiable for clinical use. The interpreting department (`INTP`, already seeded) assesses a volunteer's Spanish and records a yes/no result. Only that verified result should make a person count as a Spanish provider in scheduling.

So a single `spanishSpeaking` boolean cannot honestly represent both "the volunteer says they speak Spanish" and "the interpreting department confirmed it." The two must be separate, and scheduling must key off the verified one.

## Decisions (locked during brainstorming)

1. **Spanish stored result is a boolean.** The interpreting department assesses level as their internal process, but the app records only verified yes/no. No proficiency enum.
2. **Existing imported data is NOT auto-verified.** Rows with the old `spanishSpeaking = true` become `spanishSelfReported = true, spanishVerified = false`. The Airtable flag was a self-report, not an interpreting-department assessment, so it must not count clinically until assessed. Accepted consequence: Spanish scheduling coverage drops to roughly zero at migration time and recovers as the interpreting department works through the queue.
3. **Only verified Spanish feeds scheduling.** Self-report is an intake signal; it does not make a person Spanish-eligible for the schedule.
4. **Licensed RN is self-report only.** No verification workflow in this project unless decided otherwise later.
5. **Admin remains an override.** An admin can directly set the verified flag from the person edit form; doing so is recorded as a verification event (who/when).

## Roadmap

The full workflow spans four subsystems and is built in three phases. Each phase ships independently.

- **Phase 1 (this spec): data model and admin surface (the foundation).** Replace the single `spanishSpeaking` boolean with self-reported and verified fields plus verifier/timestamp, migrate existing data, repoint scheduling and email-audience at the verified signal, retire the Airtable clobber, and fix the admin create form. **Issue #68 closes here.**
- **Phase 2: interpreting-department assessment surface.** A queue plus record-assessment screen for the `INTP` department, gated by an interpreting permission, mirroring the existing HIPAA-cert verification pattern. Consumes the Phase 1 queue predicate.
- **Phase 3: onboarding capture.** Add the "Are you a licensed RN? / Do you speak Spanish?" questions to the onboarding form; self-reporting Spanish drops the person into the Phase 2 queue.

---

# Phase 1 detailed spec

## Data model

Replace the single boolean with a small cluster on `Person` that mirrors the existing HIPAA-cert verification shape (`verifiedById` / `verifiedAt`).

```prisma
model Person {
  // ...
  // REMOVE: spanishSpeaking Boolean @default(false)

  spanishSelfReported  Boolean   @default(false)  // intake signal (onboarding / admin)
  spanishVerified      Boolean   @default(false)  // interpreting-dept confirmed -> gates scheduling
  spanishVerifiedAt    DateTime?                  // null = never assessed by a human
  spanishVerifiedById  String?                    // verifier's Person id, bare (no FK), mirroring HipaaCertificate.verifiedById

  licensedRN           Boolean   @default(false)  // self-report only, unchanged
}
```

`spanishVerifiedAt == null` is the single source of truth for "this person has never been through a real interpreting-department assessment." No separate `needsReview` flag is required.

### Queue predicate (shipped in Phase 1, consumed by Phase 2)

Phase 1 ships the queue as a tested query helper (a Prisma `where`-clause builder), so Phase 2 only adds UI:

```
INTP review queue = spanishVerifiedAt IS NULL AND (spanishSelfReported OR spanishVerified)
```

State coverage:

| State | selfReported | verified | verifiedAt | In queue? | Scheduling-eligible? |
|---|---|---|---|---|---|
| Not Spanish | false | false | null | no | no |
| Self-reported, awaiting assessment (incl. migrated existing data) | true | false | null | yes | no |
| Assessed yes | true | true | set | no | yes |
| Assessed no | true | false | set | no | no |
| Verified but unstamped (defensive; not produced by migration or normal flow) | * | true | null | yes | yes |

The last row exists only so the predicate stays well-defined: an admin override always stamps `verifiedAt`, and the migration never sets `verified = true`, so no normal path produces `verified = true` with `verifiedAt = null`. The predicate tolerates it (treats it as still-in-queue) rather than depending on it.

### Migration

For every existing row where the old `spanishSpeaking = true`:

- `spanishSelfReported = true`
- `spanishVerified = false`
- `spanishVerifiedAt = null`
- `spanishVerifiedById = null`

All other rows get the column defaults (false / null). `licensedRN` is untouched. After the data backfill, drop the `spanishSpeaking` column.

**Operational consequence (accepted).** Because no existing row is auto-verified, Spanish scheduling coverage (RHD counts, builder badges) drops to roughly zero immediately after deploy and recovers only as the interpreting department records assessments. The migration deliberately routes every previously-flagged person into the Phase 2 queue so the department has a complete worklist. If a softer cutover is ever wanted, that is a separate decision; this spec implements the no-auto-verify policy.

## Behavior changes (six touch-points)

1. **Admin person form (`modules/admin/components/person-form.tsx`).** Replace the two checkboxes with three:
   - Licensed RN (self-report), unchanged.
   - Spanish-speaking (self-reported) -> `spanishSelfReported`.
   - Spanish verified, interpreting dept -> `spanishVerified` (admin override), with a read-only "Verified on {date}" caption rendered when `spanishVerifiedAt` is set. (Verifier-name display is deferred to the Phase 2 interpreting-department surface to avoid a name lookup here.)
   The form's `person` prop type widens to include the new fields.

2. **`createPersonRecord` (`platform/people.ts`) and the create page action (`admin/people/new/page.tsx`).** This is the bug fix for #68. The create action reads `spanishSelfReported`, `spanishVerified`, and `licensedRN` from `formData`. `createPersonRecord` writes all three in the create branch and includes them in the audit `after`. When `spanishVerified` is true on create, stamp `spanishVerifiedById = actor` and `spanishVerifiedAt = now`.

3. **`updatePersonFields` (`platform/people.ts`).** Swap `spanishSpeaking` out of the diff `fields` array for `spanishSelfReported` and `spanishVerified`. The verified transition is domain logic owned by the core: a `false -> true` transition stamps `spanishVerifiedById = actor` and `spanishVerifiedAt = now`; a `true -> false` transition clears both (returning the person to the queue). Self-report and verified are independent: editing `spanishSelfReported` never touches the verified fields, and vice versa.

4. **Scheduling / RHD repoint.** `modules/schedule/engine/rhd.ts` (Spanish coverage count and the `RhdPersonLite` select) and `modules/schedule/services/builder.ts` (the `BuilderMember` type, the person selects, and the "ES" badge in `schedule/builder/page.tsx`) move from `spanishSpeaking` to `spanishVerified`. The "ES" badge now means verified. The `licensedRN` / "RN" badge is unchanged.

5. **Email audience (`platform/email/audience/person-fields.ts`).** Repoint the existing "Spanish-speaking" condition to `spanishVerified`, and add `spanishSelfReported` as a second audience field so campaigns can target the pending-verification group (useful for nudging the interpreting department or reminding volunteers). The `licensedRN` audience field is unchanged.

6. **Retire the Airtable clobber (`platform/airtable/import/schedule-config.ts`).** Stop importing `spanishSpeaking` / `licensedRN` from Airtable so a sync cannot overwrite a verification or a self-report. Existing values already survived via the migration. These fields remain un-mirrored (they are not in `ALL_PEOPLE_FIELDS`); the source of truth is now the app, not Airtable.

## People-table display

`modules/admin/components/people-table.tsx` keeps the "ES" and "RN" badges. "ES" now reflects `spanishVerified`. (Optional, deferred: a distinct muted badge for self-reported-but-unverified. Not in Phase 1 to keep the table simple.)

## Testing (test-driven)

Implementation follows the test-driven-development skill (RED -> GREEN), against the per-worktree test DB pattern the repo already uses (`TEST_DATABASE_URL`).

Core mutation tests (`platform/people.ts`):

- **#68 regression:** `createPersonRecord` with `spanishSelfReported` / `spanishVerified` / `licensedRN` set persists all three and includes them in the audit `after`. (Fails on `main` today; this is the proof the bug is fixed.)
- Create with `spanishVerified = true` stamps `verifiedById` and `verifiedAt`.
- `updatePersonFields`: verified `false -> true` stamps verifier and timestamp; `true -> false` clears both; editing only `spanishSelfReported` leaves the verified fields untouched.

Queue predicate: unit-tested across the states (self-reported-awaiting / assessed-yes / assessed-no, plus the defensive verified-but-unstamped case).

Repoint tests:

- RHD Spanish coverage counts `spanishVerified`, not self-report: a self-reported-but-unverified person does not count; a verified one does.
- Email audience: the "Spanish-speaking" condition resolves against `spanishVerified`; the new self-reported condition resolves correctly.

Migration verification: the backfill cannot be unit-tested (the Vitest harness applies migrations to an empty database before any seed, so there is no pre-migration data to assert). It is verified by reviewing the migration SQL and by a manual check on a staging copy of production data: a person who had `spanishSpeaking = true` must land as `spanishSelfReported = true, spanishVerified = false, spanishVerifiedAt = null` (self-reported, in queue, and NOT scheduling-eligible until assessed).

Plus updating every existing test or reference that names `spanishSpeaking` (the rename is compile-breaking, so this is required cleanup, not optional).

## Out of scope for Phase 1

- The interpreting-department UI (queue screen, record-assessment action, INTP permission). That is Phase 2; Phase 1 only ships the data and the tested queue predicate.
- Onboarding-form capture of the self-report answers. That is Phase 3.
- Any RN verification workflow.
- A separate self-reported badge in the people table.

---

# Phase 2 sketch (interpreting-department assessment)

- A queue screen listing people matching the Phase 1 predicate, scoped to an interpreting-department permission (model after existing department-scoped access and the HIPAA compliance-manager gate).
- A record-assessment action that sets `spanishVerified` (yes/no), stamps `spanishVerifiedById` / `spanishVerifiedAt`, and audits the event.
- Optional notification to the volunteer or department when a result is recorded (reuse the `notify()` dispatcher).
- Migrated existing data (self-reported, unverified) is the initial queue contents; recording any result removes a person from the queue. Expect the full pre-existing Spanish-speaking population here on day one.

# Phase 3 sketch (onboarding capture)

- Add "Do you speak Spanish?" and "Are you a licensed RN?" to the onboarding form. The exact surface (recruitment application form vs. the get-started profile step) is a Phase 3 design decision.
- Wire the answers to `spanishSelfReported` and `licensedRN`. Self-reporting Spanish (with no prior assessment) places the person in the Phase 2 queue automatically via the predicate.
- Decide whether a previously-verified person who re-affirms self-report stays verified (expected yes; self-report does not reset verification).
