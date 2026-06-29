# Per-template / per-category email sender address

**Date:** 2026-06-29
**Branch:** `worktree-feat+email-sender-per-template` (off `main`)
**Status:** Approved design, ready for planning

## Problem

Every outbound email currently sends from one global address. `resolveEmailTransport()`
reads a single `email.sender` setting and builds one `GraphTransport`; every queued
row sends as that address via Microsoft Graph `/users/{sender}/sendMail`.

HAVEN Free Clinic needs recruitment email to come from a different delegated address
(one the connecting account, hfc.admin, also has Send-As rights on) rather than from
hfc.it@yale.edu. More generally, admins want to choose the "from" address per email
category, and override it per individual template when needed.

## Constraints and decisions

These were settled during brainstorming:

1. **Same login, Send-As shared mailbox.** The recruitment address is a shared mailbox
   the already-connected account can send AS. The stored OAuth token already carries
   `Mail.Send.Shared`, so NO second OAuth connection is needed. We send AS the other
   address with the same credential.
2. **Granularity: by category, with per-template override.** A category-level default
   plus an optional override on a single template.
3. **Free-text address per assignment.** No curated picker. The admin types the address.
   We de-risk this with a synchronous "send test" rather than a stored allow-list.

## Architecture

The key seam is `queueEmail(db, { template, ... })` in `src/platform/email/send.ts`.
EVERY send path funnels through it with a template key: recruitment, compliance, epic,
campaigns, and notifications. Resolving the sender there means one chokepoint covers all
of them, including recruitment per-cycle emails (they still pass `recruitment.*` keys).

The resolved address is SNAPSHOTTED onto the `EmailLog` row at enqueue time, so editing
a rule never rewrites the "from" of mail already sitting in the queue, and the log records
exactly what was intended.

### Data model

**`TemplateDescriptor` gains a `group` field** (`src/platform/email/templates/types.ts`).
Template keys are not consistently prefixed (recruitment uses dots like
`recruitment.acceptance`; compliance and epic use hyphens like `compliance-reminder`,
`epic-onboarding`), so the group is declared explicitly on each descriptor rather than
parsed from the key.

Sendable groups: `recruitment`, `compliance`, `epic`, `campaign`. The `layout` descriptor
is the shared wrapper and is never enqueued, so it is excluded from the sender UI; it may
carry `group: "layout"` to keep the type total.

**New table `EmailSenderRule`:**

```prisma
enum EmailSenderScope {
  CATEGORY
  TEMPLATE
}

model EmailSenderRule {
  id          String           @id @default(cuid())
  scope       EmailSenderScope
  /// Group name when scope=CATEGORY; template descriptor key when scope=TEMPLATE.
  target      String
  fromEmail   String
  fromName    String?
  updatedById String?
  updatedBy   Person?          @relation("emailSenderRuleUpdatedBy", fields: [updatedById], references: [id], onDelete: SetNull)
  createdAt   DateTime         @default(now())
  updatedAt   DateTime         @updatedAt

  @@unique([scope, target])
}
```

`@@unique([scope, target])` enforces at most one rule per category and per template.

**`EmailLog` gains two nullable columns:** `fromEmail String?`, `fromName String?`.
A null `fromEmail` means "use the global default at send time", identical to today's
behavior. No backfill needed: existing rows stay null.

A migration adds the enum, the table, and the two columns.

### Resolution service (cached)

New module (for example `src/platform/email/sender-rules.ts`):

```
resolveSenderForTemplate(templateKey): { fromEmail, fromName } | null
```

Precedence:

1. `TEMPLATE` rule whose `target` equals the template key.
2. `CATEGORY` rule whose `target` equals the template's group.
3. `null` (caller falls back to the global default).

Group lookup: `getDescriptor(key)?.group` if the key is a registered descriptor; else a
small static map for system keys that have no descriptor (`campaign` and `campaign:*`
both map to group `campaign`); else none.

Rules are loaded once into an in-memory Map and invalidated on any save or delete. This
matters because campaign dispatch (`executeRun` in
`src/platform/email/campaigns/service.ts`) calls `queueEmail` in a per-recipient loop:
a DB read per row would be N queries. The cache mirrors the existing settings-cache
pattern. `resetDb` clears this cache in tests, the same way it clears the settings cache,
to avoid cross-test leakage.

### Enqueue (chokepoint)

`queueEmail` resolves the sender from the template key and writes `fromEmail` / `fromName`
onto the new `EmailLog` columns. `QueueEmailInput` does not change; callers are untouched.

