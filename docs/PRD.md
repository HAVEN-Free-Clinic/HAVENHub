# HAVEN Hub: Product Requirements Document

**Status:** Canonical product spec (describes the product as built)
**Version baseline:** v1.0.0 (initial public release, 2026-06-12)
**Audience:** Engineers and contributors
**Last updated:** 2026-06-29

> This is a retrospective PRD. It documents what HAVEN Hub is and how it
> behaves today, so a new contributor can understand the product, its users,
> its scope, and the requirements each module satisfies without reading the
> whole codebase first. Where a requirement maps to a specific part of the
> code, the relevant module or platform service is named so you can find it.

---

## 1. Overview

HAVEN Hub is the volunteer and clinic operations platform for the HAVEN Free
Clinic, a student-run free clinic in the Yale ecosystem. It covers the full
volunteer lifecycle (recruitment, onboarding, scheduling, compliance, training,
and day-to-day operations) behind role-based access control, with Yale-tenant
single sign-on, an auditable record of changes, and an administrator-configurable
surface so clinic leadership can run the platform without code changes.

The product is a single Next.js application (App Router, React 19) backed by
PostgreSQL through Prisma, deployed on Vercel. It replaces a sprawl of Airtable
bases, spreadsheets, and manual processes with one system of record for people,
terms, departments, schedules, and compliance.

At the baseline release it is roughly 69k lines of TypeScript across nine
feature modules and a shared platform layer, with 47 Prisma models and 150+ test
files.

---

## 2. Problem and background

The HAVEN Free Clinic runs on student volunteers and directors organized into
clinical and operational departments, recruited and onboarded each academic
term. Before HAVEN Hub the clinic coordinated this work across:

- Airtable bases for people, rosters, and schedules.
- Spreadsheets and email threads for recruitment and interviews.
- Manual tracking of HIPAA certification and training completion.
- Ad hoc handling of Epic (electronic health record) access requests to the
  hospital partner (Yale New Haven Health, YNHH).

That approach had recurring failure modes the platform is built to remove:

- **No single source of truth.** The same person existed in several places with
  no reconciliation, so rosters drifted.
- **Compliance was invisible until it failed.** HIPAA expiry and missing
  training were discovered late, sometimes at the clinic door.
- **Access was all-or-nothing.** There was no fine-grained way to let a
  recruitment lead manage applications without also handing them everything
  else.
- **No audit trail.** Changes to people, roles, and compliance had no record of
  who did what.

HAVEN Hub consolidates these into one record-of-truth with permissions, an audit
log, and automated compliance computation, while preserving a one-way import
path from the legacy Airtable base during the transition.

---

## 3. Goals and non-goals

### Goals

- Be the single system of record for people, terms, departments, memberships,
  schedules, and compliance.
- Cover the volunteer lifecycle end to end: apply, interview, accept, onboard,
  clear, schedule, train, operate, offboard.
- Enforce least-privilege access with permissions scoped to the whole platform,
  a term, a department, or a single person.
- Make compliance (HIPAA and training) continuously computed and visible, not
  manually tracked.
- Keep an auditable history of consequential changes.
- Let clinic administrators configure branding, operational settings, terms,
  departments, roles, email content, and feature behavior without code changes.
- Integrate with the tools the clinic already uses: Microsoft 365 (sign-in,
  email, Teams), Airtable (import), and the hospital Epic/YNHH access process.

### Non-goals

- **HAVEN Hub is not an electronic health record.** It deliberately holds
  minimal patient health information. Patient-facing artifacts (such as the
  After Visit Summary) are generated client-side and are not persisted.
- It is not a general-purpose CRM, LMS, or HR system. Training delivery is
  scoped to SCORM packages the clinic authors; it is not a course-authoring
  tool.
- It is not multi-tenant. It serves one clinic, though most clinic-specific
  values are configurable rather than hardcoded.
- It does not replace Microsoft Teams or email as communication channels. It
  links to and sends through them.

---

## 4. Users, roles, and personas

