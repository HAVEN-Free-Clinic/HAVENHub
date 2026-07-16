# PostHog Instrumentation Uplift, Design Spec

**Date:** 2026-07-16
**Branch:** `worktree-posthog-audit`
**PostHog project:** HAVEN Hub (id 514029)

## Context

An audit of the existing PostHog implementation found a solid foundation (modern
`instrumentation-client.ts` init, `/ingest` reverse proxy, serverless-correct
server capture with `flush()`, clean event-property hygiene, OTLP logs) plus a
set of gaps. This spec covers the code changes to close those gaps. Two audit
items were resolved outside code and are out of scope here:

- **Session-replay masking (P0):** dropped. The app stores no HIPAA-protected data (owner decision).
- **Phantom flags scout:** already disabled via MCP (`signals-scout-feature-flags`, project 514029, 2026-07-16). Verified `feature-flag-get-all` returns `count: 0`, so the scout watched a `$feature_flag_called` stream that never emits.

## Goals

1. Capture server-side errors into PostHog Error Tracking (today only client exceptions are captured).
2. Add group analytics so events can be sliced by term and (where meaningful) department.
3. Instrument four milestone areas: onboarding, compliance, shift scheduling, learning.
4. Stitch applicant identity to person identity at conversion.
5. Refactor all existing capture sites onto one shared helper.

## Settled decisions

| # | Decision | Choice |
|---|---|---|
| D1 | Full clearance | No dedicated event. Instrument the component milestones; derive "fully cleared" as a PostHog funnel/cohort over them. |
| D2 | Capture layer | Put new captures in service functions where the transition passes exactly once or has multiple/batched entry points (`verifyCertificate`, `markEhsComplete`, `persistScoCmi`, `promoteContracts`). Single-path wrappers keep capturing in the wrapper. |
| D3 | Course completion | Replace the best-effort client `course_completed` with a server-authoritative one. |
| D4 | Shift events | Requests + approvals + reminders (the real transitions). No "publish"/"self-signup" exist. |

## Architecture

### 1. Shared server capture helper — `src/platform/posthog/capture.ts` (server-only)

Wraps `getPostHogClient()` to kill the repeated `getPostHogClient()/capture/flush`
boilerplate at ~20 sites. Lives in `@/platform`, so `@/modules` services may
import it (platform-imports-modules is the banned direction, not this one).

```ts
export const GROUP_TERM = "term";
export const GROUP_DEPARTMENT = "department";

type CaptureInput = {
  event: string;
  distinctId: string;
  properties?: Record<string, string | number | boolean | null | undefined>;
  groups?: Partial<Record<typeof GROUP_TERM | typeof GROUP_DEPARTMENT, string>>;
  setPersonProperties?: Record<string, string | number | boolean | string[] | null>;
  flush?: boolean; // default true; pass false inside loops, then call flushEvents()
};

export async function captureEvent(input: CaptureInput): Promise<void>;
export async function aliasPerson(input: { personId: string; previousDistinctId: string; flush?: boolean }): Promise<void>;
export async function flushEvents(): Promise<void>;
```

