# Plan 6: Volunteers Module Part 2 (Offboarding, Epic Requests, Disciplinary, Graph Email) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the last three director-facing people-ops workflows still in Airtable/updatemyinfo: two-step offboarding (directors flag, ops executes), an Epic account request queue with YNHH ticket batches, and a disciplinary actions log, plus the platform email layer (Microsoft Graph) that keeps the onboarding/activation/password-reset emails alive when Epic requests leave Airtable.

**Architecture:** Spec: `docs/superpowers/specs/2026-06-07-volunteers-part-2-design.md` (binding). Email lives in `src/platform/email/` behind a transport interface; EmailLog is itself the queue (status QUEUED/SENT/FAILED, drained by a worker cron, exactly like the mirror outbox). The three features are volunteers-module services + pages following plan 5's patterns: services trust callers but enforce directorship scoping internally (like `verifyCertificate`), permission gates live in pages/actions, every mutation audited.

**Tech stack:** Existing stack only, plus raw `fetch` against Microsoft Graph (client-credentials token + `/users/{sender}/sendMail`). No new dependencies.

**Decisions from Jack (binding):**
- Offboarding is two-step: directors flag (delegation-aware scope via `manageableDepartmentIds`), `volunteers.manage_offboarding` executes: `Person.status -> OFFBOARDED`, ALL the person's ACTIVE memberships (any term) -> REMOVED. Flags are internal; the Airtable "Check to offboard" checkbox is NOT mirrored.
- Epic intake is both-sided (member self-service in My Info + managers for anyone). Middle name, government ID, YNHHS status are dropped entirely. One open (PENDING/SUBMITTED) request per person, enforced at service level.
- Epic lifecycle: PENDING -> SUBMITTED (attached to a YnhhTicket) -> COMPLETED or CANCELLED. Completing NEW/MODIFY records the Epic ID onto Person.epicId (flows to Airtable via the existing person mirror). No legacy request import.
- Graph email ships now: shared mailbox, app-only credentials, template wording copied from the Airtable automations. `EMAIL_TRANSPORT` defaults to `log` so dev/CI never need credentials.
- Disciplinary: directors issue for their manageable departments; `volunteers.issue_disciplinary` issues/sees/deletes everything. Directors do NOT see confidential actions issued by someone else. Strike count = computed count of actions. No edit flow; delete (central only) + reissue.

**Conventions (binding):** no em-dashes; "HAVEN Hub" prose; UTC dates; audits on mutations; services trust callers; permission checks at page/action layer; TDD for services and platform code.

---

### Task 0: Branch + plan commit
- [ ] `git checkout -b plan-6/volunteers-part-2`; commit this doc and the spec if not already on the branch.

### Task 1: Schema (5 tables, 4 enums)
**Files:** `prisma/schema.prisma`, migration `volunteers-part2`, `src/platform/test/db.ts`.
- Add exactly the models/enums from spec section 3: `EpicRequestKind { NEW MODIFY RENEW }`, `EpicRequestStatus { PENDING SUBMITTED COMPLETED CANCELLED }`, `YnhhTicketStatus { OPEN CLOSED }`, `EmailStatus { QUEUED SENT FAILED }`; models `OffboardFlag` (`@@unique([personId, termId])`, person/term relations `onDelete: Cascade`, flaggedBy relation to Person), `EpicRequest` (`@@index([status])`, `@@index([personId])`, ticket relation optional, person relation `onDelete: Cascade`), `YnhhTicket` (requests relation), `DisciplinaryAction` (`@@index([personId])`, person relation `onDelete: Cascade`), `EmailLog` (`@@index([personId])`, `@@index([status, createdAt])`). EmailLog deviates from the spec sketch in three deliberate ways: `html String` is stored on the row (so the drain needs no template knowledge; the three Epic templates contain nothing beyond name/email, data the DB already holds), `attempts Int @default(0)` supports drain retries, and the spec's `error` column is named `lastError` to match Outbox.
- Person gains the back-relations Prisma requires (offboardFlags, offboardFlagsIssued, epicRequests, disciplinaryActions, etc.). Name them; do not let `prisma format` invent ambiguous ones. Multiple relations to Person need explicit `@relation("name")` pairs (e.g. `OffboardFlag.person` vs `OffboardFlag.flaggedBy`).
- `npx prisma migrate dev --name volunteers-part2`; INSPECT THE SQL: additive only (CREATE TYPE/TABLE/INDEX). Stop on any DROP/ALTER of existing objects.
- `resetDb()` TRUNCATE list gains `"OffboardFlag", "EpicRequest", "YnhhTicket", "DisciplinaryAction", "EmailLog"`.
- Run `npm run test:prepare` so the test DB picks up the migration, then `npm test` (all existing tests still green).
- Commit: `feat(volunteers): part 2 schema (offboard flags, epic requests, tickets, disciplinary, email log)`

