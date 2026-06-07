# Volunteers Module Part 2: Offboarding, Epic Requests, Disciplinary

**Date:** 2026-06-07
**Status:** Approved design, pre-implementation
**Builds on:** Plan 5 (compliance dashboards, department delegation, status mirror)

## 1. Goal

Replace the last three director-facing people-ops workflows still living in Airtable and the legacy updatemyinfo app:

1. **Offboarding/verification** (updatemyinfo `/verify` + the "Check to offboard" checkbox on All People)
2. **Epic account requests** (six Airtable form tables: Volunteer Epic New Account / Modify / Renew and the three Director variants, plus the YNHH Ticket Tracker)
3. **Disciplinary actions** (the Disciplinary Actions table; effectively greenfield, it holds 2 test records)

Plan 6 also builds the platform email layer (Microsoft Graph) because the legacy Epic tables triggered Airtable email automations (onboarding, activation, password reset) that must keep working when requests move in-platform.

## 2. Binding decisions (from Jack)

- All three features ship in one plan.
- **Offboarding is two-step:** directors flag members of their departments; people with `volunteers.manage_offboarding` review the flagged list and execute. Executing sets `Person.status = OFFBOARDED` and all ACTIVE memberships to REMOVED.
- Offboard flags are internal only. The Airtable "Check to offboard" checkbox is NOT mirrored.
- **Epic intake is both-sided:** members self-submit (My Info panel) and managers submit for anyone. Middle name, government ID, and YNHHS employment status are dropped entirely; YNHH accepts blanks for them.
- **Epic processing is a queue with ticket batches:** PENDING -> SUBMITTED (attached to a YnhhTicket with an SR#) -> COMPLETED or CANCELLED. The YnhhTicket entity replaces the YNHH Ticket Tracker table.
- **Graph email ships now**, sending from a shared clinic mailbox via app-only credentials. Template wording is copied from the existing Airtable automations.
- **Disciplinary:** directors issue for their own departments (delegation-aware); `volunteers.issue_disciplinary` issues and sees everything.
- **No legacy Epic data import.** The ~284 SU 26 request rows stay in Airtable for reference; HAVEN Hub handles requests going forward.

**Conventions (binding):** no em-dashes; "HAVEN Hub" in prose; UTC dates; audits on mutations; services trust callers; permission checks at the page/action layer.

## 3. Data model

Five new tables. No changes to existing tables.

```prisma
enum EpicRequestKind   { NEW MODIFY RENEW }
enum EpicRequestStatus { PENDING SUBMITTED COMPLETED CANCELLED }
enum YnhhTicketStatus  { OPEN CLOSED }
enum EmailStatus       { QUEUED SENT FAILED }

model OffboardFlag {
  id          String   @id @default(cuid())
  personId    String
  termId      String
  flaggedById String
  note        String?
  createdAt   DateTime @default(now())
  // relations: person, term (onDelete: Cascade), flaggedBy
  @@unique([personId, termId]) // one flag per person per term
}

model EpicRequest {
  id            String            @id @default(cuid())
  personId      String
  kind          EpicRequestKind
  status        EpicRequestStatus @default(PENDING)
  jobTitle      String?
  mirrorEpicId  String?  // "Epic ID to Mirror": existing account to copy access from
  notes         String?
  requestedById String   // self-service: equals personId
  ticketId      String?  // set when attached to a YnhhTicket
  completedAt   DateTime?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  @@index([status])
  @@index([personId])
}

model YnhhTicket {
  id                   String           @id @default(cuid())
  serviceRequestNumber String?  // recorded after YNHH replies
  description          String?
  status               YnhhTicketStatus @default(OPEN)
  submittedById        String
  submittedAt          DateTime @default(now())
  closedAt             DateTime?
  requests             EpicRequest[]
}

model DisciplinaryAction {
  id              String   @id @default(cuid())
  personId        String
  issuedById      String
  occurredAt      DateTime
  category        String   // UI offers a fixed list; stored as text so the list can evolve without migrations
  description     String
  followUpActions String?
  policyReference String?
  notes           String?
  confidential    Boolean  @default(false)
  patientInvolved Boolean  @default(false)
  createdAt       DateTime @default(now())
  @@index([personId])
}

model EmailLog {
  id            String      @id @default(cuid())
  toEmail       String
  subject       String
  template      String      // e.g. "epic-activation"
  personId      String?
  triggeredById String?
  status        EmailStatus @default(QUEUED)
  error         String?
  sentAt        DateTime?
  createdAt     DateTime @default(now())
  @@index([personId])
  @@index([status, createdAt])
}
```

Design notes:
- **Strike count is computed** (count of DisciplinaryAction rows per person), never stored. Same philosophy as compliance status.
- **One open request per person:** the service rejects a new EpicRequest when the person already has one in PENDING or SUBMITTED. Service-level rule, not a DB constraint.
- **Flag rows are transient:** unflagging or executing an offboard deletes the row. History lives in the audit log (`offboard.flag`, `offboard.unflag`, `person.offboard`).

## 4. Offboarding

Page: `/volunteers/offboarding` behind `requireModuleAccess("volunteers")`.

**Director view** (ACTIVE DIRECTOR membership in the active term; delegation one-hop via `manageableDepartmentIds`, same as compliance): department cards listing ACTIVE members (both kinds) with a flag toggle and optional note. Flagging creates an OffboardFlag for (person, active term); unflagging deletes it. Both audited.

**Executor view** (`volunteers.manage_offboarding`): a clinic-wide "Flagged for offboarding" table: person, department(s), flagged by, flagged at, note, with per-row actions:
- **Offboard** (ConfirmButton): sets `Person.status = OFFBOARDED`, sets all the person's ACTIVE TermMemberships (any term) to REMOVED, deletes the person's flag rows, audits `person.offboard`.
- **Unflag**: deletes the flag without acting (audited).

No mirrored person fields change on offboard, so no outbox row is written. Any HIPAA-status consequence of losing the membership is picked up by the nightly compliance refresh. Reinstating a person stays in Admin (people page edits status).

## 5. Epic requests

### Intake

- **My Info** gains an Epic panel: current Epic ID (read-only here; IT-managed), the open request's status if any, and a lean self-service form. Kind is NEW when the person has no `epicId` on file, else a MODIFY/RENEW choice. Fields: kind, jobTitle (optional), mirrorEpicId (optional), notes (optional).
- **Managers** (`volunteers.manage_epic`) create requests for any person from the queue page via person search, same form.

### Queue (`/volunteers/epic`, requires `volunteers.manage_epic`)

- Request table filtered by status with per-status counts. Row: person (name, NetID, email), kind, status, ticket SR#, requested by/at, send-history.
- **Submit to YNHH:** select PENDING requests, create a YnhhTicket (optional description); selected requests get `ticketId` and flip to SUBMITTED. The SR# is recorded on the ticket when YNHH replies (editable field). Audited.
- **Complete:** NEW and MODIFY prompt for the Epic ID, which writes `Person.epicId` through the existing people service (audited; flows to Airtable via the existing person mirror outbox). RENEW completes without prompting. Sets `completedAt`. Audited `epic.complete`.
- **Cancel** with a reason (appended to `notes`, audited `epic.cancel`).
- **Ticket list:** open and closed tickets with submission date, business-day age, SR#, request count; close ticket action. Replaces the YNHH Ticket Tracker.
- **Email buttons** per request: Send onboarding / Send activation / Send PW reset. Each queues a templated email to the person's contactEmail and the row shows send history from EmailLog.

## 6. Email layer (`src/platform/email/`)

- **`transport.ts`:** `EmailTransport` interface (`send(message): Promise<void>`) with two implementations:
  - **GraphTransport:** client-credentials flow against the clinic's Entra tenant; sends via `POST /users/{EMAIL_SENDER}/sendMail`. Token cached until expiry. Retries are the queue's job, not the transport's.
  - **LogTransport:** logs the message and succeeds. Default everywhere credentials are absent (dev, CI).
- **`send.ts`:** `queueEmail({ to, subject, html, template, personId?, triggeredById? })` inserts an EmailLog row and a pg-boss job in one transaction. The worker job loads the row, sends via the configured transport, stamps SENT or FAILED with the error. pg-boss retry with backoff applies before FAILED is final.
- **Templates** (`src/platform/email/templates/`): typed functions returning `{ subject, html }` for `epic-onboarding`, `epic-activation`, `epic-password-reset`. Wording copied from the Airtable automations. Airtable's API does not expose automation configs, so the plan includes a controller step to capture the three template texts (browser session or paste).
- **Config:** `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`, `EMAIL_SENDER` (shared mailbox), `EMAIL_TRANSPORT` (`graph` | `log`, default `log`). Config validation requires the Graph variables only when `EMAIL_TRANSPORT=graph`.

## 7. Disciplinary

Page: `/volunteers/disciplinary` behind `requireModuleAccess("volunteers")`.

- **Issue rights:** directors for people with an ACTIVE membership in a department they direct (delegation-aware via `manageableDepartmentIds`); anyone with `volunteers.issue_disciplinary` for any person.
- **Visibility:** central (`volunteers.issue_disciplinary`) sees all actions. Directors see actions for their departments' members EXCEPT confidential actions issued by someone else. Members see nothing in-app for now.
- **Issue form:** person (picker scoped to the issuer's reach), occurredAt (date), category (UI list: Attendance, Professionalism, Privacy & HIPAA Violations, Patient Safety, Other), description (required), followUpActions, policyReference, notes, confidential, patientInvolved. Audited `disciplinary.issue`.
- **List:** filterable by department, person search, category; shows per-person strike counts.
- **Delete:** central only, audited `disciplinary.delete`, for mistaken entries. No edit flow; delete and reissue.
- **Deferred:** attachments (upload infra exists if wanted later); member-facing visibility; automated strike consequences.

## 8. Roles, nav, permissions

- New system role **Volunteer Operations Manager** granting `volunteers.view`, `volunteers.manage_offboarding`, `volunteers.manage_epic`, `volunteers.issue_disciplinary`. Seeded with GLOBAL department assignments to EXEC, SRR, ITCM (skip silently if a code is absent), same pattern as Compliance Manager.
- The three permissions already exist in the module registry (declared in plan 1); no registry permission changes.
- Registry nav becomes: Compliance, Master view, Offboarding, Epic requests, Disciplinary.
- Directors need no new permissions: flagging and issuing are scoped by directorship, like compliance verification.

## 9. Architecture placement

- `src/platform/email/` - transport, queue, templates (platform: future modules will send mail).
- `src/modules/volunteers/services/offboarding.ts`, `epic.ts`, `disciplinary.ts` - module services, TDD, trusting callers.
- Pages under `src/app/volunteers/` with server actions colocated per existing module conventions.
- Worker gains the `email-send` queue alongside the mirror drain and compliance refresh.

## 10. Testing

- **Unit/integration (TDD):**
  - Offboarding: flag, unflag, double-flag idempotence, execute (status + memberships + flag cleanup), director scoping incl. delegation, executor permission boundary.
  - Epic: lifecycle transitions (legal and illegal), one-open-request rule, ticket grouping, completion writes epicId + outbox row, cancel.
  - Disciplinary: issue scoping (director own dept, delegation, central), visibility matrix (confidential x issuer x viewer), delete rights.
  - Email: queueEmail transactionality, worker job stamps SENT/FAILED, LogTransport in tests, config validation per transport.
- **e2e (~3 new):** offboard flag + execute on a seeded person; epic request round trip (create, ticket, complete); disciplinary issue + director visibility.
- **Manual:** one real Graph send to Jack before the PR; CI runs credential-free on LogTransport.

## 11. Deferred deliberately

- Disciplinary attachments
- Member-facing disciplinary visibility and appeal flow
- Automated strike thresholds/consequences
- Compliance reminder emails (the email layer now exists; wiring reminders is a small follow-up)
- Retiring the legacy Airtable Epic tables and automations (manual cleanup after FA 26 proves the new flow)