HAVEN Hub serves both authenticated members (volunteers and staff) and
unauthenticated applicants. Capabilities are not tied to a fixed job title;
they come from permissions granted to a person, so the personas below describe
typical permission bundles rather than rigid roles.

| Persona | Description | Typical capabilities |
| --- | --- | --- |
| **Applicant** | A prospective volunteer or director, unauthenticated, interacting through the public application portal and the token onboarding link. | Submit an application to an open cycle; resume a draft; complete an onboarding contract. |
| **Volunteer** | An active member assigned to one or more departments for a term. | View and manage their own profile, schedule, training, and HIPAA status; request swaps and drops; complete assigned learning. |
| **Director** | A member who leads a department for a term. | Everything a volunteer can do, plus build and edit the schedule for their department, record training attendance, and view team compliance. |
| **Compliance manager** | A member responsible for HIPAA and training clearance. | Verify HIPAA certificates, set and backfill completion dates, view the compliance roster, run reminders and escalations. |
| **Recruiter / recruitment lead** | A member running a recruitment cycle. | Manage cycles and the application form, review applications, run interviews, make decisions, send acceptance and onboarding links. |
| **Platform administrator** | A member with the wildcard permission. | Everything: people, terms, departments, roles, settings, branding, email, sync, Epic/ITCM. |
| **Attending physician** | A procedure-qualified attending on the attendings roster. | Surfaced in scheduling for procedure coverage; not necessarily a full platform user. |

### Roles and the RBAC scope model

Permissions are strings in a `module.action` namespace (for example
`schedule.edit_own_dept`, `volunteers.manage_compliance`,
`recruitment.review_all`, `admin.manage_roles`). A wildcard `*` grants
everything and backs the **Platform Admin** system role.

A **Role** is a named bundle of permission grants. System roles ship seeded and
cannot be deleted: Platform Admin (`*`), Director, Volunteer (`schedule.view`),
and Recruiter. The canonical seed list lives in the RBAC layer
(`src/platform/rbac`), and production grant changes require a backfill migration
because deploys run `prisma migrate deploy` but not the seed.

A **RoleAssignment** binds a person to a role within a **scope**. Scope is the
key idea: the same role means different reach depending on where it is granted.

- **Global** scope: applies everywhere.
- **Term** scope: applies within one academic term.
- **Department** scope: applies within one department (and, through delegation,
  to departments that department manages).
- **Person** scope: applies to a single person.
- **Cohort (kind) target:** an assignment can target everyone of a membership
  kind (all volunteers or all directors) in a term, so an administrator can, for
  example, grant a permission to every director for a term in one action.

The RBAC engine (`src/platform/rbac/engine.ts`) resolves an effective permission
set for the signed-in person against the scope of the thing being acted on.
Navigation and sub-navigation are filtered by the same permissions, so members
only see the modules and tabs they can use; denied deep links land on
`/no-access`.

---

## 5. System architecture

### 5.1 Stack

- **Framework:** Next.js 16 (App Router) on React 19, TypeScript throughout.
- **Data:** PostgreSQL via Prisma 6. Neon in production (pooled `DATABASE_URL`
  plus an unpooled `DATABASE_URL_UNPOOLED` that `prisma migrate` needs for its
  advisory lock). A Docker Compose Postgres is used locally.
- **Auth:** Auth.js / next-auth v5 with Microsoft Entra ID (Yale tenant) SSO;
  developer and demo credential login for non-production, gated by `DEMO_MODE`.
- **Styling:** Tailwind CSS v4 with the HAVEN Hub design system and a semantic
  light/dark token layer.
- **Storage:** Vercel Blob for SCORM packages and uploaded files; branded asset
  serving for logo and favicon.
- **Background work:** scheduled HTTP cron endpoints (see Section 11).
- **Testing:** Vitest for unit and integration tests; Playwright for end-to-end.
- **Hosting:** Vercel, region `iad1`, with migrate-on-deploy
  (`prisma migrate deploy && next build`).

### 5.2 Code layout

