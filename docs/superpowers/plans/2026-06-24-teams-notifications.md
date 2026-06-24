# Teams Notifications via Microsoft Graph — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver HAVEN Hub's existing notifications as Microsoft Teams 1:1 chat messages (from the connected mailer account), routed per-notification-type by an admin, with automatic email fallback.

**Architecture:** A unified `notify()` dispatcher replaces the direct `queueEmail()` calls at the ~5 notification sites. It reads a per-type channel setting (`email | teams | both`) and queues to the existing email outbox and/or a new `TeamsMessage` outbox. Both queues are drained by the existing `/api/cron/email` cron. Teams sends reuse the existing delegated Graph token (`getAccessToken`). When a recipient has no resolvable Teams identity, or a send fails permanently, the message falls back to email.

**Tech Stack:** Next.js (App Router), TypeScript, Prisma (PostgreSQL), Zod, Vitest, Microsoft Graph v1.0 (delegated OAuth).

## Global Constraints

- **Product name:** "HAVEN Hub" (two words) in all prose/UI copy; identifiers stay `havenhub`.
- **No em-dashes** in any user-facing copy or comments; use other punctuation.
- **TDD:** every task is test-first. Run the test, see it fail, implement, see it pass, commit.
- **Test DB isolation:** this worktree must run vitest with a per-worktree `TEST_DATABASE_URL` (a migration adds a table). Set it before running DB-backed tests, e.g. `TEST_DATABASE_URL=postgresql://localhost/havenhub_test_teams`.
- **Single drainer:** the Teams queue, like the email queue, assumes one drainer (no `SELECT FOR UPDATE SKIP LOCKED`). Only the email cron drains it.
- **Reuse `EmailStatus` semantics** but Teams adds a `FALLBACK` terminal state, so Teams uses its own enum `TeamsMessageStatus`.
- **Graph delegated send:** all Graph calls use `getAccessToken()` from `src/platform/email/oauth.ts`; the connected account (the authorizing user, `MailCredential.account`) is the chat sender.

---

## File Structure

**New files**
- `src/platform/notifications/registry.ts` — notification type catalog + channel types + setting-key helper.
- `src/platform/notifications/registry.test.ts`
- `src/platform/notifications/channel.ts` — resolve a type's channel from settings.
- `src/platform/notifications/channel.test.ts`
- `src/platform/notifications/identity.ts` — resolve a person's Entra user id for Teams (with caching).
- `src/platform/notifications/identity.test.ts`
- `src/platform/notifications/teams-transport.ts` — `TeamsTransport` interface, `LogTeamsTransport`, `GraphTeamsTransport`, `resolveTeamsTransport`.
- `src/platform/notifications/teams-transport.test.ts`
- `src/platform/notifications/render.ts` — build the short-form Teams HTML body.
- `src/platform/notifications/render.test.ts`
- `src/platform/notifications/send.ts` — `queueTeamsMessage`, `drainTeamsQueue` (with drain-time fallback).
- `src/platform/notifications/send.test.ts`
- `src/platform/notifications/notify.ts` — the unified dispatcher.
- `src/platform/notifications/notify.test.ts`
- `src/modules/admin/services/teams-messages.ts` — `listTeamsMessages`, `retryTeamsMessage`.
- `src/modules/admin/services/teams-messages.test.ts`
- `src/app/(app)/admin/notifications/page.tsx` — Teams message monitor + channel-settings link.

**Modified files**
- `prisma/schema.prisma` — add `TeamsMessageStatus` enum, `TeamsMessage` model, `Person.teamsMessages` relation.
- `src/platform/settings/registry.ts` — register one channel select per notification type (category "Notifications").
- `src/platform/email/oauth.ts` — add `Chat.Create` + `ChatMessage.Send` scopes; export current scope list for the admin check.
- `src/app/api/cron/email/route.ts` — drain the Teams queue alongside email.
- `src/platform/email/reminders.ts` — route reminder + escalation through `notify()`.
- `src/modules/volunteers/services/epic.ts` — route EPIC emails through `notify()`.
- `src/app/(app)/admin/email/page.tsx` — add a "reconnect to enable Teams DMs" note when Teams scopes are not yet granted.

---

## Task 1: TeamsMessage schema + migration

**Files:**
- Modify: `prisma/schema.prisma` (add enum after `EmailStatus` ~line 331; add model after `MailCredential` ~line 639; add relation to `Person` ~line 104)
- Test: `src/platform/notifications/schema.test.ts`

**Interfaces:**
- Produces: Prisma model `TeamsMessage` with fields `{ id, personId, type, title, summary, link?, bodyHtml, chatId?, fallbackSubject, fallbackHtml, status: TeamsMessageStatus, attempts, lastError?, sentAt?, createdAt }`; enum `TeamsMessageStatus { QUEUED SENT FAILED FALLBACK }`; `Person.teamsMessages` relation.

- [ ] **Step 1: Write the failing test**

```ts
// src/platform/notifications/schema.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";

describe("TeamsMessage model", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("creates and reads a queued Teams message linked to a person", async () => {
    const person = await prisma.person.create({
      data: { name: "Sam Volunteer", contactEmail: "sam@example.com" },
    });

    const row = await prisma.teamsMessage.create({
      data: {
        personId: person.id,
        type: "compliance-reminder",
        title: "HIPAA compliance reminder",
        summary: "Your HIPAA training is expiring soon.",
        link: "https://hub.example.com/compliance",
        bodyHtml: "<strong>HIPAA compliance reminder</strong>",
        fallbackSubject: "HIPAA compliance reminder",
        fallbackHtml: "<p>reminder</p>",
      },
    });

    expect(row.status).toBe("QUEUED");
    expect(row.attempts).toBe(0);

    const found = await prisma.teamsMessage.findFirst({ where: { personId: person.id } });
    expect(found?.type).toBe("compliance-reminder");
  });
});
```

> `resetDb` lives at `src/platform/test/db.ts` (imported as `@/platform/test/db`); it truncates all tables between tests. This matches `src/platform/email/send.test.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL=postgresql://localhost/havenhub_test_teams npx vitest run src/platform/notifications/schema.test.ts`
Expected: FAIL — `prisma.teamsMessage` is undefined (model does not exist).

- [ ] **Step 3: Add the enum**

In `prisma/schema.prisma`, immediately after the `EmailStatus` enum block:

```prisma
enum TeamsMessageStatus {
  QUEUED
  SENT
  FAILED
  /// Teams delivery was abandoned and the message was re-queued as email instead.
  FALLBACK
}
```

- [ ] **Step 4: Add the model**

In `prisma/schema.prisma`, immediately after the `MailCredential` model:

```prisma
/// Outbound Teams 1:1 chat message queue (mirrors EmailLog). Drained by the
/// email cron alongside the email queue. Carries the email fallback payload so a
/// permanently-failed Teams send degrades to email without re-involving the caller.
model TeamsMessage {
  id              String             @id @default(cuid())
  /// Recipient person. Teams messages are always person-addressed.
  personId        String
  /// Notification type key from the notification registry (e.g. "compliance-reminder").
  type            String
  title           String
  summary         String
  link            String?
  /// Rendered HTML body posted to the Teams chat.
  bodyHtml        String
  /// Cached 1:1 chat id once resolved, so a retry does not re-create the chat.
  chatId          String?
  /// Email fallback payload, queued if Teams delivery fails permanently.
  fallbackSubject String
  fallbackHtml    String
  status          TeamsMessageStatus @default(QUEUED)
  attempts        Int                @default(0)
  lastError       String?
  sentAt          DateTime?
  createdAt       DateTime           @default(now())
  /// Cascade: Teams messages do not outlive the person they address.
  person          Person             @relation("teamsMessagePerson", fields: [personId], references: [id], onDelete: Cascade)

  @@index([personId])
  @@index([status, createdAt])
}
```

- [ ] **Step 5: Add the Person relation**

In `prisma/schema.prisma`, in the `Person` model, after the `complianceReminder` relation line (~line 104):

```prisma
  teamsMessages             TeamsMessage[]       @relation("teamsMessagePerson")
```

- [ ] **Step 6: Generate the migration and client**

Run:
```bash
cd .claude/worktrees/feat+teams-notifications
npx prisma migrate dev --name teams_messages
```
Expected: a new migration directory under `prisma/migrations/`, `prisma generate` runs, no errors.

- [ ] **Step 7: Run test to verify it passes**

Run: `TEST_DATABASE_URL=postgresql://localhost/havenhub_test_teams npx vitest run src/platform/notifications/schema.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/platform/notifications/schema.test.ts
git commit -m "feat(notifications): add TeamsMessage model + migration"
```

---

## Task 2: Notification type registry + per-type channel settings

**Files:**
- Create: `src/platform/notifications/registry.ts`
- Test: `src/platform/notifications/registry.test.ts`
- Modify: `src/platform/settings/registry.ts` (append generated channel settings)

