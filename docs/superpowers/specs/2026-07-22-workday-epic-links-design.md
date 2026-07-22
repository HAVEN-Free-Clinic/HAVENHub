# Workday training links + Epic access button

**Date:** 2026-07-22
**Status:** Approved (design)

## Problem

Two external systems that volunteers must reach are invisible inside HAVEN Hub:

1. **Yale Workday Learning** (`https://www.myworkday.com/yale/learning`) is where volunteers
   actually complete their EHS trainings and HIPAA certification. Today the app shows their
   EHS/HIPAA status but never tells them where to go do the training. EHS has no call-to-action
   anywhere; HIPAA only has an "upload certificate" form (proving completion), with no link to
   the course that produces the certificate.
2. **YNHH remote apps portal / Epic** (`https://myapps.ynhh.org`) is where provisioned users
   launch Epic. There is no in-app shortcut to it.

## Goals

- When a user has an outstanding EHS training or HIPAA certification, point them to Workday.
- Give users with a provisioned Epic account a one-click "Access Epic" shortcut to the YNHH
  apps portal.

## Non-goals

- No admin-configurable URLs. The two links are hardcoded constants, consistent with the
  existing hardcoded Yale SSO / YNHH Epic assumptions. They can be promoted to settings later.
- No changes to the onboarding engine, the `OnboardingTask` model, clearance/gating logic, or
  any config/settings registry.
- No expiration-aware gating on the Epic card (presence of `Person.epicId` is sufficient).

## Decisions (from brainstorming)

- **Epic button:** dashboard side-rail card, shown only to users with `Person.epicId` set.
- **Workday link surfaces:** `/my-info` panels + `/get-started` onboarding checklist (dashboard
  "Your status" rows keep linking internally to `/my-info`, where the CTA now lives).
- **URL storage:** hardcoded constants.

## Design

### 1. Constants — `src/platform/external-links.ts` (new)

```ts
/** Yale Workday Learning — where volunteers complete EHS and HIPAA training. */
export const WORKDAY_LEARNING_URL = "https://www.myworkday.com/yale/learning";

/** YNHH remote apps portal — where provisioned users launch Epic. */
export const EPIC_APPS_URL = "https://myapps.ynhh.org";
```

### 2. Reusable primitive — `src/platform/ui/external-link-button.tsx` (new)

The codebase has no anchor variant of `Button`; external CTAs are hand-rolled `<a>` +
`buttonClasses(...)` + `target="_blank" rel="noopener noreferrer"` + sr-only text (see the two
`eslint-disable no-restricted-syntax` sites). This primitive centralizes that pattern so the
three Workday CTAs stay consistent.

- Props: `href`, `variant` (default `"outline"`), `size` (default `"sm"`), `children`,
  optional `className`.
- Renders `<a href target="_blank" rel="noopener noreferrer" className={buttonClasses(variant, size, className)}>`
  with `children`, a trailing `ExternalLink` (lucide) icon (`aria-hidden`), and a
  `<span className="sr-only"> (opens in a new tab)</span>`.
- Carries the `eslint-disable-next-line no-restricted-syntax` comment for the raw anchor, so
  callers don't each need it.

### 3. Workday CTAs — three placements, each gated on "outstanding"

**a. EHS panel — `src/modules/my-info/components/ehs-panel.tsx`**
- Compute `hasOutstanding = items.some((i) => !i.complete)`.
- When `hasOutstanding`, render below the list:
  `<ExternalLinkButton href={WORKDAY_LEARNING_URL} variant="primary">Complete EHS training in Workday</ExternalLinkButton>`
- The empty state ("No EHS trainings are required for you.") is unchanged — no link.

