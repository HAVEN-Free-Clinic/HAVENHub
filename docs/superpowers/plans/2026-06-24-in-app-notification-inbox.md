# In-App Notification Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every signed-in person an in-app notification inbox — a bell (with unread count + dropdown) next to the user profile and a full `/notifications` page — populated automatically by the existing `notify()` dispatcher; plus link the admin delivery monitor in the admin tab bar.

**Architecture:** A new per-person `Notification` table is written unconditionally by `notify()` (reusing the short form it already receives). A small inbox service exposes query + owner-scoped mark-read operations. The bell is a client component (the app shell is persistent and can't re-fetch on soft nav) that polls a read-only `GET /api/notifications`; mutations are server actions. A user-facing `/notifications` page lists everything.

**Tech Stack:** Next.js (App Router), TypeScript, Prisma (PostgreSQL), Zod where relevant, Vitest, lucide-react icons.

## Global Constraints

- **Product name:** "HAVEN Hub" (two words) in user-facing copy; identifiers stay `havenhub`.
- **No em-dashes** in user-facing copy or comments; use other punctuation.
- **TDD:** test-first for every service/route/integration task. UI (client component, server-rendered pages) has no unit test in this repo's `node` vitest env — verify those via `npx tsc --noEmit` and a described manual smoke.
- **Owner scoping:** every inbox read/mutation takes the `personId` from the server session, NEVER from client input. Mark operations use `updateMany` with `personId` in the `where`.
- **Test DB:** use the per-worktree DB `postgresql://haven:haven_dev@localhost:5434/havenhub_test_inbox` via `TEST_DATABASE_URL` for vitest. The migration runs against it with `DATABASE_URL` + `DATABASE_URL_UNPOOLED` both set to that URL. After any migrate, re-run `prisma generate` from this worktree before tests (the shared main `node_modules` client can be regenerated from main's schema by other processes — symptom: `db.notification undefined`).
- **Distinct routes:** `/notifications` is the new per-user inbox (any signed-in person). `/admin/notifications` is the pre-existing admin Teams delivery monitor — do not conflate.
- **`notify()` writes in-app unconditionally** — independent of the resolved Email/Teams channel.

---

## File Structure

**New files**
- `src/platform/notifications/inbox.ts` — Notification create + query + mark service.
- `src/platform/notifications/inbox.test.ts`
- `src/platform/notifications/inbox-actions.ts` — `"use server"` markRead/markAllRead actions.
- `src/platform/notifications/inbox-actions.test.ts`
- `src/app/api/notifications/route.ts` — `GET` unread count + recent for the signed-in person.
- `src/app/api/notifications/route.test.ts`
- `src/platform/ui/notification-bell.tsx` — client bell (badge + dropdown).
- `src/app/(app)/notifications/page.tsx` — full inbox page.

**Modified files**
- `prisma/schema.prisma` — add `Notification` model + `Person.notifications` relation.
- `src/platform/notifications/notify.ts` — call `createNotification` unconditionally.
- `src/platform/notifications/notify.test.ts` — assert a Notification row is created per dispatch.
- `src/platform/ui/app-shell.tsx` — mount `<NotificationBell />` in the toolbar.
- `src/platform/modules/registry.ts` — add the admin "Notifications" nav link.

---

## Task 1: Notification schema + migration

**Files:**
- Modify: `prisma/schema.prisma` (add model after an existing model; add relation to `Person`)
- Test: `src/platform/notifications/inbox-schema.test.ts`

**Interfaces:**
- Produces: Prisma model `Notification { id, personId, type, title, body, link?, readAt?, createdAt }` with indexes `[personId, createdAt]` and `[personId, readAt]`; `Person.notifications` relation (`"personNotifications"`).

- [ ] **Step 1: Write the failing test**

```ts
// src/platform/notifications/inbox-schema.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";

describe("Notification model", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("creates and reads an unread notification linked to a person", async () => {
    const person = await prisma.person.create({
      data: { name: "Sam Volunteer", contactEmail: "sam@example.com" },
    });
    const row = await prisma.notification.create({
      data: {
        personId: person.id,
        type: "epic-activation",
        title: "EPIC access update",
        body: "Your EPIC access has been activated.",
        link: "https://hub.example.com/volunteers",
      },
    });
    expect(row.readAt).toBeNull();
    const found = await prisma.notification.findFirst({ where: { personId: person.id } });
    expect(found?.type).toBe("epic-activation");
  });
});
```

> `resetDb` is at `@/platform/test/db`. After adding the model, also add `"Notification"` to the TRUNCATE list in `src/platform/test/db.ts` (see Step 5) so it is cleared between tests.

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_inbox npx vitest run src/platform/notifications/inbox-schema.test.ts`
Expected: FAIL — `prisma.notification` is undefined.

- [ ] **Step 3: Add the model**

In `prisma/schema.prisma`, add (after the `TeamsMessage` model, or any model — placement is cosmetic):

```prisma
/// Per-person in-app notification (the bell inbox). Written unconditionally by
/// notify() for every notification addressed to a person, independent of the
/// Email/Teams channel routing. readAt null means unread.
model Notification {
  id        String    @id @default(cuid())
  personId  String
  /// Notification registry key (e.g. "epic-activation").
  type      String
  title     String
  body      String
  link      String?
  readAt    DateTime?
  createdAt DateTime  @default(now())
  /// Cascade: notifications do not outlive the person they address.
  person    Person    @relation("personNotifications", fields: [personId], references: [id], onDelete: Cascade)

  @@index([personId, createdAt])
  @@index([personId, readAt])
}
```

- [ ] **Step 4: Add the Person relation**

In `prisma/schema.prisma`, in the `Person` model, add (near the other relation fields, e.g. after `teamsMessages` if present, else after `emailLogs`):

```prisma
  notifications             Notification[]       @relation("personNotifications")
```

- [ ] **Step 5: Add Notification to resetDb**

In `src/platform/test/db.ts`, add `"Notification"` to the `TRUNCATE` list (it has a FK to Person; list it before `"Person"` or rely on CASCADE — adding it explicitly is clearest). Insert it alongside the other outbox tables, e.g. next to `"EmailLog"`:

```
"Notification", "EmailLog",
```

- [ ] **Step 6: Generate the migration and client**

Run from the worktree root (no `.env` here; Prisma needs both URLs, equal locally):
```bash
export DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_inbox
export DATABASE_URL_UNPOOLED=$DATABASE_URL
npx prisma migrate dev --name notification_inbox
```
Expected: a new migration dir under `prisma/migrations/`, client generated, no errors.

- [ ] **Step 7: Run test to verify it passes**

Run: `TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_inbox npx vitest run src/platform/notifications/inbox-schema.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/platform/test/db.ts src/platform/notifications/inbox-schema.test.ts
git commit -m "feat(notifications): add Notification model + migration"
```

---

## Task 2: Inbox service

**Files:**
- Create: `src/platform/notifications/inbox.ts`
- Test: `src/platform/notifications/inbox.test.ts`

**Interfaces:**
- Consumes: `prisma`; Prisma `Notification` type.
- Produces:
  - `const NOTIFICATIONS_PAGE_SIZE = 20`
  - `type CreateNotificationInput = { personId: string; type: string; title: string; body: string; link?: string | null }`
  - `createNotification(db: Db, input: CreateNotificationInput): Promise<Notification>` (Db = PrismaClient | Prisma.TransactionClient)
  - `unreadCount(personId: string): Promise<number>`
  - `recentNotifications(personId: string, limit?: number): Promise<Notification[]>` (default 10, newest-first)
  - `listNotifications(personId: string, params?: { page?: number }): Promise<{ rows: Notification[]; total: number; page: number }>`
  - `markRead(personId: string, id: string): Promise<void>` (owner-scoped, no-op otherwise)
  - `markAllRead(personId: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

```ts
// src/platform/notifications/inbox.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  createNotification,
  unreadCount,
  recentNotifications,
  listNotifications,
  markRead,
  markAllRead,
} from "./inbox";

async function person(name = "Sam") {
  return prisma.person.create({ data: { name, contactEmail: `${name}-${Math.random()}@x.com` } });
}

describe("inbox service", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("createNotification writes an unread row", async () => {
    const p = await person();
    const n = await createNotification(prisma, {
      personId: p.id,
      type: "epic-activation",
      title: "T",
      body: "B",
      link: "/volunteers",
    });
    expect(n.readAt).toBeNull();
    expect(await unreadCount(p.id)).toBe(1);
  });

  it("unreadCount only counts unread rows for that person", async () => {
    const a = await person("A");
    const b = await person("B");
    await createNotification(prisma, { personId: a.id, type: "t", title: "1", body: "b" });
    await createNotification(prisma, { personId: a.id, type: "t", title: "2", body: "b" });
    await createNotification(prisma, { personId: b.id, type: "t", title: "3", body: "b" });
    expect(await unreadCount(a.id)).toBe(2);
    expect(await unreadCount(b.id)).toBe(1);
  });

  it("recentNotifications returns newest-first, capped to the limit", async () => {
    const p = await person();
    for (let i = 0; i < 12; i++) {
      await createNotification(prisma, { personId: p.id, type: "t", title: `n${i}`, body: "b" });
    }
    const recent = await recentNotifications(p.id, 10);
    expect(recent).toHaveLength(10);
    expect(recent[0].title).toBe("n11");
  });

  it("listNotifications paginates", async () => {
    const p = await person();
    for (let i = 0; i < 3; i++) {
      await createNotification(prisma, { personId: p.id, type: "t", title: `n${i}`, body: "b" });
    }
    const { rows, total, page } = await listNotifications(p.id, { page: 1 });
    expect(total).toBe(3);
    expect(page).toBe(1);
    expect(rows).toHaveLength(3);
  });

  it("markRead is owner-scoped: it does not touch another person's row", async () => {
    const a = await person("A");
    const b = await person("B");
    const bRow = await createNotification(prisma, { personId: b.id, type: "t", title: "B", body: "b" });
    await markRead(a.id, bRow.id); // wrong owner
    const reloaded = await prisma.notification.findUnique({ where: { id: bRow.id } });
    expect(reloaded?.readAt).toBeNull();
    await markRead(b.id, bRow.id); // correct owner
    const after = await prisma.notification.findUnique({ where: { id: bRow.id } });
    expect(after?.readAt).not.toBeNull();
  });

  it("markAllRead clears all unread for the person only", async () => {
    const a = await person("A");
    const b = await person("B");
    await createNotification(prisma, { personId: a.id, type: "t", title: "1", body: "b" });
    await createNotification(prisma, { personId: a.id, type: "t", title: "2", body: "b" });
    await createNotification(prisma, { personId: b.id, type: "t", title: "3", body: "b" });
    await markAllRead(a.id);
    expect(await unreadCount(a.id)).toBe(0);
    expect(await unreadCount(b.id)).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_inbox npx vitest run src/platform/notifications/inbox.test.ts`
Expected: FAIL — cannot find module `./inbox`.

- [ ] **Step 3: Implement**

```ts
// src/platform/notifications/inbox.ts
import type { Prisma, PrismaClient, Notification } from "@prisma/client";
import { prisma } from "@/platform/db";

type Db = PrismaClient | Prisma.TransactionClient;

export const NOTIFICATIONS_PAGE_SIZE = 20;

export type CreateNotificationInput = {
  personId: string;
  type: string;
  title: string;
  body: string;
  link?: string | null;
};

/** Append an in-app notification. Accepts any Db handle (joins a surrounding tx). */
export async function createNotification(
  db: Db,
  input: CreateNotificationInput
): Promise<Notification> {
  return db.notification.create({
    data: {
      personId: input.personId,
      type: input.type,
      title: input.title,
      body: input.body,
      link: input.link ?? null,
    },
  });
}

/** Count unread notifications for a person. */
export async function unreadCount(personId: string): Promise<number> {
  return prisma.notification.count({ where: { personId, readAt: null } });
}

/** The most recent notifications for a person, newest-first. */
export async function recentNotifications(
  personId: string,
  limit = 10
): Promise<Notification[]> {
  return prisma.notification.findMany({
    where: { personId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

/** Paginated full list for a person, newest-first. */
export async function listNotifications(
  personId: string,
  params: { page?: number } = {}
): Promise<{ rows: Notification[]; total: number; page: number }> {
  const page = Math.max(1, params.page ?? 1);
  const [rows, total] = await Promise.all([
    prisma.notification.findMany({
      where: { personId },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * NOTIFICATIONS_PAGE_SIZE,
      take: NOTIFICATIONS_PAGE_SIZE,
    }),
    prisma.notification.count({ where: { personId } }),
  ]);
  return { rows, total, page };
}

/**
 * Mark one notification read. Owner-scoped via updateMany: the personId is in the
 * where clause, so a mismatched owner (or an already-read row) is a silent no-op
 * rather than touching another person's data.
 */
export async function markRead(personId: string, id: string): Promise<void> {
  await prisma.notification.updateMany({
    where: { id, personId, readAt: null },
    data: { readAt: new Date() },
  });
}

/** Mark all of a person's unread notifications read. */
export async function markAllRead(personId: string): Promise<void> {
  await prisma.notification.updateMany({
    where: { personId, readAt: null },
    data: { readAt: new Date() },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_inbox npx vitest run src/platform/notifications/inbox.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/platform/notifications/inbox.ts src/platform/notifications/inbox.test.ts
git commit -m "feat(notifications): in-app inbox service (create/query/mark)"
```

---

## Task 3: notify() writes an in-app notification unconditionally

**Files:**
- Modify: `src/platform/notifications/notify.ts`
- Test: `src/platform/notifications/notify.test.ts` (add cases; keep existing green)

**Interfaces:**
- Consumes: `createNotification` (Task 2).
- Produces: every `notify()` call creates exactly one `Notification` for `input.person.id` using the short form (`title`=`teams.title`, `body`=`teams.summary`, `link`=`teams.link ?? null`, `type`=`input.type`), regardless of channel.

- [ ] **Step 1: Write the failing test**

Add to `src/platform/notifications/notify.test.ts` (the file already mocks `resolveChannel`; reuse its helpers/imports):

```ts
import { createNotification as _cn } from "./inbox"; // ensure module resolves
import * as inboxChannel from "./channel";

it("always creates one in-app Notification for the recipient, regardless of channel", async () => {
  // channel = email
  vi.spyOn(inboxChannel, "resolveChannel").mockResolvedValue("email");
  const p1 = await makePerson({ entraObjectId: null });
  await notify(prisma, { type: "epic-onboarding", person: p1, email, teams });
  expect(await prisma.notification.count({ where: { personId: p1.id } })).toBe(1);

  // channel = teams
  vi.spyOn(inboxChannel, "resolveChannel").mockResolvedValue("teams");
  const p2 = await makePerson({ entraObjectId: "e2" });
  await notify(prisma, { type: "epic-onboarding", person: p2, email, teams });
  const n = await prisma.notification.findFirst({ where: { personId: p2.id } });
  expect(n?.title).toBe(teams.title);
  expect(n?.body).toBe(teams.summary);
});
```

> Use the same `makePerson`, `email`, `teams` fixtures already defined in this test file. If `resolveChannel` is already spied per-test there, follow that file's existing mocking style instead of re-importing.

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_inbox npx vitest run src/platform/notifications/notify.test.ts`
Expected: FAIL — no `notification` rows created.

- [ ] **Step 3: Wire createNotification into notify()**

In `src/platform/notifications/notify.ts`, add the import:

```ts
import { createNotification } from "./inbox";
```

Then, inside `notify()`, as the FIRST statement of the body (before `const channel = ...`), add:

```ts
  // In-app inbox: always recorded for the recipient, independent of the
  // Email/Teams channel routing below.
  await createNotification(db, {
    personId: input.person.id,
    type: input.type,
    title: input.teams.title,
    body: input.teams.summary,
    link: input.teams.link ?? null,
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_inbox npx vitest run src/platform/notifications/notify.test.ts`
Expected: PASS (new case + all existing notify cases).

- [ ] **Step 5: Commit**

```bash
git add src/platform/notifications/notify.ts src/platform/notifications/notify.test.ts
git commit -m "feat(notifications): notify() records an in-app notification per dispatch"
```

---

## Task 4: GET /api/notifications

**Files:**
- Create: `src/app/api/notifications/route.ts`
- Test: `src/app/api/notifications/route.test.ts`

**Interfaces:**
- Consumes: `auth` (`@/platform/auth/auth`), `getActivePerson` (`@/platform/auth/match-person`), `unreadCount` + `recentNotifications` (Task 2).
- Produces: `GET` returning `{ unreadCount: number, recent: Notification[] }` for the signed-in person; `401 { error }` when unauthenticated.

- [ ] **Step 1: Write the failing test**

```ts
// src/app/api/notifications/route.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";

// Mock the auth + person resolution the route depends on.
vi.mock("@/platform/auth/auth", () => ({ auth: vi.fn() }));
vi.mock("@/platform/auth/match-person", () => ({ getActivePerson: vi.fn() }));

import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";

describe("GET /api/notifications", () => {
  beforeEach(async () => {
    await resetDb();
    vi.resetAllMocks();
  });

  it("returns 401 when unauthenticated", async () => {
    (auth as unknown as vi.Mock).mockResolvedValue(null);
    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns the signed-in person's unread count and recent items", async () => {
    const p = await prisma.person.create({ data: { name: "Sam", contactEmail: "sam@x.com" } });
    await prisma.notification.create({
      data: { personId: p.id, type: "t", title: "Hi", body: "b" },
    });
    (auth as unknown as vi.Mock).mockResolvedValue({ personId: p.id });
    (getActivePerson as unknown as vi.Mock).mockResolvedValue({ id: p.id });

    const { GET } = await import("./route");
    const res = await GET();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.unreadCount).toBe(1);
    expect(json.recent[0].title).toBe("Hi");
  });
});
```

> If `vi.Mock` typing is awkward in this repo, cast with `as ReturnType<typeof vi.fn>` or `as any` consistent with other tests; the behavior asserted is what matters.

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_inbox npx vitest run src/app/api/notifications/route.test.ts`
Expected: FAIL — cannot find module `./route`.

- [ ] **Step 3: Implement**

```ts
// src/app/api/notifications/route.ts
import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";
import { unreadCount, recentNotifications } from "@/platform/notifications/inbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Read-only inbox snapshot for the signed-in person: unread count + recent. */
export async function GET(): Promise<Response> {
  const session = await auth();
  if (!session?.personId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const person = await getActivePerson(session.personId);
  if (!person) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const [count, recent] = await Promise.all([
    unreadCount(person.id),
    recentNotifications(person.id, 10),
  ]);
  return Response.json({ unreadCount: count, recent });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_inbox npx vitest run src/app/api/notifications/route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/notifications/route.ts src/app/api/notifications/route.test.ts
git commit -m "feat(notifications): GET /api/notifications (unread count + recent)"
```

---

## Task 5: Inbox server actions

**Files:**
- Create: `src/platform/notifications/inbox-actions.ts`
- Test: `src/platform/notifications/inbox-actions.test.ts`

**Interfaces:**
- Consumes: `requirePersonSession` (`@/platform/auth/session`), `markRead` + `markAllRead` (Task 2).
- Produces: `markReadAction(id: string): Promise<void>` and `markAllReadAction(): Promise<void>`, both resolving the person from the session.

- [ ] **Step 1: Write the failing test**

```ts
// src/platform/notifications/inbox-actions.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";

vi.mock("@/platform/auth/session", () => ({ requirePersonSession: vi.fn() }));
import { requirePersonSession } from "@/platform/auth/session";
import { markReadAction, markAllReadAction } from "./inbox-actions";

describe("inbox server actions", () => {
  beforeEach(async () => {
    await resetDb();
    vi.resetAllMocks();
  });

  it("markReadAction marks the signed-in person's notification read", async () => {
    const p = await prisma.person.create({ data: { name: "Sam", contactEmail: "s@x.com" } });
    const n = await prisma.notification.create({
      data: { personId: p.id, type: "t", title: "T", body: "b" },
    });
    (requirePersonSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ personId: p.id });
    await markReadAction(n.id);
    const after = await prisma.notification.findUnique({ where: { id: n.id } });
    expect(after?.readAt).not.toBeNull();
  });

  it("markAllReadAction clears the signed-in person's unread", async () => {
    const p = await prisma.person.create({ data: { name: "Sam", contactEmail: "s2@x.com" } });
    await prisma.notification.create({ data: { personId: p.id, type: "t", title: "1", body: "b" } });
    await prisma.notification.create({ data: { personId: p.id, type: "t", title: "2", body: "b" } });
    (requirePersonSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ personId: p.id });
    await markAllReadAction();
    expect(await prisma.notification.count({ where: { personId: p.id, readAt: null } })).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_inbox npx vitest run src/platform/notifications/inbox-actions.test.ts`
Expected: FAIL — cannot find module `./inbox-actions`.

- [ ] **Step 3: Implement**

```ts
// src/platform/notifications/inbox-actions.ts
"use server";

import { requirePersonSession } from "@/platform/auth/session";
import { markRead, markAllRead } from "./inbox";

/** Mark one of the signed-in person's notifications read. */
export async function markReadAction(id: string): Promise<void> {
  const { personId } = await requirePersonSession();
  await markRead(personId, id);
}

/** Mark all of the signed-in person's notifications read. */
export async function markAllReadAction(): Promise<void> {
  const { personId } = await requirePersonSession();
  await markAllRead(personId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_inbox npx vitest run src/platform/notifications/inbox-actions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/platform/notifications/inbox-actions.ts src/platform/notifications/inbox-actions.test.ts
git commit -m "feat(notifications): inbox mark-read server actions"
```

---

## Task 6: NotificationBell client component + toolbar mount

**Files:**
- Create: `src/platform/ui/notification-bell.tsx`
- Modify: `src/platform/ui/app-shell.tsx` (mount the bell)

**Interfaces:**
- Consumes: `GET /api/notifications` (Task 4); `markReadAction`, `markAllReadAction` (Task 5); lucide `Bell`.
- Produces: `<NotificationBell />` (no props) rendered in the toolbar.

This is a client component; the repo's vitest env is `node`, so there is no unit test. Verify with `npx tsc --noEmit` and the manual smoke in Step 4.

- [ ] **Step 1: Create the bell component**

```tsx
// src/platform/ui/notification-bell.tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Bell } from "lucide-react";
import { markReadAction, markAllReadAction } from "@/platform/notifications/inbox-actions";

type Item = {
  id: string;
  title: string;
  body: string;
  link: string | null;
  readAt: string | null;
  createdAt: string;
};

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function NotificationBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(0);
  const [items, setItems] = useState<Item[]>([]);
  const ref = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications", { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as { unreadCount: number; recent: Item[] };
      setCount(json.unreadCount);
      setItems(json.recent);
    } catch {
      // Network hiccup: leave the last known state.
    }
  }, []);

  // Initial load + light poll.
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 60_000);
    return () => clearInterval(t);
  }, [refresh]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function openItem(item: Item) {
    setOpen(false);
    if (!item.readAt) {
      await markReadAction(item.id);
      await refresh();
    }
    if (item.link) router.push(item.link);
  }

  async function markAll() {
    await markAllReadAction();
    await refresh();
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) void refresh();
        }}
        aria-label={count > 0 ? `Notifications, ${count} unread` : "Notifications"}
        className="relative inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
      >
        <Bell aria-hidden className="h-4 w-4" />
        {count > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid min-h-4 min-w-4 place-items-center rounded-full bg-critical px-1 text-[10px] font-semibold leading-none text-white">
            {count > 9 ? "9+" : count}
          </span>
        )}
      </button>

      {open && (
        <div className="glass-panel absolute right-0 top-10 z-40 w-80 overflow-hidden rounded-xl border border-border shadow-lg">
          <div className="flex items-center justify-between border-b border-border-subtle px-4 py-2.5">
            <span className="text-sm font-semibold text-foreground">Notifications</span>
            {count > 0 && (
              <button
                type="button"
                onClick={() => void markAll()}
                className="text-xs font-medium text-brand-fg hover:underline"
              >
                Mark all as read
              </button>
            )}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {items.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                No notifications yet.
              </p>
            ) : (
              items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => void openItem(item)}
                  className="flex w-full flex-col items-start gap-0.5 border-b border-border-subtle px-4 py-2.5 text-left transition-colors hover:bg-muted"
                >
                  <span className="flex w-full items-center gap-2">
                    {!item.readAt && (
                      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
                    )}
                    <span className="text-sm font-medium text-foreground">{item.title}</span>
                  </span>
                  <span className="line-clamp-2 text-xs text-muted-foreground">{item.body}</span>
                  <span className="text-[11px] text-subtle-foreground">{timeAgo(item.createdAt)}</span>
                </button>
              ))
            )}
          </div>
          <div className="border-t border-border-subtle px-4 py-2 text-center">
            <Link
              href="/notifications"
              onClick={() => setOpen(false)}
              className="text-xs font-medium text-brand-fg hover:underline"
            >
              View all
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
```

> If `bg-critical` / `glass-panel` / `text-brand-fg` are not valid tokens in this codebase, substitute the nearest existing token (check `src/app/globals.css` and how `/admin/notifications` and the glass nav use them). The bell must match the existing toolbar look.

- [ ] **Step 2: Mount in the toolbar**

In `src/platform/ui/app-shell.tsx`, add the import:

```ts
import { NotificationBell } from "./notification-bell";
```

Then place the bell between `<ThemeToggle .../>` and the user-avatar `div` (inside the `flex items-center gap-3` container):

```tsx
          <div className="flex items-center gap-3">
            <ThemeToggle initial={resolvedTheme} />
            <NotificationBell />
            <div className="hidden items-center gap-2.5 sm:flex">
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: clean (no errors in the new/modified files).

- [ ] **Step 4: Manual smoke (recommended)**

Run the dev server, sign in, and confirm: the bell renders next to the avatar; with a seeded unread Notification the badge shows; clicking opens the dropdown; "Mark all as read" clears the badge; "View all" navigates to `/notifications`.

- [ ] **Step 5: Commit**

```bash
git add src/platform/ui/notification-bell.tsx src/platform/ui/app-shell.tsx
git commit -m "feat(notifications): toolbar notification bell"
```

---

## Task 7: /notifications full page

**Files:**
- Create: `src/app/(app)/notifications/page.tsx`

**Interfaces:**
- Consumes: `requirePersonSession` (`@/platform/auth/session`); `listNotifications`, `markRead`, `NOTIFICATIONS_PAGE_SIZE` (Task 2); `markAllReadAction` (Task 5); `PageHeader`, `Pagination`, `Button` primitives; `redirect`/`revalidatePath`.

Server-rendered page; no unit test (verify via `tsc` + manual smoke).

- [ ] **Step 1: Create the page**

```tsx
// src/app/(app)/notifications/page.tsx
import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePersonSession } from "@/platform/auth/session";
import {
  listNotifications,
  markRead,
  NOTIFICATIONS_PAGE_SIZE,
} from "@/platform/notifications/inbox";
import { markAllReadAction } from "@/platform/notifications/inbox-actions";
import { PageHeader } from "@/platform/ui/page-header";
import { Pagination } from "@/platform/ui/pagination";
import { Button } from "@/platform/ui/button";

function fmtDateTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(
    d.getUTCHours()
  )}:${pad(d.getUTCMinutes())} UTC`;
}

type PageProps = { searchParams: Promise<{ page?: string }> };

export default async function NotificationsPage({ searchParams }: PageProps) {
  const { personId } = await requirePersonSession();
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page ?? "1") || 1);
  const { rows, total } = await listNotifications(personId, { page });
  const pageCount = Math.max(1, Math.ceil(total / NOTIFICATIONS_PAGE_SIZE));

  async function markAllAction() {
    "use server";
    await markAllReadAction();
    revalidatePath("/notifications");
  }

  // Mark a single notification read, then go to its link (or back to the list).
  async function openAction(formData: FormData) {
    "use server";
    const { personId: pid } = await requirePersonSession();
    const id = String(formData.get("id") ?? "");
    const link = String(formData.get("link") ?? "");
    if (id) await markRead(pid, id);
    redirect(link.length > 0 ? link : "/notifications");
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Notifications" description="Everything addressed to you in HAVEN Hub." />

      <form action={markAllAction}>
        <Button type="submit" variant="secondary">Mark all as read</Button>
      </form>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No notifications yet.</p>
      ) : (
        <ul className="divide-y divide-border-subtle rounded-xl border border-border">
          {rows.map((n) => (
            <li key={n.id}>
              <form action={openAction}>
                <input type="hidden" name="id" value={n.id} />
                <input type="hidden" name="link" value={n.link ?? ""} />
                <button
                  type="submit"
                  className="flex w-full flex-col items-start gap-1 px-4 py-3 text-left transition-colors hover:bg-muted"
                >
                  <span className="flex w-full items-center gap-2">
                    {!n.readAt && (
                      <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-brand" />
                    )}
                    <span className="font-medium text-foreground">{n.title}</span>
                  </span>
                  <span className="text-sm text-muted-foreground">{n.body}</span>
                  <span className="text-xs text-subtle-foreground">{fmtDateTime(n.createdAt)}</span>
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}

      {pageCount > 1 && (
        <Pagination
          page={page}
          pageCount={pageCount}
          hrefFor={(p: number) => `/notifications?page=${p}`}
        />
      )}
    </div>
  );
}
```

> Verify the `Pagination` props (`page`, `pageCount`, `hrefFor`) and `Button` `variant` against their real signatures (`src/platform/ui/pagination.tsx`, `button.tsx`) and match them — the admin pages use these same primitives, so mirror their usage exactly.

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Manual smoke (recommended)**

Sign in, seed a few notifications, visit `/notifications`: rows render newest-first; clicking a row marks it read and navigates to its link; "Mark all as read" clears the unread dots; pagination appears past `NOTIFICATIONS_PAGE_SIZE` rows.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/notifications/page.tsx"
git commit -m "feat(notifications): user-facing /notifications inbox page"
```

---

## Task 8: Admin "Notifications" nav link

**Files:**
- Modify: `src/platform/modules/registry.ts`

**Interfaces:**
- Produces: an admin tab-bar entry linking `/admin/notifications` (the delivery monitor shipped in PR #54).

- [ ] **Step 1: Add the nav entry**

In `src/platform/modules/registry.ts`, in the `admin` module's `nav` array, add the Notifications entry after Email:

```ts
      { label: "Email", href: "/admin/email" },
      { label: "Notifications", href: "/admin/notifications" },
      { label: "Settings", href: "/admin/settings" },
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Manual smoke (recommended)**

As an admin, open the Admin section and confirm a "Notifications" tab appears and routes to `/admin/notifications`.

- [ ] **Step 4: Commit**

```bash
git add src/platform/modules/registry.ts
git commit -m "feat(notifications): link admin Notifications monitor in the admin nav"
```

---

## Task 9: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Focused suite**

Run:
```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_inbox npx vitest run \
  src/platform/notifications \
  src/app/api/notifications/route.test.ts
```
Expected: all PASS.

- [ ] **Step 2: Full suite**

Run: `TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_inbox npx vitest run`
Expected: green except the 4 known pre-existing certificate `/tmp` ENOENT flakes (note, not feature-caused). If other tests fail, investigate whether this feature caused them.

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit (if any verification-driven fixes were needed)**

Only if changes were made; otherwise nothing to commit.

---

## Self-Review notes (for the implementer)

- **Spec coverage:** Task 1 → data model; Task 2 → service (query/mark, owner-scoped); Task 3 → unconditional creation via notify(); Task 4 → API for the persistent-shell bell; Task 5 → mark actions; Task 6 → bell UI (badge/dropdown/mark-all); Task 7 → full page; Task 8 → admin nav link; Task 9 → verification.
- **Persistent-shell rationale:** the bell self-fetches via `/api/notifications` (mount + 60s poll + after mutations + on open) precisely because the shell does not re-render on soft nav. Do not move the count into a server-rendered shell prop.
- **Owner scoping:** `markRead`/`markAllRead` use `updateMany` with `personId` in the where; the API and actions take personId only from the session. Never accept a personId from the client.
- **Token check:** before finalizing the bell/page, confirm `glass-panel`, `bg-critical`, `text-brand-fg`, `border-border-subtle`, `text-subtle-foreground` exist in this codebase (grep globals.css / existing components) and swap for the nearest real token if not.
