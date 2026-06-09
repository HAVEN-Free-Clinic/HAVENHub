# Email Templates & Campaigns — Design

**Date:** 2026-06-08
**Branch:** `worktree-email-templates-campaigns` (off `main`)
**Status:** Approved design, pending spec review

## Goal

Two related capabilities, built as one coherent system sharing a rendering engine and recipient model:

1. **Customizable templates** — every email the platform sends (Epic, compliance, recruitment, plus a shared layout wrapper) becomes editable from the admin section, without a deploy.
2. **Ad-hoc / campaign sending** — admins compose an email, target a dynamic audience via a structured condition builder, preview the recipient list, and send now or on a schedule (one-time or recurring).

## Existing infrastructure (reused, not rebuilt)

- **Queue + worker:** `queueEmail(db, input)` writes an `EmailLog` row; the pg-boss `email-send` job drains via `drainEmailQueue()` through `GraphTransport` (Microsoft Graph, delegated OAuth, sends as hfc.it@yale.edu). All sending — transactional and campaign — flows through this. Throttling and retry come for free.
- **Templates today:** hardcoded HTML strings in code registries (`EPIC_TEMPLATES`, `COMPLIANCE_TEMPLATES`) and one inline recruitment string, each producing `{ subject, html }` from typed params, escaped via `esc()`. No templating engine.
- **People model:** `Person` (status ACTIVE/OFFBOARDED, `contactEmail`), `TermMembership` (kind DIRECTOR/VOLUNTEER, department, term, status ACTIVE/REMOVED), `HipaaCertificate` / `ComplianceReminder`, `EpicRequest`. Recruitment: `RecruitmentCycle`, `Applicant` (own `email`), `Application` (applicantType NEW/RENEWAL, departmentChoices, status).
- **Admin + RBAC:** pages under `/admin/*`, gated by `requirePermission(name)`; existing `/admin/email` monitors logs and retries failures. Audit log infrastructure exists.

## Key decisions (locked)

| Decision | Choice |
|---|---|
| Sequencing | One combined spec; clean module boundaries so it can be built in phases. |
| Template override model | Code ships a default per email type; a DB row overrides it when present; fall back to code default otherwise. "Reset to default" deletes the DB row. |
| Audience definition | Structured AND/OR condition builder over a whitelist of fields, compiled to a safe Prisma `where`. Preview before send. |
| Template syntax | `{{variable}}` + `{{#if var}}…{{else}}…{{/if}}`, auto HTML-escaped, validated against a declared variable catalog. |
| Send timing | Send-now, scheduled (one-time), and recurring (cron). |
| Audience scope | `PERSON` and `APPLICANT` record types, each with its own field whitelist + variable catalog + email source. |
| Layout wrapper | One editable shared HTML wrapper (HAVEN header/footer); template bodies render inside it. |
| Safeguards | Recipient preview, test-send-to-self, typed confirmation above threshold, audit + per-run dedup. |
| Recurring semantics | Re-evaluate the audience against current data each run; dedup is per-run only (recurring intentionally reaches the same person each period). |
| Template history | Edit-in-place; each edit writes a before/after entry to the existing audit log. No in-app version history/rollback. |
| Campaign composition | Inline subject + body (same syntax + wrapper), with an option to save as a reusable campaign template. |
| Rendering engine | Tiny custom renderer, zero new dependencies (chosen over Handlebars for a smaller, safer, fully-controlled surface). |
| Permissions | New `admin.manage_email_templates` (Phase 1) and `admin.send_email_campaign` (Phase 2). Namespaced under `admin` to satisfy the module-id invariant. Existing log monitor unchanged. |
| Typed-confirmation threshold | 25 recipients. |

## Architecture

### 1. Rendering engine — `src/platform/email/render/`

- `renderTemplate(source: string, context: Record<string, unknown>): string`
  - Supports `{{var}}` interpolation (auto HTML-escaped via the existing `esc()` semantics) and `{{#if var}}…{{else}}…{{/if}}` blocks. Truthiness: non-empty string / true / non-zero.
  - Unknown variables render empty (and are surfaced by the validator at edit time, not at send time).
- `validateTemplate(source, catalog): ValidationResult` — flags unknown variable references and unbalanced/mismatched block tags. Used by the editor and by a save-time guard.
- `renderEmail(templateKey, context): { subject, html }` — resolves subject + body (override → default), renders both, then renders the resolved layout wrapper with `{{ body }}` set to the rendered body. One funnel for every email in the system.

### 2. Template registry + override store

- **Code registry** (`src/platform/email/templates/registry.ts`): `TemplateDescriptor[]`, one per email type plus the `layout` wrapper. Each descriptor declares:
  - `key`, display `name`, `category` (transactional | layout | campaign),
  - `variables: VariableDef[]` — `{ name, label, sampleValue }` (the catalog),
  - `defaultSubject`, `defaultBody` — version-controlled fallback in `{{}}` syntax.
- **DB model `EmailTemplate`** (override-only): `key` (unique), `subject`, `body`, `updatedById`, timestamps. The `layout` wrapper is just another key.
- **Resolution:** descriptor → DB override if present else code default → render → wrap in layout. Deleting the DB row reverts to code default.

### 3. Convert existing transactional emails

Refactor Epic (`epic-onboarding`, `epic-activation`, `epic-password-reset`), compliance (`compliance-reminder`, `compliance-escalation`), and recruitment (`recruitment.application_received`) to:

- Register a descriptor (variable catalog + default subject/body in `{{}}` syntax). Conditional phrasing (e.g. NEW/MODIFY/RENEW; EXPIRING_SOON/EXPIRED/…) maps to `{{#if}}` blocks.
- Trigger code passes a **context object** (the variables) into `renderEmail(key, context)` instead of building HTML inline.