The source tree separates routing, feature logic, and shared services:

```
src/
  app/        Next.js routes (App Router): pages, layouts, API routes
  modules/    Feature modules, each with components/ services/ engine/
  platform/   Cross-cutting services shared by all modules
  proxy.ts    Request proxy / middleware entry (Next 16 proxy)
```

- **`src/app`** holds the route tree. The authenticated app lives under the
  `(app)` route group, which owns the shared shell (toolbar, navigation, bell).
  Unauthenticated and gate routes live at the top level: `/login`,
  `/apply/[slug]` (public application portal), `/onboard/[token]` (token
  onboarding), `/get-started` (clearance gate), `/welcome`. API routes live
  under `/app/api` (auth, cron, branding asset serving, learning blob upload,
  ITCM generation, GitBook docs gateway, health).

- **`src/modules`** holds the nine feature modules: `admin`, `clinic`,
  `learning`, `my-info`, `onboarding`, `recruitment`, `schedule`, `volunteers`.
  Each module keeps its UI in `components/`, its server-side business logic in
  `services/`, and pure decision logic in `engine/` where it has one. Module
  code is responsible for calling `requirePermission` to gate its own actions.

- **`src/platform`** holds shared services that modules compose: `auth`, `rbac`,
  `compliance`, `email`, `notifications`, `teams`, `airtable`, `settings`,
  `terms`, `branding`, `quiz`, `ui` (shared primitives), plus standalone
  services like `people`, `departments`, `audit`, `dates`, `storage`, `db`,
  `cron`, and `spanish-review`.

### 5.3 Request and authorization flow

1. A request hits the Next proxy, then the route.
2. Authenticated routes resolve the session through the auth layer. Session and
   gate checks live in `requirePersonSession` (not the root layout), because App
   Router layouts do not re-render on soft navigation and would let a stale
   session through.
3. The route or service calls into a module service, which calls
   `requirePermission(...)` against the RBAC engine for the relevant scope.
4. Consequential writes record an entry in the audit log.

---

## 6. Data model

PostgreSQL through Prisma, 47 models. The core entities and how they relate:

### People, terms, departments, membership

- **Person** is the central record (status `ACTIVE` or `OFFBOARDED`, profile,
  Yale affiliation, NetID, Epic ID, Spanish fluency flags, licensed-RN status,
  theme preference).
- **Term** is an academic term (status `PLANNING`, `ACTIVE`, or `ARCHIVED`),
  holding the clinic calendar; exactly one term is active at a time.
- **Department** is a clinical or operational unit. **DepartmentDelegation**
  lets a manager department oversee managed departments. **Subcommittee** is a
  sub-grouping used in recruitment interest capture.
- **TermMembership** links a person to a department for a term, with a
  **MembershipKind** (`DIRECTOR` or `VOLUNTEER`) and **MembershipStatus**
  (`ACTIVE` or `REMOVED`). Rosters key off membership status, so offboarding both
  flips `Person.status` and removes active memberships in one converged path.

### Access control and audit

- **Role**, **RoleGrant** (a permission on a role), and **RoleAssignment**
  (a role granted to a person within a scope, optionally targeting a cohort
  kind) implement RBAC.
- **AuditLog** captures actor, action, affected entity, and before/after
  snapshots.

### Compliance and clearance

- **HipaaCertificate** stores an uploaded or imported certificate with a
  completion date, source (`UPLOAD` or `IMPORT`), and extraction provenance
  (`PARSED`, `MANUAL`, `AIRTABLE`, `NONE`).
- **ComplianceReminder** records reminder sends for deduplication and
  escalation.
- **DisciplinaryAction** records category, severity, follow-up, and issuer.
- **OffboardFlag** marks a person for offboarding at term end.

### Recruitment and onboarding

- **RecruitmentCycle** (track `VOLUNTEER` or `DIRECTOR`, status `DRAFT`, `OPEN`,
  `CLOSED`, `ARCHIVED`) owns the application surface.
