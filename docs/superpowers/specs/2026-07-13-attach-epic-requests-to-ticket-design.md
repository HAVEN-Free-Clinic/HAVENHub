# Attach many Epic requests to one support ticket

Date: 2026-07-13
Branch: `feat/attach-epic-to-ticket`
Status: Approved design, pending spec review

## Problem

An IT Support ticket (`TechRequest`) can currently be linked to **exactly one**
Epic access request (`EpicRequest`). The link is a `@unique` foreign key on the
parent (`TechRequest.epicRequestId`), and the "Create Epic request" promotion on
`/support/[id]`:

- only appears for `category === "EPIC"` tickets,
- only appears while the ticket has no linked request,
- always targets the ticket's **requester** as the subject person.

That blocks every real workflow a manager runs into:

1. **Follow-up for the same person.** The ticket's Epic request is done, and the
   same person later needs another action (got NEW access, now needs MODIFY /
   RENEW). Today that forces a brand-new ticket.
2. **Several open at once.** One ticket should carry multiple Epic requests that
   are open simultaneously.
3. **Non-Epic ticket needs Epic.** A ticket filed under `GENERAL_IT` / `DUO_MFA`
   turns out to need Epic access. Promotion is blocked because the category is
   not `EPIC`.
4. **Redo after a wrong one.** The first request was created with the wrong kind
   and needs to be discarded and re-created. There is no way to cancel it from
   the ticket.
5. **Director bulk for multiple people.** A director files one ticket asking for
   Epic access for many volunteers. Today the promotion can only create a
   request for the ticket's requester (the director), not for the listed people.

## Goals

- One support ticket can hold **many** Epic requests, for **any active people**
  (not just the requester), of any kind, some open at once.
- Attaching works regardless of the ticket's `category`.
- A manager can **cancel** a pending attached request (to support the redo case).
- Attached requests are worked through the YNHH pipeline on `/support/epic`, not
  inline on the ticket. The ticket is the origin plus a live status tracker.

## Non-goals

- No change to how the requester self-serves. Attaching arbitrary people to a
  ticket is a manager action (`support.manage_requests`), same permission as
  today's promotion.
- No change to the YNHH ticket (`YnhhTicket`) model, the PDF/spreadsheet
  generator, or the Tracker/History tables beyond adding the pending queue.
- Per-person mixed kinds in a single attach action are out of scope. One attach
  action applies one kind to the selected people; mixed kinds are achieved with
  multiple attach passes. (YAGNI.)
- Attaching to a resolved/closed/cancelled ticket is out of scope; reopen first.

## Design

### 1. Data model: flip `TechRequest <-> EpicRequest` to 1:N

Move the link from the parent to the child, mirroring the existing
`EpicRequest.ticketId -> YnhhTicket` relation (a nullable child-side FK, already
1:N).

`prisma/schema.prisma`:

- **Add** to `EpicRequest`:
  ```prisma
  techRequestId String?
  techRequest   TechRequest? @relation("techRequestEpic", fields: [techRequestId], references: [id], onDelete: SetNull)
  ```
  plus `@@index([techRequestId])`.
- **Remove** from `TechRequest`: the `epicRequestId String? @unique` column and
  the `epicRequest EpicRequest? @relation("techRequestEpic", ...)` field. The
  relation name `techRequestEpic` is reused on the new child-side FK.
- **Keep** `TechRequest.epicSubtype`. It stops being authoritative for "the
  linked request's kind" (there can be many now) and reverts to a pure intake
  hint: what the submitter asked for at creation. The ticket list badge keeps
  reading it as-is; `promoteToEpic`'s old write of `epicSubtype = kind` goes away.

Migration (`prisma migrate dev`, then trim to intended per the migrate-dev-drift
memory):

1. Add `EpicRequest.techRequestId` (nullable) + index.
2. Backfill: `UPDATE "EpicRequest" e SET "techRequestId" = t.id FROM "TechRequest" t WHERE t."epicRequestId" = e.id;`
3. Drop `TechRequest.epicRequestId` (drops its unique index with it).

Because the old link was `@unique`, each existing EpicRequest is referenced by at
most one TechRequest, so the backfill is unambiguous. No data loss.

### 2. Service layer

#### `epic-link.ts`: replace `promoteToEpic` with `attachEpicRequests`

```ts
attachEpicRequests(
  actorPersonId: string,
  techRequestId: string,
  input: { kind: EpicRequestKind; personIds: string[] }
): Promise<EpicRequest[]>
```

- Requires `support.manage_requests` (`SupportForbiddenError` otherwise).
- `kind` must be one of `NEW | MODIFY | RENEW` (`SupportStateError` otherwise).
  DEACTIVATE stays out of this path, same as today's `PROMOTABLE_KINDS`.