### Task 2: Config + email transports (TDD)
**Files:** `src/platform/config.ts`, `src/platform/config.test.ts`, `src/platform/email/transport.ts`, `src/platform/email/transport.test.ts`.
- Config adds: `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`, `EMAIL_SENDER` (all optional strings) and `EMAIL_TRANSPORT: z.enum(["log", "graph"]).default("log")`. New `superRefine`: when `EMAIL_TRANSPORT === "graph"`, all four Graph/sender vars are required (same style as the mirror block). Tests: defaults to log with no vars; graph mode without vars lists each missing key; graph mode with all four passes.
- `transport.ts`:
```ts
export type EmailMessage = { to: string; subject: string; html: string };
export interface EmailTransport { send(message: EmailMessage): Promise<void> }
```
  - `LogTransport`: `send` logs `[email] to=<to> subject=<subject>` and resolves.
  - `GraphTransport(opts: { tenantId; clientId; clientSecret; sender })`: lazily fetches a client-credentials token from `https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token` (form-encoded, `scope=https://graph.microsoft.com/.default`), caches it until 60s before `expires_in`, then POSTs `https://graph.microsoft.com/v1.0/users/{sender}/sendMail` with `{ message: { subject, body: { contentType: "HTML", content: html }, toRecipients: [{ emailAddress: { address: to } }] }, saveToSentItems: true }`. Non-2xx throws `Error` with status + response text (the queue layer handles retries; the transport never retries).
  - `emailTransportFromConfig(config)`: returns GraphTransport when `EMAIL_TRANSPORT === "graph"`, else LogTransport.
- Transport tests stub `global.fetch` (vi.stubGlobal): token request shape, send request shape (URL contains sender, body matches), token reuse across two sends (one token call), non-2xx send throws, expired token refetches.
- Commit: `feat(email): config + log/graph transports`

### Task 3: Email queue + worker wiring (TDD)
**Files:** `src/platform/email/send.ts`, `src/platform/email/send.test.ts`, `worker/index.ts`.
- `send.ts` (EmailLog IS the queue, mirroring the outbox pattern):
```ts
export type QueueEmailInput = { to: string; subject: string; html: string; template: string; personId?: string | null; triggeredById?: string | null };
export async function queueEmail(db: Db, input: QueueEmailInput): Promise<EmailLog>; // Db = PrismaClient | TransactionClient, like enqueueMirror
export async function drainEmailQueue(transport: EmailTransport): Promise<number>;   // returns processed count
```
  - `queueEmail` inserts the row with status QUEUED including the rendered `html` (stored on the row per Task 1, so the drain needs no template knowledge).
  - `drainEmailQueue`: fetch QUEUED rows oldest-first (limit 25 per pass), for each call `transport.send`; success -> status SENT + sentAt; failure -> attempts+1, lastError, status stays QUEUED until `attempts >= 8` then FAILED (constants and shape copied from `drainOutbox`).
- Tests (integration, resetDb): queueEmail inside a `prisma.$transaction` that throws leaves no row; drain marks SENT with a stub transport; failing transport increments attempts and keeps QUEUED; 8th failure marks FAILED with lastError; drained count correct; SENT/FAILED rows never re-sent.
- Worker: `EMAIL_QUEUE = "email-send"`, createQueue + `boss.schedule(EMAIL_QUEUE, "* * * * *")`, handler builds the transport once via `emailTransportFromConfig(config)` and loops `drainEmailQueue` until 0, same shape as the outbox handler.
- Commit: `feat(email): queued sends drained by the worker`