**Interfaces:**
- Produces:
  - `type NotificationChannel = "email" | "teams" | "both"`
  - `interface NotificationType { key: string; label: string; defaultChannel: NotificationChannel }`
  - `const NOTIFICATION_TYPES: NotificationType[]`
  - `function channelSettingKey(typeKey: string): string` → `notifications.<typeKey>.channel`
  - Settings registered under category `"Notifications"`, one `select` per type, default `email`.

- [ ] **Step 1: Write the failing test**

```ts
// src/platform/notifications/registry.test.ts
import { describe, it, expect } from "vitest";
import { NOTIFICATION_TYPES, channelSettingKey } from "./registry";
import { getSettingDef } from "@/platform/settings/registry";

describe("notification registry", () => {
  it("declares the five existing notification types", () => {
    const keys = NOTIFICATION_TYPES.map((t) => t.key).sort();
    expect(keys).toEqual(
      [
        "compliance-escalation",
        "compliance-reminder",
        "epic-activation",
        "epic-onboarding",
        "epic-password-reset",
      ].sort()
    );
    for (const t of NOTIFICATION_TYPES) {
      expect(t.defaultChannel).toBe("email");
    }
  });

  it("builds the dotted channel setting key", () => {
    expect(channelSettingKey("compliance-reminder")).toBe(
      "notifications.compliance-reminder.channel"
    );
  });

  it("registers a channel select setting per type in the settings registry", () => {
    for (const t of NOTIFICATION_TYPES) {
      const def = getSettingDef(channelSettingKey(t.key));
      expect(def.category).toBe("Notifications");
      expect(def.input).toEqual({
        type: "select",
        options: [
          { value: "email", label: "Email" },
          { value: "teams", label: "Teams DM" },
          { value: "both", label: "Email + Teams DM" },
        ],
      });
      expect(def.envDefault()).toBe("email");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/platform/notifications/registry.test.ts`
Expected: FAIL — cannot find module `./registry`.

- [ ] **Step 3: Create the registry**

```ts
// src/platform/notifications/registry.ts

/** Where a notification type is delivered. */
export type NotificationChannel = "email" | "teams" | "both";

/** One admin-routable notification type, keyed by its email-template descriptor. */
export interface NotificationType {
  /** Stable key, matches the email template descriptor (e.g. "compliance-reminder"). */
  key: string;
  /** Human label for the admin channel picker. */
  label: string;
  /** Channel used until an admin overrides it. Always "email" so behavior is unchanged on first deploy. */
  defaultChannel: NotificationChannel;
}

/** Every notification type that flows through the notify() dispatcher. */
export const NOTIFICATION_TYPES: NotificationType[] = [
  { key: "compliance-reminder", label: "HIPAA compliance reminder", defaultChannel: "email" },
  { key: "compliance-escalation", label: "HIPAA compliance escalation (directors)", defaultChannel: "email" },
  { key: "epic-onboarding", label: "EPIC onboarding", defaultChannel: "email" },
  { key: "epic-activation", label: "EPIC activation", defaultChannel: "email" },
  { key: "epic-password-reset", label: "EPIC password reset", defaultChannel: "email" },
];

/** The settings-registry key that stores a type's channel override. */
export function channelSettingKey(typeKey: string): string {
  return `notifications.${typeKey}.channel`;
}
```

- [ ] **Step 4: Register the channel settings**

In `src/platform/settings/registry.ts`, add this import near the top (after the existing imports):

```ts
import { NOTIFICATION_TYPES, channelSettingKey, type NotificationChannel } from "@/platform/notifications/registry";
```

Then, inside the `SETTINGS` array literal, add this spread as the LAST element (after the `ui.defaultTheme` entry, before the closing `]`):

```ts
  ...NOTIFICATION_TYPES.map((t) =>
    define<NotificationChannel>({
      key: channelSettingKey(t.key),
      category: "Notifications",
      label: t.label,
      help: `Where to deliver the "${t.label}" notification.`,
      input: {
        type: "select",
        options: [
          { value: "email", label: "Email" },
          { value: "teams", label: "Teams DM" },
          { value: "both", label: "Email + Teams DM" },
        ],
      },
      schema: z.enum(["email", "teams", "both"]),
      envDefault: () => t.defaultChannel,
      secret: false,
    })
  ),
```

> The settings page auto-renders categories from `SETTINGS` (see `listCategories`), so the new "Notifications" group appears in `/admin/settings` with no further UI work.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/platform/notifications/registry.test.ts src/platform/settings/registry.test.ts`
Expected: PASS (and the existing settings registry tests still pass).

- [ ] **Step 6: Commit**

```bash
git add src/platform/notifications/registry.ts src/platform/notifications/registry.test.ts src/platform/settings/registry.ts
git commit -m "feat(notifications): notification type registry + per-type channel settings"
```

---

## Task 3: Channel resolver

**Files:**
- Create: `src/platform/notifications/channel.ts`
- Test: `src/platform/notifications/channel.test.ts`

**Interfaces:**
- Consumes: `channelSettingKey`, `NotificationChannel` (Task 2); `getSetting` from `@/platform/settings/service`.
- Produces: `async function resolveChannel(typeKey: string): Promise<NotificationChannel>`.

- [ ] **Step 1: Write the failing test**

```ts
// src/platform/notifications/channel.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveChannel } from "./channel";
import * as settings from "@/platform/settings/service";

describe("resolveChannel", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("reads the per-type channel setting by its dotted key", async () => {
    const spy = vi.spyOn(settings, "getSetting").mockResolvedValue("both" as never);
    const channel = await resolveChannel("epic-onboarding");
    expect(channel).toBe("both");
    expect(spy).toHaveBeenCalledWith("notifications.epic-onboarding.channel");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/platform/notifications/channel.test.ts`
Expected: FAIL — cannot find module `./channel`.

- [ ] **Step 3: Implement**

```ts
// src/platform/notifications/channel.ts
import { getSetting } from "@/platform/settings/service";
import { channelSettingKey, type NotificationChannel } from "./registry";

/** Resolve a notification type's delivery channel (DB override -> default "email"). */
export async function resolveChannel(typeKey: string): Promise<NotificationChannel> {
  return getSetting<NotificationChannel>(channelSettingKey(typeKey));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/platform/notifications/channel.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/platform/notifications/channel.ts src/platform/notifications/channel.test.ts
git commit -m "feat(notifications): per-type channel resolver"
```

---

## Task 4: Teams identity resolution

**Files:**
- Create: `src/platform/notifications/identity.ts`
- Test: `src/platform/notifications/identity.test.ts`

**Interfaces:**
- Consumes: `getAccessToken` from `@/platform/email/oauth`; `prisma`.
- Produces:
  - `interface ResolveIdentityDeps { fetchImpl?: typeof fetch; getToken?: () => Promise<string> }`
  - `async function resolveTeamsUser(person: { id: string; entraObjectId: string | null; contactEmail: string | null }, deps?: ResolveIdentityDeps): Promise<string | null>`

- [ ] **Step 1: Write the failing test**

```ts
// src/platform/notifications/identity.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { resolveTeamsUser } from "./identity";

describe("resolveTeamsUser", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("returns the stored entraObjectId without calling Graph", async () => {
    const fetchImpl = vi.fn();
    const id = await resolveTeamsUser(
      { id: "p1", entraObjectId: "entra-123", contactEmail: "x@y.com" },
      { fetchImpl: fetchImpl as unknown as typeof fetch, getToken: async () => "tok" }
    );
    expect(id).toBe("entra-123");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns null when there is no entra id and no contactEmail", async () => {
    const id = await resolveTeamsUser(
      { id: "p1", entraObjectId: null, contactEmail: null },
      { getToken: async () => "tok" }
    );
    expect(id).toBeNull();
  });

  it("looks up by email via Graph and caches the id back onto the person", async () => {
    const person = await prisma.person.create({
      data: { name: "Sam", contactEmail: "sam@example.com" },
    });
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "entra-looked-up" }),
    });
    const id = await resolveTeamsUser(
      { id: person.id, entraObjectId: null, contactEmail: "sam@example.com" },
      { fetchImpl: fetchImpl as unknown as typeof fetch, getToken: async () => "tok" }
    );
    expect(id).toBe("entra-looked-up");
    const url = fetchImpl.mock.calls[0][0] as string;
    expect(url).toContain("/users/sam%40example.com");
    const reloaded = await prisma.person.findUnique({ where: { id: person.id } });
    expect(reloaded?.entraObjectId).toBe("entra-looked-up");
  });

  it("returns null when the Graph lookup fails", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => "not found" });
    const id = await resolveTeamsUser(
      { id: "p1", entraObjectId: null, contactEmail: "missing@example.com" },
      { fetchImpl: fetchImpl as unknown as typeof fetch, getToken: async () => "tok" }
    );
    expect(id).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL=postgresql://localhost/havenhub_test_teams npx vitest run src/platform/notifications/identity.test.ts`
