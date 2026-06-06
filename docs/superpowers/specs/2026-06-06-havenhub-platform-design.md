# HAVENHub Platform — Design Spec

**Date:** 2026-06-06
**Status:** Approved design, pre-implementation
**Author:** Jack Carney (with Claude)

## 1. Summary

HAVENHub is the unified platform for all directors and volunteers at HAVEN Free Clinic. It replaces a constellation of single-purpose apps — the SU 26 scheduler, the Member Information Update Form (updatemyinfo), the original Figma Make Havenhub, and haven-triage — with one application behind a single Yale Entra ID login. Members land on a hub of module tiles (Schedule, My Info, Volunteers, Admin at launch; Recruitment, Triage, Referrals, Patient Trackers later) and can open any module their permissions allow.

Postgres is the system of record. Airtable becomes a continuously-updated mirror so non-technical directors keep their familiar views and the clinic's Outlook email automations keep working during a slow transition away from Airtable.

## 2. Context: what exists today

| Platform | Stack | Auth | Data | Status |
|---|---|---|---|---|
| updatemyinfo (HAVENINFO) | Vite SPA + Supabase Edge Fn (Hono) | None (NetID+email lookup) | Airtable `HAVEN Management` (`appkxTQ19GmaHgW1O`) | Live |
| HAVEN-scheduler | Vite SPA + Hono on Vercel | None (NetID+email per request, honor system) | Airtable (Management + Director/Volunteer Recruitment bases) | Live for SU 26 |
| Havenhub (original) | Figma Make export → Supabase; 10k-line edge function | Supabase Auth (Entra OAuth + hand-rolled CAS, unresolved) | Supabase Postgres | Stalled |
| haven-triage | Next.js 16 + Prisma/Postgres + Socket.IO custom server, Docker | NextAuth v5 + Microsoft Entra ID (Yale tenant) — working | Postgres | Built, never launched; no data to preserve |

Lessons these encode:

- **Auth is solved once already.** haven-triage's NextAuth v5 + Entra setup against the Yale tenant works and is the template. Two live apps have no real auth at all; the scheduler's spec explicitly defers SSO and acknowledges anyone with a NetID/email pair can write.
- **The original Havenhub stalled for architectural reasons** (one 10k-line server file, no migrations-as-code, hardcoded keys, scattered duplicated role checks) — not because the vision was wrong. Its docs/glossary remain a good domain reference.
- **"SU 26" is hardcoded everywhere** in the scheduler — table names, field names, the 18 clinic dates, even field-name prefixes. Terms must become data.
- **The scheduler's pure business-logic modules** (swap engine with rollback, conflict detection, capacity math, availability resolution) are unit-tested and port nearly verbatim.
- **Airtable's `All People` table has 101 fields** of accumulated sync scar tissue. The mirror must own an explicit, small set of fields mapped by field ID and touch nothing else.

Airtable history (per-term bases now consolidated into `HAVEN Management`, `HAVEN Director Recruitment`, `HAVEN Volunteer Recruitment`) confirms the direction: term-scoped copies of rosters are valued artifacts, but the master data wants to live somewhere term-agnostic.

## 3. Decisions (settled with the owner)