- **FormSection** and **FormField** define the dynamic application form
  (field types: short/long text, single/multi select, checkbox, email, phone,
  number, and more).
- **Applicant**, **Application**, **Acceptance**, and **OnboardingContract**
  track a person through apply, decision, and onboarding.
- **ApplicantPortalToken** and the onboarding token back the unauthenticated
  applicant and onboarding flows.
- **Interview**, **InterviewPanelist**, and **Evaluation** run the interview
  process.
- **RecruitmentCycleEmail** holds per-cycle overrides of recruitment email
  content.

### Scheduling

- **ScheduleDay** is a clinic date. **ShiftAssignment** places a person in a
  shift with a **ShiftRole** (`DIRECTOR`, `VOLUNTEER`, `SHADOW`) and med-team
  tag. **ShiftRequest** models swap and drop requests (status `PENDING`,
  `APPROVED`, `DENIED`, `CANCELLED`).
- **RhdAttending** and **RhdClinic** model the attendings roster and clinic
  days imported from the legacy "RHD" source.

### Training and learning

- **Training** is a term-linked, track-scoped training requirement;
  **QuizAttempt** records quiz-based completion.
- **Course**, **CourseDepartment**, **CourseProgress**, and **ScoProgress**
  model SCORM courses, their department assignment, and per-learner (and per-SCO)
  progress.

### Email, notifications, and integration

- **EmailTemplate** (editable, keyed, with code-default fallback),
  **EmailCampaign**, **EmailCampaignRun**, and **EmailLog** (status `QUEUED`,
  `SENT`, `FAILED`) implement templated and campaign email with queue-based
  delivery.
- **Notification** is a per-user in-app notification.
- **TeamsMessage** tracks Teams delivery with statuses including `FALLBACK`
  (abandoned and re-queued as email) and a distinct log-transport state, plus an
  `emailAlreadyQueued` guard so the "both" channel does not double-send.
- **MailCredential** stores the delegated Graph OAuth tokens for the connected
  mailbox.
- **EpicRequest** (kind `NEW`/`MODIFY`/`RENEW`, status `PENDING`/`SUBMITTED`/
  `COMPLETED`/`CANCELLED`) and **YnhhTicket** (`OPEN`/`CLOSED`) track Epic
  access provisioning.

### Configuration

- **Setting** is a typed key/value store backing administrator-configurable
  branding, operational settings, and feature toggles, resolved through a
  registry-and-resolver pattern with a short-lived cache.

---

## 7. Product scope by module

Each module below lists its purpose, the key requirements and behaviors it
satisfies, and the roles that use it.

### 7.1 Home and navigation

**Purpose:** orient a member the moment they sign in and route them only to what
they can use.

**Behavior:**

- Personalized dashboard: greeting, next-shift hero, clearance and compliance
  status, quick actions, and module tiles.
- Permission-driven global and sub navigation; modules and tabs the member
  cannot access are hidden, and denied deep links land on `/no-access`.
- The current clinic week's Microsoft Teams channel link is surfaced on the
  dashboard when configured.
- A persistent shell (single shared `(app)` layout) owns the toolbar and the
  notification bell across the app.

**Roles:** all authenticated members.

### 7.2 Recruitment and applications

**Purpose:** run each term's recruitment from open call through accepted
volunteer.

**Behavior:**

- **Cycles** for the volunteer and director tracks move through draft, open,
  closed, and archived. Eligibility (new, renewal, or both) is enforced.
- A **dynamic form builder** composes the application from sections and fields
  with conditional logic, department choices, and validation; it supports new
  and renewal applicants and returning-applicant autofill.
- A **public portal** at `/apply/[slug]` lets applicants apply and resume a
  saved draft. An abandoned-draft sweep purges stale drafts but skips
  still-open cycles so an applicant can always finish.
- **Applicant tracking** deduplicates by email per cycle and records department
  preferences.