### Task 4: Email templates (controller step + code)
**Files:** `src/platform/email/templates/epic.ts`, `src/platform/email/templates/epic.test.ts`.
- **Controller step (Jack):** capture the wording of the three Airtable automation emails (onboarding, activation, password reset). Airtable's API does not expose automations; Jack either pastes the texts into the session or screenshares the automation config. THE IMPLEMENTER MUST STOP AND ASK if the texts have not been provided; do not invent wording silently. If Jack approves placeholder wording, mark each template with a `// TODO(jack): confirm wording against Airtable automation` comment and list them in the PR description.
- `epic.ts`: three pure functions, each `(p: { personName: string }) => { subject: string; html: string }`: `epicOnboardingEmail`, `epicActivationEmail`, `epicPasswordResetEmail`. Export `EPIC_TEMPLATES = { "epic-onboarding": epicOnboardingEmail, "epic-activation": epicActivationEmail, "epic-password-reset": epicPasswordResetEmail } as const; export type EpicTemplateKey = keyof typeof EPIC_TEMPLATES;`. HTML is simple paragraphs; no external assets; "HAVEN Hub"/clinic naming per conventions; no em-dashes in template text.
- Tests: each returns non-empty subject/html containing the person's name; the keys of EPIC_TEMPLATES are exactly the three.
- Commit: `feat(email): epic notification templates`

### Task 5: Offboarding service (TDD) + page + nav
**Files:** `src/modules/volunteers/services/offboarding.ts`, `offboarding.test.ts`, `src/app/volunteers/offboarding/page.tsx`, `src/platform/modules/registry.ts`.
- Service (imports `can`, `manageableDepartmentIds`, `setPersonStatusField`, `recordAudit`; typed errors `OffboardForbiddenError`, `OffboardNotFoundError`):
```ts
export async function flagForOffboarding(actorPersonId: string, personId: string, note?: string): Promise<OffboardFlag>;
export async function unflag(actorPersonId: string, personId: string): Promise<void>;
export async function executeOffboard(actorPersonId: string, personId: string): Promise<void>;
export async function offboardingView(viewerPersonId: string): Promise<{ departments: DepartmentOffboarding[]; flagged: FlaggedRow[] | null }>;
```
  - `flagForOffboarding` / `unflag` scope: allowed when `can(actor, "volunteers.manage_offboarding")` OR the target has an ACTIVE membership in the active term in one of the actor's `manageableDepartmentIds`. Flag is upsert-safe on `(personId, activeTerm.id)` (double-flag returns the existing row, no duplicate audit). No active term -> `OffboardForbiddenError`. Audits `offboard.flag` / `offboard.unflag` with the note.
  - `executeOffboard` requires `can(actor, "volunteers.manage_offboarding")` (service-side check, defense in depth; the action checks too). In one `prisma.$transaction`: set all the person's ACTIVE TermMemberships (ANY term) to REMOVED, delete all the person's OffboardFlag rows; then `setPersonStatusField(actor, personId, "OFFBOARDED")` (the shared mutation core in `src/platform/people.ts`; it already audits, read it before wiring) and audit `person.offboard` with `{ removedMemberships: n }`.
  - `offboardingView`: `departments` = same shape as compliance's department cards (dept + ACTIVE members of the active term with `flagged: OffboardFlag | null`), for the viewer's manageable departments; `flagged` = clinic-wide flag list (person, departments in active term, flaggedBy name, note, createdAt) when the viewer holds manage_offboarding, else null.
