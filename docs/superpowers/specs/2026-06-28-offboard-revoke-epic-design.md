# Offboarding revokes Epic access and generates a YNHH deactivation request

**Issue:** [#87](https://github.com/HAVEN-Free-Clinic/HAVENHub/issues/87): Offboarding never revokes Epic (EHR) access or closes the person's open Epic request.

**Date:** 2026-06-28
**Branch:** `worktree-fix+offboard-revoke-epic`

## Problem

`executeOffboard()` removes memberships and sets `Person.status = OFFBOARDED` but does nothing with the person's Epic state:

1. Any open `EpicRequest` (`PENDING` or `SUBMITTED`) is left open and still actionable in the queue.
2. `completeRequest()` guards only on the request's own status, never on `Person.status`, so a manager can still click "Complete" on an offboarded person's `NEW`/`MODIFY` request and stamp a fresh `epicId` onto someone who has left. This contradicts `createEpicRequest()`, which refuses the same person for being non-ACTIVE.
3. There is no `EpicRequestKind` for revocation, so the module that provisions Epic access has no workflow to track that deprovisioning is owed at YNHH.

Per the issue's verifier note, `Person.epicId` is a recorded/mirrored credential identifier, not the live EHR switch. Actual provisioning and deprovisioning happen at YNHH via the manual service-request workflow; the hub tracks it. The substantive gap stands: stale `epicId` plus open requests, a `completeRequest` path that grants access to offboarded people, and no kind/workflow for owed revocation.

## Goals

- On every offboard path, cancel the person's open access-granting requests and enqueue a tracked deactivation task so the revocation owed at YNHH is visible in the hub.
- Block `completeRequest` from granting/stamping Epic access onto a non-active person.
- Let an ITCM admin batch pending deactivations into a real YNHH Electronic Service Request (PDF + spreadsheet + email), the same shape as the existing bulk new/modify flow, but for deactivation.

## Decisions (locked with the user)

- **Trigger model:** offboarding queues a tracked `PENDING DEACTIVATE` request. An ITCM admin later batches pending deactivations into the YNHH submission. Offboarding does not auto-generate the PDF; a human stays in the loop for the YNHH submission.
- **Epic ID handling:** `epicId` is never cleared automatically. It stays as a historical record. Only the request status tracks revocation.
- **Naming:** the new kind/type is `DEACTIVATE` (request types `deactivate_individual` and `bulk_deactivate`).
- **YNHH artifact:** the same Service Request PDF (with a termination/deactivation section) plus a spreadsheet plus an email body, mirroring the bulk flow.
- **Hook location (Approach A):** the logic lives in `setPersonStatusField` (`src/platform/people.ts`), the documented single convergence point for every offboard path. This guarantees both `executeOffboard` and the admin people-page offboard revoke Epic, and gives symmetric cleanup on reactivation. Precedent: `setPersonStatusField` already does cross-cutting offboard cleanup (removing all ACTIVE memberships) in the same transaction.

## Architecture

The change spans two existing seams, kept separate so each stays small and testable:

1. **Offboard convergence + the security guard** (closes #87 by itself).
2. **The YNHH deactivation service-request generator** (the "similar to a bulk request" capability).

`EpicRequest` remains the single source of truth for "an Epic access change that is owed or in flight." Offboard creates a `PENDING DEACTIVATE` request (revocation owed); the ITCM generator moves selected pending deactivations to `SUBMITTED` under a new `YnhhTicket`; a manager later marks them `COMPLETED` when YNHH confirms.

## Phase 1: Offboard convergence + completeRequest guard

### 1.1 Schema

Add `DEACTIVATE` to the `EpicRequestKind` enum in `prisma/schema.prisma`:

```prisma
enum EpicRequestKind {
  NEW
  MODIFY
  RENEW
  DEACTIVATE
}
```

Generate a migration. Adding an enum value is additive and safe under `migrate deploy` (no backfill needed). Run `prisma migrate status` before any Neon deploy per project convention.

### 1.2 `setPersonStatusField` (src/platform/people.ts)

Extend the existing transaction. The person record is already loaded above the transaction, so `existing.epicId` and `existing.status` are available.

On transition to `OFFBOARDED`, inside the transaction:
- Cancel open access-granting requests: find the person's `PENDING`/`SUBMITTED` requests whose kind is `NEW`/`MODIFY`/`RENEW`, set each to `CANCELLED`, and append a `Cancelled: person offboarded` line to `notes` (preserving any existing notes; volume is at most one row at clinic scale). Collect their ids.
- If `existing.epicId` is set and the person has no open `DEACTIVATE` request, create one `PENDING DEACTIVATE` `EpicRequest` (`requestedById = actorPersonId`). Capture its id.
- If `existing.epicId` is null, create nothing (no Epic access to revoke).

On transition to `ACTIVE` (reactivation), inside the transaction:
- Cancel any open (`PENDING`/`SUBMITTED`) `DEACTIVATE` request for the person (they returned; revocation is no longer owed). Collect their ids.

Audit: fold the results into the existing single audit row rather than emitting extra rows (the "one audit row per status change" contract holds). The `person.offboard` `after` payload gains `cancelledEpicRequestIds: string[]` and `deactivationRequestId: string | null`; the `person.reactivate` payload gains `cancelledDeactivationRequestIds: string[]`.

`createEpicRequest` is left unchanged: it correctly refuses non-active people for `NEW`/`MODIFY`/`RENEW`, and `DEACTIVATE` requests are created only by this hook and the ITCM generate route (both direct prisma writes), never through `createEpicRequest`.

### 1.3 `completeRequest` (src/modules/volunteers/services/epic.ts)

Load the request's person (currently it does not). Then:
- For `NEW`/`MODIFY`/`RENEW`: if `person.status !== "ACTIVE"`, throw `EpicStateError` ("Cannot complete a `<kind>` request for a non-active person."). This blocks stamping `epicId` onto an offboarded person and removes the internal inconsistency with `createEpicRequest`.
- For `DEACTIVATE`: allowed regardless of `person.status`; no `epicId` argument is read or required; set `status = COMPLETED`, `completedAt = now`. `epicId` is not cleared. Audit `epic.complete` with `{ kind: "DEACTIVATE" }`.

### 1.4 Tests (Phase 1)

- `setPersonStatusField`: offboard with an `epicId` creates one `PENDING DEACTIVATE` and cancels an open `NEW` request; offboard without an `epicId` creates no deactivation; offboard is idempotent (no duplicate `DEACTIVATE` on a re-run); reactivate cancels an open `DEACTIVATE`. Audit payload carries the new fields.
- `completeRequest`: completing a `NEW`/`MODIFY` request for an `OFFBOARDED` person throws; completing for an `ACTIVE` person still works; completing a `DEACTIVATE` request for an `OFFBOARDED` person succeeds, sets `COMPLETED`, and leaves `epicId` intact.
- `executeOffboard`: end-to-end, an offboarded person with an `epicId` ends up with a `PENDING DEACTIVATE` request and no open `NEW`/`MODIFY`/`RENEW` requests (covers the convergence through `setPersonStatusField`).

## Phase 2: YNHH deactivation service request

### 2.1 `itcm-pdf.ts`

Add to `RequestType`: `deactivate_individual`, `bulk_deactivate`. Add `SECTION_IX` entries describing a deactivation/termination request. In `generatePdf`, branch the deactivation types to:
- check the form's termination/deactivation checkbox in the access-type section (exact field id TBD; the user will point to the correct checkbox during implementation; reuse the existing duplicate-widget and vector-checkmark handling already in this file),
- fill the person's existing `epicId` (the account being deactivated) for individual deactivation, or "See spreadsheet" for bulk,
- use the termination date for the relevant date field.

### 2.2 `generate` route (src/app/api/admin/itcm/generate/route.ts)

- Extend `EMAIL_BODIES`, `PDF_FILENAMES`, `REQUEST_TYPE_LABELS`, and the `epicKind` mapping (deactivate types map to `DEACTIVATE`).
- `endDate` becomes the termination/deactivation date; it defaults to today when blank rather than erroring (the new-request branch already uses a fixed date; deactivation should not require manual entry).
- Reconciliation (the key difference from new/modify): for deactivate types, for each selected person, attach their existing open (`PENDING`/`SUBMITTED`) `DEACTIVATE` request to the new `YnhhTicket` and set it `SUBMITTED`; if none exists, create a `SUBMITTED DEACTIVATE` request attached to the ticket (defensive, supports ad-hoc deactivation). This avoids duplicate request rows for offboard-queued people.
- Spreadsheet: reuse `generateSpreadsheet` for `bulk_deactivate`, populating the Epic ID column with the account to deactivate (mirror column left blank, end date = termination date).

### 2.3 `itcm.ts`

Add `listPendingDeactivations()`: returns people with an open (`PENDING`) `DEACTIVATE` `EpicRequest` (id, name, netId, contactEmail, epicId, and active-or-last department names for display). This is the person source for the deactivate flow, because offboarded people are no longer active members and so do not appear in `listDepartmentsWithMembers`.

### 2.4 UI: `epic-request-form.tsx`

- Add "Deactivate" to the request-type control (individual and bulk scope).
- When the request type is a deactivate type, render the person picker from `listPendingDeactivations()` (a flat selectable list of people awaiting deactivation) instead of the department/member tree. The page (`src/app/(app)/admin/itcm/epic-requests/page.tsx`) passes this list alongside `departments`.
- Add the `EMAIL_SUBJECTS` entry for the deactivate types.

### 2.5 UI: volunteers Epic queue

Where the queue renders a row's "Complete" action, a `DEACTIVATE` row completes without the "enter Epic ID" prompt (no `epicId` is needed or written). Confirm the queue page (`src/app/(app)/volunteers/epic/page.tsx`) and any complete form handle the new kind label.

### 2.6 Tests (Phase 2)

- `itcm-pdf`: a `deactivate_individual` generation checks the termination field and fills the person's `epicId`; `bulk_deactivate` prints "See spreadsheet".
- `generate` route reconciliation: selecting a person who already has a `PENDING DEACTIVATE` attaches that request to the ticket and sets it `SUBMITTED` (no duplicate created); selecting a person with none creates one.
- `listPendingDeactivations` returns only people with an open `DEACTIVATE` request.

## Out of scope

- Clearing or rotating `epicId` on deactivation (explicitly excluded by the "never clear automatically" decision).
- Any live YNHH/Epic API integration. Deprovisioning remains the manual YNHH service-request workflow; the hub only tracks it.
- A dedicated deactivation email template in the notification system (the generator's email body is assembled in the route, matching the existing bulk flow).

## Risks and mitigations

- **Wrong PDF checkbox for termination.** The YNHH template fields are generically named (`Check Box51`, etc.) and no local text extractor is available. Mitigation: Phase 1 fully closes the audit finding without touching the PDF; the exact termination field is confirmed with the user (an authorizer on the form) during Phase 2 implementation.
- **Platform-layer coupling.** `setPersonStatusField` touches the `EpicRequest` model. Mitigation: this matches the file's existing role as the offboard convergence point (it already writes `TermMembership`), and the coupling is a direct prisma write, not a domain import.
- **Duplicate `DEACTIVATE` requests** if offboard runs twice or an admin also creates one. Mitigation: the offboard hook and the route both guard on "no existing open `DEACTIVATE` request" before creating.
