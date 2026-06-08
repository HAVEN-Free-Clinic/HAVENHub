# Microsoft Graph Email Cutover: Compliance Reminders, Monitoring, Go-Live

**Date:** 2026-06-08
**Status:** Approved design, pre-implementation
**Builds on:** Plan 6 (the platform email layer: transport, queue, EmailLog, Epic templates)

## 1. Goal

Turn HAVEN Hub's email layer on. Plan 6 built the pipe (Graph + log transports, the `email-send` queue draining every minute, the `EmailLog` table, Epic notification templates) but left it on the log transport with only Epic notifications wired. This plan adds the one substantial sender the platform still needs (HIPAA compliance reminders with director escalation), an admin surface to monitor and retry sends, and the live cutover to the Graph transport.

## 2. Binding decisions (from Jack)

- **Compliance reminders go to the volunteer; directors get escalated emails after the volunteer ignores reminders.**
- **Triggers:** EXPIRING_SOON, EXPIRED, NO_CERTIFICATE, and UNKNOWN_DATE all earn a reminder. Cadence: at most one reminder per person every 7 days. Escalation fires after 3 unheeded reminders.
- **Escalation format:** one email per escalated volunteer to each of that volunteer's directors (not a digest).
- **Admin surface:** a new `/admin/email` page with a filterable EmailLog viewer and a Retry action for FAILED rows, plus a failed-count on the admin overview.
- **Cutover is a hard gate:** the Entra app registration (Mail.Send for the shared mailbox) will be ready; one real Graph send must be verified before the PR.

**Conventions (binding):** no em-dashes; "HAVEN Hub" prose; UTC dates; audits on mutations; services trust callers; permission checks at the page/action layer; TDD for engine/service code.

## 3. Data model

One new table; no changes to existing tables.

```prisma
/// Per-person HIPAA reminder state. Drives the weekly cadence (lastRemindedAt),
/// the escalation threshold (remindersSent), and the once-only director
/// escalation (escalatedAt). Reset to zero when the person becomes COMPLIANT.
model ComplianceReminder {
  id            String    @id @default(cuid())
  personId      String    @unique
  /// Count of volunteer reminders sent in the current non-compliant streak.
  remindersSent Int       @default(0)
  /// When the most recent volunteer reminder was queued (the 7-day dedup anchor).
  lastRemindedAt DateTime?
  /// The computed compliance status at the last reminder (for template wording and audit).
  lastStatus    String?
  /// Set once when the director escalation email is queued; cleared on reset.
  escalatedAt   DateTime?
  person        Person    @relation(fields: [personId], references: [id], onDelete: Cascade)
}
```

Person gains the back-relation `complianceReminder ComplianceReminder?`.

Config: `COMPLIANCE_REMINDER_INTERVAL_DAYS` (default 7) and `COMPLIANCE_ESCALATION_THRESHOLD` (default 3), both positive-int validated, so the cadence is tunable without a code change.

## 4. Reminder engine (`src/platform/email/reminders.ts`)

`runComplianceReminders(now = new Date()): Promise<{ remindersSent: number; escalationsSent: number; reset: number; skipped: number }>`.

Algorithm, over every ACTIVE person with at least one ACTIVE membership in the ACTIVE term:
1. Compute HIPAA status with the plan-5 engine (newest cert + active term + `now`), exactly as the compliance dashboards do.
2. **COMPLIANT** -> if a ComplianceReminder row exists with non-zero state, reset it (remindersSent 0, lastRemindedAt null, lastStatus null, escalatedAt null) and count `reset`. No email.
3. **Non-compliant** (EXPIRING_SOON / EXPIRED / NO_CERTIFICATE / UNKNOWN_DATE):
   - Skip (count `skipped`) when a reminder was sent within `COMPLIANCE_REMINDER_INTERVAL_DAYS` (lastRemindedAt within the window).
   - Otherwise queue a `compliance-reminder` email to the person's contactEmail (skip + log when they have none), upsert the row with `remindersSent += 1`, `lastRemindedAt = now`, `lastStatus = status`; count `remindersSent`.
   - After incrementing, when `remindersSent >= COMPLIANCE_ESCALATION_THRESHOLD` and `escalatedAt` is null: for each director (ACTIVE DIRECTOR membership in the active term in any department where the person has an ACTIVE membership; deduped, delegation NOT followed) with a contactEmail, queue one `compliance-escalation` email naming the volunteer + department; set `escalatedAt = now`; count `escalationsSent` (one per director email). The escalation fires once per streak.