**b. HIPAA panel — `src/modules/my-info/components/hipaa-panel.tsx`**
- Add a pure predicate `hipaaNeedsTrainingLink(status: ComplianceStatus): boolean` to
  `src/platform/compliance/rules.ts` (next to the `ComplianceStatus` union, so it is importable
  in a plain vitest test without pulling in JSX/UI). Returns `true` for
  `NO_CERTIFICATE | EXPIRED | EXPIRING_SOON`, `false` for
  `COMPLIANT | PENDING_VERIFICATION | UNKNOWN_DATE` (the latter two mean a cert is on file and
  the ball is in a manager's court, so retaking the course would misdirect). The HIPAA panel
  imports and calls it.
- When `hipaaNeedsTrainingLink(status)`, render inside the *Upload New Certificate* section,
  above the form, a short helper line + `<ExternalLinkButton href={WORKDAY_LEARNING_URL}>`
  labeled "Complete HIPAA training in Workday". Copy frames the flow: take/renew the training
  in Workday, then upload the certificate below.
- This component is shared by `/my-info` and `/get-started/hipaa`, so both surfaces are covered
  by this single change.

**c. Onboarding checklist — `src/app/get-started/onboarding-checklist.tsx`**
- The EHS row (`task.key === "ehs"`) currently renders no CTA (EHS has no `href`). When the EHS
  task is not done, render `<ExternalLinkButton href={WORKDAY_LEARNING_URL}>Complete in Workday</ExternalLinkButton>`
  in the CTA slot.
- `StatusPill` `actionable` for EHS becomes `true` (there is now a real action), so an
  incomplete EHS row shows "Action needed" instead of the neutral "Pending". Implement by
  computing per-row whether a CTA will render (internal `task.href` OR EHS's external Workday
  link) and passing that as `actionable`, rather than the current `!!task.href`.
- The HIPAA row is untouched: its existing "Upload certificate" button routes to
  `/get-started/hipaa`, which renders the HipaaPanel that now carries the Workday link.
- External URLs are NOT threaded through `OnboardingTask.href` (that field is app-internal
  routing consumed by `<Link>`); the Workday link is handled locally in the row for the `ehs`
  key only.

### 4. Epic access card — `src/app/(app)/epic-access-card.tsx` (new)

Async server component mirroring `ClinicChannelCard`:
- Signature `EpicAccessCard({ personId }: { personId: string })`.
- Queries `Person.epicId` (`select: { epicId: true }`). Returns `null` when `epicId` is null/empty,
  so users without a provisioned Epic account never see the card.
- When present, renders an external `<a href={EPIC_APPS_URL} target="_blank" rel="noopener noreferrer">`
  styled like the clinic card: leading `Stethoscope` (lucide) icon tile, "Access Epic" eyebrow
  and a "YNHH remote apps" sub-label, trailing `ExternalLink` icon, sr-only "(opens in a new tab)".
- Rendered in the dashboard side rail (`src/app/(app)/page.tsx`) directly below the
  `ClinicChannelCard`. The `personId` is already available from `requirePersonSession()`. A local
  DB read is fast, so no `Suspense` wrapper is needed (unlike the Graph-bound clinic card).

## Data flow

No new data model. Reads only:
- EHS/HIPAA status already loaded by `/my-info` and `/get-started` pages (`getMyEhsStatus`,
  compliance `status`). The CTAs are pure functions of that already-present state.
- Epic card issues one additional `person.findUnique({ where: { id: personId }, select: { epicId: true } })`.

## Error handling

- All links are static external URLs; nothing to fail at click time.
- Epic card: a DB read failure should degrade to rendering nothing (card is non-critical), not
  crash the dashboard. Follow the existing render-path degradation convention (return `null` on
  empty; do not throw for a missing optional card).

## Testing

- **Unit (vitest):** `hipaaNeedsTrainingLink(status)` in `src/platform/compliance/rules.test.ts`
  (add to the existing file if present, else create) — assert `true` for
  `NO_CERTIFICATE/EXPIRED/EXPIRING_SOON`, `false` for `COMPLIANT/PENDING_VERIFICATION/UNKNOWN_DATE`.
  Written test-first (TDD).
- EHS "outstanding" is a trivial `.some(!complete)` and the Epic gate is `epicId != null`;
  both are covered implicitly and don't warrant dedicated unit tests.
- Link rendering is low-risk presentational markup; existing e2e onboarding/my-info paths
  exercise the surfaces. (E2E is not runnable locally per repo conventions.)

## Files

New:
- `src/platform/external-links.ts`
- `src/platform/ui/external-link-button.tsx`
- `src/app/(app)/epic-access-card.tsx`

Modified:
- `src/platform/compliance/rules.ts` (add `hipaaNeedsTrainingLink` predicate)
- `src/platform/compliance/rules.test.ts` (add predicate test; create if absent)
- `src/modules/my-info/components/ehs-panel.tsx`
- `src/modules/my-info/components/hipaa-panel.tsx`
- `src/app/get-started/onboarding-checklist.tsx`
- `src/app/(app)/page.tsx` (render `EpicAccessCard` in the side rail)

## Verification checklist

- `epicId` confirmed on `Person` (schema `model Person` line 111, field line 118). ✓
- `HipaaPanel` confirmed shared by `/my-info` and `/get-started/hipaa`. ✓
- `ComplianceStatus` union confirmed: `COMPLIANT | EXPIRING_SOON | EXPIRED | PENDING_VERIFICATION | UNKNOWN_DATE | NO_CERTIFICATE`. ✓
