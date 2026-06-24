# Teams Notifications via Microsoft Graph — Design

**Date:** 2026-06-24
**Branch / worktree:** `feat/teams-notifications` (`.claude/worktrees/feat+teams-notifications`)
**Status:** Approved design, pending implementation plan

## Goal

Let HAVEN Hub deliver its existing notifications as Microsoft Teams 1:1 chat
messages (DMs), in addition to or instead of email, on a per-notification-type
basis chosen by an admin. The DM is sent from the already-connected mailer
account (the account that authorized the Graph mailer in `/admin/email`).

## Decisions (from brainstorming)

1. **Destination:** 1:1 Teams DM to each recipient, sent **from the connected
   mailer account** (same delegated credential used for email today).
2. **Delivery model:** **admin-configurable per notification type** — each type
   routes to `email`, `teams`, or `both`. Defaults to `email`, so behavior is
   unchanged until an admin opts a type into Teams.
3. **Fallback:** when a type is set to `teams` but Teams delivery isn't possible
   for a recipient (no resolvable Teams identity, or permanent send failure),
   **fall back to email** so compliance-critical messages always land somewhere.
4. **Message format:** **short summary + link** — a concise title + 1–2 line
   summary with a link back to the relevant HAVEN Hub page. (Teams chat messages
   render only a limited subset of HTML; full email templates are not reused.)

## Current architecture (baseline)

- No generic notification system. Notifications today are domain-specific
  **emails** queued into an outbox and drained by cron.
- `queueEmail(db, input)` — `src/platform/email/send.ts` — writes an `EmailLog`
  row (`status=QUEUED`) inside the caller's DB transaction.
- `drainEmailQueue(transport)` — drained by `/api/cron/email`
  (`src/app/api/cron/email/route.ts`), every minute; up to 25 oldest QUEUED,
  retry with attempts, `FAILED` after max attempts.
- `GraphTransport.send()` — `src/platform/email/transport.ts` — POSTs
  `/users/{sender}/sendMail`.
- Delegated OAuth — `src/platform/email/oauth.ts` — `getAccessToken()` with
  refresh-token rotation; credential stored in the singleton `MailCredential`
  row. Current scopes: `Mail.Send`, `Mail.Send.Shared`, `Channel.ReadBasic.All`,
  plus `openid profile email offline_access`.
- `Person` model has `entraObjectId` (Azure AD object id, optional, unique) and
  `contactEmail` (optional, unique). No Teams-specific id.
- Existing notification types (email-template descriptors):
  `compliance-reminder`, `compliance-escalation`, `epic-onboarding`,
  `epic-activation`, `epic-password-reset`.

## Approach (selected)

**Unified `notify()` dispatcher + a parallel Teams outbox**, both drained by the
existing cron. Reuses all existing Graph token infrastructure. (Alternatives
considered: overloading `EmailLog` with a `channel` column — rejected for muddy
payload/identity semantics; a standalone Teams service with no dispatcher —
rejected for duplication/drift.)

### 1. Notification type registry & routing

- A registry keyed by the existing template descriptors. Each entry: `key`,
  human `label`, `defaultChannel` (`email`).
- A new `notify(db, input)` dispatcher replaces the direct `queueEmail()` calls
  at the ~5 existing sites. Callers pass **both** forms:
  - `email: { subject, html, template }` (unchanged from today)
  - `teams: { title, summary, link }` (new short form)
- `notify()` resolves the channel for that type from settings
  (`email | teams | both`) and queues to email and/or Teams accordingly — inside
  the caller's existing DB transaction, exactly like `queueEmail` today.

### 2. Teams identity resolution & transport

- `resolveTeamsUser(person)`:
  - use `Person.entraObjectId` if present;
  - else Graph `GET /users/{contactEmail}` to look up the Entra user, and cache
    the result back onto `Person.entraObjectId`;
  - if neither resolves → no Teams identity → fallback path.
- `GraphTeamsTransport.send()` (mirrors `GraphTransport`):
  1. `getAccessToken()` — reuses the existing connected mailer credential.
  2. Ensure a 1:1 chat: `POST /chats` with `chatType: oneOnOne` and members =
     [connected sender, recipient]. Graph returns the existing chat if one
     already exists, so this is effectively idempotent. Cache the resolved
     `chatId` on the Teams-message row.
  3. Post the message: `POST /chats/{chatId}/messages` with a short HTML body
     (title + summary + link back to HAVEN Hub).
- **New delegated scopes required:** `Chat.Create` + `ChatMessage.Send`. Because
  granted scopes change, the admin must **reconnect the mailer once** in
  `/admin/email` to re-consent. Surfaced clearly in the admin UI.

### 3. Teams outbox, drain & fallback

- **New `TeamsMessage` model** (mirrors `EmailLog`):
  - `id`, `personId`, `type` (registry key), `status` (`QUEUED|SENT|FAILED`)
  - `title`, `summary`, `link`, rendered `bodyHtml`
  - `chatId` (cached once resolved), `attempts`, `lastError`, `queuedAt`,
    `sentAt`
  - `fallbackSubject`, `fallbackHtml` — the email payload, stored so fallback can
    queue an email without re-involving the caller.
- **Drain:** extend `/api/cron/email` with `drainTeamsQueue(transport)` alongside
  `drainEmailQueue()` (same batch + retry shape).
- **Fallback to email** in two places:
  1. **At queue time** in `notify()`: if `resolveTeamsUser` finds no identity,
     skip Teams and queue the email immediately (mark the would-be Teams row for
     visibility in the admin monitor).
  2. **At drain time**: if a Teams send fails permanently (max attempts), the
     drainer queues an email from the stored `fallbackSubject`/`fallbackHtml`.

### 4. Admin UI & settings

- **Settings:** one per type — `notifications.<type>.channel` ∈
  `{email, teams, both}` (registry/resolver pattern; defaults to `email`).
- **Admin UI:** a "Notification channels" panel (on `/admin/email` or a sibling
  `/admin/notifications`) listing each type with an Email/Teams/Both selector,
  plus a Teams-message monitor table (status/type/recipient, retry action)
  mirroring the existing email monitor. The mailer-connection panel shows a note
  when Teams scopes aren't yet granted ("Reconnect to enable Teams DMs").

## Testing

- **Unit:** registry resolution; `notify()` routing for each channel value;
  identity resolution (entra id present vs. email lookup vs. unresolvable);
  fallback-at-queue and fallback-at-drain.
- **Transport:** mock Graph `POST /chats` + `/messages`; assert idempotent chat
  reuse and correct payloads.
- **Integration:** queue → drain → SENT; forced-failure → email fallback.

## Out of scope

- Channel (non-DM) posts; group chats.
- Per-user channel preferences (this iteration is admin-per-type only).
- Adaptive Cards (short HTML summary only).
- Application (app-only) Graph permissions / bot framework proactive messaging.

## Operational notes

- Adding scopes requires a one-time mailer reconnect by an admin.
- New env: none required beyond existing Graph OAuth config; the Teams DM uses
  the same connected account. `Person.entraObjectId` is populated lazily.
- Test DB isolation: this worktree should use a per-worktree `TEST_DATABASE_URL`
  (see project memory on vitest test DB isolation) since a Prisma migration adds
  the `TeamsMessage` table.