Out-of-the-box behavior is identical; the emails are now admin-overridable.

### 4. Audiences — `src/platform/email/audience/`

- An audience = `recordType` (`PERSON` | `APPLICANT`) + a serialized AND/OR **condition tree** (`conditionJson`).
- Per-record-type **field whitelist**, each entry mapping an operator + value to a Prisma `where` fragment:
  - **Person:** status; membership kind (DIRECTOR/VOLUNTEER); department; term; compliance status; has-Epic.
  - **Applicant:** cycle; applicant type (NEW/RENEWAL); application status; department choices.
- `resolveAudience(audience): Recipient[]`, where `Recipient = { email, displayName, recordType, recordId, variables }`. Per-recipient `variables` are drawn from that record type's catalog (e.g. `firstName`, `departmentName`).
- Recipients with no/blank email are excluded and counted separately (surfaced in preview).

### 5. Campaigns — `src/platform/email/campaigns/`

(Kept under `src/platform/email/` for cohesion with the queue, render engine, and dispatch worker it depends on, rather than `src/modules/`.)

- **`EmailCampaign`:** `name`, `recordType`, `conditionJson`, inline `subject` + `body`, optional `savedTemplateKey`, `scheduleType` (NOW | SCHEDULED | RECURRING), `scheduledAt?`, `cronExpr?`, `status` (DRAFT | SCHEDULED | ACTIVE | SENDING | SENT | CANCELLED), `createdById`, `lastRunAt?`, `nextRunAt?`.
- **`EmailCampaignRun`:** one row per execution — `campaignId`, `runAt`, `recipientCount`, `status`. Enqueued `EmailLog` rows reference their run. Unique `(campaignRunId, email)` enforces **per-run dedup**.
- **Sending:** resolve audience → for each recipient `renderEmail`/inline-render with that recipient's variables → `queueEmail()` into the existing queue. The existing worker delivers.

### 6. Scheduling

- New pg-boss job **`campaign-dispatch`**, every minute: finds SCHEDULED campaigns with `scheduledAt <= now` and RECURRING campaigns whose `cronExpr` is due since `lastRunAt`. For each: create an `EmailCampaignRun`, **re-evaluate the audience against current data**, enqueue. One-time → `SENT`; recurring → recompute `nextRunAt`, stays `ACTIVE`.
- Send-now path triggers the same run logic immediately (no waiting on the cron tick), within the admin action.

### 7. Admin UI — extends `/admin/email`

- **Templates tab:** lists all descriptors + layout + saved campaign templates. Editor with live preview (rendered against the catalog's sample values), variable-insert palette, save-time validation warnings, and "reset to default" (deletes the override). Gated by `emails.manage_templates`.
- **Campaigns tab:** lists drafts / scheduled / recurring / sent. Create wizard:
  1. **Compose** — subject + body (insert variables, render inside layout).
  2. **Audience** — condition builder + **recipient preview** (count, sample list, excluded-no-email count).
  3. **Timing** — now / scheduled / recurring.
  4. **Review** — **test-send-to-self**, then **typed confirmation** when recipients > 25, then send/schedule.
  - Past runs and their per-run `EmailLog` rows are viewable. Gated by `emails.send_campaign`.

### 8. Permissions

- `admin.manage_email_templates` — edit templates and the layout wrapper. (Namespaced under the `admin` module: the codebase enforces an invariant that every permission is prefixed by its module id. Implemented in Phase 1.)
- `admin.send_email_campaign` (Phase 2) — manage audiences and campaigns, trigger sends. (Same module-id namespacing rule; revisit whether campaigns warrant a dedicated `emails` module when Phase 2 lands.)
- Existing `/admin/email` log monitor stays under its current gate.

### 9. Data flow (single funnel)

```
Trigger (transactional)            Campaign run (dispatch or send-now)
        │                                       │
        ▼                                       ▼
   build context per recipient ────────────────┘
        │
        ▼
   renderEmail(key|inline, context)  →  resolve override/default subject+body
        │                                →  render {{vars}} / {{#if}}
        │                                →  wrap in layout
        ▼
   queueEmail(db, { toEmail, subject, html, template, personId?, ... })   [existing]
        │
        ▼
   email-send worker → GraphTransport → Microsoft Graph   [existing]
```

## Module boundaries (for phased build)

1. **Render engine** (`render/`) — pure, no DB. Independently testable.
2. **Template registry + override store + `renderEmail`** — depends on (1) + DB.
3. **Convert existing transactional emails** — depends on (2). Ships value alone (editable transactional emails).
4. **Audience engine** (`audience/`) — pure-ish query compiler + resolver. Independently testable.
5. **Campaigns + dispatch + UI** — depends on (2) and (4).

## Testing (TDD)

- **Render engine:** variable substitution; HTML escaping / injection attempts; `{{#if}}`/`{{else}}` truthiness; unknown variables; unbalanced blocks; layout wrapping.
- **Override resolution:** DB present vs absent → correct subject/body; reset-to-default.
- **Audience resolver:** each whitelisted condition → expected query/results; AND/OR composition; blank-email exclusion; per-run dedup unique constraint.
- **Campaign dispatch:** scheduled-due selection; recurring cron next-run; re-evaluation picks up data changes; status transitions; send-now path.
- **Converted transactional emails:** byte-for-byte (or semantically) identical default output to pre-refactor.

## Out of scope (YAGNI)

- In-app template version history / rollback (audit log covers accountability).
- WYSIWYG / block editor (raw HTML + variable palette).
- Cross-run "never resend" suppression and drip sequencing.
- A/B testing, open/click tracking.