- Tests (resetDb fixtures like compliance.test.ts): director flags own-dept member; delegation edge (PCAR director flags SCTP member); director cannot flag other-dept member (Forbidden); manage_offboarding holder flags anyone; double-flag idempotent; unflag deletes; execute requires permission; execute flips status + REMOVES all ACTIVE memberships across two terms + deletes flags + audits; view returns flagged=null without the permission.
- Page `/volunteers/offboarding`: layout already gates the module. Director cards: member rows with flag toggle (ConfirmButton) + optional note input on flag. Executor section (rendered when `flagged !== null`): table with person, departments, flagged by/at, note, Unflag button, Offboard ConfirmButton ("Offboard <name>? This removes all their active memberships."). Server actions re-check scope/permission and `revalidatePath`. Empty states: "No departments to review." / "No one is flagged."
- Registry nav gains `{ label: "Offboarding", href: "/volunteers/offboarding" }`.
- Commit: `feat(volunteers): two-step offboarding workflow`

### Task 6: Epic service (TDD)
**Files:** `src/modules/volunteers/services/epic.ts`, `epic.test.ts`.
- Typed errors: `EpicForbiddenError`, `EpicNotFoundError`, `EpicStateError` (illegal transition / duplicate open request / missing epicId on complete).
```ts
export type EpicRequestInput = { personId: string; kind: EpicRequestKind; jobTitle?: string | null; mirrorEpicId?: string | null; notes?: string | null };
export async function createEpicRequest(actorPersonId: string, input: EpicRequestInput): Promise<EpicRequest>;
export async function myEpicPanel(personId: string): Promise<{ epicId: string | null; openRequest: EpicRequest | null }>;
export async function listEpicRequests(q: { status?: EpicRequestStatus; page?: number }): Promise<{ rows: EpicRequestRow[]; total: number; counts: Record<EpicRequestStatus, number> }>;
export async function createTicket(actorPersonId: string, input: { requestIds: string[]; description?: string | null }): Promise<YnhhTicket>;
export async function setTicketServiceRequestNumber(actorPersonId: string, ticketId: string, srNumber: string): Promise<void>;
export async function closeTicket(actorPersonId: string, ticketId: string): Promise<void>;
export async function listTickets(): Promise<TicketRow[]>; // open first, with request counts and business-day age computed in the page from submittedAt
export async function completeRequest(actorPersonId: string, requestId: string, epicId?: string): Promise<void>;
export async function cancelRequest(actorPersonId: string, requestId: string, reason: string): Promise<void>;
export async function sendEpicEmail(actorPersonId: string, requestId: string, template: EpicTemplateKey): Promise<void>;
export async function emailHistory(personIds: string[]): Promise<Map<string, EmailLog[]>>; // keyed by personId, rows whose template is in EPIC_TEMPLATES only
```
  - `createEpicRequest` scope: self (`actorPersonId === input.personId`) or `can(actor, "volunteers.manage_epic")`. Person must be ACTIVE. Rejects when an open (PENDING or SUBMITTED) request exists for the person (`EpicStateError`). Kind sanity: NEW requires the person has no epicId; MODIFY/RENEW require one (EpicStateError otherwise). Audit `epic.request`.
  - All other mutations require `can(actor, "volunteers.manage_epic")` service-side.
  - `createTicket`: all ids must be PENDING (else EpicStateError); transaction creates the ticket and sets `ticketId` + status SUBMITTED on each. Audit `epic.ticket_create` with requestIds.
  - `completeRequest`: request must be PENDING or SUBMITTED. NEW/MODIFY require `epicId` argument; writes it via `updatePersonFields(actor, personId, { epicId })` (audits + enqueues the person mirror). RENEW ignores any provided epicId. Sets status COMPLETED + completedAt. Audit `epic.complete`.
  - `cancelRequest`: PENDING or SUBMITTED only; appends `"\nCancelled: <reason>"` to notes; status CANCELLED. Audit `epic.cancel`.
  - `sendEpicEmail`: loads request + person; `EpicStateError` when the person has no contactEmail; renders `EPIC_TEMPLATES[template]({ personName })` and `queueEmail(prisma, { to, subject, html, template, personId, triggeredById: actor })`. Audit `epic.email` with the template key.