- `undefined` property values are dropped (mirror the logger's `clean`).
- `setPersonProperties` is merged into `properties.$set`.
- `flush: false` lets batch callers (promotion alias loop, reminder cron) capture N then flush once.

### 2. Server-side error tracking

- **`src/instrumentation.ts`** gains `export function onRequestError(err, request, context)`. Guards `NEXT_RUNTIME === "nodejs"`, calls `getPostHogClient().captureException(err, distinctId, { path, method, router_kind, route_path })`, then `flushEvents()`. `distinctId` is read from the NextAuth session cookie when cheaply available, else omitted.
- **`src/app/global-error.tsx`** (new, client component with its own `<html>/<body>`) captures the exception and renders a minimal branded fallback.
- **`src/platform/posthog/capture-exception.tsx`** (new, `"use client"`): a tiny `<CaptureException error={error} />` component that calls `posthog.captureException` in an effect. Dropped into the 4 existing `error.tsx` boundaries (`(app)`, `apply/[slug]`, `get-started`, `onboard/[token]`) plus `global-error.tsx`, so boundary-swallowed errors still reach Error Tracking.

Net: client-uncaught, client-boundary-caught, and server errors all become Error Tracking issues, so the `error_tracking` self-driving signals stop being half-blind.

### 3. Group analytics model

**Person↔department is many-to-many** (`TermMembership`, unique on `[personId, termId, departmentId, kind]`), so there is no single department per person. Therefore:

- **`term` group** — attached broadly. Client `identify` also calls `posthog.group("term", termId, { name })` (termId/name passed from the `(app)` layout's `activeTerm`). Server events attach `groups: { term }` where a termId is in scope directly, via a cheap `cycle → termId` lookup, or via `getActiveTerm()`.
- **`department` group** — attached only where exactly one department is unambiguous: `application_routed`, `interview_scheduled`, `shift_change_requested`, `shift_request_approved`, `shift_request_denied`.
- **Person properties** via `$set` on the server `user_signed_in` capture (login frequency, not per render): `departments` (active-term membership dept codes, array) and `active_term`. This gives per-department filtering everywhere without modeling a single-department group.

### 4. Applicant → person alias

Inside `promoteContracts` (`src/modules/recruitment/services/promotion.ts`), for each contract that creates (`:91`) or reactivates (`:74`) a Person, call `aliasPerson({ personId: person.id, previousDistinctId: contract.email, flush: false })`, then `flushEvents()` once after the loop. This merges pre-conversion apply-portal events (keyed by email) into the person timeline. Must live in the service: the wrapper `promoteAction` is batch and cannot alias per applicant.

### 5. Refactor existing sites

All existing `getPostHogClient()/capture/flush` sites move to `captureEvent(...)`, adding `groups` per the model above. No behavior change beyond added groups.

## Event catalog

### Existing (refactored onto helper; groups added)

| Event | Site | distinctId | Groups added |
|---|---|---|---|
| `user_signed_in` | `platform/auth/auth.ts:138` | personId | `term`; `$set { departments, active_term }` |
| `recruitment_cycle_created` | `recruitment/actions.ts:41` | personId | `term` (in scope) |
| `recruitment_cycle_published` | `recruitment/actions.ts:74` | personId | `term` (cycle→term) |
| `recruitment_cycle_closed` | `recruitment/actions.ts:87` | personId | `term` (cycle→term) |
| `application_committee_score_submitted` | `.../applicants/actions.ts:29` | personId | `term` (cycle→term) |
| `application_routed` | `.../applicants/actions.ts:48` | personId | `term`, `department` |
| `application_decided` | `.../applicants/actions.ts:71` | personId | `term` |
| `interview_scheduled` | `.../applicants/actions.ts:92` | personId | `term`, `department` |
| `recruitment_decisions_released` | `.../decisions/actions.ts:22` | personId | `term` |
| `onboarding_links_sent` | `.../onboarding/actions.ts:36` | personId | `term` |
| `volunteers_promoted` | `.../onboarding/actions.ts:55` | personId | `term` |
| `incident_report_submitted` | `incidents/actions.ts:88` | personId | `term` (active) |
| `incident_reviewed` | `incidents/actions.ts:126` | personId | `term` (active) |
| `support_request_submitted` | `support/new/page.tsx:66` | personId | `term` (active) |
| `volunteer_offboarded` | `volunteers/offboarding/page.tsx:86` | personId | `term` (active) |
| `application_submitted` | `apply/[slug]/actions.ts:55` | personId ?? email ?? slug | `term` (slug→cycle→term) |
| `application_draft_saved` | `apply/[slug]/draft-actions.ts:16` | personId ?? email | `term` (slug→cycle→term) |
| `applicant_magic_link_requested` | `apply/portal-actions.ts:16` | email | none |

### New

| Event | Site (layer) | distinctId | Properties | Groups |
|---|---|---|---|---|
| `onboarding_contract_submitted` | `submitOnboarding` wrapper (`onboard/[token]/actions.ts`), from `submitContract` result | contract.email | `cycle_id` | `term` |
| `hipaa_certificate_verified` | `verifyCertificate` service (`compliance.ts:512`) + `setCompletionDateAsManager` path | cert.personId | `verified_by`, `via` | `term` (active) |
| `ehs_training_completed` | `markEhsComplete` service (`completion.ts:10`), only on complete transition | personId | `training_id`, `completed_by` | `term` (active) |
| `course_started` | `persistScoCmi` service, first NOT_STARTED→IN_PROGRESS | personId | `course_id` | `term` (active) |
| `sco_completed` | `persistScoCmi`, on newly-stamped `ScoProgress.completedAt` | personId | `course_id`, `sco_id` | `term` (active) |
| `course_completed` | `persistScoCmi`, on newly-stamped `CourseProgress.completedAt` (replaces client event) | personId | `course_id`, `sco_count` | `term` (active) |
| `shift_change_requested` | `createRequest` wrapper (`schedule/page.tsx:113`) | actorPersonId | `request_type`, `date_key` | `term`, `department` |
| `shift_request_approved` | `approveRequest` wrapper | actorPersonId | `request_id` | `term`, `department` |
| `shift_request_denied` | `denyRequest` wrapper | actorPersonId | `request_id` | `term`, `department` |
| `shift_reminder_sent` | `runShiftReminders` cron (`shift-reminders.ts:263`), per recipient, `flush:false` + `flushEvents()` | person.id | `target_date`, `department` (headline) | `term` |

### Removed

- Client `course_completed` in `learning/[courseId]/ScormPlayer.tsx:124` (replaced by the server-authoritative one).

## Property hygiene

All properties remain IDs, counts, enums, booleans. No names, emails, or free-text notes in event properties (preserve the existing discipline). `email` is used only as a `distinctId`/alias where a person does not yet exist, never as a property.

## Testing

- `capture.ts`: unit tests (mock `getPostHogClient`) for property/group/`$set` shaping, the `flush` toggle, and `aliasPerson`.
- `onRequestError`: unit test that it no-ops on the edge runtime and calls `captureException` + flush on node.
- `persistScoCmi`: assert `course_started` fires once on first progress, `course_completed`/`sco_completed` fire once when `completedAt` is newly stamped and never again (mock `captureEvent`).
- `promoteContracts`: assert `aliasPerson` is called once per created/reactivated person.
- `verifyCertificate` / `markEhsComplete`: assert the event fires on the complete transition only (mock `captureEvent`).

## Non-goals

- No PostHog feature-flag adoption (owner chose to disable the phantom scout instead).
- No dedicated `full_clearance_reached` event (D1 derive-via-funnel).
- No per-cell `shift_assigned/unassigned` events (D4).
- No changes to the OTLP logging pipeline.

## Follow-ups (post-merge, PostHog side)

- Build the clearance funnel over the milestone events.
- Consider enabling `signals-scout-product-analytics` once funnels exist.
- Optionally set display names for the `term` / `department` group types in PostHog.