Expected: FAIL — cannot find module `./identity`.

- [ ] **Step 3: Implement**

```ts
// src/platform/notifications/identity.ts
import { prisma } from "@/platform/db";
import { getAccessToken } from "@/platform/email/oauth";

export interface ResolveIdentityDeps {
  /** Injected fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Returns a valid delegated Graph token. Defaults to the mailer token. */
  getToken?: () => Promise<string>;
}

/**
 * Resolve a person's Entra user id for Teams delivery.
 *
 * Uses Person.entraObjectId when present. Otherwise looks the user up by
 * contactEmail via Graph (GET /users/{email}?$select=id) and caches the id back
 * onto the Person row so future sends skip the lookup. Returns null when no
 * identity can be resolved (no entra id, no email, or a failed/!ok lookup).
 * Never throws.
 */
export async function resolveTeamsUser(
  person: { id: string; entraObjectId: string | null; contactEmail: string | null },
  deps: ResolveIdentityDeps = {}
): Promise<string | null> {
  if (person.entraObjectId) return person.entraObjectId;
  if (!person.contactEmail) return null;

  const { fetchImpl = fetch, getToken = getAccessToken } = deps;
  try {
    const token = await getToken();
    const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(
      person.contactEmail
    )}?$select=id`;
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const json = (await res.json()) as { id?: string };
    if (!json.id) return null;
    await prisma.person.update({
      where: { id: person.id },
      data: { entraObjectId: json.id },
    });
    return json.id;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TEST_DATABASE_URL=postgresql://localhost/havenhub_test_teams npx vitest run src/platform/notifications/identity.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/platform/notifications/identity.ts src/platform/notifications/identity.test.ts
git commit -m "feat(notifications): resolve + cache Teams identity via Graph"
```

---

## Task 5: Short-form Teams body renderer

**Files:**
- Create: `src/platform/notifications/render.ts`
- Test: `src/platform/notifications/render.test.ts`

**Interfaces:**
- Produces: `function renderTeamsBody(input: { title: string; summary: string; link?: string | null }): string` — returns Teams-safe HTML (title, summary, optional link). Escapes interpolated text.

- [ ] **Step 1: Write the failing test**

```ts
// src/platform/notifications/render.test.ts
import { describe, it, expect } from "vitest";
import { renderTeamsBody } from "./render";

