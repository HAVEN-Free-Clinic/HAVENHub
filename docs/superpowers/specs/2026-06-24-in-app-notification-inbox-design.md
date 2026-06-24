# In-App Notification Inbox (bell) — Design

**Date:** 2026-06-24
**Branch / worktree:** `feat/notification-inbox` (`.claude/worktrees/feat+notification-inbox`, off `origin/main`)
**Status:** Approved design, pending implementation plan

## Goal

Give every signed-in person an in-app notification inbox: a bell icon next to
the user profile in the app toolbar showing an unread count, a dropdown of
recent notifications, and a full `/notifications` page. Also add the admin
"Notifications" delivery-monitor link (`/admin/notifications`) to the admin tab
bar (it shipped in PR #54 but was never linked).

## Context (baseline, already in main)

- A unified `notify(db, input)` dispatcher (`src/platform/notifications/notify.ts`)
  is called at the ~5 notification sites. It already receives, per call:
  - `person: { id, entraObjectId, contactEmail }`
  - `email: { subject, html }`
  - `teams: { title, summary, link? }`  ← the short form, reused for in-app
  - `type` (registry key)
- It routes to the email outbox and/or the `TeamsMessage` outbox per the
  per-type channel setting (`email | teams | both`).
- `/admin/notifications` is the admin delivery monitor (Teams queue). The new
  personal inbox is a DIFFERENT, user-facing page at `/notifications`.
- The app shell (`src/platform/ui/app-shell.tsx`) is the single persistent
  toolbar; it does NOT re-render on soft navigation (per project memory), so a
  server-fetched count there would go stale.

## Decisions (from brainstorming)

1. **Always created, independent of channel.** `notify()` always writes one
   in-app `Notification` for the recipient, regardless of the Email/Teams
   routing. The bell is a reliable "everything addressed to me" record.
2. **Dropdown panel + full page.** Bell opens a dropdown of the ~10 most recent
   with a "View all" link to `/notifications`.
3. **Count badge; per-item read + mark-all.** Bell shows a numeric unread count.
   Opening a notification (clicking its link) marks that one read; a "Mark all
   as read" action clears the rest.
4. **Shown to all signed-in users** (anyone can be a recipient).

## Architecture

### 1. Data model & creation

New Prisma model:

```prisma
model Notification {
  id        String    @id @default(cuid())
  personId  String
  type      String    // notification registry key
  title     String
  body      String
  link      String?
  readAt    DateTime? // null = unread
  createdAt DateTime  @default(now())
  person    Person    @relation("personNotifications", fields: [personId], references: [id], onDelete: Cascade)

  @@index([personId, createdAt])
  @@index([personId, readAt])
}
```

`Person` gains `notifications Notification[] @relation("personNotifications")`.

Creation: `notify()` always creates a `Notification` for `input.person.id` using
the short Teams form it already receives (`title` = `teams.title`, `body` =
`teams.summary`, `link` = `teams.link ?? null`, `type` = `input.type`). This is
unconditional — independent of the resolved Email/Teams channel — so no
call-site changes are required. The write uses the same `db` handle passed to
`notify()` (joins any surrounding transaction).

### 2. Service & access

A focused service module (`src/platform/notifications/inbox.ts`):
- `listNotifications(personId, { page }): { rows, total, page }` — newest-first,
  paginated by a `NOTIFICATIONS_PAGE_SIZE`.
- `unreadCount(personId): number`.
- `recentNotifications(personId, limit = 10): Notification[]` — for the dropdown.
- `markRead(personId, id)` — sets `readAt` only on a row owned by `personId`
  (owner-scoped; no-op if the row belongs to someone else or is already read).
- `markAllRead(personId)` — sets `readAt` on the person's unread rows.

All functions take the personId from the server session, never from the client.

### 3. API & mutations (works with the persistent shell)

Because the shell can't re-fetch on soft nav:
- `GET /api/notifications` — returns `{ unreadCount, recent }` for the signed-in
  person (auth via the existing session helper; 401 if unauthenticated).
- Mutations are **server actions** (`markReadAction`, `markAllReadAction`)
  resolving the person from the session, calling the service.

### 4. Bell UI

`<NotificationBell>` — a client component mounted in `app-shell.tsx` between the
theme toggle and the user avatar, styled like `ThemeToggle` (`h-8 w-8` button,
lucide `Bell` icon):
- Fetches `GET /api/notifications` on mount, on dropdown open, after any
  mark-read action, and on a light ~60s poll.
- Renders a count badge (capped display "9+") when `unreadCount > 0`.
- Dropdown (glass-panel styling) lists the ~10 recent: title, relative time,
  unread indicator. Clicking an item calls `markReadAction(id)` then navigates
  to its `link`. Footer: "Mark all as read" + "View all" → `/notifications`.
  Closes on outside-click / Esc.

### 5. Full page

`/notifications` (under the `(app)` route group, any signed-in person):
paginated full list, per-item read state and link, a "Mark all as read" button,
and an empty state. Distinct from the admin monitor at `/admin/notifications`.

### 6. Admin nav link

Add `{ label: "Notifications", href: "/admin/notifications" }` to the admin
module `nav` array in `src/platform/modules/registry.ts` (next to "Email"). This
links the admin delivery monitor that shipped unlinked in PR #54.

## Testing

- Service: `unreadCount`, `listNotifications` pagination, `recentNotifications`
  limit/order, `markRead` (owner-scoped; no-op on another person's row or an
  already-read row), `markAllRead`.
- `notify()`: creates exactly one `Notification` for the recipient on every
  dispatch, regardless of channel (`email`, `teams`, `both`).
- API route: returns only the signed-in person's unread count + recent;
  401 when unauthenticated.
- Bell/page: render with unread badge; "mark all as read" action clears unread.

## Out of scope (YAGNI)

- Real-time push / websockets (light client poll only).
- Per-type "in-app on/off" config (in-app is always on).
- Notification preferences, grouping, retention/purge (full list paginates;
  revisit if volume warrants).
- Notifications for non-`notify()` events.

## Operational notes

- A Prisma migration adds the `Notification` table; use the per-worktree test DB
  (`TEST_DATABASE_URL`) per project memory, and re-run `prisma generate` from
  this worktree before tests (shared-node_modules hazard).