- Tests: self-create NEW happy path; volunteer cannot create for someone else; manager creates for anyone; duplicate-open rejected; NEW-with-epicId and RENEW-without-epicId rejected; ticket groups only PENDING and flips to SUBMITTED; complete NEW writes Person.epicId AND an Outbox row exists with changedFields containing "epicId"; complete RENEW leaves epicId untouched; cancel appends reason; sendEpicEmail creates a QUEUED EmailLog row with the right template/to; permission boundaries on every manager-only function; counts/pagination of listEpicRequests.
- Commit: `feat(volunteers): epic request service`

### Task 7: Epic pages (queue + My Info panel)
**Files:** `src/app/volunteers/epic/page.tsx`, `src/modules/my-info/components/epic-panel.tsx`, `src/app/my-info/page.tsx`, `src/platform/modules/registry.ts`.
- `/volunteers/epic`: `requirePermission("volunteers.manage_epic")` at the page (layout gates module access). Sections:
  - Summary counts per status (stat cards like /volunteers/master).
  - Request table filtered by `?status=` (default PENDING): person (name, NetID, contactEmail), kind Badge, status Badge (PENDING default / SUBMITTED warning / COMPLETED success / CANCELLED critical), jobTitle, mirrorEpicId, ticket SR#, requested at (UTC), actions: checkbox for ticket selection (PENDING rows), Complete (inline epicId input for NEW/MODIFY; plain ConfirmButton for RENEW), Cancel (reason input), three send buttons (Onboarding / Activation / PW reset) with last-sent status from `emailHistory` rendered under them ("Activation sent Jun 7" / "queued" / "failed").
  - "Submit to YNHH" form above the PENDING table: selected request ids + optional description -> `createTicket`.
  - New request form (person search via existing admin searchPeople pattern or a simple email/netId input + lookup; kind select; jobTitle; mirrorEpicId; notes) -> `createEpicRequest`.
  - Ticket table: SR# (inline edit form -> `setTicketServiceRequestNumber`), description, submitted at, business-day age (computed UTC, weekends excluded), request count, status, Close button.
  - Server actions wrap typed errors into `?error=` like plan 5 pages.
- My Info: `epic-panel.tsx` renders current Epic ID (read-only, "Managed by the IT team."), open request status line when present ("NEW request pending since <date>" / "submitted to YNHH"), else the lean self-service form (kind constrained by whether epicId exists: NEW when absent, MODIFY/RENEW select when present; jobTitle, mirrorEpicId, notes optional) posting to a server action calling `createEpicRequest(session.personId, { personId: session.personId, ... })`. Surface EpicStateError messages inline.
- Registry nav gains `{ label: "Epic requests", href: "/volunteers/epic" }`.
- e2e is deferred to Task 10 (one round-trip test).
- Commit: `feat(volunteers): epic queue page + my-info request panel`

### Task 8: Disciplinary service (TDD) + page
**Files:** `src/modules/volunteers/services/disciplinary.ts`, `disciplinary.test.ts`, `src/app/volunteers/disciplinary/page.tsx`, `src/platform/modules/registry.ts`.
- Constants: `export const DISCIPLINARY_CATEGORIES = ["Attendance", "Professionalism", "Privacy & HIPAA Violations", "Patient Safety", "Other"] as const;` (stored as text; the form constrains, the service validates membership).
- Typed errors `DisciplinaryForbiddenError`, `DisciplinaryNotFoundError`.
```ts
export type DisciplinaryInput = { personId: string; occurredAt: Date; category: string; description: string; followUpActions?: string | null; policyReference?: string | null; notes?: string | null; confidential?: boolean; patientInvolved?: boolean };
export async function issueAction(actorPersonId: string, input: DisciplinaryInput): Promise<DisciplinaryAction>;
export async function deleteAction(actorPersonId: string, id: string): Promise<void>;
export async function listActions(viewerPersonId: string, q: { departmentId?: string; q?: string; category?: string; page?: number }): Promise<{ rows: ActionRow[]; total: number; canIssueForAll: boolean; issuablePersonIds: string[] | "ALL" }>;
export async function strikeCount(personId: string): Promise<number>;
```
  - `issueAction` scope: `can(actor, "volunteers.issue_disciplinary")` OR target has an ACTIVE membership in the active term in the actor's `manageableDepartmentIds`. Validates category membership, non-empty description, occurredAt not in the future. Audit `disciplinary.issue`.
  - `listActions` visibility: central (`issue_disciplinary`) sees all. Otherwise viewer must direct something (else Forbidden -> page shows nothing); rows limited to people with ACTIVE membership in the viewer's manageable departments AND (not confidential OR issuedById = viewer). Each row includes person name, issuedBy name, strike count for the person (single grouped count query, no N+1).
  - `deleteAction`: central only. Audit `disciplinary.delete` with the full row in `before`.