- All emails go through the existing `queueEmail(prisma, {...})`; the engine never sends directly. No audit row per email (the EmailLog row IS the record); a single summary is logged by the worker.

This is a platform service (both volunteers compliance and the worker conceptually consume reminder state), tested as an integration service against the DB.

## 5. Templates (`src/platform/email/templates/compliance.ts`)

Pure functions returning `{ subject, html }`, registered in a `COMPLIANCE_TEMPLATES` map keyed `compliance-reminder` / `compliance-escalation` (same shape as `EPIC_TEMPLATES`).
- `complianceReminderEmail({ personName, status, expiresAt? })`: status-aware body. EXPIRING_SOON -> "Your HIPAA certification expires on `<date>`." EXPIRED -> "Your HIPAA certification expired on `<date>`." NO_CERTIFICATE/UNKNOWN_DATE -> "We do not have a current HIPAA certificate on file for you." All link to My Info to upload/renew. Subject `[HAVEN] HIPAA certification reminder`.
- `complianceEscalationEmail({ directorName, volunteerName, departmentName, status })`: "`<volunteerName>` in `<departmentName>` is not HIPAA compliant (`<status>`) and has not responded to reminders." Subject `[HAVEN] Volunteer HIPAA compliance needs attention`.
HTML-escape interpolated values; no em-dashes.

## 6. Worker

A `compliance-reminders` pg-boss queue, cron `0 13 * * *` (about 8am ET; after the 05:30 nightly compliance refresh so statuses are fresh). Handler calls `runComplianceReminders()` and logs the summary counts. Per-person 7-day dedup means the daily run emails each person at most weekly while letting a newly-lapsed person get their first reminder within a day.

## 7. Admin email surface

- **`src/modules/admin/services/email.ts`:** `listEmails({ status?, template?, q?, page? })` (paginated, newest first, person/recipient search) and `retryEmail(actorPersonId, emailId)` (FAILED-only; sets status QUEUED + attempts 0; the minute-cron drain re-sends; audit `email.retry`). `emailHealthCounts()` returns `{ queued, failed, sentToday }` for the overview banner.
- **`/admin/email`** (gated `requirePermission("admin.manage_sync")`): filter bar (status select, template select, search), summary stat cards (queued / failed / sent today), table (recipient, template, status Badge, attempts, lastError truncated, created/sent UTC), Retry ConfirmButton on FAILED rows. Registry admin nav gains `{ Email, /admin/email }`.
- **Admin overview:** the existing sync-health banner area gains a failed-email line when `failed > 0`, linking to /admin/email.

## 8. Cutover (controller checkpoint, hard gate)

With the Entra app registration ready: set `EMAIL_TRANSPORT=graph` and `GRAPH_TENANT_ID` / `GRAPH_CLIENT_ID` / `GRAPH_CLIENT_SECRET` / `EMAIL_SENDER` in the environment, run the worker, trigger one real `compliance-reminder` (or a manual test send) to Jack's address, confirm receipt and that the EmailLog row reads SENT. Only after a confirmed real send does the PR proceed. CI and dev stay on the log transport (config validation already enforces the Graph vars only when `EMAIL_TRANSPORT=graph`).

## 9. Testing

- **Engine (integration, resetDb):** weekly dedup (second run within the window sends nothing); escalation fires once at the threshold to each director and not again next cycle; reset on return to COMPLIANT clears count + escalation; each non-compliant status selects the right template wording inputs; no-contactEmail person skipped; person with no active membership ignored.
- **Templates (unit):** each status branch renders distinct, non-empty, escaped HTML naming the person; the two template keys are exactly present.
- **Admin service:** listEmails filtering/pagination/counts; retryEmail FAILED-only + audit + status reset; permission boundary at the page.
- **e2e (~2):** /admin/email renders the table + stat cards for an admin; a FAILED row retry round trip flips it to QUEUED.
- **Live:** the section-8 real send, before the PR.

## 10. Deferred deliberately

- Other transactional emails (welcome on roster add, offboarding notices, disciplinary notices): each is a small follow-up once a need is confirmed.
- Per-person email preferences / unsubscribe (internal clinic tool; not needed now).
- Inbound email / reply handling.
- Retiring the legacy Airtable reminder automations (manual, once the platform reminders prove out).