- `personIds` must be non-empty (`SupportStateError`).
- Ticket must exist (`SupportNotFoundError`) and **must not be terminal**
  (`RESOLVED / CLOSED / CANCELLED` -> `SupportStateError`). Reuses
  `TERMINAL_STATUSES` from `manage.ts`.
- **Dropped gates** (vs `promoteToEpic`): the `category === "EPIC"` check and the
  `t.epicRequestId` already-linked check are gone.
- Enforces the **same per-person rules `createEpicRequest` guarantees**
  (person-exists, person-ACTIVE, no-open-duplicate, kind-vs-epicId), reusing the
  same typed errors so messages stay consistent.
- **All-or-nothing**: validate every person up front, then create in one
  `$transaction` (mirroring `submitEpicRequests`, which faces the identical
  bulk-with-shared-rules problem). On any failure, attach none and surface the
  offending names in the message. Rationale: a partially applied bulk attach is
  confusing for a director's multi-person ticket.
- Links each new request via `techRequestId`; advances the ticket from
  `SUBMITTED` to `IN_PROGRESS` if it is still `SUBMITTED`, and otherwise leaves
  its status untouched (so a later attach never yanks an `AWAITING_*` ticket
  backward). Audits `support.epic_attach` with `{ personIds, kind, count }`.

Note: `createEpicRequest` uses the global prisma client and cannot join an outer
transaction, so `attachEpicRequests` does **not** call it in a loop. It instead
inlines the per-person validation + `createMany` inside its own `$transaction`,
exactly as `submitEpicRequests` already does. The validation rules are copied
from `createEpicRequest`; a comment on each cross-references the other so they
stay in sync.

#### `epic.ts`: add `cancelEpicRequest`

```ts
cancelEpicRequest(actorPersonId: string, requestId: string): Promise<void>
```

- Requires `support.manage_requests`.
- Request must exist (`EpicNotFoundError`) and be `PENDING`
  (`EpicStateError` otherwise). A `SUBMITTED` request is already at YNHH; redoing
  that is out of scope. `COMPLETED` / `CANCELLED` are no-ops-that-error.
- Sets `status = CANCELLED`. Does not touch `Person.epicId`. Audits `epic.cancel`.

### 3. Ticket detail UI (`/support/[id]`, "Epic access" section)

Turn the singleton into a **list plus an attach control**. The whole inline YNHH
pipeline (complete / create YNHH ticket / set SR# / send email) is **removed**
from the ticket; that work now lives on `/support/epic` (section 4).

- **Attached requests list.** One row per linked `EpicRequest`: person name,
  kind badge, status badge, and (if submitted) the YNHH SR# / ticket status.
  Rows are read-mostly. A `PENDING` row gets a **Cancel** button wired to
  `cancelEpicRequest`.
- **Attach control.** A "Attach Epic request(s)" form: a **kind** select
  (New / Modify / Renew) and a **people** picker. Shown to managers while the
  ticket is non-terminal.
  - Picker: reuse the department/member tree already built for the Generate tab.
    Extract it out of `epic-request-form.tsx` into a shared component
    (e.g. `member-tree-picker.tsx`) consumed by both the Generate form and this
    attach form, so bulk selection is ergonomic and consistent.
  - The ticket's requester is offered as a one-click quick-add, since the
    single-person cases (follow-up, non-Epic-needs-Epic) target the requester.
- Server actions in `page.tsx`: `attachEpicAction` (reads kind + personIds) and
  `cancelEpicAction` (reads epicRequestId). Both re-derive the ticket, gate on
  `support.manage_requests`, catch the typed errors, and redirect with
  `?epicError=` exactly like the current `promoteAction`. The old
  `completeEpicAction` / `createEpicTicketAction` / `setEpicSrAction` /
  `sendEpicEmailAction` are deleted from this page.

`tech-request.ts` `loadDetail`: change `epicRequest: {...}` (singleton) to
`epicRequests: { include: { ticket: true }, orderBy: { createdAt: "asc" } }` via
the new back-relation, and include each request's `person` for the row label.

### 4. New "Pending" queue on `/support/epic`

Required consequence of "work them on `/support/epic`". Today a `PENDING`
EpicRequest with no `ticketId` has no home on that page: the Generate flow
creates-and-submits into a `YnhhTicket` in one step, and the Tracker only lists
`YnhhTicket`s. So attaching-as-PENDING needs a place to advance them.

Add a new **Pending tab** to `EpicRequestTabs` (tab nav becomes
Generate / Pending / Tracker / History). Keeping it separate from Tracker matters
because Tracker lists open `YnhhTicket`s, whereas these are loose, not-yet-batched
requests:

- Lists un-submitted requests: `EpicRequest` where `status === "PENDING"` and
  `ticketId === null`, newest first, showing person, kind, source ticket number
  (via `techRequest`), and business days pending.
- Multi-select + a **"Create YNHH ticket"** action that calls the existing
  `createTicket(actor, { requestIds, description })` from `epic.ts` (already
  atomic-claim safe). After that the request is `SUBMITTED` under a `YnhhTicket`
  and shows on the Tracker.
- New read in `itcm.ts`: `listPendingEpicRequests()` returning the rows above.
- New server action on the epic page: `createTicketFromPendingAction(formData)`
  gated on `support.manage_requests`.

This effectively revives the retired `/volunteers/epic` multi-select queue,
scoped to pending requests, and is bulk-ready for the director case.

#### 4a. Per-request Complete + Email on the Tracker (corrected scope)

Discovered while planning: the Tracker today only does **SR#** and **close the
YnhhTicket** (`closeTicket` does not complete individual requests). The
per-request **Complete** (`completeRequest`, which writes `Person.epicId` and
marks the request `COMPLETED`) and the **Epic emails** (`sendEpicEmail`:
onboarding / activation / password-reset) live **only** in the inline ticket
pipeline we are removing. Generate-flow requests currently have no in-app
Complete or Email at all.

So moving the pipeline home to `/support/epic` requires **adding those two steps
to the Tracker**, per request row:

- **Complete**: for a `NEW`/`MODIFY` request, an `epicId` input + Complete button
  wired to the existing `completeRequest(actor, requestId, epicId)`; for `RENEW`,
  a confirm-only Complete. Only shown for `PENDING`/`SUBMITTED` requests.
- **Email**: onboarding / activation / password-reset buttons wired to the
  existing `sendEpicEmail(actor, requestId, template)`, shown for
  `PENDING`/`SUBMITTED`/`COMPLETED` requests (matches current ticket behavior).

Both services already exist and are unchanged; this is UI + two new server
actions on the epic page (`completeEpicRequestAction`, `sendEpicEmailAction`).
Net effect: the Tracker becomes the real pipeline home for **all** Epic requests,
closing the pre-existing Generate-flow gap as a bonus.

### 5. Guards and edge cases

- **Mixed epicId in a bulk NEW.** If any selected person already has an epicId, a
  `NEW` attach fails for them and (all-or-nothing) the whole action reports the
  offending names. Managers pick the correct kind per batch. This matches
  `submitEpicRequests` today.
- **Duplicate open request.** `createEpicRequest`'s rule (no PENDING/SUBMITTED
  request may already exist for a person) is preserved in the copied validation,
  so a person cannot be double-attached across tickets or twice on one ticket.
