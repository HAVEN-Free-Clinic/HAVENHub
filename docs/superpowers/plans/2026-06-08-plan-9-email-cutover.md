# Plan 9: Microsoft Graph Email Cutover (Compliance Reminders, Monitoring, Go-Live) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn HAVEN Hub's email layer on: add HIPAA compliance reminder emails with director escalation, an admin surface to monitor and retry sends, and the live cutover to the Microsoft Graph transport.

**Architecture:** Spec: `docs/superpowers/specs/2026-06-08-email-cutover-design.md` (binding). Branch `plan-9/email-cutover` off `main` (independent of the open PRs #5-#7). The email pipe already exists from Plan 6 (`src/platform/email/`: transport.ts, send.ts queueEmail/drainEmailQueue, templates/epic.ts, the `email-send` worker queue, the EmailLog model). This plan adds a `ComplianceReminder` state table, a `runComplianceReminders` engine that reuses the plan-5 compliance status engine and queues via the existing `queueEmail`, two new templates, a daily worker cron, and a `/admin/email` monitoring page. The live Graph send is a controller checkpoint.

**Tech stack:** Existing stack only. No new dependencies.

**Decisions from Jack (binding):**
- Reminders go to the volunteer; directors get one email per escalated volunteer after 3 unheeded reminders.
- Triggers: EXPIRING_SOON, EXPIRED, NO_CERTIFICATE, UNKNOWN_DATE. Cadence: at most one reminder per person per 7 days (tunable via config). Escalate after 3.
- Admin: `/admin/email` viewer + retry-failed; failed count on the admin overview.
- Live Graph send verified before the PR (the Entra registration will be ready).

**Key existing signatures (consume; do not modify):**
- `queueEmail(db, { to, subject, html, template, personId?, triggeredById? }): Promise<EmailLog>` in `src/platform/email/send.ts`.
- `complianceStatus(cert: { completionDate: Date | null } | null, termEnd: Date | null, now?: Date): ComplianceStatus` and `certExpiresAt(completionDate: Date): Date` in `src/platform/compliance/rules.ts`. ComplianceStatus union: `"COMPLIANT" | "EXPIRING_SOON" | "EXPIRED" | "UNKNOWN_DATE" | "NO_CERTIFICATE"`.
- `EPIC_TEMPLATES` map + `EpicTemplateKey` pattern in `src/platform/email/templates/epic.ts` (mirror for compliance templates).
- The all-people candidate scan + newest-cert-per-person pattern in `src/platform/compliance/mirror-status.ts` (`refreshComplianceMirror`) and `src/modules/volunteers/services/compliance.ts` (newest cert via `orderBy uploadedAt desc, take 1`).

**Conventions (binding):** no em-dashes; "HAVEN Hub" prose; UTC dates; audits on mutations; services trust callers; permission checks at the page/action layer; TDD for engine/service code.

---

### Task 0: Branch + plan commit
- [ ] `git checkout main && git pull` (ensure current); `git checkout -b plan-9/email-cutover`; commit this doc and the spec.

### Task 1: Schema + config
**Files:** `prisma/schema.prisma`, migration `compliance_reminder`, `src/platform/test/db.ts`, `src/platform/config.ts` (+ `config.test.ts`).
- Add the model (READ the schema's comment/relation conventions first):
```prisma
/// Per-person HIPAA reminder state. Drives the weekly cadence (lastRemindedAt),
/// the escalation threshold (remindersSent), and the once-only director
/// escalation (escalatedAt). Reset to zero when the person becomes COMPLIANT.
model ComplianceReminder {
  id             String    @id @default(cuid())
  personId       String    @unique
  remindersSent  Int       @default(0)
  lastRemindedAt DateTime?
  lastStatus     String?
  escalatedAt    DateTime?
  person         Person    @relation(fields: [personId], references: [id], onDelete: Cascade)
}
```
  Person gains `complianceReminder ComplianceReminder?`.
- Config: `COMPLIANCE_REMINDER_INTERVAL_DAYS: z.string().default("7").transform(Number).pipe(positive-int refine)` and `COMPLIANCE_ESCALATION_THRESHOLD: z.string().default("3").transform(Number).pipe(positive-int refine)`, copying the `MAX_UPLOAD_MB` superRefine shape (message "must be a positive number"). config.test.ts: defaults are 7 and 3; "abc"/"0"/"-1" rejected for each.
- `npx prisma migrate dev --name compliance_reminder`; INSPECT SQL: additive only (CREATE TABLE + unique index + FK + the Person relation needs no column). STOP on any DROP. NEVER `prisma migrate reset` (dev DB has live data).
- `resetDb()` TRUNCATE list gains `"ComplianceReminder"`.
- `npm run test:prepare`, full `npm test`, `npm run typecheck`.
- Commit: `feat(email): compliance reminder state schema + cadence config`

### Task 2: Compliance templates (TDD)
**Files:** `src/platform/email/templates/compliance.ts` + `compliance.test.ts`.
- Mirror `epic.ts`'s structure (an `esc()` html-escaper, pure functions, a registry map). Reuse `esc` by copying the tiny helper (templates are self-contained; do not cross-import from epic.ts).
```ts
import type { ComplianceStatus } from "@/platform/compliance/rules";
export type ComplianceReminderParams = { personName: string; status: ComplianceStatus; expiresAt: Date | null };
export type ComplianceEscalationParams = { directorName: string; volunteerName: string; departmentName: string; status: ComplianceStatus };
export function complianceReminderEmail(p: ComplianceReminderParams): { subject: string; html: string };
export function complianceEscalationEmail(p: ComplianceEscalationParams): { subject: string; html: string };
export const COMPLIANCE_TEMPLATES = {
  "compliance-reminder": complianceReminderEmail,
  "compliance-escalation": complianceEscalationEmail,
} as const;
export type ComplianceTemplateKey = keyof typeof COMPLIANCE_TEMPLATES;
```
  - `complianceReminderEmail`: subject `[HAVEN] HIPAA certification reminder`. Body branches on status: EXPIRING_SOON -> "Your HIPAA certification expires on <fmtDate(expiresAt)>." EXPIRED -> "Your HIPAA certification expired on <fmtDate(expiresAt)>." NO_CERTIFICATE / UNKNOWN_DATE -> "We do not have a current HIPAA certificate on file for you." COMPLIANT should never be passed (defensive: render a neutral "Your HIPAA certification is up to date." line). All bodies include a paragraph "Please upload or renew your certificate in My Info." A small local `fmtDate(d: Date | null): string` (UTC, "Month D, YYYY"; "soon" when null). HTML-escape personName.
  - `complianceEscalationEmail`: subject `[HAVEN] Volunteer HIPAA compliance needs attention`. Body: "Hello <directorName>," then "<volunteerName> in <departmentName> is not HIPAA compliant (<readable status>) and has not responded to reminders. Please follow up." A status-to-readable map (EXPIRING_SOON -> "expiring soon", EXPIRED -> "expired", NO_CERTIFICATE -> "no certificate on file", UNKNOWN_DATE -> "completion date needed"). Escape all interpolations.
- Tests: each status branch renders distinct non-empty html containing the escaped person name; expiry date rendered when present; the two COMPLIANCE_TEMPLATES keys are exactly present; a `<script>` name is escaped; escalation names volunteer + department + readable status.
- Commit: `feat(email): compliance reminder and escalation templates`

### Task 3: Reminder engine (TDD)
**Files:** `src/platform/email/reminders.ts` + `reminders.test.ts`.
- READ first: `src/platform/compliance/mirror-status.ts` (candidate scan), `src/modules/volunteers/services/compliance.ts` (newest cert selection + active-term resolution), `src/platform/compliance/rules.ts` (complianceStatus/certExpiresAt), `src/platform/email/send.ts` (queueEmail), the new `compliance.ts` templates, `src/platform/config.ts` (the two new constants).
```ts
export type ReminderRunResult = { remindersSent: number; escalationsSent: number; reset: number; skipped: number };
export async function runComplianceReminders(now: Date = new Date()): Promise<ReminderRunResult>;
```
  Algorithm:
  1. Resolve the ACTIVE term (latest startDate). If none, return all-zero (no reminders without a term).
  2. Candidate people: ACTIVE Persons with an ACTIVE membership in the active term (one query: termMembership where termId + status ACTIVE, distinct personId; then person where id in set AND status ACTIVE). Include contactEmail, name.
  3. Load each candidate's newest cert (one query: hipaaCertificate where personId in set, orderBy [personId asc, uploadedAt desc]; reduce to first-per-person in JS) and their existing ComplianceReminder row (one query, map by personId).
  4. For each candidate compute `status = complianceStatus(newestCert ?? null mapped to { completionDate }, activeTerm.endDate, now)`.
  5. COMPLIANT: if a reminder row exists with remindersSent > 0 OR escalatedAt set OR lastRemindedAt set, reset it (`update` to remindersSent 0, lastRemindedAt null, lastStatus null, escalatedAt null) and `reset++`. Continue.
  6. Non-compliant (any of the four): 
     - If the row exists and `lastRemindedAt` is within `COMPLIANCE_REMINDER_INTERVAL_DAYS` of `now` (now - lastRemindedAt < interval ms): `skipped++` and continue. No reminder and no escalation evaluation happen inside the dedup window; escalation is only evaluated in the same step that sends a reminder (below).
     - Otherwise (no row, or lastRemindedAt older than the interval): when the person has a contactEmail, `queueEmail(prisma, { to: contactEmail, subject+html from complianceReminderEmail({ personName: name, status, expiresAt: newestCert?.completionDate ? certExpiresAt(completionDate) : null }), template: "compliance-reminder", personId })`; upsert the ComplianceReminder row with `remindersSent = (existing?.remindersSent ?? 0) + 1`, `lastRemindedAt = now`, `lastStatus = status`; `remindersSent++` (the result counter). When no contactEmail, skip the send but STILL do not advance state (count `skipped`); leave a console note.
     - After a successful reminder send+increment, when the new `remindersSent >= COMPLIANCE_ESCALATION_THRESHOLD` and the row's `escalatedAt` is null: resolve the person's directors = ACTIVE DIRECTOR memberships in the active term in any department where the person has an ACTIVE membership in the active term (one query joining the person's active-term departments; delegation NOT followed); dedupe director personIds; for each director with a contactEmail queue one `compliance-escalation` email (`directorName`, `volunteerName = person.name`, `departmentName` = the person's department in that membership; when multiple departments, use the first by code and note it) with `personId = the volunteer's id`, `triggeredById = null`; set `escalatedAt = now` on the row; `escalationsSent += <director emails queued>`.
  - All sends go through `queueEmail`; the engine never calls a transport. No per-email audit (EmailLog is the record).
- Tests (integration, resetDb; fixtures: active term with endDate, persons with contactEmail + ACTIVE memberships, certs with various completionDates to drive each status):
  - first run on an EXPIRED person with no row: one reminder queued (EmailLog row template compliance-reminder), row created remindersSent 1; `remindersSent === 1`.
  - second run immediately after: skipped (no new email), `skipped >= 1`, row unchanged.
  - advancing `now` past the interval: a second reminder queued, remindersSent 2.
  - reaching the threshold (3rd reminder): the director (fixture: a DIRECTOR member of the volunteer's department) gets one compliance-escalation EmailLog row, escalatedAt set, escalationsSent 1; a subsequent past-interval run does NOT re-escalate (escalatedAt already set) though it may still send the volunteer reminder.
  - person becomes COMPLIANT (swap in a fresh cert): next run resets the row (remindersSent 0, escalatedAt null), `reset === 1`, no email.
  - NO_CERTIFICATE and UNKNOWN_DATE persons both get reminders (status-driven).
  - person with no contactEmail: skipped, no row advance.
  - person with no active-term membership: ignored entirely.
  - no active term: all-zero result.
- Commit: `feat(email): compliance reminder engine with director escalation`

### Task 4: Worker cron
**Files:** `worker/index.ts`.
- Add `REMINDERS_QUEUE = "compliance-reminders"`, `boss.createQueue`, `boss.schedule(REMINDERS_QUEUE, "0 13 * * *")` (about 8am ET; after the 05:30 compliance refresh + 06:00 reconcile). Handler: `const r = await runComplianceReminders(); console.log(\`[worker] compliance reminders sent=${r.remindersSent} escalations=${r.escalationsSent} reset=${r.reset} skipped=${r.skipped}\`);`. Import runComplianceReminders.
- Run `npm run typecheck`; smoke `npm run worker` is optional (cron only fires on schedule). Confirm the file still boots in tests if any cover it.
- Commit: `feat(email): daily compliance reminder cron`

### Task 5: Admin email service (TDD)
**Files:** `src/modules/admin/services/email.ts` + `email.test.ts`.
- READ first: `src/modules/admin/services/people.ts` or an existing admin service for the pagination + audit conventions, `src/platform/email/send.ts` (EmailStatus), `src/platform/audit.ts`.
```ts
import type { EmailLog, EmailStatus } from "@prisma/client";
export type EmailRow = EmailLog; // raw row is fine; the page formats
export async function listEmails(q: { status?: EmailStatus; template?: string; q?: string; page?: number }): Promise<{ rows: EmailLog[]; total: number; counts: { queued: number; failed: number; sentToday: number } }>;
export async function retryEmail(actorPersonId: string, emailId: string): Promise<void>;
export async function emailHealthCounts(): Promise<{ queued: number; failed: number; sentToday: number }>;
```
  - `listEmails`: page size 25, newest first (createdAt desc); filter by status when given; template exact when given; `q` matches toEmail contains (case-insensitive). `counts` from grouped queries: queued = status QUEUED, failed = status FAILED, sentToday = status SENT AND sentAt >= start of today UTC. Typed errors `EmailNotFoundError`.
  - `retryEmail`: FAILED-only (else throw a typed `EmailStateError`); load row (EmailNotFoundError when missing); update status QUEUED, attempts 0, lastError null; audit `email.retry` (entityType "EmailLog", entityId, before: { status: "FAILED" }). The existing minute-cron drain re-sends.
  - `emailHealthCounts`: the same three counts (reused by the overview banner).
- Tests (integration, resetDb; seed EmailLog rows in various states): listEmails filtering (status, template, q), pagination boundary (26 -> page 2 has 1), counts correctness (sentToday respects UTC midnight + only SENT); retryEmail flips a FAILED row to QUEUED + audit row exists; retry on a SENT/QUEUED row throws EmailStateError; retry missing throws EmailNotFoundError.
- Commit: `feat(admin): email monitoring service`

### Task 6: Admin email page + overview banner + nav
**Files:** `src/app/admin/email/page.tsx`, `src/app/admin/page.tsx` (overview banner), `src/platform/modules/registry.ts` (admin nav).
- READ first: `src/app/admin/sync/page.tsx` (the closest analog: health counts + banner style), `src/app/admin/audit/page.tsx` or `src/app/volunteers/master/page.tsx` (filter bar + stat cards + paginated table + the `?error=`/ConfirmButton patterns), `src/platform/ui/*`.
- `/admin/email`: `requirePermission("admin.manage_sync")`. Stat cards (Queued / Failed / Sent today) from `counts`. Filter bar (status Select of the EmailStatus values + "All"; template Select built from a small known-templates list: "epic-onboarding", "epic-activation", "epic-password-reset", "compliance-reminder", "compliance-escalation", plus "All"; search Input on recipient; GET form). Table: recipient (toEmail), template, status Badge (QUEUED default / SENT success / FAILED critical), attempts, lastError (truncated with title attr), created (UTC) / sent (UTC). Retry ConfirmButton on FAILED rows posting a server action -> `retryEmail(session.personId, id)`, typed errors -> `?error=`, success -> revalidatePath + `?retried=1`. Pagination. Empty state.
- Admin overview (`/admin/page.tsx`): call `emailHealthCounts()`; when `failed > 0` render a line in the existing health/banner area: "<failed> email(s) failed to send" linking to /admin/email. Match the existing sync-health banner styling (read how the mirror failed-count is shown).
- Registry: admin module nav gains `{ label: "Email", href: "/admin/email" }` (after Sync).
- `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` (pkill -f "next dev" first) all green.
- Commit: `feat(admin): email monitoring page and overview banner`

### Task 7: Live cutover + e2e + gauntlet + PR
**Files:** `e2e/admin.spec.ts` (extend); `.env.example` (document the Graph + transport vars if not already present from Plan 6).
- e2e (2 tests, devLogin admin pattern from e2e/admin.spec.ts; the retry round trip is covered by the Task 5 integration test, so e2e stays at rendering + navigation which is deterministic without seeding EmailLog rows): (1) Jack opens /admin/email, the page heading and the three stat cards (Queued / Failed / Sent today) are visible; (2) Jack navigates to /admin/email?status=FAILED and the status filter Select shows the selected value and the table or empty-state renders without error.
- **Controller checkpoint (live Graph send, HARD GATE):** with the Entra app registration ready, set `EMAIL_TRANSPORT=graph` + `GRAPH_TENANT_ID` / `GRAPH_CLIENT_ID` / `GRAPH_CLIENT_SECRET` / `EMAIL_SENDER` in `.env`, run `npm run worker`, trigger one real send (either temporarily lower a test person's cert to force a reminder, or queue a one-off via a throwaway script/`queueEmail`), confirm Jack receives it and the EmailLog row reads SENT. Revert any test data. Do NOT commit real credentials; `.env` is gitignored.
- Full gauntlet (kill dev servers): `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run e2e`.
- Screenshots: /admin/email -> /tmp/havenhub-shots/.
- Push; PR onto `main`. Summary: compliance reminders + escalation, the daily cron, admin monitoring, and the confirmed live Graph send. Note in the PR that the live send was verified (or, if the registration slipped, that it ships on the log transport pending verification, per Jack's call). Watch CI green.

## Deferred deliberately (spec section 10)
- Other transactional emails (welcome, offboarding, disciplinary notices): small follow-ups when a need is confirmed.
- Per-person email preferences / unsubscribe.
- Inbound email / reply handling.
- Retiring the legacy Airtable reminder automations (manual, once platform reminders prove out).

---

## Delegated-OAuth transport tasks (added; spec section 11)

### Task 7a: OAuth schema + config
**Files:** `prisma/schema.prisma`, migration `mail_credential`, `src/platform/test/db.ts`, `src/platform/config.ts` (+ config.test.ts).
- Add `MailCredential` per spec 11.2 (id @default("mailer"), refreshToken, account?, scope?, connectedAt, updatedAt). resetDb TRUNCATE gains "MailCredential".
- Config: REMOVE GRAPH_TENANT_ID/GRAPH_CLIENT_ID/GRAPH_CLIENT_SECRET (client-credentials, abandoned); KEEP EMAIL_SENDER. ADD GRAPH_OAUTH_TENANT_ID, GRAPH_OAUTH_CLIENT_ID, GRAPH_OAUTH_CLIENT_SECRET (all optional), GRAPH_OAUTH_REDIRECT_URI (optional, default "http://localhost:3000/admin/email/oauth/callback"). The EMAIL_TRANSPORT=graph superRefine now requires GRAPH_OAUTH_TENANT_ID, GRAPH_OAUTH_CLIENT_ID, GRAPH_OAUTH_CLIENT_SECRET, GRAPH_OAUTH_REDIRECT_URI, EMAIL_SENDER. Update config.test.ts accordingly (defaults; graph mode missing-var rejection lists the new keys).
- Migration additive only; tests + typecheck green. Commit: `feat(email): mail credential schema + delegated oauth config`

### Task 7b: OAuth helper (TDD)
**Files:** `src/platform/email/oauth.ts` + `oauth.test.ts`.
- Per spec 11.4: `buildAuthorizeUrl({ state }): string` (authorize endpoint `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize` with client_id, response_type=code, redirect_uri, response_mode=query, scope "openid profile email offline_access https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.Send.Shared", state); `exchangeCode(code): Promise<void>` (token endpoint grant_type=authorization_code with client_secret + redirect_uri; upsert MailCredential { id: "mailer", refreshToken, account from id_token/userinfo or the token response, scope }); `getAccessToken(): Promise<string>` (read MailCredential else throw MailNotConnectedError; redeem grant_type=refresh_token; PERSIST the rotated refresh_token back to the row; cache access token in a module var until expires_in - 60s); `mailConnectionStatus(): Promise<{ connected; account; connectedAt }>`. Typed error `MailNotConnectedError`. Inject fetch (fetchImpl param defaulting to global) for tests; the DB store uses prisma directly. Read config for tenant/client/secret/redirect.
- Tests (mix: pure URL test + integration with resetDb for the DB-backed token store, stubbing fetch): buildAuthorizeUrl shape (contains client_id, redirect_uri encoded, scope, state); exchangeCode persists a MailCredential row with the refresh token; getAccessToken redeems + persists the ROTATED refresh token (assert the row's refreshToken changed to the new one) + caches (second call within expiry does not re-fetch); getAccessToken throws MailNotConnectedError with no row; token endpoint non-2xx throws; mailConnectionStatus reflects connected/disconnected.
- Commit: `feat(email): delegated oauth token helper`

### Task 7c: Rewrite GraphTransport (TDD)
**Files:** `src/platform/email/transport.ts` + `transport.test.ts`.
- GraphTransport now takes `{ getAccessToken: () => Promise<string>; sender: string; fetchImpl? }`. `send(message)` -> `const token = await getAccessToken();` then `POST https://graph.microsoft.com/v1.0/users/{encodeURIComponent(sender)}/sendMail` with Bearer token + the Graph message body (subject, body HTML, toRecipients, saveToSentItems true); non-2xx throws with status + text. Remove the old client-credentials token logic from the transport (it lives in oauth.ts now). `emailTransportFromConfig(config)`: when EMAIL_TRANSPORT=graph, return `new GraphTransport({ getAccessToken, sender: config.EMAIL_SENDER! })` where getAccessToken is the oauth.ts function; else LogTransport. Update transport.test.ts: stub getAccessToken + fetch; assert the sendMail request shape, sender in URL, non-2xx throws; LogTransport unchanged.
- Full `npm test` + typecheck. Commit: `feat(email): graph transport sends via delegated token`

### Task 7d: Admin connect UI + callback route
**Files:** `src/app/admin/email/page.tsx` (add connection panel + connect action), `src/app/admin/email/oauth/callback/route.ts` (new).
- Connection panel on /admin/email: call `mailConnectionStatus()`; show "Connected as <account> since <date UTC>" or "Not connected", plus a Connect/Reconnect Button posting a `connectMailerAction` server action: generate `state = crypto.randomUUID()`, set an httpOnly cookie `mailer_oauth_state` (short maxAge), `redirect(buildAuthorizeUrl({ state }))`. Only render the panel + action when EMAIL_TRANSPORT=graph? No: always render; the action will fail clearly if config is absent (catch + error banner). Gate: the page is already admin.manage_sync.
- callback route (GET, `src/app/admin/email/oauth/callback/route.ts`): `requirePermission("admin.manage_sync")` (or redirect to /login); read `code`, `state`, `error` from the URL; read the `mailer_oauth_state` cookie; when error present or state mismatch or missing code -> redirect `/admin/email?error=validation&message=<reason>`; else `await exchangeCode(code)`, `recordAudit({ action: "email.mailer_connect", entityType: "MailCredential", actorPersonId: session.personId })`, clear the cookie, redirect `/admin/email?connected=1`. Show "Mailbox connected." success line on connected=1.
- `npm test`, typecheck, lint, build green. Commit: `feat(admin): connect mailbox oauth flow`

### Task 7e: Live cutover + e2e + gauntlet + PR
- e2e already added in the prior Task 7 (email page renders + filter). Add one assertion that the connection panel shows "Not connected" by default (deterministic with no MailCredential row).
- **Controller checkpoint (HARD GATE):** Jack creates the "HAVEN Hub Mailer" Entra app (delegated Mail.Send + Mail.Send.Shared + offline_access), registers the redirect URI, sets GRAPH_OAUTH_* + EMAIL_SENDER + EMAIL_TRANSPORT=graph in .env, restarts dev + worker, clicks Connect mailbox on /admin/email, completes consent, then triggers one real reminder (force a test person's status) and confirms the EmailLog row reads SENT from hfc.it@yale.edu. Revert test data.
- Full gauntlet; screenshots /admin/email (with connection panel) -> /tmp/havenhub-shots/. Push, PR onto main, watch CI green.
