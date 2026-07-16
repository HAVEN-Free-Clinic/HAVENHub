# IT Support: unified tech request ticketing (with Epic consolidation)

Status: approved design, ready for implementation planning
Date: 2026-07-09
Author: Jack C (with Claude)

## 1. Summary

Bring the Airtable "Tech Requests" workflow into HAVEN Hub as a first-class **IT Support** module. Any signed-in person can submit a tech request and track it (status plus a two-way comment thread). A grantable permission lets managers (ITCM) see and work the master list. Epic access requests become one category of tech request, and the two existing Epic surfaces (`/volunteers/epic` and `/admin/itcm`) are consolidated into this single module and removed from their old homes. All Epic and tech self-service is removed from My Info; submission and tracking happen only in IT Support.

The existing Epic machinery (`EpicRequest`, `YnhhTicket`, the YNHH PDF/Excel generator, mirror-person and authorizer logic, and offboard auto-revocation) is preserved unchanged and reused. An Epic-category ticket links to an `EpicRequest` when a manager promotes it.

## 2. Background and current state

### 2.1 Airtable "Tech Requests" table (source of truth for the workflow)

The Airtable table is a general IT helpdesk in which Epic is one category.

- `Request Type` (category): Epic Issue, DUO Multi-Factor Authentication, General IT Issue, Teams Access, Other
- `Epic Issue Type` (when Epic): New Account, Modification, Renewal (maps to the hub's `EpicRequestKind` NEW / MODIFY / RENEW)
- `Status`: Submitted, Awaiting Your Action, In Progress, Request Sent to YNHH, YNHH Assigned Ticket, Awaiting YNHH, Resolved, Sent Activation Instructions, Sent Renewal Instructions, Unable to Reach
- `Priority`: Low, Medium, High, Critical
- Epic-specific fields: Job Title/Position, Epic ID to Mirror, Start/End Date, "Currently works at YNHHS?", Government Issued ID (NPI for providers), NetID, YNHH Ticket Number
- Requester link to People, Assigned To link to People, Description, Resolution Details, Attachments, timestamps

### 2.2 Existing hub Epic machinery (preserved, reused)

- Models: `EpicRequest`, `YnhhTicket`; enums `EpicRequestKind` (NEW / MODIFY / RENEW / DEACTIVATE), `EpicRequestStatus` (PENDING / SUBMITTED / COMPLETED / CANCELLED), `YnhhTicketStatus` (OPEN / CLOSED). `Person.epicId` holds the granted account id.
- Lifecycle service: `src/modules/volunteers/services/epic.ts` (create, complete, cancel, update details, batch into ticket, set SR number, close ticket, send Epic emails). Internally gates on `volunteers.manage_epic` via `requireManageEpic()`.
- YNHH generation: `src/modules/admin/services/itcm.ts`, `itcm-pdf.ts`, and the POST route `src/app/api/admin/itcm/generate/route.ts` (PDF via pdf-lib, Excel via exceljs, authorizer/mirror resolution, `reconcileDeactivationRequests`). Gated on `admin.access`.
- Offboard revocation: `setPersonStatusField` in `src/platform/people.ts` cancels open NEW/MODIFY/RENEW requests and enqueues a PENDING DEACTIVATE request; reactivation cancels open DEACTIVATE requests.
- Self-service today: My Info `EpicPanel` (`src/modules/my-info/components/epic-panel.tsx`) plus `myEpicPanel` / `createEpicRequest` and the `epicRequestAction` server action in `src/app/(app)/my-info/page.tsx`.

### 2.3 Platform primitives to reuse

- Module registry `src/platform/modules/registry.ts` (single wiring point); nav filtering `src/platform/modules/access.ts` (`filterNavItems`); page gates `requirePermission` / `requireModuleAccess` in `src/platform/auth/session.ts`.
- RBAC engine `src/platform/rbac/engine.ts` (`can`, `getEffectivePermissions`); system roles `src/platform/rbac/system-roles.ts`; roles admin `src/modules/admin/services/rbac.ts` (validates against the registry).
- Notifications: `notify(db, input)` in `src/platform/notifications/notify.ts` (queues email + Teams + in-app inbox, per-person); type registry `src/platform/notifications/registry.ts` (`NOTIFICATION_TYPES`, admin-routable channel per type). Email rendered through the editable template engine (subset only: `{{#if}}`, `{{var}}`, `{{{raw}}}`, no `{{#each}}`).
- Uploads: Vercel Blob plus the shared `validateUploadedFile` size/MIME guard.
- Audit: `recordAudit`; person field writes via `updatePersonFields`.
- UI primitives: Card, Badge (neutral chip plus status dot), Alert, Modal, PageHeader, SectionHeader, ModuleNav, Spinner, PageLoading.

## 3. Decisions (locked)

1. **Architecture: unified.** One `TechRequest` umbrella; Epic is a category. Epic-category tickets link to the existing `EpicRequest` machinery.
2. **Module: "IT Support"** at `/support`, permission namespace `support.*`. Top-level module, open to everyone (no `accessPermission`), so anyone can submit.
3. **Submitter entry: inside the module**, permission-filtered tabs. Everyone gets Submit and My requests; managers additionally get All requests and Epic / YNHH tools. All Epic and tech self-service is removed from My Info.
4. **Phasing: one build.** Umbrella, all categories including Epic, consolidation of both Epic surfaces, and retirement of `/admin/itcm` and `/volunteers/epic`, shipped together.
5. **Attachments: yes** (Vercel Blob) on tickets and comments, via `validateUploadedFile`.
6. **Comments: two-way plus internal.** `PUBLIC` thread (submitter and managers) and `INTERNAL` notes (managers only) on the same ticket.
7. **Epic flow: manager-promoted.** Submitting an Epic-category ticket creates a plain `TechRequest` carrying the Epic intake fields. A manager clicks "Create Epic request" to spawn and link the `EpicRequest`, which then flows through the existing pipeline.
8. **Priority is manager-owned** (triage), not submitter-set, to prevent self-escalation.
9. **Offboard DEACTIVATE stays Epic-only**, shown in the Epic / YNHH tools tab, not surfaced as a submitter TechRequest.

## 4. Data model

New Prisma models. `EpicRequest` and `YnhhTicket` are unchanged except for the back-relation from `TechRequest`.

### TechRequest

- `id` String cuid
- `number` Int `@unique @default(autoincrement())` (human ticket number, Airtable "Request ID")
- `requesterId` -> Person (relation "TechRequestRequester")
- `category` `TechRequestCategory`
- `epicSubtype` `EpicRequestKind?` (only NEW / MODIFY / RENEW valid; set only when category = EPIC)
- `subject` String
- `description` String `@db.Text`
- `priority` `TechRequestPriority @default(MEDIUM)`
- `status` `TechRequestStatus @default(SUBMITTED)`
- `assignedToId` -> Person? (relation "TechRequestAssignee", Restrict)
- `resolution` String? `@db.Text`
- `resolvedAt` DateTime?
- `epicRequestId` String? `@unique`; `epicRequest` `EpicRequest?` (SetNull) (link created on promotion)
- Epic intake fields (captured at submit, used when promoting): `epicJobTitle` String?, `epicMirrorId` String?, `epicStartDate` DateTime?, `epicEndDate` DateTime?, `worksAtYnhh` Boolean?, `govId` String? (NPI), `netId` String?
- `createdAt`, `updatedAt`
- Relations: `comments TechRequestComment[]`, `attachments TechRequestAttachment[]`
- Indexes: `@@index([status])`, `@@index([requesterId])`, `@@index([assignedToId])`

### TechRequestComment

- `id`, `requestId` -> TechRequest (Cascade), `authorId` -> Person
- `body` String `@db.Text`
- `visibility` `CommentVisibility @default(PUBLIC)`
- `createdAt`
- `attachments TechRequestAttachment[]`
- `@@index([requestId])`

### TechRequestAttachment

- `id`, `requestId` String? -> TechRequest (Cascade), `commentId` String? -> TechRequestComment (Cascade) (exactly one set)
- Blob fields: `url`, `pathname`, `filename`, `mimeType`, `size` Int
- `uploadedById` -> Person, `createdAt`
- `@@index([requestId])`, `@@index([commentId])`

### Enums

- `TechRequestCategory { EPIC DUO_MFA GENERAL_IT TEAMS OTHER }`
- `TechRequestPriority { LOW MEDIUM HIGH CRITICAL }`
- `TechRequestStatus { SUBMITTED IN_PROGRESS AWAITING_REQUESTER AWAITING_YNHH RESOLVED CLOSED CANCELLED }`
- `CommentVisibility { PUBLIC INTERNAL }`

Epic-specific YNHH sub-states (Request Sent to YNHH, YNHH Assigned Ticket, Awaiting YNHH, Sent Activation/Renewal Instructions) are read from the linked `EpicRequest` / `YnhhTicket` (status and service request number) and shown on the ticket rather than duplicated as top-level `TechRequestStatus` values. "Unable to Reach" is expressed as a resolution note on a RESOLVED/CLOSED ticket.

## 5. Module, routes, permissions

### 5.1 Registry and nav

Add to `MODULES`:

```
{
  id: "support",
  title: "IT Support",
  description: "Submit and track IT and Epic access requests",
  icon: LifeBuoy, // lucide; confirm during planning
  // no accessPermission: open to any signed-in matched person (like my-info)
  permissions: ["support.manage_requests"],
  status: "active",
  nav: [
    { label: "My requests", href: "/support" },
    { label: "Submit a request", href: "/support/new" },
    { label: "All requests", href: "/support/all", permission: "support.manage_requests" },
    { label: "Epic / YNHH tools", href: "/support/epic", permission: "support.manage_requests" },
  ],
}
```

Routes under `src/app/(app)/support/`:
- `layout.tsx` calls `requireModuleAccess("support")` and renders `<ModuleNav items={filterNavItems(mod.nav, perms)} />`
- `page.tsx` My requests (everyone)
- `new/page.tsx` Submit (everyone)
- `all/page.tsx` master list (requirePermission `support.manage_requests`)
- `[id]/page.tsx` ticket detail (submitter sees own; managers see any; gate accordingly)
- `epic/page.tsx` relocated Epic / YNHH tools (requirePermission `support.manage_requests`)

### 5.2 Retirements and moves

- Remove `/admin/itcm` and `/admin/itcm/epic-requests`; drop the `ITCM` entry from the Admin module nav. Move `EpicRequestTabs` and the generate route under `/support` (new location `src/app/api/support/epic/generate/route.ts` or similar), re-gated from `admin.access` to `support.manage_requests`.
- Remove `/volunteers/epic`; drop the "Epic requests" entry from the Volunteers module nav. Its queue actions move into `/support/epic`.
- Remove the My Info Epic Access section: delete `EpicPanel` usage, the `epicRequestAction` server action, the `myEpicPanel` import/fetch, and the related searchParams (`epicError` / `epicSaved`) from `src/app/(app)/my-info/page.tsx`. Retire `src/modules/my-info/components/epic-panel.tsx`.

### 5.3 Permission migration

- Introduce `support.manage_requests`. Re-gate the Epic lifecycle service (`requireManageEpic`) and the generate route to it. Replace all `volunteers.manage_epic` references and remove that permission from the Volunteers module `permissions[]` and its nav.
- Update `SYSTEM_ROLES`: the "Volunteer Operations Manager" role grants `support.manage_requests` in place of `volunteers.manage_epic`. Platform Admin keeps `"*"`.
- Backfill migration (data): grant `support.manage_requests` to every current holder of `volunteers.manage_epic` (mirror existing `RoleGrant` rows), then remove the old grants. Follow the system-role-grants note: production runs `migrate deploy`, not the seed, so the grant change needs an explicit backfill migration.

### 5.4 Code layout

Consolidate the feature under a single module `src/modules/support/`:
- `services/tech-request.ts` (umbrella lifecycle: create, list, get, comment, attach, assign, set status/priority, resolve, cancel; permission enforcement; typed errors; audit)
- `services/epic.ts`, `services/itcm.ts`, `services/itcm-pdf.ts` moved from their current modules (or re-exported), re-gated to `support.manage_requests`
- `components/` for the forms, list, detail, comment thread, and the relocated `EpicRequestTabs`

Callers updated for the moved Epic services: `src/platform/people.ts` (offboard), `src/modules/volunteers/services/offboarding.ts`, and any tests.

## 6. Behavior

### 6.1 Submit (`/support/new`, everyone)

Category-conditional form:
- Common: category, subject, description, optional attachments.
- Epic: also `epicSubtype` (New / Modification / Renewal) and Epic intake fields (job title, Epic ID to mirror, start/end dates, works-at-YNHHS, government ID / NPI, NetID).
- Priority is not on the submit form (manager-set later).

On submit: create `TechRequest` (status SUBMITTED, requester = current person), persist any attachments, fire `support.ticket_submitted`.

### 6.2 My requests (`/support`, everyone)

List of the person's own tickets (number, subject, category, status badge, last updated), newest first. Detail view (`/support/[id]`) for the owner shows ticket fields, the PUBLIC conversation (reply plus attach), and the resolution once resolved. Owner can cancel while the ticket is open. INTERNAL notes are never returned to a non-manager.

### 6.3 All requests (`/support/all`, managers)

Master list with filters (status, category, priority, assignee) and search over number / requester name / subject; sort by created / updated / priority. Row links to the ticket detail.

### 6.4 Ticket detail, manager view

Everything the submitter sees plus the INTERNAL notes stream and controls: set status, set priority, assign to a manager, edit resolution, cancel or close. For Epic-category tickets, a "Create Epic request" action promotes the ticket: it creates an `EpicRequest` from the captured intake fields and links it via `epicRequestId`. Once linked, the existing Epic pipeline surfaces inline (generate YNHH PDF/Excel, set SR number, complete with `epicId`, send Epic emails). The linked `EpicRequest` / `YnhhTicket` status and SR number are displayed on the ticket.

### 6.5 Epic / YNHH tools (`/support/epic`, managers)

The relocated `EpicRequestTabs` (generate / tracker / history), the Epic queue actions, and pending deactivations (offboard-driven). Bulk YNHH generation lives here.

### 6.6 Status lifecycle

`SUBMITTED` -> `IN_PROGRESS` (assigned or picked up) -> `AWAITING_REQUESTER` (needs the submitter; notifies) or `AWAITING_YNHH` (Epic ticket sent to YNHH; SR number on the linked `YnhhTicket`) -> `RESOLVED` (resolution set; notifies) -> `CLOSED` (terminal). `CANCELLED` from any open state (submitter or manager). Completing the linked `EpicRequest` (an `epicId` is granted) prompts the manager to mark the ticket `RESOLVED`.

## 7. Notifications and email

New types added to `NOTIFICATION_TYPES` (each admin-routable to email / Teams / both), rendered via the editable template engine (precompute any lists as strings; no `{{#each}}`):

- `support.ticket_submitted`: confirmation to the submitter, and an alert to managers.
- `support.request_assigned`: to the assignee.
- `support.status_changed`: to the submitter (notably `AWAITING_REQUESTER`).
- `support.comment_added`: to the other side. A submitter PUBLIC comment notifies the assignee (or all managers if unassigned); a manager PUBLIC comment notifies the submitter; INTERNAL notes notify no one submitter-side.
- `support.request_resolved`: to the submitter, with the resolution.

`notify()` is per-person, so the manager fan-out resolves the holders of `support.manage_requests` (preferring the assignee once assigned) and notifies each. Existing `epic-onboarding` / `epic-activation` / `epic-password-reset` emails are unchanged for the Epic pipeline.

## 8. Testing and rollout

- Service unit tests (DB-backed, so CI is the gate per the shared-Prisma / worktree constraint): create and list; permission gating (submitter cannot read others' tickets; non-manager cannot reach the master list); comment-visibility (INTERNAL hidden from the submitter and from `support.comment_added`); Epic promotion links an `EpicRequest` and carries the intake fields; offboard still cancels and enqueues correctly after the Epic service move.
- Notification tests: each new type queues on the resolved channel; INTERNAL notes never notify the submitter; manager fan-out targets the right recipients.
- Playwright e2e: submit, appears in My requests, manager sees it in All requests, PUBLIC comment round-trip, resolve, submitter sees the resolution; Epic promotion path.
- Migration: additive tables and enums plus the RBAC grant backfill; verify with `prisma migrate status` before the Neon deploy (previews share the prod DB, so a branch behind a migration crashes P2021 at runtime).
- UI: reuse existing primitives; neutral status styling (Badge plus status dot, no tinted fills); no em-dashes in copy; "HAVEN Hub" as two words in prose.

## 9. Out of scope (this build)

- SLA timers, business-hours math, and overdue automation beyond what the Epic tracker already does.
- Public (unauthenticated) submission; submitters must be signed-in matched persons.
- Migrating historical Airtable tech-request rows (separate import task if desired).
- Generalizing `YnhhTicket` beyond Epic.

## 10. Open questions

None blocking. To confirm during planning: the exact lucide icon for the module, and whether `AWAITING_YNHH` should auto-set when a linked `EpicRequest` is batched into a `YnhhTicket` (proposed: yes, as a convenience, with manager override).