- **Interviews:** panelist assignment, scheduling with meeting links, independent
  per-panelist recommendations, and accept/reject/waitlist decisions. A panelist
  has a personal "My Interviews" view. Decisions are conflict-aware (a
  multi-department acceptance conflict is refused) and an emailed acceptance
  locks out later reject/waitlist changes until it is rescinded.
- **Acceptance** is per department, with acceptance emails and onboarding-link
  sending gated on cycle status.
- **Subcommittee ranking** captures applicant subcommittee interest.
- All recruitment emails are editable, both as global descriptors and as
  per-cycle overrides.

**Roles:** recruiters and recruitment leads (`recruitment.*`); panelists for the
interview surface.

### 7.3 Onboarding and the clearance gate

**Purpose:** turn an accepted applicant into a cleared, ready-to-schedule member.

**Behavior:**

- A **token onboarding contract** at `/onboard/[token]` prefills known data,
  collects signature acknowledgments, a HIPAA certificate, and Epic provisioning
  flags. Submitting promotes the contract into a full person record. Captured
  data maps to self-reported (never auto-verified) status where verification is
  required.
- A blocking **"Get started" clearance gate** at `/get-started` walks a new
  member through profile, HIPAA, and training steps before the rest of the app
  opens. The gate is enforced in `requirePersonSession`, not the layout, and uses
  a short positive-only cache.

**Roles:** applicants (token flow); new members (gate).

### 7.4 Scheduling

**Purpose:** plan and run clinic shifts per department and per person.

**Behavior:**

- **Personal schedule:** upcoming shifts, availability self-update, and swap or
  drop requests.
- **Department schedule:** shift roles (`DIRECTOR`, `VOLUNTEER`, `SHADOW`) and
  med-team tags (triage, walk-in, continuity care, remote).
- **Director schedule builder:** capacity math, assignment, availability
  validation, and a requests panel (shown only with the manage-requests scope).
  Training-intake answers (minimum shifts, availability, feedback) are surfaced
  read-only to directors, keyed by membership track, but are not fed into
  capacity math.
- **Three-tier availability:** application baseline, volunteer self-update, and
  director override, over structured clinic-date selection.
- **Swap and drop workflow** with approval gates and dual validation.
- **Attendings roster** of procedure-qualified attending physicians.
- **Capacity planning** with per-clinic patient counts and headcount thresholds.

**Roles:** volunteers (own schedule, requests); directors (`schedule.edit_own_dept`,
`schedule.manage_requests`); administrators (`schedule.edit_all`).

### 7.5 Compliance engine

**Purpose:** make HIPAA and training clearance continuously computed and visible.

**Behavior:**

- **HIPAA status** is computed against a twelve-month window into one of:
  `COMPLIANT`, `EXPIRING_SOON`, `EXPIRED`, `UNKNOWN_DATE` (a certificate exists
  but its completion date could not be established), or `NO_CERTIFICATE`.
- Certificate completion dates are validated by a dedicated parser; applicant
  and self-uploaded dates do not clear a person until a compliance manager
  verifies them (`compliance.verify`, `compliance.set_date`), and dates can be
  backfilled (`compliance.backfill_date`).
- **Overall clearance** combines HIPAA, training, and disciplinary status and is
  surfaced consistently on home, My Info, and training.
- Compliance is recomputed nightly across all people, and campaign audiences
  that target a compliance status are derived live (newest certificate plus term
  end) rather than from a stored last-status.

**Roles:** compliance managers (`compliance.*`, `volunteers.manage_compliance`);
read surfaces for all members.

### 7.6 Volunteer management and operations

**Purpose:** give leadership the operational tools to manage active members.

**Behavior:**

- **Department compliance roster** with HIPAA and training status, filtering,
  sorting, and quick actions; and a **master roster** across all terms and
  departments.
- **HIPAA reminders** on a weekly cadence with per-person deduplication and
  director escalation after repeated reminders.
- **Offboarding:** flag members at term end, then execute bulk offboarding with
  an audit trail; offboarding converges status and membership removal and also
  cancels open Epic grant requests and enqueues a deactivation.