describe("renderTeamsBody", () => {
  it("renders title, summary, and a link", () => {
    const html = renderTeamsBody({
      title: "HIPAA compliance reminder",
      summary: "Your training is expiring soon.",
      link: "https://hub.example.com/compliance",
    });
    expect(html).toContain("<strong>HIPAA compliance reminder</strong>");
    expect(html).toContain("Your training is expiring soon.");
    expect(html).toContain('href="https://hub.example.com/compliance"');
    expect(html).toContain("Open in HAVEN Hub");
  });

  it("omits the link block when no link is given", () => {
    const html = renderTeamsBody({ title: "T", summary: "S" });
    expect(html).not.toContain("<a ");
  });

  it("escapes HTML in title and summary", () => {
    const html = renderTeamsBody({ title: "<b>x</b>", summary: "a & b <c>" });
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).toContain("a &amp; b &lt;c&gt;");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/platform/notifications/render.test.ts`
Expected: FAIL — cannot find module `./render`.

- [ ] **Step 3: Implement**

```ts
// src/platform/notifications/render.ts

/** Escape the five characters that are unsafe in HTML text/attribute context. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Build the short-form HTML body for a Teams chat message: a bold title, a
 * one or two line summary, and an optional link back into HAVEN Hub. Teams
 * renders only a limited HTML subset, so this stays intentionally plain.
 */
export function renderTeamsBody(input: {
  title: string;
  summary: string;
  link?: string | null;
}): string {
  const title = `<strong>${escapeHtml(input.title)}</strong>`;
  const summary = `<p>${escapeHtml(input.summary)}</p>`;
  const link = input.link
    ? `<p><a href="${escapeHtml(input.link)}">Open in HAVEN Hub</a></p>`
    : "";
  return `${title}${summary}${link}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/platform/notifications/render.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/platform/notifications/render.ts src/platform/notifications/render.test.ts
git commit -m "feat(notifications): short-form Teams body renderer"
```

---

## Task 6: Teams transport (Graph chat send)

**Files:**
- Create: `src/platform/notifications/teams-transport.ts`
- Test: `src/platform/notifications/teams-transport.test.ts`

**Interfaces:**
- Consumes: `getAccessToken` from `@/platform/email/oauth`; `getSetting` from `@/platform/settings/service`; `mailConnectionStatus` from `@/platform/email/oauth`.
- Produces:
  - `interface TeamsOutboundMessage { recipientUserId: string; chatId: string | null; bodyHtml: string }`
  - `interface TeamsSendResult { chatId: string }`
  - `interface TeamsTransport { send(message: TeamsOutboundMessage): Promise<TeamsSendResult> }`
  - `class LogTeamsTransport implements TeamsTransport`
  - `class GraphTeamsTransport implements TeamsTransport` (ctor `{ getAccessToken, senderUpn, fetchImpl? }`)
  - `async function resolveTeamsTransport(): Promise<TeamsTransport>`

- [ ] **Step 1: Write the failing test**

```ts
// src/platform/notifications/teams-transport.test.ts
import { describe, it, expect, vi } from "vitest";
import { GraphTeamsTransport, LogTeamsTransport } from "./teams-transport";

describe("LogTeamsTransport", () => {
  it("returns a synthetic chat id and never calls the network", async () => {
    const r = await new LogTeamsTransport().send({
      recipientUserId: "u1",
      chatId: null,
      bodyHtml: "<p>hi</p>",
    });
    expect(r.chatId).toBeTruthy();
  });
});

describe("GraphTeamsTransport", () => {
  it("creates a 1:1 chat then posts the message when no chatId is cached", async () => {
    const fetchImpl = vi
      .fn()
      // POST /chats -> returns new chat id
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "chat-1" }) })
      // POST /chats/{id}/messages -> ok
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "msg-1" }) });

    const transport = new GraphTeamsTransport({
      getAccessToken: async () => "tok",
      senderUpn: "hfc.admin@yale.edu",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await transport.send({
      recipientUserId: "entra-recipient",
      chatId: null,
      bodyHtml: "<p>hello</p>",
    });

    expect(result.chatId).toBe("chat-1");

    const [chatUrl, chatInit] = fetchImpl.mock.calls[0];
    expect(chatUrl).toBe("https://graph.microsoft.com/v1.0/chats");
    const chatBody = JSON.parse((chatInit as RequestInit).body as string);
    expect(chatBody.chatType).toBe("oneOnOne");
    expect(chatBody.members).toHaveLength(2);
    expect(JSON.stringify(chatBody.members)).toContain("hfc.admin@yale.edu");
    expect(JSON.stringify(chatBody.members)).toContain("entra-recipient");

    const [msgUrl, msgInit] = fetchImpl.mock.calls[1];
    expect(msgUrl).toBe("https://graph.microsoft.com/v1.0/chats/chat-1/messages");
    const msgBody = JSON.parse((msgInit as RequestInit).body as string);
    expect(msgBody.body.contentType).toBe("html");
    expect(msgBody.body.content).toBe("<p>hello</p>");
  });

  it("reuses a cached chatId and skips chat creation", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "msg-1" }) });
    const transport = new GraphTeamsTransport({
      getAccessToken: async () => "tok",
      senderUpn: "hfc.admin@yale.edu",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await transport.send({
      recipientUserId: "entra-recipient",
      chatId: "chat-existing",
      bodyHtml: "<p>hi</p>",
    });
    expect(result.chatId).toBe("chat-existing");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      "https://graph.microsoft.com/v1.0/chats/chat-existing/messages"
    );
  });

  it("throws when the message POST is not ok", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "chat-1" }) })
      .mockResolvedValueOnce({ ok: false, status: 403, text: async () => "forbidden" });
    const transport = new GraphTeamsTransport({
      getAccessToken: async () => "tok",
      senderUpn: "s@y.com",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      transport.send({ recipientUserId: "r", chatId: null, bodyHtml: "<p>x</p>" })
    ).rejects.toThrow(/403/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/platform/notifications/teams-transport.test.ts`
Expected: FAIL — cannot find module `./teams-transport`.

- [ ] **Step 3: Implement**

```ts
// src/platform/notifications/teams-transport.ts
import { getAccessToken, mailConnectionStatus } from "@/platform/email/oauth";
import { getSetting } from "@/platform/settings/service";

/** A single outbound Teams chat message. */
export interface TeamsOutboundMessage {
  /** Recipient Entra user id. */
  recipientUserId: string;
  /** Previously-resolved chat id, or null to create/find the 1:1 chat. */
  chatId: string | null;
  /** Teams-safe HTML body. */
  bodyHtml: string;
}

/** Result of a successful send: the chat id used, so callers can cache it. */
export interface TeamsSendResult {
  chatId: string;
}

/** Minimal contract every Teams transport must satisfy. */
export interface TeamsTransport {
  send(message: TeamsOutboundMessage): Promise<TeamsSendResult>;
}

// ---------------------------------------------------------------------------
// LogTeamsTransport
// ---------------------------------------------------------------------------

/** Dev transport: logs instead of sending. Safe for CI and local dev. */
export class LogTeamsTransport implements TeamsTransport {
  async send(message: TeamsOutboundMessage): Promise<TeamsSendResult> {
    console.log(
      `[teams] to=${message.recipientUserId} body=${message.bodyHtml.slice(0, 80)}`
    );
    return { chatId: message.chatId ?? "log-chat" };
  }
}

// ---------------------------------------------------------------------------
// GraphTeamsTransport
// ---------------------------------------------------------------------------

interface GraphTeamsTransportOpts {
  getAccessToken: () => Promise<string>;
  /** UPN of the connected (authorizing) account that sends the DM. */
  senderUpn: string;
  fetchImpl?: typeof fetch;
}

/**
 * Production transport: sends a 1:1 Teams chat message via Microsoft Graph using
 * the delegated mailer token. Ensures the 1:1 chat exists (Graph returns the
 * existing chat for the same member pair, so POST /chats is effectively
 * idempotent), then posts the message. Never retries -- the queue layer handles
 * back-off and retry.
 */
export class GraphTeamsTransport implements TeamsTransport {
  private readonly getToken: () => Promise<string>;
  private readonly senderUpn: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GraphTeamsTransportOpts) {
    this.getToken = opts.getAccessToken;
    this.senderUpn = opts.senderUpn;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async send(message: TeamsOutboundMessage): Promise<TeamsSendResult> {
    const token = await this.getToken();
    const chatId = message.chatId ?? (await this.ensureChat(token, message.recipientUserId));

    const url = `https://graph.microsoft.com/v1.0/chats/${encodeURIComponent(chatId)}/messages`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ body: { contentType: "html", content: message.bodyHtml } }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Graph send chat message failed: ${res.status} ${text}`);
    }
    return { chatId };
  }

  /** Create (or get) the 1:1 chat between the sender and the recipient. */
  private async ensureChat(token: string, recipientUserId: string): Promise<string> {
    const member = (bind: string) => ({
      "@odata.type": "#microsoft.graph.aadUserConversationMember",
      roles: ["owner"],
      "user@odata.bind": `https://graph.microsoft.com/v1.0/users('${bind}')`,
    });
    const res = await this.fetchImpl("https://graph.microsoft.com/v1.0/chats", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        chatType: "oneOnOne",
        members: [member(this.senderUpn), member(recipientUserId)],
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Graph create chat failed: ${res.status} ${text}`);
    }
    const json = (await res.json()) as { id: string };
    return json.id;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Resolve the Teams transport. Reuses the email.transport toggle: when it is
 * "graph" and a mailer account is connected, returns the Graph transport sending
 * AS the connected account; otherwise returns the log transport.
 */
export async function resolveTeamsTransport(): Promise<TeamsTransport> {
  const transport = await getSetting<"log" | "graph">("email.transport");
  if (transport !== "graph") return new LogTeamsTransport();
  const status = await mailConnectionStatus();
  if (!status.connected || !status.account) {
    console.warn("[teams] graph transport selected but no mailer account is connected; using log transport");
    return new LogTeamsTransport();
  }
  return new GraphTeamsTransport({ getAccessToken, senderUpn: status.account });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/platform/notifications/teams-transport.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/platform/notifications/teams-transport.ts src/platform/notifications/teams-transport.test.ts
git commit -m "feat(notifications): Graph Teams chat transport"
```

---

## Task 7: queueTeamsMessage + drainTeamsQueue (with drain-time fallback)

**Files:**
- Create: `src/platform/notifications/send.ts`
- Test: `src/platform/notifications/send.test.ts`

**Interfaces:**
- Consumes: `queueEmail` from `@/platform/email/send`; `TeamsTransport` (Task 6); `prisma`.
- Produces:
  - `type QueueTeamsInput = { personId: string; type: string; title: string; summary: string; link?: string | null; bodyHtml: string; fallbackSubject: string; fallbackHtml: string }`
  - `async function queueTeamsMessage(db: Db, input: QueueTeamsInput): Promise<TeamsMessage>`
  - `async function drainTeamsQueue(transport: TeamsTransport): Promise<number>`
  - `const TEAMS_MAX_ATTEMPTS = 8`

- [ ] **Step 1: Write the failing test**

```ts
// src/platform/notifications/send.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { queueTeamsMessage, drainTeamsQueue, TEAMS_MAX_ATTEMPTS } from "./send";
import type { TeamsTransport } from "./teams-transport";

const baseInput = {
  type: "compliance-reminder",
  title: "HIPAA compliance reminder",
  summary: "Expiring soon.",
  link: "https://hub/compliance",
  bodyHtml: "<p>x</p>",
  fallbackSubject: "HIPAA compliance reminder",
  fallbackHtml: "<p>fallback</p>",
};

describe("queueTeamsMessage", () => {
  beforeEach(async () => await resetDb());

  it("creates a QUEUED row", async () => {
    const p = await prisma.person.create({
      data: { name: "Sam", contactEmail: "sam@x.com", entraObjectId: "e1" },
    });
    const row = await queueTeamsMessage(prisma, { personId: p.id, ...baseInput });
    expect(row.status).toBe("QUEUED");
  });
});

describe("drainTeamsQueue", () => {
  beforeEach(async () => await resetDb());

  it("sends a queued message and marks it SENT, caching the chat id", async () => {
    const p = await prisma.person.create({
      data: { name: "Sam", contactEmail: "sam@x.com", entraObjectId: "e1" },
    });
    await queueTeamsMessage(prisma, { personId: p.id, ...baseInput });
    const transport: TeamsTransport = {
      send: vi.fn().mockResolvedValue({ chatId: "chat-9" }),
    };
    const n = await drainTeamsQueue(transport);
    expect(n).toBe(1);
    const row = await prisma.teamsMessage.findFirst({ where: { personId: p.id } });
    expect(row?.status).toBe("SENT");
    expect(row?.chatId).toBe("chat-9");
  });

  it("requeues on transient failure until max attempts", async () => {
    const p = await prisma.person.create({
      data: { name: "Sam", contactEmail: "sam@x.com", entraObjectId: "e1" },
    });
    const row = await queueTeamsMessage(prisma, { personId: p.id, ...baseInput });
    // Pre-age the row to one attempt below the max.
    await prisma.teamsMessage.update({
      where: { id: row.id },
      data: { attempts: TEAMS_MAX_ATTEMPTS - 2 },
    });
    const transport: TeamsTransport = {
      send: vi.fn().mockRejectedValue(new Error("graph 500")),
    };
    await drainTeamsQueue(transport);
    const after1 = await prisma.teamsMessage.findUnique({ where: { id: row.id } });
    expect(after1?.status).toBe("QUEUED");
    expect(after1?.attempts).toBe(TEAMS_MAX_ATTEMPTS - 1);
  });

  it("falls back to email when a send fails permanently", async () => {
    const p = await prisma.person.create({
      data: { name: "Sam", contactEmail: "sam@x.com", entraObjectId: "e1" },
    });
    const row = await queueTeamsMessage(prisma, { personId: p.id, ...baseInput });
    await prisma.teamsMessage.update({
      where: { id: row.id },
      data: { attempts: TEAMS_MAX_ATTEMPTS - 1 },
    });
    const transport: TeamsTransport = {
      send: vi.fn().mockRejectedValue(new Error("graph 500")),
    };
    await drainTeamsQueue(transport);
    const after = await prisma.teamsMessage.findUnique({ where: { id: row.id } });
    expect(after?.status).toBe("FALLBACK");
    const email = await prisma.emailLog.findFirst({ where: { personId: p.id } });
    expect(email?.toEmail).toBe("sam@x.com");
    expect(email?.subject).toBe("HIPAA compliance reminder");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL=postgresql://localhost/havenhub_test_teams npx vitest run src/platform/notifications/send.test.ts`
Expected: FAIL — cannot find module `./send`.

- [ ] **Step 3: Implement**

```ts
// src/platform/notifications/send.ts
import type { Prisma, PrismaClient, TeamsMessage } from "@prisma/client";
import { prisma } from "@/platform/db";
import { queueEmail } from "@/platform/email/send";
import type { TeamsTransport } from "./teams-transport";

type Db = PrismaClient | Prisma.TransactionClient;

export type QueueTeamsInput = {
  personId: string;
  type: string;
  title: string;
  summary: string;
  link?: string | null;
  bodyHtml: string;
  fallbackSubject: string;
  fallbackHtml: string;
};

export const TEAMS_MAX_ATTEMPTS = 8;

/** Append a Teams message job, mirroring queueEmail (any Db handle). */
export async function queueTeamsMessage(db: Db, input: QueueTeamsInput): Promise<TeamsMessage> {
  return db.teamsMessage.create({
    data: {
      personId: input.personId,
      type: input.type,
      title: input.title,
      summary: input.summary,
      link: input.link ?? null,
      bodyHtml: input.bodyHtml,
      fallbackSubject: input.fallbackSubject,
      fallbackHtml: input.fallbackHtml,
    },
  });
}

/**
 * Drain up to 25 QUEUED Teams messages, oldest-first. On success: SENT + sentAt,
 * caching the chat id. On failure: increment attempts (requeue) until
 * TEAMS_MAX_ATTEMPTS, then queue the stored email fallback and mark FALLBACK.
 *
 * Single-worker assumption (no SKIP LOCKED), same as drainEmailQueue.
 */
export async function drainTeamsQueue(transport: TeamsTransport): Promise<number> {
  const rows = await prisma.teamsMessage.findMany({
    where: { status: "QUEUED" },
    orderBy: { createdAt: "asc" },
    take: 25,
  });

  let processed = 0;
  for (const row of rows) {
    try {
      const person = await prisma.person.findUnique({
        where: { id: row.personId },
        select: { entraObjectId: true, contactEmail: true },
      });
      const userId = person?.entraObjectId ?? null;
      if (!userId) throw new Error("recipient has no Teams identity");

      const result = await transport.send({
        recipientUserId: userId,
        chatId: row.chatId,
        bodyHtml: row.bodyHtml,
      });
      await prisma.teamsMessage.update({
        where: { id: row.id },
        data: { status: "SENT", sentAt: new Date(), chatId: result.chatId },
      });
    } catch (error) {
      const attempts = row.attempts + 1;
      const message = error instanceof Error ? error.message.slice(0, 500) : String(error);
      if (attempts >= TEAMS_MAX_ATTEMPTS) {
        // Permanent failure: degrade to email so the notification still lands.
        const person = await prisma.person.findUnique({
          where: { id: row.personId },
          select: { contactEmail: true },
        });
        if (person?.contactEmail) {
          await queueEmail(prisma, {
            to: person.contactEmail,
            subject: row.fallbackSubject,
            html: row.fallbackHtml,
            template: row.type,
            personId: row.personId,
          });
        }
        await prisma.teamsMessage.update({
          where: { id: row.id },
          data: { attempts, lastError: message, status: "FALLBACK" },
        });
      } else {
        await prisma.teamsMessage.update({
          where: { id: row.id },
          data: { attempts, lastError: message, status: "QUEUED" },
        });
      }
    }
    processed += 1;
  }
  return processed;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TEST_DATABASE_URL=postgresql://localhost/havenhub_test_teams npx vitest run src/platform/notifications/send.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/platform/notifications/send.ts src/platform/notifications/send.test.ts
git commit -m "feat(notifications): Teams queue + drain with email fallback"
```

---

## Task 8: notify() dispatcher

**Files:**
- Create: `src/platform/notifications/notify.ts`
- Test: `src/platform/notifications/notify.test.ts`

**Interfaces:**
- Consumes: `resolveChannel` (Task 3); `resolveTeamsUser` + `ResolveIdentityDeps` (Task 4); `renderTeamsBody` (Task 5); `queueTeamsMessage` (Task 7); `queueEmail` from `@/platform/email/send`.
- Produces:
  - `type NotifyPerson = { id: string; entraObjectId: string | null; contactEmail: string | null }`
  - `type NotifyInput = { type: string; person: NotifyPerson; email: { subject: string; html: string }; teams: { title: string; summary: string; link?: string | null }; triggeredById?: string | null }`
  - `async function notify(db: Db, input: NotifyInput, deps?: ResolveIdentityDeps): Promise<void>`

- [ ] **Step 1: Write the failing test**

```ts
// src/platform/notifications/notify.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { notify } from "./notify";
import * as channel from "./channel";

const email = { subject: "Subj", html: "<p>email</p>" };
const teams = { title: "Title", summary: "Summary", link: "https://hub/x" };

async function makePerson(over: Partial<{ entraObjectId: string | null; contactEmail: string | null }> = {}) {
  return prisma.person.create({
    data: {
      name: "Sam",
      contactEmail: over.contactEmail === undefined ? "sam@x.com" : over.contactEmail,
      entraObjectId: over.entraObjectId === undefined ? "e1" : over.entraObjectId,
    },
  });
}

describe("notify", () => {
  beforeEach(async () => {
    await resetDb();
    vi.restoreAllMocks();
  });

  it("channel=email queues only an email", async () => {
    vi.spyOn(channel, "resolveChannel").mockResolvedValue("email");
    const p = await makePerson();
    await notify(prisma, { type: "epic-onboarding", person: p, email, teams });
    expect(await prisma.emailLog.count()).toBe(1);
    expect(await prisma.teamsMessage.count()).toBe(0);
  });

  it("channel=teams with an identity queues only a Teams message", async () => {
    vi.spyOn(channel, "resolveChannel").mockResolvedValue("teams");
    const p = await makePerson({ entraObjectId: "e1" });
    await notify(prisma, { type: "epic-onboarding", person: p, email, teams });
    expect(await prisma.emailLog.count()).toBe(0);
    expect(await prisma.teamsMessage.count()).toBe(1);
  });

  it("channel=both queues an email and a Teams message", async () => {
    vi.spyOn(channel, "resolveChannel").mockResolvedValue("both");
    const p = await makePerson({ entraObjectId: "e1" });
    await notify(prisma, { type: "epic-onboarding", person: p, email, teams });
    expect(await prisma.emailLog.count()).toBe(1);
    expect(await prisma.teamsMessage.count()).toBe(1);
  });

  it("channel=teams with no identity falls back to email at queue time", async () => {
    vi.spyOn(channel, "resolveChannel").mockResolvedValue("teams");
    const p = await makePerson({ entraObjectId: null });
    await notify(
      prisma,
      { type: "epic-onboarding", person: { ...p, entraObjectId: null }, email, teams },
      { getToken: async () => "tok", fetchImpl: vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => "x" }) as unknown as typeof fetch }
    );
    expect(await prisma.teamsMessage.count()).toBe(0);
    const e = await prisma.emailLog.findFirst({ where: { personId: p.id } });
    expect(e?.subject).toBe("Subj");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL=postgresql://localhost/havenhub_test_teams npx vitest run src/platform/notifications/notify.test.ts`
Expected: FAIL — cannot find module `./notify`.

- [ ] **Step 3: Implement**

```ts
// src/platform/notifications/notify.ts
import type { Prisma, PrismaClient } from "@prisma/client";
import { queueEmail } from "@/platform/email/send";
import { resolveChannel } from "./channel";
import { resolveTeamsUser, type ResolveIdentityDeps } from "./identity";
import { renderTeamsBody } from "./render";
import { queueTeamsMessage } from "./send";

type Db = PrismaClient | Prisma.TransactionClient;

export type NotifyPerson = {
  id: string;
  entraObjectId: string | null;
  contactEmail: string | null;
};

export type NotifyInput = {
  /** Notification type key (must be in the notification registry). */
  type: string;
  person: NotifyPerson;
  /** Email form (rendered subject/html), used for email delivery and Teams fallback. */
  email: { subject: string; html: string };
  /** Short Teams form. */
  teams: { title: string; summary: string; link?: string | null };
  triggeredById?: string | null;
};

/**
 * Unified notification dispatcher. Resolves the type's channel from settings and
 * queues to email and/or the Teams outbox accordingly. When channel is "teams"
 * but the recipient has no resolvable Teams identity, falls back to email at
 * queue time so the message still lands. Queues happen on the provided Db handle
 * (so it joins any surrounding transaction), exactly like queueEmail.
 */
export async function notify(
  db: Db,
  input: NotifyInput,
  deps: ResolveIdentityDeps = {}
): Promise<void> {
  const channel = await resolveChannel(input.type);
  const wantsEmail = channel === "email" || channel === "both";
  const wantsTeams = channel === "teams" || channel === "both";

  const queueTheEmail = async () => {
    if (!input.person.contactEmail) return;
    await queueEmail(db, {
      to: input.person.contactEmail,
      subject: input.email.subject,
      html: input.email.html,
      template: input.type,
      personId: input.person.id,
      triggeredById: input.triggeredById ?? null,
    });
  };

  if (wantsEmail) {
    await queueTheEmail();
  }

  if (wantsTeams) {
    const teamsUserId = await resolveTeamsUser(input.person, deps);
    if (teamsUserId) {
      await queueTeamsMessage(db, {
        personId: input.person.id,
        type: input.type,
        title: input.teams.title,
        summary: input.teams.summary,
        link: input.teams.link ?? null,
        bodyHtml: renderTeamsBody(input.teams),
        fallbackSubject: input.email.subject,
        fallbackHtml: input.email.html,
      });
    } else if (channel === "teams") {
      // No Teams identity and email was not already queued above: fall back now.
      await queueTheEmail();
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TEST_DATABASE_URL=postgresql://localhost/havenhub_test_teams npx vitest run src/platform/notifications/notify.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/platform/notifications/notify.ts src/platform/notifications/notify.test.ts
git commit -m "feat(notifications): unified notify() dispatcher"
```

---

## Task 9: Add Teams Graph scopes + scope-status helper

**Files:**
- Modify: `src/platform/email/oauth.ts` (extend `SCOPES`; export the granted-scope check)
- Test: `src/platform/email/oauth.test.ts` (add cases)

**Interfaces:**
- Produces:
  - `SCOPES` includes `https://graph.microsoft.com/Chat.Create` and `https://graph.microsoft.com/ChatMessage.Send`.
  - `function teamsScopesGranted(scope: string | null): boolean` — true when a stored credential scope string includes both Teams chat scopes.

- [ ] **Step 1: Write the failing test**

Add to `src/platform/email/oauth.test.ts`:

```ts
import { buildAuthorizeUrl, teamsScopesGranted } from "./oauth";

describe("Teams scopes", () => {
  it("buildAuthorizeUrl requests the Teams chat scopes", () => {
    // Requires GRAPH_OAUTH_CLIENT_ID + GRAPH_OAUTH_TENANT_ID in the test env.
    const url = buildAuthorizeUrl({ state: "s" });
    expect(decodeURIComponent(url)).toContain("Chat.Create");
    expect(decodeURIComponent(url)).toContain("ChatMessage.Send");
  });

  it("teamsScopesGranted detects both chat scopes in a stored scope string", () => {
    expect(teamsScopesGranted(null)).toBe(false);
    expect(teamsScopesGranted("Mail.Send")).toBe(false);
    expect(teamsScopesGranted("Mail.Send Chat.Create ChatMessage.Send")).toBe(true);
  });
});
```

> If the existing `oauth.test.ts` already stubs `config.GRAPH_OAUTH_CLIENT_ID`/`TENANT_ID`, reuse that setup. Otherwise guard `buildAuthorizeUrl` cases with the same env the file already relies on.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/platform/email/oauth.test.ts`
Expected: FAIL — `teamsScopesGranted` is not exported; URL lacks the new scopes.

- [ ] **Step 3: Extend SCOPES and add the helper**

In `src/platform/email/oauth.ts`, replace the `SCOPES` constant:

```ts
const SCOPES =
  "openid profile email offline_access https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.Send.Shared https://graph.microsoft.com/Channel.ReadBasic.All https://graph.microsoft.com/Chat.Create https://graph.microsoft.com/ChatMessage.Send";
```

Then add, near `mailConnectionStatus` at the bottom of the file:

```ts
/**
 * True when the stored credential scope string already includes both Teams chat
 * scopes. Used by the admin UI to prompt for a reconnect after the scopes grew.
 */
export function teamsScopesGranted(scope: string | null): boolean {
  if (!scope) return false;
  return scope.includes("Chat.Create") && scope.includes("ChatMessage.Send");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/platform/email/oauth.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/platform/email/oauth.ts src/platform/email/oauth.test.ts
git commit -m "feat(notifications): request Teams chat scopes + scope-status helper"
```

---

## Task 10: Drain the Teams queue in the email cron

**Files:**
- Modify: `src/app/api/cron/email/route.ts`
- Test: `src/app/api/cron/email/route.test.ts` (create if absent, else add a case)

**Interfaces:**
- Consumes: `drainTeamsQueue` (Task 7); `resolveTeamsTransport` (Task 6).
- Produces: the cron JSON response gains a `teams: number` field; Teams queue drained until empty after the email drain.

- [ ] **Step 1: Write the failing test**

```ts
// src/app/api/cron/email/route.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";

// The cron authorizes via Bearer CRON_SECRET; set it for the test.
process.env.CRON_SECRET = process.env.CRON_SECRET ?? "test-secret";

describe("GET /api/cron/email drains Teams", () => {
  beforeEach(async () => await resetDb());

  it("includes a teams count and marks queued Teams messages sent (log transport)", async () => {
    const p = await prisma.person.create({
      data: { name: "Sam", contactEmail: "sam@x.com", entraObjectId: "e1" },
    });
    await prisma.teamsMessage.create({
      data: {
        personId: p.id,
        type: "epic-onboarding",
        title: "T",
        summary: "S",
        bodyHtml: "<p>x</p>",
        fallbackSubject: "T",
        fallbackHtml: "<p>x</p>",
      },
    });

    const { GET } = await import("./route");
    const req = new Request("https://app/api/cron/email", {
      headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
    });
    const res = await GET(req);
    const json = await res.json();

    expect(json.ok).toBe(true);
    expect(json.teams).toBeGreaterThanOrEqual(1);
    const row = await prisma.teamsMessage.findFirst({ where: { personId: p.id } });
    expect(row?.status).toBe("SENT"); // log transport succeeds (email.transport defaults to "log")
  });
});
```

> The default `email.transport` is `log`, so `resolveTeamsTransport()` returns `LogTeamsTransport` and the drain marks the row SENT without any network call. If `authorizeCron` reads the secret differently, mirror whatever the existing email-cron tests do.

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL=postgresql://localhost/havenhub_test_teams npx vitest run src/app/api/cron/email/route.test.ts`
Expected: FAIL — response has no `teams` field; the row stays QUEUED.

- [ ] **Step 3: Wire the drain into the route**

In `src/app/api/cron/email/route.ts`, add imports:

```ts
import { drainTeamsQueue } from "@/platform/notifications/send";
import { resolveTeamsTransport } from "@/platform/notifications/teams-transport";
```

Then, after the existing email drain `do/while` loop and before the `return`, add the Teams drain and extend the response:

```ts
  const teamsTransport = await resolveTeamsTransport();
  let teams = 0;
  let teamsProcessed: number;
  do {
    teamsProcessed = await drainTeamsQueue(teamsTransport);
    teams += teamsProcessed;
  } while (teamsProcessed > 0);

  return Response.json({ ok: true, dispatched: executed, errors, emails, teams });
```

(Replace the existing `return Response.json({ ok: true, dispatched: executed, errors, emails });` line.)

- [ ] **Step 4: Run test to verify it passes**

Run: `TEST_DATABASE_URL=postgresql://localhost/havenhub_test_teams npx vitest run src/app/api/cron/email/route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/cron/email/route.ts src/app/api/cron/email/route.test.ts
git commit -m "feat(notifications): drain Teams queue in the email cron"
```

---

## Task 11: Route compliance reminders + escalations through notify()

**Files:**
- Modify: `src/platform/email/reminders.ts`
- Test: `src/platform/email/reminders.test.ts` (add a Teams-routing case; keep existing cases green)

**Interfaces:**
- Consumes: `notify` (Task 8).
- Produces: reminder and escalation sends go through `notify()`; person selects include `entraObjectId`.

- [ ] **Step 1: Write the failing test**

Add to `src/platform/email/reminders.test.ts` a case asserting Teams routing. Adapt the arrange step to the file's existing fixtures (an active term, an ACTIVE membership, a non-compliant person):

```ts
import * as channel from "@/platform/notifications/channel";

it("queues a Teams message for the reminder when the type routes to teams", async () => {
  vi.spyOn(channel, "resolveChannel").mockResolvedValue("teams");
  // ... existing arrange: active term + ACTIVE membership + non-compliant person
  //     WITH entraObjectId set, e.g. entraObjectId: "e-vol"
  await runComplianceReminders(new Date());
  const teams = await prisma.teamsMessage.findFirst({ where: { type: "compliance-reminder" } });
  expect(teams).not.toBeNull();
  expect(teams?.title).toContain("compliance");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL=postgresql://localhost/havenhub_test_teams npx vitest run src/platform/email/reminders.test.ts`
Expected: FAIL — no `teamsMessage` is created (reminders still call `queueEmail` directly).

- [ ] **Step 3: Replace the reminder send with notify()**

In `src/platform/email/reminders.ts`:

1. Update imports — remove the now-unused `queueEmail` import only if nothing else uses it (escalation also moves to notify, so it can go), and add:

```ts
import { notify } from "@/platform/notifications/notify";
```

2. Add `entraObjectId` to the candidate person select (~line 98):

```ts
    select: { id: true, name: true, contactEmail: true, entraObjectId: true },
```

3. Replace the reminder `queueEmail(...)` block (~lines 187-193) with:

```ts
    await notify(prisma, {
      type: "compliance-reminder",
      person: {
        id: person.id,
        entraObjectId: person.entraObjectId,
        contactEmail: person.contactEmail,
      },
      email: { subject: renderedReminder.subject, html: renderedReminder.html },
      teams: {
        title: "HIPAA compliance reminder",
        summary: "Your HIPAA training needs attention. Please review your compliance status.",
        link: `${await getSetting<string>("app.baseUrl")}/get-started`,
      },
    });
```

> `getSetting` is already imported in this file. `app.baseUrl` is a registered setting.

- [ ] **Step 4: Replace the escalation send with notify()**

In `sendEscalations`, the director select (~line 287) must include `entraObjectId` and `id`:

```ts
      person: { select: { id: true, name: true, contactEmail: true, entraObjectId: true } },
```

Carry `id` and `entraObjectId` into the `seenDirectors` map value:

```ts
  const seenDirectors = new Map<
    string,
    { id: string; name: string; contactEmail: string | null; entraObjectId: string | null; departmentName: string }
  >();
```

In the loop that fills the map:

```ts
      seenDirectors.set(dirPersonId, {
        id: dirPersonId,
        name: dm.person.name,
        contactEmail: dm.person.contactEmail,
        entraObjectId: dm.person.entraObjectId,
        departmentName: dept?.name ?? "Unknown Department",
      });
```

Replace the escalation `queueEmail(...)` block (~lines 328-334) with:

```ts
    await notify(prisma, {
      type: "compliance-escalation",
      person: {
        id: director.id,
        entraObjectId: director.entraObjectId,
        contactEmail: director.contactEmail,
      },
      email: { subject: renderedEscalation.subject, html: renderedEscalation.html },
      teams: {
        title: "HIPAA compliance escalation",
        summary: `${volunteer.name} in ${director.departmentName} has an outstanding HIPAA compliance issue.`,
        link: `${await getSetting<string>("app.baseUrl")}/admin`,
      },
    });
```

> Note: the `if (!director.contactEmail) continue;` guard above this block must be relaxed so directors with a Teams identity but no email still get notified. Replace it with: skip only when the director has neither a contactEmail nor an entraObjectId:
> ```ts
>     if (!director.contactEmail && !director.entraObjectId) continue;
> ```

- [ ] **Step 5: Run tests to verify they pass**

Run: `TEST_DATABASE_URL=postgresql://localhost/havenhub_test_teams npx vitest run src/platform/email/reminders.test.ts`
Expected: PASS (the new Teams case plus all existing reminder/escalation cases).

- [ ] **Step 6: Commit**

```bash
git add src/platform/email/reminders.ts src/platform/email/reminders.test.ts
git commit -m "feat(notifications): route compliance reminders + escalations through notify()"
```

---

## Task 12: Route EPIC emails through notify()

**Files:**
- Modify: `src/modules/volunteers/services/epic.ts`
- Test: `src/modules/volunteers/services/epic.test.ts` (add a Teams-routing case; keep existing green)

**Interfaces:**
- Consumes: `notify` (Task 8).
- Produces: `sendEpicEmail` routes through `notify()`; `person` already loaded with `entraObjectId` via `include: { person: true }`.

- [ ] **Step 1: Write the failing test**

Add to `src/modules/volunteers/services/epic.test.ts`, adapting to its existing fixtures (a person with `contactEmail` + an `EpicRequest`; an actor with `volunteers.manage_epic`):

```ts
import * as channel from "@/platform/notifications/channel";

it("queues a Teams message when the EPIC type routes to teams", async () => {
  vi.spyOn(channel, "resolveChannel").mockResolvedValue("teams");
  // ... existing arrange: person WITH entraObjectId: "e-epic", an EpicRequest, actor with perm
  await sendEpicEmail(actor.id, request.id, "epic-onboarding");
  const teams = await prisma.teamsMessage.findFirst({ where: { type: "epic-onboarding" } });
  expect(teams).not.toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL=postgresql://localhost/havenhub_test_teams npx vitest run src/modules/volunteers/services/epic.test.ts`
Expected: FAIL — no `teamsMessage` created (still calling `queueEmail`).

- [ ] **Step 3: Replace the EPIC send with notify()**

In `src/modules/volunteers/services/epic.ts`:

1. Replace the `queueEmail` import:

```ts
import { notify } from "@/platform/notifications/notify";
```

2. Replace the `queueEmail(prisma, {...})` block (~lines 644-651) with:

```ts
  const epicTeamsSummary: Record<EpicTemplateKey, string> = {
    "epic-onboarding": "Your EPIC access onboarding has an update. Open HAVEN Hub for details.",
    "epic-activation": "Your EPIC access has been activated. Open HAVEN Hub for details.",
    "epic-password-reset": "Your EPIC password was reset. Open HAVEN Hub for details.",
  };

  // Global prisma client is intentional: there is no surrounding domain write to be transactional with.
  await notify(prisma, {
    type: template,
    person: {
      id: person.id,
      entraObjectId: person.entraObjectId,
      contactEmail: person.contactEmail,
    },
    email: { subject, html },
    teams: {
      title: "EPIC access update",
      summary: epicTeamsSummary[template],
      link: `${await getSetting<string>("app.baseUrl")}/volunteers`,
    },
    triggeredById: actorPersonId,
  });
```

3. Ensure `getSetting` is imported in this file. If not present, add:

```ts
import { getSetting } from "@/platform/settings/service";
```

> `person` here comes from `req.person` via `include: { person: true }`, so it carries `entraObjectId` and `contactEmail` already. The existing guard `if (!person.contactEmail) throw new EpicStateError(...)` may now be too strict for a Teams-only recipient; leave it as-is for this iteration (EPIC recipients are expected to have an email), since loosening it would change the function's documented contract. Note this in the PR description.

- [ ] **Step 4: Run tests to verify they pass**

Run: `TEST_DATABASE_URL=postgresql://localhost/havenhub_test_teams npx vitest run src/modules/volunteers/services/epic.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/volunteers/services/epic.ts src/modules/volunteers/services/epic.test.ts
git commit -m "feat(notifications): route EPIC emails through notify()"
```

---

## Task 13: Admin — Teams message monitor service

**Files:**
- Create: `src/modules/admin/services/teams-messages.ts`
- Test: `src/modules/admin/services/teams-messages.test.ts`

**Interfaces:**
- Consumes: `prisma`; mirror the existing `src/modules/admin/services/email.ts` shape (read it first to match conventions, page size, error classes).
- Produces:
  - `const TEAMS_PAGE_SIZE = 25`
  - `class TeamsMessageNotFoundError extends Error`
  - `class TeamsMessageStateError extends Error`
  - `async function listTeamsMessages(params: { status?: TeamsMessageStatus; type?: string; q?: string; page?: number }): Promise<{ rows: TeamsMessageWithPerson[]; total: number; page: number }>`
  - `async function retryTeamsMessage(id: string): Promise<void>` — only FAILED/FALLBACK rows reset to QUEUED (attempts reset to 0).

- [ ] **Step 1: Write the failing test**

```ts
// src/modules/admin/services/teams-messages.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  listTeamsMessages,
  retryTeamsMessage,
  TeamsMessageStateError,
} from "./teams-messages";

async function seed(status: "QUEUED" | "SENT" | "FAILED" | "FALLBACK") {
  const p = await prisma.person.create({
    data: { name: "Sam", contactEmail: "sam@x.com", entraObjectId: "e1" },
  });
  return prisma.teamsMessage.create({
    data: {
      personId: p.id,
      type: "epic-onboarding",
      title: "T",
      summary: "S",
      bodyHtml: "<p>x</p>",
      fallbackSubject: "T",
      fallbackHtml: "<p>x</p>",
      status,
    },
  });
}

describe("listTeamsMessages", () => {
  beforeEach(async () => await resetDb());

  it("filters by status", async () => {
    await seed("QUEUED");
    await seed("FAILED");
    const { rows, total } = await listTeamsMessages({ status: "FAILED" });
    expect(total).toBe(1);
    expect(rows[0].status).toBe("FAILED");
  });
});

describe("retryTeamsMessage", () => {
  beforeEach(async () => await resetDb());

  it("resets a FAILED row to QUEUED with zero attempts", async () => {
    const row = await seed("FAILED");
    await prisma.teamsMessage.update({ where: { id: row.id }, data: { attempts: 8 } });
    await retryTeamsMessage(row.id);
    const after = await prisma.teamsMessage.findUnique({ where: { id: row.id } });
    expect(after?.status).toBe("QUEUED");
    expect(after?.attempts).toBe(0);
  });

  it("rejects retrying a SENT row", async () => {
    const row = await seed("SENT");
    await expect(retryTeamsMessage(row.id)).rejects.toBeInstanceOf(TeamsMessageStateError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL=postgresql://localhost/havenhub_test_teams npx vitest run src/modules/admin/services/teams-messages.test.ts`
Expected: FAIL — cannot find module `./teams-messages`.

- [ ] **Step 3: Implement (mirroring email.ts conventions)**

First read `src/modules/admin/services/email.ts` to match its filter/pagination style, then:

```ts
// src/modules/admin/services/teams-messages.ts
import type { TeamsMessage, TeamsMessageStatus, Person } from "@prisma/client";
import { prisma } from "@/platform/db";

export const TEAMS_PAGE_SIZE = 25;

export class TeamsMessageNotFoundError extends Error {
  constructor(id: string) {
    super(`Teams message not found: ${id}`);
    this.name = "TeamsMessageNotFoundError";
  }
}

export class TeamsMessageStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeamsMessageStateError";
  }
}

export type TeamsMessageWithPerson = TeamsMessage & {
  person: Pick<Person, "id" | "name" | "contactEmail">;
};

/** List Teams messages with optional status/type/recipient filters, paginated. */
export async function listTeamsMessages(params: {
  status?: TeamsMessageStatus;
  type?: string;
  q?: string;
  page?: number;
}): Promise<{ rows: TeamsMessageWithPerson[]; total: number; page: number }> {
  const page = Math.max(1, params.page ?? 1);
  const where = {
    ...(params.status ? { status: params.status } : {}),
    ...(params.type ? { type: params.type } : {}),
    ...(params.q
      ? { person: { is: { name: { contains: params.q, mode: "insensitive" as const } } } }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.teamsMessage.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * TEAMS_PAGE_SIZE,
      take: TEAMS_PAGE_SIZE,
      include: { person: { select: { id: true, name: true, contactEmail: true } } },
    }),
    prisma.teamsMessage.count({ where }),
  ]);

  return { rows, total, page };
}

/** Reset a FAILED or FALLBACK Teams message back to QUEUED for another attempt. */
export async function retryTeamsMessage(id: string): Promise<void> {
  const row = await prisma.teamsMessage.findUnique({ where: { id } });
  if (!row) throw new TeamsMessageNotFoundError(id);
  if (row.status !== "FAILED" && row.status !== "FALLBACK") {
    throw new TeamsMessageStateError(`Only failed messages can be retried (status: ${row.status}).`);
  }
  await prisma.teamsMessage.update({
    where: { id },
    data: { status: "QUEUED", attempts: 0, lastError: null },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TEST_DATABASE_URL=postgresql://localhost/havenhub_test_teams npx vitest run src/modules/admin/services/teams-messages.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/admin/services/teams-messages.ts src/modules/admin/services/teams-messages.test.ts
git commit -m "feat(notifications): admin Teams message monitor service"
```

---

## Task 14: Admin — Teams monitor page + reconnect note

**Files:**
- Create: `src/app/(app)/admin/notifications/page.tsx`
- Modify: `src/app/(app)/admin/email/page.tsx` (add a reconnect-for-Teams note)

**Interfaces:**
- Consumes: `listTeamsMessages`, `retryTeamsMessage`, `TEAMS_PAGE_SIZE` (Task 13); `mailConnectionStatus` + `teamsScopesGranted` (Task 9); the UI primitives used by the email page.

This task is a UI mirror of `src/app/(app)/admin/email/page.tsx`. Read that page in full first and replicate its structure (server component, `requirePermission("admin.manage_sync")`, filter form, `StatCard` health counts, `Table`, `Pagination`, a `retried`/`error` searchParam flow, and a server action calling `retryTeamsMessage`). Substitute the Teams service and statuses (`QUEUED | SENT | FAILED | FALLBACK`), and the type list from `NOTIFICATION_TYPES`.

- [ ] **Step 1: Build the monitor page**

Create `src/app/(app)/admin/notifications/page.tsx` mirroring the email page, with:
- Header: `PageHeader` titled "Notifications".
- A short intro line linking to `/admin/settings` for channel configuration: "Choose Email, Teams, or Both per notification type in Settings > Notifications."
- A server action `retryAction` (form action) that reads `id` and calls `retryTeamsMessage`, then `revalidatePath("/admin/notifications")`.
- Health `StatCard`s: queued / failed / fallback counts (via `listTeamsMessages` totals per status or direct `prisma.teamsMessage.count`).
- A `Table` of rows: recipient name, type, status `Badge`, attempts, createdAt, sentAt, lastError, and a `ConfirmButton`/`Button` Retry for FAILED/FALLBACK rows.
- Status tone helper: `SENT` → success, `FAILED` → critical, `FALLBACK` → default, `QUEUED` → default.

Use the exact same imports and helpers (`fmtDateTime`, `BadgeTone`) as the email page; copy them locally rather than importing private helpers.

- [ ] **Step 2: Add the reconnect note to the email page**

In `src/app/(app)/admin/email/page.tsx`:

1. Add imports:

```ts
import { teamsScopesGranted } from "@/platform/email/oauth";
```

2. Where the page already calls `mailConnectionStatus()`, also read the credential scope to decide whether to show the note. Add near that call:

```ts
  const cred = await prisma.mailCredential.findUnique({ where: { id: "mailer" } });
  const needsTeamsReconnect = cred != null && !teamsScopesGranted(cred.scope);
```

(Import `prisma` from `@/platform/db` if not already imported.)

3. In the mailer-connection panel JSX, when `needsTeamsReconnect` is true, render an `Alert`:

```tsx
{needsTeamsReconnect && (
  <Alert tone="warning">
    Teams direct messages need an additional permission. Reconnect the mailbox to grant it.
  </Alert>
)}
```

> Match the `Alert` tone prop to whatever the component supports (the email page already imports `Alert`).

- [ ] **Step 3: Type-check and build**

Run:
```bash
npx tsc --noEmit
```
Expected: no type errors in the new/modified files.

- [ ] **Step 4: Manual smoke (optional but recommended)**

Run the dev server and visit `/admin/notifications` and `/admin/settings` (Notifications category) to confirm they render. With `email.transport=log`, queued Teams rows drain to SENT on the next cron tick.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/admin/notifications/page.tsx" "src/app/(app)/admin/email/page.tsx"
git commit -m "feat(notifications): admin Teams monitor page + reconnect note"
```

---

## Task 15: Full suite, env docs, and final verification

**Files:**
- Modify: `.env.example` (document that Teams DMs reuse the Graph OAuth config and require a mailer reconnect)
- Modify: `CHANGELOG.md` (add an entry, matching the existing format)

- [ ] **Step 1: Document env / operational note**

In `.env.example`, near the existing Graph OAuth block, add a comment (no new variables are required):

```
# Teams direct-message notifications reuse the Graph OAuth credentials above and
# the connected mailbox. After deploying, an admin must RECONNECT the mailbox in
# /admin/email once to grant the added Chat.Create + ChatMessage.Send scopes.
# Per-type routing (Email / Teams / Both) is configured in /admin/settings.
```

- [ ] **Step 2: Add a CHANGELOG entry**

Add a bullet under the appropriate heading in `CHANGELOG.md` (match the file's existing style):

```
- Teams notifications: notifications can now be delivered as Microsoft Teams direct messages, configurable per type (Email / Teams / Both) in Settings, with automatic email fallback.
```

- [ ] **Step 3: Run the full notifications + touched suites**

Run:
```bash
TEST_DATABASE_URL=postgresql://localhost/havenhub_test_teams npx vitest run \
  src/platform/notifications \
  src/platform/email/reminders.test.ts \
  src/platform/email/oauth.test.ts \
  src/modules/volunteers/services/epic.test.ts \
  src/modules/admin/services/teams-messages.test.ts \
  src/app/api/cron/email/route.test.ts
```
Expected: all PASS.

- [ ] **Step 4: Run the entire test suite**

Run: `TEST_DATABASE_URL=postgresql://localhost/havenhub_test_teams npx vitest run`
Expected: green except the 4 pre-existing cert `/tmp` ENOENT flakes noted in project memory.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add .env.example CHANGELOG.md
git commit -m "docs(notifications): document Teams DM setup + changelog"
```

---

## Self-Review notes (for the implementer)

- **Spec coverage:** Task 1 (model) → spec §3; Task 2-3 (registry+settings+resolver) → §1, §4; Task 4 (identity) → §2; Task 5-6 (render+transport) → §2, §4 format; Task 7-8 (queue/drain/notify+fallback) → §1, §3; Task 9 (scopes) → §2; Task 10 (cron) → §3; Task 11-12 (call sites) → §1; Task 13-14 (admin) → §4; Task 15 (docs/verify) → operational notes.
- **Reconnect gotcha:** nothing sends real Teams DMs until an admin reconnects the mailbox (new scopes) AND sets a type's channel to Teams/Both. Until then, behavior is identical to today (email only).
- **Transaction note:** the existing call sites pass the global `prisma` (not a transaction) to `queueEmail`, so `notify()`'s identity-cache write is safe. If a future caller passes a real transaction client, be aware `resolveTeamsUser` writes via the global client outside that transaction.
- **`resetDb` / `TEST_DATABASE_URL`:** `resetDb` is imported from `@/platform/test/db`; confirm the `TEST_DATABASE_URL` value matches your local Postgres before running DB-backed tests.