1. **Launch scope:** platform shell + ported existing modules — Schedule, My Info, Volunteers (people ops), Admin. Recruitment, Triage, Referrals, Patient Trackers are post-launch modules, each with its own spec→plan cycle against the module contract.
2. **Data:** Postgres is master from day one. One-way continuous mirror Postgres → Airtable keeps a full roster copy (like `SU 26`) in `HAVEN Management` forever, preserving director-friendly views and conditional Outlook email automations. Slow transition off Airtable; recruitment bases stay Airtable-mastered until the Recruitment module exists.
3. **Hosting:** Yale SpinUp VM (behind the Yale network, under Yale's BAA) for production — required before any PHI. No Supabase anywhere. Until SpinUp: local-first via Docker Compose; temporary no-PHI demos may run anywhere convenient.
4. **Eligibility:** anyone who signs in with Yale Entra ID and matches an `All People`-derived Person record gets in; current-term membership determines module access. Non-current people (alumni, incoming) get a limited view (My Info). Unmatched logins see a "Welcome to HAVEN" page with contact/apply guidance.
5. **Permissions:** full RBAC — custom roles, per-action permission strings namespaced by module, assignable to individuals or departments, scoped globally or per-term. Editable in Admin; no redeploys to change access.
6. **Cutover:** FA26. SU 26 finishes untouched on the existing apps. HAVENHub is built and tested over summer 2026 against imported real data, and becomes THE platform when FA26 term setup begins (~Sep/Oct 2026).
7. **Architecture:** modular monolith — one Next.js app, one Postgres, one deploy; modules are enforced internal boundaries, not separate services. Fresh codebase (not a fork), deliberately importing proven pieces from the existing apps.

## 4. Architecture

### 4.1 Containers

```
docker-compose.yml
├── app        Next.js 16 (App Router) — UI + API routes, standalone output
├── worker     Node process (same codebase) — Airtable mirror, scheduled jobs
└── postgres   Postgres 16 — single database, all modules' tables
```

Production adds a TLS proxy container (Caddy with auto-certs, or nginx with a Yale-provided cert — finalized when the SpinUp VM exists).

### 4.2 Stack

- TypeScript, Next.js 16 (App Router), React 19
- Tailwind CSS v4 + shadcn/ui (the visual language all existing apps share)
- Prisma 6 + Postgres 16, real migrations from day one
- NextAuth v5 (Auth.js) with the `MicrosoftEntraID` provider
- pg-boss for background jobs (Postgres-backed queue; no Redis)
- Vitest (unit/integration) + Playwright (e2e smoke)

**No custom server.** Nothing at launch needs realtime; the scheduler's debounced-autosave + refresh pattern carries over. When Triage arrives, add authenticated SSE or a websocket sidecar — the persistent SpinUp server permits either without rearchitecting.

### 4.3 Repo layout

```
src/
  platform/        # the shell: auth, RBAC engine, term context, people,
                   # Airtable mirror, module registry, shared UI kit, audit
  modules/
    schedule/      # each module: manifest.ts + routes + services + components
    my-info/
    volunteers/
    admin/
  app/             # Next.js routes — thin; delegates into platform/modules
worker/            # entrypoint for the jobs container (shares src + Prisma)
prisma/            # schema + migrations
docs/superpowers/  # specs and plans
```

**Boundary rule (lint-enforced):** modules may import `platform`; modules never import each other. Cross-module needs go through platform services. This rule is the structural fix for what killed the original Havenhub.

### 4.4 Environments

- **Local dev:** `docker compose up postgres` + `npm run dev`. Dev-only credentials login (no Entra round-trip), seeded data from the Airtable importer.
- **Production:** same compose file on SpinUp. GitHub Actions builds images → GHCR; the VM runs `docker compose pull && up -d`.
- **Config validated at boot:** the app refuses to start with a clear list of missing env vars. Every variable documented in `.env.example`.

## 5. Identity & authentication

- One button: "Sign in with Yale" → Entra ID (Yale tenant). App registration redirect URIs for localhost and the SpinUp domain (reuse haven-triage's registration or clone its setup).
- Dev-only passwordless credentials provider, disabled in production (haven-triage pattern).

**Login → Person resolution order:**

1. `Person.entraObjectId` already linked → done (stable through name/email changes)
2. NetID extracted from UPN (`netid@yale.edu`) matches `Person.netId` → link object ID, done
3. Email matches `Person.contactEmail` or `Person.yaleEmail` → link, done
4. No match → "Welcome to HAVEN" page (signed in, not in records, contact IT / apply); attempt logged for admin review

No self-registration. People enter via term rosters (later: the Recruitment module).

**Sessions:** JWT cookie; role/permission context hydrated from Postgres per request — revocations and role changes take effect immediately.

## 6. Core data model (platform)

```
Person          netId, entraObjectId, name, contactEmail, yaleEmail, phone,
                epicId, yaleAffiliation, gradYear, status (active/offboarded),
                airtableRecordId
Term            code (SU26, FA26), name, startDate, endDate,
                status (planning → active → archived), clinicDates[]
Department      code (ITCM, VADM, SRR, …), name, isActive   ← canonical list
TermMembership  person ↔ term ↔ department, kind (director | volunteer),
                status (active/removed), availability (baseline available dates,
                self-updated availability text, updatedAt / acknowledgedAt)
AuditLog        actor, action, entity, before/after JSON, timestamp, IP
Outbox          entity, entityId, operation, changedFields, status, attempts
```

Modules add their own tables (e.g., `ScheduleShift`, `ShiftRequest`, `EpicRequest`, `DisciplinaryAction`, `ComplianceRecord`) referencing platform entities by foreign key.

**Terms are data.** Creating FA26 — dates, roster, schedule scaffold — is an Admin action, not a code change. This is the single biggest fix over the scheduler.

## 7. RBAC

Permissions are namespaced strings declared by modules: `schedule.view`, `schedule.edit_own_dept`, `schedule.edit_all`, `volunteers.manage_compliance`, `volunteers.issue_disciplinary`, `admin.manage_roles`, `admin.manage_terms`, …

```
Role            name, description, isSystem
RoleGrant       role → permission string
RoleAssignment  role → (person | department), scope: term | global
```

Effective permissions = union of roles assigned directly to the person and roles assigned to departments the person belongs to in the **active term**.

Seeded system roles:

- **Platform Admin** (global) — assigned to ITCM and EXEC by default
- **Director**, **Volunteer** — auto-attached via TermMembership kind
- Department-scoped delegation roles reproducing today's hardcoded reality (VADC→VADM, SRHD→counseling depts), as editable assignments rather than constants

Enforcement is server-side in one place — `can(user, "schedule.edit_all")` — at route guards and service layers. UI reflects, never decides. The Admin RBAC editor is fed by every module's declared permission list.

## 8. Module system & hub

Each module exports a manifest:

```ts
export const scheduleModule: ModuleManifest = {
  id: "schedule",
  title: "Clinic Schedule",
  description: "Build and view department schedules, request swaps",
  icon: CalendarDays,
  accessPermission: "schedule.view",   // tile visibility + route guard
  permissions: [...],                  // declared strings, for the RBAC editor
  status: "active" | "coming-soon",
  nav: [...],
}
```

The registry (`src/platform/modules.ts`) is the single wiring point. The hub page renders tiles from it: accessible modules live, `coming-soon` modules greyed with a label. Routes live at `/<module-id>/…` behind layout-level permission guards.

## 9. Launch modules

### 9.1 Schedule (port of HAVEN-scheduler)

Everything current survives: builder with assign/shadow/availability/pending-request modes; Saturday-card and full-term-grid layouts; 3-tier availability resolution (director override → volunteer self-update with acknowledge handshake → application baseline); drop/named-swap engine with re-validation and rollback; same-day and cross-department conflict detection; capacity math (SCTP/JCTP rules); RHD clinic-readiness panel; compliance banners; removal audit log.

Deliberate changes:

1. **Viewer requires login.** The anonymous `/view` page and NetID-only `/compliance/:netid` check disappear — everyone who needs them is in All People. Closes the scheduler's documented security holes.
2. **Term-parameterized.** Dates, departments, role-slot definitions, and admin/delegation mappings come from the database (Term, Department, RBAC), not constants.

The scheduler's unit-tested pure modules (`requests.ts`, `conflicts.ts`, `capacity`, `compliance.ts`, `rhd.ts`) and its Airtable client retry/escaping logic port with their tests.

### 9.2 My Info (port of updatemyinfo)

Authenticated, so the NetID+email lookup step disappears — opens straight to the signed-in member's record. Edit contact fields, Epic ID, affiliation, graduation year; "not volunteering" flow (clears department for the term); HIPAA certificate upload. Files stored on a server volume with DB metadata; pushed into the Airtable attachment field via Airtable's content-upload API so existing automations still see certificates. The dynamic field-renderer component from updatemyinfo is reused.

### 9.3 Volunteers (new; absorbs director-facing people ops)

- **Compliance dashboard:** HIPAA / volunteer training / contract status per person and per department (replacing the Compliance table workflows and scheduler compliance checks)
- **Roster + offboarding:** term roster views by department; the offboarding/verification workflow (from updatemyinfo's `/verify`, now permission-gated instead of URL-secret); onboarding status tracking
- **Epic account requests:** New/Modify/Renew workflows replacing the `Volunteer Epic (*)` and `Director Epic Requests` Airtable form tables
- **Disciplinary/strikes:** disciplinary actions log, strike counts, issuing workflow (replacing the `Disciplinary Actions` table)

### 9.4 Admin

People management (create/edit/merge Person records); term lifecycle (create FA26, set clinic dates, build roster via import/promotion, archive SU26); RBAC editor; Airtable sync health (last sync, outbox depth, failures, drift report); audit log viewer; module enablement toggles.

## 10. Airtable mirror & import

### 10.1 Mirror (continuous, one-way: Postgres → Airtable)

**Mechanism — outbox pattern.** Service-layer writes to mirrored entities append an outbox row in the same transaction. The worker drains via pg-boss: batches by table, respects Airtable's 5 req/s limit, retries with exponential backoff (reusing the scheduler's `airtable.ts` patterns). Airtable downtime queues writes; the app never blocks on Airtable.

**Mirror map (config: entity → table ID → field-ID mapping):**

| Postgres entity | Airtable target (`HAVEN Management`, `appkxTQ19GmaHgW1O`) |
|---|---|
| Person (core fields) | `All People` (`tblnHgBpknuqWvx9c`) — only fields we own, mapped by field ID; the other ~90 legacy fields untouched |
| TermMembership roster | Per-term table (e.g., `FA 26`), created via Airtable's table-creation API at term creation, same shape as `SU 26`: department rows with Directors/Volunteers links |
| Compliance status | Status fields on All People / Compliance table |
| HIPAA certificates | Attachment field via content-upload API |

Schedule mirroring (e.g., for shift-reminder automations) is a later config entry + outbox hook, not a rearchitecture.

**Drift handling:** a nightly reconciliation job diffs mirrored fields, rewrites Airtable to match Postgres, and logs every drift event to the sync-health dashboard (visibility into who still edits the wrong place). Non-mirrored fields and Airtable automations are never touched.

### 10.2 Import (deliberate, not a sync)

1. **Dev/test seed:** idempotent, dry-run-by-default importer pulls `All People`, `SU 26`, and `Compliance` into Postgres for development against real-shaped data all summer.
2. **FA26 bootstrap:** recruitment for FA26 still runs in the Airtable recruitment bases. When the roster settles, the importer ingests accepted applicants + returning members into Person/TermMembership. From then on Postgres masters and the mirror takes over.
3. Recruitment bases are read only at import time until the Recruitment module exists.

## 11. Error handling & observability

- Config validation at boot with explicit missing-variable errors
- Typed service errors mapped to friendly UI states; React error boundaries per module so one module's crash never takes down the hub
- Audit log on every mutation, platform-wide, viewable in Admin
- Sync health surfaced: outbox failures and reconciliation drift as Admin banner + dashboard; later, Microsoft Graph email alerts (same Entra tenant)
- `/api/health`: DB reachable, worker heartbeat, outbox depth — for SpinUp monitoring

## 12. Testing

- **Vitest unit:** RBAC evaluation, login→Person matching, term lifecycle, outbox/mirror mapping; ported scheduler logic arrives with its existing test suite
- **Integration:** real Postgres in Docker, exercised through service layers
- **Playwright smoke:** sign-in → hub → each module opens; permission denial denies; my-info edit round-trips; schedule assign/swap flow
- **CI (GitHub Actions):** lint (incl. module-boundary rules), typecheck, unit + integration on every PR; image build on main

## 13. Deployment & operations

- Images built by CI → GHCR; SpinUp VM pulls and restarts via compose
- TLS: Caddy (auto-certs) or nginx + Yale cert — finalized at SpinUp provisioning
- Backups: nightly `pg_dump` to the VM volume; off-box copy is an open ops item for SpinUp setup
- Secrets: single `.env` on the server — Entra client ID/secret/tenant, `AUTH_SECRET`, `DATABASE_URL`, Airtable PAT, mirror-map base/table/field IDs
- No PHI until production lives on SpinUp under the BAA; launch modules hold no patient data

## 14. Post-launch roadmap (each gets its own spec → plan cycle)

1. **Recruitment** — cycle management, application builder, applicant review (SRR + IT + EDs); replaces the per-cycle Airtable recruitment bases
2. **Triage** — fresh port of haven-triage's case-coordination design (no data migration; it never launched); requires the realtime decision (authenticated SSE or websocket sidecar) and SpinUp/PHI posture
3. **Referrals**, **Patient Trackers** — PHI modules; SpinUp + BAA prerequisite; domain design happens with the relevant departments during those modules' own spec cycles
4. **Email ownership** — Microsoft Graph sendMail replaces Airtable Outlook automations module by module; the mirror keeps automations alive until then

## 15. Deferred decisions (consciously open, with owners)

| Decision | When | Owner |
|---|---|---|
| SpinUp VM specifics (size, TLS, domain, network exposure) | At provisioning, before any PHI | Jack + Yale ITS |
| Reuse vs. new Entra app registration | First auth implementation step | Jack |
| Off-box backup destination | SpinUp setup | Jack |
| Realtime transport for Triage (SSE vs websocket sidecar) | Triage module spec | Triage spec cycle |
| Schedule mirroring to Airtable for reminder automations | If/when automations need it | Config change, not design change |