- Tests: director issues for own dept + delegation edge; director blocked cross-dept; central issues for anyone; category/description/future-date validation; visibility matrix (central sees confidential; issuing director sees own confidential; other director of same dept does NOT; director of other dept sees nothing); delete central-only + audited; strike counts grouped correctly.
- Page `/volunteers/disciplinary`: issue form (person picker scoped: directors get a select of their departments' ACTIVE members, central gets the search input; category select; date; description textarea; optional fields; confidential + patientInvolved checkboxes), filter bar (department select, search, category select), table (date UTC, person, category, description truncated with title attr, issued by, confidential Badge, patient-involved Badge, strikes count, Delete ConfirmButton for central). Server actions re-check via the service's typed errors -> `?error=`.
- Registry nav gains `{ label: "Disciplinary", href: "/volunteers/disciplinary" }`.
- Commit: `feat(volunteers): disciplinary actions log`

### Task 9: Seed role
**Files:** `prisma/seed.ts`.
- SYSTEM_ROLES gains `{ name: "Volunteer Operations Manager", description: "Offboarding, Epic requests, and disciplinary across the clinic", grants: ["volunteers.view", "volunteers.manage_offboarding", "volunteers.manage_epic", "volunteers.issue_disciplinary"] }`.
- Replicate the Compliance Manager GLOBAL assignment block for the new role (EXEC, SRR, ITCM; skip silently when a code is absent). Extract a small `assignGlobalToDepartments(roleName, codes)` helper and use it for BOTH roles instead of duplicating the block.
- Run `npm run db:seed` in dev; verify with a quick psql query that the role and 3 assignments exist.
- Commit: `feat(volunteers): volunteer operations manager role`

### Task 10: e2e + final verification + PR
**Files:** `e2e/volunteers.spec.ts` (extend).
- New e2e tests (dev login pattern from the existing spec):
  1. Offboarding: Jack opens /volunteers/offboarding, sees the ITCM card, flags a seeded dev volunteer, sees them in the flagged table, executes, and the row disappears (person now OFFBOARDED; dev.volunteer login then bounces to /welcome if that fixture was used: PICK a seeded person that no other e2e test logs in as, or re-activate via the admin page at the end of the test).
  2. Epic: Jack opens /volunteers/epic, creates a NEW request for a seeded person without an epicId, submits it to a ticket, completes it with epicId "E2E123", and the status badge shows Completed.
  3. Disciplinary: Jack issues a non-confidential action for an ITCM member and sees it in the table with a strike count of 1.
- Full gauntlet (kill dev servers first): `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run e2e` (19 existing + 3 new).
- Manual Graph verification (controller step, requires Entra app registration with Mail.Send + shared mailbox): set the four Graph vars + `EMAIL_TRANSPORT=graph` locally, queue one activation email to Jack's address through the UI, run the worker, confirm receipt. If the app registration is not ready, note it in the PR and ship on LogTransport (the queue keeps rows QUEUED-compatible: nothing breaks).
- Screenshots: /volunteers/offboarding, /volunteers/epic, /volunteers/disciplinary, My Info epic panel -> /tmp/havenhub-shots/.
- Push, PR (summary: the three workflows, the email layer, role seeding, template provenance), watch CI green.

## Deferred deliberately (spec section 11)
- Disciplinary attachments; member-facing disciplinary visibility; automated strike consequences
- Compliance reminder emails (email layer now exists; small follow-up)
- Retiring the legacy Airtable Epic tables/automations (manual cleanup after FA 26 proves the flow)