- **Epic access requests** (new, modify, renew) with YNHH ticket linking, status
  tracking, and ticket aging in business days.
- **Disciplinary actions** with category, severity flags, follow-up, and an
  issuer audit trail.

**Roles:** `volunteers.view`, `volunteers.manage_compliance`,
`volunteers.manage_epic`, `volunteers.manage_offboarding`,
`volunteers.issue_disciplinary`.

### 7.7 Learning (SCORM training)

**Purpose:** deliver asynchronous, department-assigned training in the hub.

**Behavior:**

- Upload and manage **SCORM 1.2 packages**, including multi-SCO manifests.
- Assign a **course** to specific departments or organization-wide, with
  auto-enrollment. Package-less assigned courses are excluded from assignment so
  they cannot silently lock the onboarding gate.
- An embedded, same-origin **SCORM player** (scorm-again runtime) tracks
  progress, score, and resume.
- A learner course list with status badges, and an administrator completion
  dashboard.

**Roles:** learners (`learning.access`); course managers
(`learning.manage_courses`, `learning.view_progress`).

### 7.8 My Info and profile

**Purpose:** let a member see and manage their own record and clearance.

**Behavior:**

- Contact and profile management, including department memberships, Spanish
  fluency (self-reported and verified are tracked separately, with only verified
  status gating scheduling), and licensed-RN status.
- Active term membership view with the ability to withdraw from a term.
- HIPAA certificate upload with completion-date entry, size limits, and stored
  metadata; an in-app certificate viewer with PDF preview (inline file serving
  allowlists safe MIME types).
- Clearance presented as a status card.

**Roles:** every member, scoped to their own record (`person.update`).

### 7.9 Clinic operations

**Purpose:** day-of-clinic tooling.

**Behavior:**

- **After Visit Summary (AVS) generator** at `/clinic/avs`: an ephemeral,
  client-side PDF (rendered with @react-pdf/renderer) that holds zero patient
  health information and is never persisted. It uses a static English/Spanish
  table rather than an online translator.

**Roles:** clinic members with access to the clinic module.

### 7.10 Admin and configuration

**Purpose:** let leadership run the platform without code changes.

**Behavior:**

- **People** directory: create, edit, and status management.
- **Terms** and academic calendar, including clinic dates and a single active
  term.
- **Departments** with delegation (a manager department overseeing managed
  departments).
- **Roles and permissions** management with assignment by scope and by cohort
  kind.
- **Audit log viewer** with search by actor, action, entity, and date.
- **Sync health** view for Airtable import and outbox status.
- **Configurable settings:** branding (app name, color, logo, favicon),
  operational settings, and feature toggles, through a registry-and-resolver
  pattern.
- **ITCM Epic request generator** that produces service-request PDFs, Excel
  spreadsheets, and pre-filled email drafts, with an Epic request tracker and
  business-day ticket aging.

**Roles:** administrators (`admin.*`, `rbac.assign`, `term.*`, `person.*`).

### 7.11 Email system

**Purpose:** send transactional and campaign email reliably from a clinic
mailbox.

**Behavior:**

- **Editable templates** keyed by purpose, each with a code-default fallback so a
  missing override never blocks a send.
- **Campaigns** with audience targeting by any person field (a field registry of
  text operators and curated relations), scheduling (immediate, one-time, or
  recurring), and per-run recipient deduplication. A match-nobody safety
  invariant prevents an empty or misconfigured audience from blasting everyone.
- **Transactional email** for recruitment, Epic, and compliance reminders.
- **Live delivery** through delegated Microsoft Graph OAuth, sending as an
  admin-connected shared mailbox, with a console-logging transport for
  development.
- **Queue-based delivery:** all email is queued and drained by a single
  per-minute job that also dispatches due campaigns. Each queued row is attempted
  at most once per tick (keyset paging) to protect the retry budget.

**Roles:** administrators (`admin.send_email_campaign`,
`admin.manage_email_templates`).

### 7.12 Notifications

**Purpose:** deliver platform events to members through their preferred channel.

**Behavior:**

