# HIPAA applicant date validation + verification gate

**Issue:** [#75](https://github.com/HAVEN-Free-Clinic/HAVENHub/issues/75) — applicant-entered HIPAA completion date is unvalidated and becomes authoritative clinic-clearance data.

**Date:** 2026-06-29
**Branch:** `fix/hipaa-applicant-date-validation`

## Problem

Two divergent paths write a HIPAA completion date, and only one validates it:

1. **Strict staff path** (`setCompletionDateAsManager`) runs every date through
   `parseCompletionDate` (real `YYYY-MM-DD`, not future, within 5 years, normalized
   to noon UTC) and stamps the cert verified by the actor.
2. **Public onboarding path** does none of this. `actions.ts` builds
   `hipaaCompletedAt` as `new Date(rawString)` from a `<input type=date>` with no
   `min`/`max`, and `submitContract` only checks presence. On promotion that value
   is written straight onto a `HipaaCertificate` (`source: IMPORT`, `verifiedById:
   null`) and `complianceStatus` treats it as authoritative.

Separately, **`complianceStatus`/`overallClearance` are purely date-driven and
ignore verification entirely.** So any cert with a `completionDate` — including a
self-asserted onboarding date or a self-uploaded PDF-parsed date that no human has
checked — counts as `COMPLIANT` and clears the person for patient-facing clinic
work and past the `/get-started` gate.

### Harm

- A future date (e.g. 2099) computes `COMPLIANT` essentially forever.
- Entering today's date for training done years ago over-credits.
- A typo (valid calendar date, wrong value) is silently accepted.
- No human ever confirms a self-asserted date before it gates clinic scheduling.

## Decisions (locked with stakeholder)

- **Gate breadth:** ALL unverified dated certs become non-clearing — gate keys on
  `verifiedAt` alone (`completionDate != null && verifiedAt == null`). Covers both
  onboarding self-entries AND self-uploaded PDF-parsed dates. No reliance on
  `source`/`extraction`.
- **Existing data:** Grandfather as accepted. A data migration back-stamps all
  existing dated-but-unverified certs as verified, so currently-cleared volunteers
  are not mass-un-cleared and no one is newly blocked at the gate. Only NEW
  self-asserted certs after this ships require verification.

## Design

### Part 1 — Validation parity (onboarding date)

- `actions.ts`: pass the raw `YYYY-MM-DD` string through to the service instead of
  pre-converting with `new Date(...)`. Change `ContractSubmission.hipaaCompletedAt`
  to `string` (the raw input value).
- `submitContract` (`onboarding.ts`): keep the presence check, then run the value
  through `parseCompletionDate`. On `CompletionDateError`, raise
  `ContractValidationError` with a friendly `hipaaCompletedAt` field error (real
  date, not in the future, within 5 years). The parsed noon-UTC `Date` is what gets
  written, fixing a latent midnight-vs-noon-UTC inconsistency.
- `onboard-form.tsx`: add `max={today}` and `min={today − 5y}` to the HIPAA date
  input (defense-in-depth + better UX). Extend the `field` helper to accept
  `min`/`max`.

`parseCompletionDate` lives in `@/platform/compliance/completion-date` and is the
single source of truth shared with the staff path.

### Part 2 — Verification gate (compliance status)

Add a new `ComplianceStatus` value: **`PENDING_VERIFICATION`** — a cert has a
completion date but no human has verified it.

`ComplianceStatus` is a pure TS union (never a DB enum; `ComplianceReminder.lastStatus`
is `String?`), so **no DB enum migration is needed** for the new value.

**`complianceStatus()` (`rules.ts`)** — extend the input to include `verifiedAt`
and insert the new branch in priority order:

```
cert === null                       -> NO_CERTIFICATE
completionDate === null             -> UNKNOWN_DATE
verifiedAt === null                 -> PENDING_VERIFICATION   (new)
else                                -> EXPIRED / EXPIRING_SOON / COMPLIANT (date math)
```

`PENDING_VERIFICATION` precedes the date math deliberately: we do not compute
expiry from a date no one has confirmed.

**Non-clearing everywhere — already true by construction:**

- `overallClearance` only clears `COMPLIANT`/`EXPIRING_SOON` → PENDING is NOT_CLEARED.
- `deriveHipaaTaskState` maps anything but those two → `INCOMPLETE` → `/get-started`
  HIPAA task stays incomplete (person held at gate).
- `summarizeNonCompliant` filters `status !== "COMPLIANT"` → PENDING shows in the
  schedule banner as non-compliant.

**Surface area to update (TypeScript `Record<ComplianceStatus, …>` maps will fail
to compile until each is handled — that is the safety net):**

- `rules.ts`: union + `complianceStatus()` signature/logic.
- `compliance.ts`: `STATUS_ORDER`, the two `Record<ComplianceStatus, number>`
  summary initializers, `EMPTY_SUMMARY`; ensure the cert queries select `verifiedAt`
  and pass it to `complianceStatus`.
- Every other `complianceStatus(...)` call site must pass `verifiedAt`:
  `builder.ts` (+ its `hipaaCertificates` select), `(app)/page.tsx`,
  `my-info/page.tsx`, `get-started/hipaa/page.tsx`, `reminders.ts`, `training.ts`,
  `onboarding/services/onboarding.ts` (already passes the full cert object).
- UI label/tone maps + summary tiles + status filters: `volunteers/page.tsx`,
  `volunteers/master/page.tsx`, `(app)/page.tsx`. Label: "Needs verification";
  tone: `warning`.
- `person-fields.ts`: add `PENDING_VERIFICATION` to `COMPLIANCE_VALUES` (email
  audience targeting).
- `reminders.ts` / `templates/compliance`: PENDING falls into the non-compliant
  reminder bucket (generic "needs attention" copy). Ensure `complianceReminderContext`
  handles the value. (See Known limitation.)

### Manager verification queue

The existing compliance dashboards already wire `verifyCertificate`
(`volunteers/page.tsx`). The "queue" is delivered by surfacing
`PENDING_VERIFICATION` as a badge + filter in those dashboards so a manager/director
can find and confirm self-asserted certs. A manager confirms via the existing verify
action (stamps `verifiedAt`/`verifiedById`, date unchanged) → status recomputes to
`COMPLIANT`. No new mutation is required. `setCompletionDateAsManager` remains for
dateless certs (`UNKNOWN_DATE`); it still rejects re-dating an already-dated cert,
which is correct — PENDING certs are verified, not re-dated.

### Migration (grandfather)

A Prisma migration with a data step:

```sql
UPDATE "HipaaCertificate"
SET "verifiedAt" = "uploadedAt"
WHERE "completionDate" IS NOT NULL
  AND "verifiedAt" IS NULL;
```

`verifiedById` is left null (a bare id, no FK) and reads as a grandfathered import in
the UI (verifiedAt present, no verifier name). Runs on deploy via `migrate deploy`.

**DB safety:** per repo convention the shared `.env` points all DB URLs (incl.
`TEST_DATABASE_URL`) at the production Neon DB. Do NOT run `prisma migrate`/vitest
against it from this worktree. Use a throwaway local Postgres + worktree-local
`TEST_DATABASE_URL` for tests; write the migration file but apply it only against a
local DB.

## Testing

- `completion-date` rules already covered; add `submitContract` tests: future date,
  >5yr, malformed, calendar-overflow rejected with field error; valid date stored as
  noon UTC.
- `rules.test.ts`: `PENDING_VERIFICATION` returned for dated+unverified; precedence
  over date math; `overallClearance`/`deriveHipaaTaskState` treat it as non-clearing.
- `compliance.test.ts`: dashboard rows/summary include PENDING; verifying a PENDING
  cert flips it to COMPLIANT.
- `promotion`/onboarding: promoted self-entered cert reads PENDING until verified.
- Banner test: PENDING volunteer appears as non-compliant.
- Migration smoke: an existing dated-unverified cert reads COMPLIANT after backfill.

## Known limitation (v1, deliberate)

Reminder emails treat `PENDING_VERIFICATION` like other non-compliant states, so a
volunteer who self-uploaded a not-yet-verified cert may get a generic "needs
attention" nudge even though the action is the manager's. Acceptable for v1; a
manager-facing verification reminder is a possible follow-up.

## Out of scope

- Changing how `setCompletionDateAsManager` works for dateless certs.
- A dedicated manager verification page distinct from the existing dashboards.
- Date-of-birth validation on the onboarding form.