- **Terminal ticket.** Attach and cancel are blocked on `RESOLVED/CLOSED/CANCELLED`.
  Reopen via the existing `setStatus` first.
- **Ticket deletion.** `onDelete: SetNull` on the new FK means deleting a ticket
  detaches its Epic requests rather than cascading them away (they retain audit
  and YNHH history). Same posture as the old `epicRequestId` SetNull.

### 6. Testing

- Unit (`epic-link.test.ts`, rewritten for `attachEpicRequests`):
  - multi-person attach links all, moves ticket to IN_PROGRESS, audits;
  - attaches to a non-EPIC category ticket;
  - attaches a second request while an earlier one exists (1:N);
  - rejects a terminal ticket;
  - all-or-nothing: one bad person (inactive / wrong-kind-vs-epicId / duplicate
    open) rejects the whole batch and lists names;
  - non-manager -> `SupportForbiddenError`.
- Unit (`epic.test.ts`): `cancelEpicRequest` PENDING -> CANCELLED, audits,
  non-PENDING errors, non-manager forbidden.
- Migration: a data test (or manual note) that backfill copies the old
  `epicRequestId` into `techRequestId`.
- E2E: attach a bulk request from a ticket -> shows in the Pending queue ->
  select + create YNHH ticket -> appears in Tracker.

## Build sequence

1. Schema + migration (data model, backfill, drop column). Regenerate client.
2. Service layer: `attachEpicRequests`, `cancelEpicRequest`, generalize
   `loadDetail`, add `listPendingEpicRequests`. Unit tests green.
3. Ticket detail UI: extract the member-tree picker, build the attached-requests
   list + attach/cancel controls, delete the inline pipeline + its actions.
4. `/support/epic` Pending queue: read + tab + create-ticket action.
5. `/support/epic` Tracker per-request Complete + Email (section 4a): two new
   server actions + Tracker row controls.
6. E2E + full check run (`npm run check` or the repo's gate).

## Decisions carried from brainstorming

- **Which ticket:** the user-facing `TechRequest` (IT Support ticket), not the
  YNHH service ticket.
- **Pipeline home:** `/support/epic`, not inline on the ticket. Attaching creates
  PENDING requests; the pending queue (section 4) is the required new surface.
- **Terminal gate:** kept. Attaching to a resolved/closed ticket requires
  reopening it first (no auto-reopen).