- A unified `notify()` dispatcher records one Notification per dispatch
  (owner-scoped, server-set person id) and routes per type to email, Teams, or
  both, with email fallback when Teams fails.
- A per-user in-app inbox and bell (`/notifications`), self-fetched by the
  persistent shell.
- The "both" channel does not double-send: a guard flag tracks whether email was
  already queued before Teams fallback runs.

**Roles:** all members receive notifications; per-type channel routing is an
admin setting.

---

## 8. Cross-cutting concerns

- **RBAC** (Section 4) gates every consequential action and filters navigation.
- **Audit logging** records actor, action, entity, and before/after snapshots
  for consequential writes.
- **Notifications** are dispatched through one service with channel routing and
  fallback (Section 7.12).
- **Design system and theming:** the HAVEN Hub design system with canonical radii
  (cards, controls, alerts), shared primitives (Card, Modal, Spinner), Hanken
  Grotesk typography, an app-wide light/dark/system theme over a semantic token
  layer with per-user preference and no-flash SSR, an Apple-style "Liquid Glass"
  material on the nav bar and overlays, and app-wide loading feedback (a
  navigation progress bar and route-level loading screens).
- **Configurability:** clinic-specific values (branding, organization name and
  tagline, operational settings, feature toggles, departments, roles, terms,
  email content) are administrator-configurable through the settings registry
  rather than hardcoded.

---

## 9. Integrations

- **Microsoft Entra ID (Yale tenant):** single sign-on; a sign-in is matched to
  an existing person record. Required in production (boot fails loudly if the
  Azure credentials are missing); optional in development, where dev/demo
  credential login works under `DEMO_MODE`.
- **Microsoft Graph (delegated OAuth):** one connected shared mailbox
  (`hfc.it@yale.edu` by default) powers three things: sending email as the
  mailbox (`Mail.Send`, `Mail.Send.Shared`), Teams direct-message notifications
  (`Chat.Create`, `ChatMessage.Send`), and the home-dashboard clinic Teams
  channel link (`Channel.ReadBasic.All`, which needs tenant admin consent). An
  administrator connects and reconnects the mailbox in Admin > Email; new scopes
  require a one-time reconnect.
- **Airtable (one-way import):** people, rosters, schedules, and HIPAA
  certificates import from the HAVEN Management base, with dry-run previews and
  nightly reconciliation. An outbound mirror exists but is disabled by default
  and is being retired; the read-only import pipeline and the `airtableRecordId`
  linkage are kept for ongoing certificate migration.
- **Vercel Blob:** stores SCORM packages and uploaded files; branded logo and
  favicon are served through a branding asset route.
- **Epic / YNHH (ITCM):** the ITCM generator produces YNHH service-request PDFs
  (pdf-lib), Excel spreadsheets (exceljs), and pre-filled email drafts for Epic
  access provisioning and deactivation, tracked through EpicRequest and
  YnhhTicket.
- **SCORM runtime:** scorm-again drives the same-origin embedded player.
- **GitBook:** a documentation gateway lets a signed-in user reach embedded docs
  with their session context.

---

## 10. Non-functional requirements and constraints

- **Minimal PHI by design.** The platform is not an EHR and holds minimal
  patient health information. HIPAA certificates are training certificates, not
  patient data. The AVS generator produces patient artifacts entirely
  client-side and persists nothing.
- **Authentication is Yale-tenant SSO.** Production requires Entra ID; the
  application boots loudly if it is misconfigured. Demo and dev credential paths
  are gated behind `DEMO_MODE` and are never enabled in production.
- **Least privilege.** Every action is permission-gated; navigation is filtered
  to match; denied access is explicit (`/no-access`).
- **Auditability.** Consequential changes are recorded with before/after
  snapshots.
- **Safe file serving.** Inline serving of uploaded certificates allowlists safe
  MIME types because a stored MIME type is not always trustworthy.
- **Email safety.** Campaign audiences enforce a match-nobody invariant; queued
  delivery attempts each row at most once per tick to protect the retry budget;
  the "both" notification channel cannot double-send.