### Transport and Graph send

In `src/platform/email/transport.ts`:

- `EmailMessage` gains optional `from?: string` and `fromName?: string`.
- `GraphTransport.send` sends as `message.from?.trim() || this.sender` and builds the
  URL with that address. When `fromName` is present it adds a
  `from: { emailAddress: { address, name } }` block to the message body for the display
  name. (Validate during testing that combining the `/users/{address}/sendMail` path with
  an explicit `from` block behaves as expected for shared-mailbox Send-As.)
- `LogTransport.send` logs the from address for dev visibility.

In `src/platform/email/send.ts`, `drainEmailQueue` passes
`from: row.fromEmail ?? undefined, fromName: row.fromName ?? undefined` to
`transport.send`. Rows with a null `fromEmail` behave exactly as today (the transport's
configured default sender).

## Admin UI

### Category defaults (`/admin/email`)

A new "Send-from addresses" section listing each sendable group (Recruitment, Compliance,
Epic, Campaigns). Each row: free-text email field, optional display-name field, and a
"Send test" button. The global default (`email.sender`) is shown at the top as the
fallback so it is clear what an empty row inherits. Saving an email upserts a `CATEGORY`
rule; clearing it deletes the rule (falls back to the global default).

### Per-template override (`/admin/email/templates/[key]`)

A "Send from" field on the template editor: free-text email plus display name, with the
inherited category/global default shown as placeholder so the admin sees what a blank
field yields. "Reset to inherited" clears the `TEMPLATE` rule. A "Send test" sits beside
it. The template list page gets a small "custom sender" marker, mirroring the existing
subject/body override indicator.

### Test-send guardrail

A server action `sendSenderTest(actorId, fromEmail, fromName?)` builds a one-off
`GraphTransport` with `sender = fromEmail` and sends a short test message directly to the
acting admin's own email, BYPASSING the queue, so any Graph rejection (malformed address,
no Send-As rights) surfaces synchronously as a readable error. In dev (the `log`
transport) it just logs. This is how the admin confirms a free-text address works before
relying on it.

## Edge cases

- Empty `fromEmail` is never stored as a rule (treated as "no rule").
- `fromName` is ignored unless `fromEmail` is set; the UI gates the name field on the
  email field.
- Address format is validated client and server side. Semantic validity (Send-As rights)
  is confirmed via the test send, not guessed.
- Unregistered template keys (for example ad-hoc notification templates) have no group, so
  only an exact `TEMPLATE` rule or the global default applies.
- An invalid address that slips past validation still fails safe: the queued row retries
  up to `MAX_ATTEMPTS` then becomes `FAILED` with `lastError`, exactly as today.

## Testing

- Resolution precedence (template beats category beats none) and cache invalidation on
  write.
- `queueEmail` snapshots the resolved `fromEmail` / `fromName`; null when no rule matches.
- `GraphTransport.send`: uses `message.from` over the configured default, builds the
  correct URL, includes the `from` block when `fromName` is present, and falls back to
  `this.sender` when `from` is absent.
- `drainEmailQueue` forwards `row.fromEmail` / `row.fromName` to the transport.
- End to end: a recruitment `CATEGORY` rule makes `recruitment.acceptance` enqueue with
  the recruitment address recorded on `EmailLog.fromEmail`.
- `sendSenderTest` returns a readable error when Graph responds non-OK (mocked fetch).

## Out of scope

- A second OAuth connection / multiple `MailCredential` rows (not needed; same login
  sends as the shared mailbox).
- A curated allow-list of sender addresses (the chosen approach is free text plus test
  send).
- Per-recruitment-cycle sender override (recruitment cycle emails inherit the recruitment
  category/template sender through the same chokepoint; a per-cycle axis can be added
  later if needed).
- Per-campaign sender selection in the campaign composer (campaigns inherit the `campaign`
  category rule; a per-campaign column on `EmailCampaign` is a possible future addition).

## Implementation notes

- Per project memory (Local DB Neon hazard): the repo `.env` points all DB URLs at the
  shared Neon database. Do NOT run `prisma migrate` or vitest `resetDb` against it. Spin
  up a throwaway local Postgres and a worktree-local `.env` (with `TEST_DATABASE_URL`)
  for migrating and testing.
- Per project memory (Stale Prisma client across worktrees): node_modules / the generated
  Prisma client may be shared across worktrees. After adding the schema fields, generate
  the client against this worktree before relying on the new types.