- **Security posture.** Ongoing hardening against CodeQL and Dependabot findings;
  production builds run with secrets present and migrate on deploy.
- **Resilience to production-only failure modes.** Infinite render loops are
  treated as production hazards (they can silently freeze the UI), and
  preview deploys that share the production database must not run behind an
  unapplied migration.

---

## 11. Operations

- **Deployment:** Vercel, region `iad1`. The build command is
  `prisma migrate deploy && next build`, so schema migrations apply on every
  production deploy. The deploy is configured to build production only.
- **Database:** Neon in production with a pooled connection for the app and an
  unpooled connection for `prisma migrate` (its advisory lock needs a stable
  session a pooler cannot guarantee). Local development uses a Docker Compose
  Postgres on port 5434, with a separate test database.
- **Scheduled jobs (cron HTTP endpoints under `/api/cron`):**
  - `/api/cron/email`: per-minute. The sole drainer of the email and Teams
    queues and the campaign dispatcher. Requires a Vercel plan with per-minute
    cron and a `CRON_SECRET`.
  - `/api/cron/nightly`: nightly compliance recomputation across all people.
  - `/api/cron/reminders`: daily HIPAA reminder enqueue (drained by the email
    job, never directly, to avoid double-sending).
  - `/api/cron/recruitment-drafts`: daily abandoned-draft sweep (registered in
    `vercel.json` at 04:00, scoped to closed cycles).
- **Health:** a `/api/health` endpoint reports service health.
- **Worktree and migration hygiene:** the repository uses git worktrees for
  parallel work; system-role and other seed-backed changes need a backfill
  migration because deploys do not run the seed.

---

## 12. Success metrics

Because HAVEN Hub replaces manual processes, success is measured by coverage,
timeliness, and the absence of the old failure modes rather than by engagement.

- **Single source of truth:** the share of active members managed entirely in
  HAVEN Hub (no parallel Airtable or spreadsheet record) trends to 100% after
  the Airtable cutover.
- **Compliance visibility:** the number of members who reach a clinic shift
  while non-compliant trends to zero; expiring HIPAA certifications are surfaced
  and reminded before they lapse.
- **Onboarding throughput:** time from acceptance to cleared-and-schedulable
  (gate completion) decreases relative to the manual process.
- **Recruitment cycle time:** time from application close to all decisions sent.
- **Access hygiene:** every Epic access request is tracked to completion or
  cancellation, and offboarding revokes access with an audit trail.
- **Operational safety:** zero double-sent emails and zero unintended
  send-to-everyone campaign incidents.

These are directional product outcomes, not instrumented dashboards; specific
measurement is out of scope for this baseline.

---

## 13. Out of scope, future work, and open questions

### Out of scope (deliberate non-goals)

- Acting as an electronic health record or storing meaningful PHI.
- Multi-tenant operation for clinics other than HAVEN.
- Authoring SCORM content (the hub delivers packages authored elsewhere).
- Replacing Teams or email as communication channels.

### Known future and in-flight work

These were specced or in progress around the baseline and may already be
shipping on feature branches; treat them as roadmap, not current behavior:

- **HIPAA verification gate refinement:** a `PENDING_VERIFICATION` state keyed on
  a verification timestamp, so self-reported dates do not clear until a manager
  verifies them.
- **Spanish fluency verification:** splitting self-reported from verified Spanish
  fluency, with a review queue, so only verified fluency gates scheduling.
- **Recruitment onboarding pages per cycle.**
- **Email campaigns phase 2** scheduling refinements.
- **Airtable cutover:** completing the migration and retiring the outbound
  mirror entirely while keeping the read-only import for certificate migration.

### Open questions

- What is the long-term plan for the Airtable dependency once the certificate
  migration is complete: full removal, or a permanent read bridge?
- Should success metrics in Section 12 be instrumented (dashboards, events), and
  if so, where?
- What is the retention and archival policy for audit logs and offboarded
  person records across terms?
```