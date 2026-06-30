# Per-template / per-category email sender address: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let admins choose the "from" address per email category (with a per-template override), so recruitment email can send from a different delegated mailbox than hfc.it@yale.edu.

**Architecture:** Resolve the sender inside the single `queueEmail` chokepoint and snapshot it onto the `EmailLog` row at enqueue time. A small cached `EmailSenderRule` table holds assignments at two scopes (CATEGORY by template group, TEMPLATE by key); precedence is template then category then global default. `GraphTransport` sends AS the per-message address using the existing connection (the stored OAuth token already carries `Mail.Send.Shared`).

**Tech Stack:** Next.js App Router (server components + server actions), Prisma + PostgreSQL, Microsoft Graph `sendMail`, Vitest (integration tests against a local test DB).

**Spec:** `docs/superpowers/specs/2026-06-29-email-sender-per-template-design.md`

## Global Constraints

- **DB safety (critical).** The repo `.env` points every DB URL at the shared production Neon database. NEVER run `prisma migrate` or Vitest against it. Every `prisma` CLI command in this plan MUST be prefixed with the local URLs, and every test run MUST set `TEST_DATABASE_URL`. The local worktree DB for this feature is:
  `postgresql://haven:haven_dev@localhost:5434/havenhub_test_emailsender`
- **No em-dashes** in any copy, comment, or doc. Use periods, commas, parentheses, or colons.
- **Naming:** "HAVEN Hub" is two words in UI prose; code identifiers stay `havenhub`.
- **TDD:** write the failing test first for every unit with logic; UI wiring tasks verify with `npx tsc --noEmit` plus a manual smoke check.
- **Commit after every task.** Keep commits small and scoped.
- **Reuse existing UI primitives** from `src/platform/ui/` (`Input`, `Button`, `Alert`, `Select`, etc.). Do not introduce new primitives.
- **node_modules in this worktree is local** (a real `npm install` ran here), so `npx prisma generate` only regenerates this worktree's client. Safe to run here.

---

### Task 0: Worktree DB and baseline (pre-flight, no commit)

**Files:** none (environment only)

- [ ] **Step 1: Bring up local Postgres**

Run:
```bash
cd /Users/jcarney/Documents/Code-Projects/HAVENHub/.claude/worktrees/feat+email-sender-per-template
npm run db:up
```
Expected: the `postgres` container is up (port 5434).

- [ ] **Step 2: Create the per-worktree test DB**

Run:
```bash
docker compose exec -T postgres psql -U haven -d havenhub -c "CREATE DATABASE havenhub_test_emailsender" || true
```
Expected: `CREATE DATABASE` (or a harmless "already exists" error swallowed by `|| true`).

- [ ] **Step 3: Apply the current migrations to the test DB**

Run:
```bash
DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_emailsender \
DATABASE_URL_UNPOOLED=postgresql://haven:haven_dev@localhost:5434/havenhub_test_emailsender \
npx prisma migrate deploy
```
Expected: migrations apply cleanly, "All migrations have been applied".

- [ ] **Step 4: Run the full test baseline**

Run:
```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_emailsender npm test
```
Expected: green (a small number of pre-existing cert `/tmp` ENOENT flakes are acceptable, per project memory). If anything else fails, STOP and report before implementing.

---

### Task 1: Schema and migration

**Files:**
- Modify: `prisma/schema.prisma` (EmailLog model; add enum + model; Person relation)

**Interfaces:**
- Produces: Prisma types `EmailSenderRule`, `EmailSenderScope` (values `CATEGORY`, `TEMPLATE`), and `EmailLog.fromEmail: string | null`, `EmailLog.fromName: string | null`.

- [ ] **Step 1: Add the enum and model to `prisma/schema.prisma`**

Add near the other email models:
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

- [ ] **Step 2: Add the snapshot columns to `EmailLog`**

In `model EmailLog`, add after `template`:
```prisma
  /// Snapshot of the resolved sender at enqueue time. Null means use the global default sender.
  fromEmail     String?
  /// Optional display name paired with fromEmail.
  fromName      String?
```

- [ ] **Step 3: Add the back-relation on `Person`**

In `model Person`, alongside the other email relations (search for `emailTemplateUpdatedBy`), add:
```prisma
  emailSenderRules EmailSenderRule[] @relation("emailSenderRuleUpdatedBy")
```

- [ ] **Step 4: Validate the schema**

Run:
```bash
npx prisma validate
```
Expected: "The schema is valid".

- [ ] **Step 5: Create and apply the migration against the local test DB, and regenerate the client**

Run:
```bash
DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_emailsender \
DATABASE_URL_UNPOOLED=postgresql://haven:haven_dev@localhost:5434/havenhub_test_emailsender \
npx prisma migrate dev --name add_email_sender_rule
```
Expected: a new folder under `prisma/migrations/` is created, applied, and `prisma generate` runs (new types available).

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(email): EmailSenderRule model + EmailLog sender snapshot columns"
```

---

### Task 2: Template `group` field

**Files:**
- Modify: `src/platform/email/templates/types.ts`
- Modify: `src/platform/email/templates/layout.ts`
- Modify: `src/platform/email/templates/compliance.ts`
- Modify: `src/platform/email/templates/epic.ts`
- Modify: `src/platform/email/templates/recruitment.ts`
- Test: `src/platform/email/templates/registry.test.ts` (create)

**Interfaces:**
- Produces: `TemplateGroup` type and `TemplateDescriptor.group: TemplateGroup`. Sendable groups: `recruitment`, `compliance`, `epic`, `campaign`. The `layout` descriptor uses `group: "layout"`.

- [ ] **Step 1: Write the failing test**

Create `src/platform/email/templates/registry.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { listDescriptors, getDescriptor } from "./registry";

describe("template descriptors carry a group", () => {
  it("every descriptor has a group", () => {
    for (const d of listDescriptors()) {
      expect(d.group, `descriptor ${d.key} is missing a group`).toBeTruthy();
    }
  });

  it("recruitment descriptors are in the recruitment group", () => {
    const d = getDescriptor("recruitment.acceptance");
    expect(d?.group).toBe("recruitment");
  });

  it("compliance descriptors are in the compliance group", () => {
    const d = getDescriptor("compliance-reminder");
    expect(d?.group).toBe("compliance");
  });

  it("epic descriptors are in the epic group", () => {
    const d = getDescriptor("epic-onboarding");
    expect(d?.group).toBe("epic");
  });

  it("the layout descriptor is in the layout group", () => {
    const d = getDescriptor("layout");
    expect(d?.group).toBe("layout");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_emailsender npx vitest run src/platform/email/templates/registry.test.ts
```
Expected: FAIL (`group` does not exist on the descriptor type / is undefined).

- [ ] **Step 3: Add `TemplateGroup` and the `group` field to the type**

In `src/platform/email/templates/types.ts`, replace the file body with:
```ts
export type VariableDef = { name: string; label: string; sampleValue: string };
export type TemplateCategory = "transactional" | "layout" | "campaign";

/** Module/group a template belongs to, used for per-category sender rules. */
export type TemplateGroup = "recruitment" | "compliance" | "epic" | "campaign" | "layout";

export type TemplateDescriptor = {
  key: string;
  name: string;
  category: TemplateCategory;
  /** Group for sender-rule resolution (distinct from the render category above). */
  group: TemplateGroup;
  variables: VariableDef[];
  defaultSubject: string;
  defaultBody: string;
};
```

- [ ] **Step 4: Set `group` on every descriptor**

In `src/platform/email/templates/layout.ts`, add `group: "layout",` to the `layoutDescriptor` object (next to its `category`).

In `src/platform/email/templates/compliance.ts`, add `group: "compliance",` to each of the three descriptors (next to each `category`).

In `src/platform/email/templates/epic.ts`, add `group: "epic",` to each of the three descriptors.

In `src/platform/email/templates/recruitment.ts`, add `group: "recruitment",` to each of the six descriptors.

(Place `group` directly after the existing `category` line in each object so the change is easy to scan.)

- [ ] **Step 5: Run the test to verify it passes**

Run:
```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_emailsender npx vitest run src/platform/email/templates/registry.test.ts
```
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run:
```bash
npx tsc --noEmit
```
Expected: no errors (every descriptor literal now satisfies the required `group` field).

- [ ] **Step 7: Commit**

```bash
git add src/platform/email/templates
git commit -m "feat(email): add group field to template descriptors"
```

---

### Task 3: Sender-rule resolution service

**Files:**
- Create: `src/platform/email/sender-rules.ts`
- Modify: `src/platform/test/db.ts` (truncate new table + reset new cache)
- Test: `src/platform/email/sender-rules.test.ts` (create)

**Interfaces:**
- Consumes: `getDescriptor` from `./templates/registry`, `TemplateGroup` from `./templates/types`, `getSetting` from `@/platform/settings/service`, `prisma`, `recordAudit`.
- Produces:
  - `type ResolvedSender = { fromEmail: string; fromName: string | null }`
  - `type SenderRuleView = { scope: EmailSenderScope; target: string; fromEmail: string; fromName: string | null }`
  - `const SENDER_CATEGORIES: { group: TemplateGroup; label: string }[]`
  - `class SenderRuleValidationError extends Error`
  - `function groupForTemplate(templateKey: string): TemplateGroup | null`
  - `async function resolveSenderForTemplate(templateKey: string): Promise<ResolvedSender | null>`
  - `async function resolveInheritedSender(templateKey: string): Promise<ResolvedSender>`
  - `async function listSenderRules(): Promise<SenderRuleView[]>`
  - `async function saveSenderRule(actorPersonId: string | null, scope: EmailSenderScope, target: string, input: { fromEmail: string; fromName?: string | null }): Promise<void>`
  - `async function clearSenderRule(actorPersonId: string | null, scope: EmailSenderScope, target: string): Promise<void>`
  - `function _resetSenderRulesCache(): void`

- [ ] **Step 1: Write the failing test**

Create `src/platform/email/sender-rules.test.ts`:
```ts
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { _resetSettingsCache } from "@/platform/settings/service";
import {
  groupForTemplate,
  resolveSenderForTemplate,
  resolveInheritedSender,
  saveSenderRule,
  clearSenderRule,
  listSenderRules,
  SenderRuleValidationError,
} from "./sender-rules";

beforeEach(async () => {
  await resetDb();
  _resetSettingsCache();
});

describe("groupForTemplate", () => {
  it("maps a registered descriptor to its group", () => {
    expect(groupForTemplate("recruitment.acceptance")).toBe("recruitment");
    expect(groupForTemplate("compliance-reminder")).toBe("compliance");
  });

  it("maps campaign system keys to the campaign group", () => {
    expect(groupForTemplate("campaign")).toBe("campaign");
    expect(groupForTemplate("campaign:test")).toBe("campaign");
  });

  it("returns null for an unknown key", () => {
    expect(groupForTemplate("totally-unknown")).toBeNull();
  });
});

describe("resolveSenderForTemplate", () => {
  it("returns null when no rule matches", async () => {
    expect(await resolveSenderForTemplate("recruitment.acceptance")).toBeNull();
  });

  it("applies a CATEGORY rule to a template in that group", async () => {
    await saveSenderRule(null, "CATEGORY", "recruitment", {
      fromEmail: "recruit@yale.edu",
      fromName: "HAVEN Recruitment",
    });
    expect(await resolveSenderForTemplate("recruitment.acceptance")).toEqual({
      fromEmail: "recruit@yale.edu",
      fromName: "HAVEN Recruitment",
    });
  });

  it("a TEMPLATE rule overrides the CATEGORY rule", async () => {
    await saveSenderRule(null, "CATEGORY", "recruitment", { fromEmail: "recruit@yale.edu" });
    await saveSenderRule(null, "TEMPLATE", "recruitment.acceptance", { fromEmail: "special@yale.edu" });
    const r = await resolveSenderForTemplate("recruitment.acceptance");
    expect(r?.fromEmail).toBe("special@yale.edu");
  });

  it("reflects a cleared rule (cache invalidated)", async () => {
    await saveSenderRule(null, "CATEGORY", "recruitment", { fromEmail: "recruit@yale.edu" });
    expect(await resolveSenderForTemplate("recruitment.acceptance")).not.toBeNull();
    await clearSenderRule(null, "CATEGORY", "recruitment");
    expect(await resolveSenderForTemplate("recruitment.acceptance")).toBeNull();
  });
});

describe("resolveInheritedSender", () => {
  it("falls back to the global email.sender setting when no category rule exists", async () => {
    await prisma.setting.create({ data: { key: "email.sender", value: "hfc.it@yale.edu" } });
    _resetSettingsCache();
    const r = await resolveInheritedSender("recruitment.acceptance");
    expect(r.fromEmail).toBe("hfc.it@yale.edu");
    expect(r.fromName).toBeNull();
  });

  it("returns the category rule when present", async () => {
    await saveSenderRule(null, "CATEGORY", "recruitment", { fromEmail: "recruit@yale.edu" });
    const r = await resolveInheritedSender("recruitment.acceptance");
    expect(r.fromEmail).toBe("recruit@yale.edu");
  });
});

describe("saveSenderRule", () => {
  it("rejects a malformed email", async () => {
    await expect(
      saveSenderRule(null, "CATEGORY", "recruitment", { fromEmail: "not-an-email" })
    ).rejects.toBeInstanceOf(SenderRuleValidationError);
  });

  it("upserts (one row per scope+target) and lists it", async () => {
    await saveSenderRule(null, "CATEGORY", "recruitment", { fromEmail: "a@yale.edu" });
    await saveSenderRule(null, "CATEGORY", "recruitment", { fromEmail: "b@yale.edu" });
    const rows = await listSenderRules();
    expect(rows).toHaveLength(1);
    expect(rows[0].fromEmail).toBe("b@yale.edu");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_emailsender npx vitest run src/platform/email/sender-rules.test.ts
```
Expected: FAIL (module `./sender-rules` not found).

- [ ] **Step 3: Implement the service**

Create `src/platform/email/sender-rules.ts`:
```ts
/**
 * Per-category and per-template email sender resolution.
 *
 * Rules live in EmailSenderRule at two scopes: CATEGORY (keyed by a template
 * group) and TEMPLATE (keyed by a descriptor key). Resolution precedence for a
 * given template key is: TEMPLATE rule, then CATEGORY rule (by the template's
 * group), then null (the caller falls back to the global email.sender setting).
 *
 * The full rule set is tiny (at most one row per group plus one per template),
 * so it is cached in-memory and invalidated on every write. This keeps the
 * per-recipient campaign enqueue loop from issuing a DB read per row.
 */
import type { EmailSenderScope } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { getSetting } from "@/platform/settings/service";
import { getDescriptor } from "./templates/registry";
import type { TemplateGroup } from "./templates/types";

export type ResolvedSender = { fromEmail: string; fromName: string | null };

export type SenderRuleView = {
  scope: EmailSenderScope;
  target: string;
  fromEmail: string;
  fromName: string | null;
};

/** Categories shown in the admin sender UI. Excludes layout (never enqueued). */
export const SENDER_CATEGORIES: { group: TemplateGroup; label: string }[] = [
  { group: "recruitment", label: "Recruitment" },
  { group: "compliance", label: "Compliance" },
  { group: "epic", label: "Epic" },
  { group: "campaign", label: "Campaigns" },
];

export class SenderRuleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SenderRuleValidationError";
  }
}

// A pragmatic email check: non-space, an @, a dot in the domain. Semantic
// validity (Send-As rights) is confirmed by the admin via the test send.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

let cache: Map<string, SenderRuleView> | null = null;

function cacheKey(scope: EmailSenderScope, target: string): string {
  return `${scope}:${target}`;
}

/** Test-only: clear the in-memory rule cache between cases. */
export function _resetSenderRulesCache(): void {
  cache = null;
}

async function loadCache(): Promise<Map<string, SenderRuleView>> {
  if (cache) return cache;
  const rows = await prisma.emailSenderRule.findMany();
  const map = new Map<string, SenderRuleView>();
  for (const r of rows) {
    map.set(cacheKey(r.scope, r.target), {
      scope: r.scope,
      target: r.target,
      fromEmail: r.fromEmail,
      fromName: r.fromName,
    });
  }
  cache = map;
  return map;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** The group a template key belongs to, for CATEGORY-rule lookup. */
export function groupForTemplate(templateKey: string): TemplateGroup | null {
  const d = getDescriptor(templateKey);
  if (d) return d.group;
  if (templateKey === "campaign" || templateKey.startsWith("campaign:")) return "campaign";
  return null;
}

/** Resolve the sender for a template key, or null to use the global default. */
export async function resolveSenderForTemplate(
  templateKey: string
): Promise<ResolvedSender | null> {
  const map = await loadCache();

  const templateRule = map.get(cacheKey("TEMPLATE", templateKey));
  if (templateRule) {
    return { fromEmail: templateRule.fromEmail, fromName: templateRule.fromName };
  }

  const group = groupForTemplate(templateKey);
  if (group) {
    const categoryRule = map.get(cacheKey("CATEGORY", group));
    if (categoryRule) {
      return { fromEmail: categoryRule.fromEmail, fromName: categoryRule.fromName };
    }
  }

  return null;
}

/**
 * The sender a template INHERITS, ignoring any TEMPLATE rule on it: the
 * CATEGORY rule for its group, else the global email.sender setting. Used to
 * show the admin what a blank per-template field falls back to.
 */
export async function resolveInheritedSender(templateKey: string): Promise<ResolvedSender> {
  const map = await loadCache();
  const group = groupForTemplate(templateKey);
  if (group) {
    const categoryRule = map.get(cacheKey("CATEGORY", group));
    if (categoryRule) {
      return { fromEmail: categoryRule.fromEmail, fromName: categoryRule.fromName };
    }
  }
  const globalSender = await getSetting<string>("email.sender");
  return { fromEmail: globalSender, fromName: null };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listSenderRules(): Promise<SenderRuleView[]> {
  const map = await loadCache();
  return [...map.values()];
}

export async function saveSenderRule(
  actorPersonId: string | null,
  scope: EmailSenderScope,
  target: string,
  input: { fromEmail: string; fromName?: string | null }
): Promise<void> {
  const fromEmail = input.fromEmail.trim();
  if (!EMAIL_RE.test(fromEmail)) {
    throw new SenderRuleValidationError(`"${input.fromEmail}" is not a valid email address.`);
  }
  const fromName = input.fromName?.trim() ? input.fromName.trim() : null;

  await prisma.emailSenderRule.upsert({
    where: { scope_target: { scope, target } },
    create: { scope, target, fromEmail, fromName, updatedById: actorPersonId },
    update: { fromEmail, fromName, updatedById: actorPersonId },
  });
  _resetSenderRulesCache();

  await recordAudit({
    actorPersonId,
    action: "email.sender_rule_save",
    entityType: "EmailSenderRule",
    entityId: `${scope}:${target}`,
    after: { fromEmail, fromName },
  });
}

export async function clearSenderRule(
  actorPersonId: string | null,
  scope: EmailSenderScope,
  target: string
): Promise<void> {
  const existing = await prisma.emailSenderRule.findUnique({
    where: { scope_target: { scope, target } },
  });
  if (!existing) return;

  await prisma.emailSenderRule.delete({ where: { scope_target: { scope, target } } });
  _resetSenderRulesCache();

  await recordAudit({
    actorPersonId,
    action: "email.sender_rule_clear",
    entityType: "EmailSenderRule",
    entityId: `${scope}:${target}`,
    before: { fromEmail: existing.fromEmail, fromName: existing.fromName },
  });
}
```

Note: the compound unique `@@unique([scope, target])` generates the Prisma `where` key `scope_target`.

- [ ] **Step 4: Wire the new table and cache into `resetDb`**

In `src/platform/test/db.ts`:
1. Add `"EmailSenderRule"` to the `TRUNCATE` list (place it next to `"EmailTemplate"`).
2. Import and call the cache reset. Change the import line to:
```ts
import { _resetSettingsCache } from "@/platform/settings/service";
import { _resetSenderRulesCache } from "@/platform/email/sender-rules";
```
3. After the existing `_resetSettingsCache();` call at the end of `resetDb`, add:
```ts
  // The sender-rule resolver holds a process-global cache; we just truncated
  // "EmailSenderRule", so clear it to avoid cross-test leakage.
  _resetSenderRulesCache();
```

- [ ] **Step 5: Run the test to verify it passes**

Run:
```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_emailsender npx vitest run src/platform/email/sender-rules.test.ts
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/platform/email/sender-rules.ts src/platform/email/sender-rules.test.ts src/platform/test/db.ts
git commit -m "feat(email): cached per-category/per-template sender resolution service"
```

---

### Task 4: Transport carries a per-message `from`

**Files:**
- Modify: `src/platform/email/transport.ts`
- Test: `src/platform/email/transport.test.ts` (add cases)

**Interfaces:**
- Consumes: nothing new.
- Produces: `EmailMessage` gains `from?: string` and `fromName?: string`. `GraphTransport.send` sends as `message.from?.trim() || this.sender` and adds a `from` block when `fromName` is present.

- [ ] **Step 1: Write the failing tests**

In `src/platform/email/transport.test.ts`, add inside the existing `describe("GraphTransport", ...)` block:
```ts
  it("sends as message.from when provided, overriding the default sender", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 202 }));
    const transport = new GraphTransport({
      getAccessToken: fakeGetAccessToken,
      sender: "hfc.it@yale.edu",
      fetchImpl: fetchMock as typeof fetch,
    });
    await transport.send({ ...msg, from: "recruit@yale.edu" });

    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain(encodeURIComponent("recruit@yale.edu"));
    expect(String(url)).not.toContain(encodeURIComponent("hfc.it@yale.edu"));
  });

  it("includes a from block with the display name when fromName is set", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 202 }));
    const transport = new GraphTransport({
      getAccessToken: fakeGetAccessToken,
      sender: "hfc.it@yale.edu",
      fetchImpl: fetchMock as typeof fetch,
    });
    await transport.send({ ...msg, from: "recruit@yale.edu", fromName: "HAVEN Recruitment" });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = JSON.parse(String(init.body));
    expect(parsed.message.from.emailAddress.address).toBe("recruit@yale.edu");
    expect(parsed.message.from.emailAddress.name).toBe("HAVEN Recruitment");
  });

  it("omits the from block when no fromName is given", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 202 }));
    const transport = new GraphTransport({
      getAccessToken: fakeGetAccessToken,
      sender: "hfc.it@yale.edu",
      fetchImpl: fetchMock as typeof fetch,
    });
    await transport.send({ ...msg, from: "recruit@yale.edu" });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = JSON.parse(String(init.body));
    expect(parsed.message.from).toBeUndefined();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_emailsender npx vitest run src/platform/email/transport.test.ts
```
Expected: FAIL (the new fields are not on `EmailMessage`; the from block is not built).

- [ ] **Step 3: Update `EmailMessage` and the transports**

In `src/platform/email/transport.ts`:

Replace the `EmailMessage` type:
```ts
/** A single outbound email message. */
export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  /** Override the sending mailbox (Send-As). Defaults to the transport's sender. */
  from?: string;
  /** Optional display name paired with `from`. */
  fromName?: string;
};
```

Replace `LogTransport.send`:
```ts
  async send(message: EmailMessage): Promise<void> {
    const from = message.from ?? "(default sender)";
    console.log(`[email] from=${from} to=${message.to} subject=${message.subject}`);
  }
```

Replace `GraphTransport.send`:
```ts
  async send(message: EmailMessage): Promise<void> {
    const token = await this.getToken();
    const sender = message.from?.trim() || this.sender;
    const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`;

    const graphMessage: Record<string, unknown> = {
      subject: message.subject,
      body: { contentType: "HTML", content: message.html },
      toRecipients: [{ emailAddress: { address: message.to } }],
    };
    // A display name requires an explicit from block; without one the mailbox's
    // own configured display name is used.
    if (message.fromName && message.fromName.trim()) {
      graphMessage.from = {
        emailAddress: { address: sender, name: message.fromName.trim() },
      };
    }

    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: graphMessage, saveToSentItems: true }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Graph sendMail failed: ${res.status} ${text}`);
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_emailsender npx vitest run src/platform/email/transport.test.ts
```
Expected: PASS (all existing cases plus the three new ones).

- [ ] **Step 5: Commit**

```bash
git add src/platform/email/transport.ts src/platform/email/transport.test.ts
git commit -m "feat(email): per-message from/fromName in transport layer"
```

---

### Task 5: Snapshot the sender at enqueue and pass it through the drain

**Files:**
- Modify: `src/platform/email/send.ts`
- Test: `src/platform/email/send.test.ts` (add cases)

**Interfaces:**
- Consumes: `resolveSenderForTemplate` from `./sender-rules`; `EmailLog.fromEmail`/`fromName` from Task 1.
- Produces: `queueEmail` writes the resolved `fromEmail`/`fromName` onto the row; `drainEmailQueue` forwards them to `transport.send`.

- [ ] **Step 1: Write the failing tests**

In `src/platform/email/send.test.ts`:

Add the import at the top (next to the other imports):
```ts
import { saveSenderRule } from "./sender-rules";
```

Extend the `okTransport` helper to capture the `from` of each message. Replace the helper with:
```ts
/** Build a stub transport whose send resolves immediately, capturing from. */
function okTransport(): EmailTransport & { calls: string[]; froms: (string | undefined)[] } {
  const calls: string[] = [];
  const froms: (string | undefined)[] = [];
  return {
    calls,
    froms,
    async send(msg) {
      calls.push(msg.to);
      froms.push(msg.from);
    },
  };
}
```

Add a new describe block at the end of the file:
```ts
describe("queueEmail sender snapshot", () => {
  it("snapshots fromEmail/fromName from a matching CATEGORY rule", async () => {
    await saveSenderRule(null, "CATEGORY", "recruitment", {
      fromEmail: "recruit@yale.edu",
      fromName: "HAVEN Recruitment",
    });
    await queueEmail(prisma, {
      to: "a@example.com",
      subject: "Hi",
      html: "<p>Hi</p>",
      template: "recruitment.acceptance",
    });
    const row = await prisma.emailLog.findFirstOrThrow();
    expect(row.fromEmail).toBe("recruit@yale.edu");
    expect(row.fromName).toBe("HAVEN Recruitment");
  });

  it("leaves fromEmail null when no rule matches", async () => {
    await queueEmail(prisma, { ...BASE_EMAIL, to: "a@example.com" });
    const row = await prisma.emailLog.findFirstOrThrow();
    expect(row.fromEmail).toBeNull();
    expect(row.fromName).toBeNull();
  });

  it("drain forwards the snapshotted from to the transport", async () => {
    await saveSenderRule(null, "CATEGORY", "recruitment", { fromEmail: "recruit@yale.edu" });
    await queueEmail(prisma, {
      to: "a@example.com",
      subject: "Hi",
      html: "<p>Hi</p>",
      template: "recruitment.acceptance",
    });
    const transport = okTransport();
    await drainEmailQueue(transport);
    expect(transport.froms).toEqual(["recruit@yale.edu"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_emailsender npx vitest run src/platform/email/send.test.ts
```
Expected: FAIL (queueEmail does not yet write `fromEmail`; drain does not pass `from`).

- [ ] **Step 3: Resolve and snapshot in `queueEmail`**

In `src/platform/email/send.ts`:

Add the import:
```ts
import { resolveSenderForTemplate } from "./sender-rules";
```

Replace the body of `queueEmail` with:
```ts
export async function queueEmail(db: Db, input: QueueEmailInput): Promise<EmailLog> {
  const sender = await resolveSenderForTemplate(input.template);
  return db.emailLog.create({
    data: {
      toEmail: input.to,
      subject: input.subject,
      html: input.html,
      template: input.template,
      personId: input.personId ?? null,
      triggeredById: input.triggeredById ?? null,
      campaignRunId: input.campaignRunId ?? null,
      fromEmail: sender?.fromEmail ?? null,
      fromName: sender?.fromName ?? null,
    },
  });
}
```

- [ ] **Step 4: Forward the snapshot in `drainEmailQueue`**

In the `for (const row of rows)` loop, replace the `transport.send(...)` call:
```ts
        await transport.send({
          to: row.toEmail,
          subject: row.subject,
          html: row.html,
          from: row.fromEmail ?? undefined,
          fromName: row.fromName ?? undefined,
        });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run:
```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_emailsender npx vitest run src/platform/email/send.test.ts
```
Expected: PASS (existing cases plus the three new ones).

- [ ] **Step 6: Commit**

```bash
git add src/platform/email/send.ts src/platform/email/send.test.ts
git commit -m "feat(email): snapshot resolved sender on enqueue and forward through drain"
```

---

### Task 6: `sendSenderTest` action (synchronous test send)

**Files:**
- Modify: `src/modules/admin/services/email.ts`
- Test: `src/modules/admin/services/email.test.ts` (create)

**Interfaces:**
- Consumes: `GraphTransport`, `LogTransport` from `@/platform/email/transport`; `getAccessToken` from `@/platform/email/oauth`; `getSetting`.
- Produces:
  - `async function sendSenderTest(actorPersonId: string, input: { toEmail: string; fromEmail: string; fromName?: string | null }, opts?: { getAccessToken?: () => Promise<string>; fetchImpl?: typeof fetch }): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Create `src/modules/admin/services/email.test.ts`:
```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { _resetSettingsCache } from "@/platform/settings/service";
import { sendSenderTest } from "./email";

beforeEach(async () => {
  await resetDb();
  _resetSettingsCache();
});

describe("sendSenderTest", () => {
  it("in log mode it does not throw and records an audit entry", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await sendSenderTest("actor1", { toEmail: "me@yale.edu", fromEmail: "recruit@yale.edu" });
    } finally {
      spy.mockRestore();
    }
    const audit = await prisma.auditLog.findFirst({ where: { action: "email.sender_test" } });
    expect(audit).not.toBeNull();
  });

  it("in graph mode it throws when Graph responds non-OK", async () => {
    await prisma.setting.create({ data: { key: "email.transport", value: "graph" } });
    _resetSettingsCache();
    const fetchMock = vi.fn(async () => new Response("denied", { status: 403 }));
    await expect(
      sendSenderTest(
        "actor1",
        { toEmail: "me@yale.edu", fromEmail: "recruit@yale.edu" },
        { getAccessToken: () => Promise.resolve("tok"), fetchImpl: fetchMock as typeof fetch }
      )
    ).rejects.toThrow(/403/);
  });
});
```

Note: confirm the audit model accessor is `prisma.auditLog`. If `recordAudit` writes to a differently named model, match it (check `src/platform/audit.ts`) and adjust the `findFirst` accordingly before running.

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_emailsender npx vitest run src/modules/admin/services/email.test.ts
```
Expected: FAIL (`sendSenderTest` not exported).

- [ ] **Step 3: Implement `sendSenderTest`**

In `src/modules/admin/services/email.ts`, add imports at the top:
```ts
import { GraphTransport, LogTransport } from "@/platform/email/transport";
import { getAccessToken as defaultGetAccessToken } from "@/platform/email/oauth";
import { getSetting } from "@/platform/settings/service";
```

Append to the file:
```ts
// ---------------------------------------------------------------------------
// sendSenderTest
// ---------------------------------------------------------------------------

/**
 * Send a one-off test email AS `fromEmail`, directly (NOT via the queue), so any
 * Graph rejection (malformed address or missing Send-As rights) surfaces
 * synchronously to the admin. In log mode it just logs. Records an audit entry.
 *
 * `opts` is for testing only; production callers omit it.
 */
export async function sendSenderTest(
  actorPersonId: string,
  input: { toEmail: string; fromEmail: string; fromName?: string | null },
  opts?: { getAccessToken?: () => Promise<string>; fetchImpl?: typeof fetch }
): Promise<void> {
  const transportKind = await getSetting<"log" | "graph">("email.transport");
  const transport =
    transportKind === "graph"
      ? new GraphTransport({
          getAccessToken: opts?.getAccessToken ?? defaultGetAccessToken,
          sender: input.fromEmail,
          fetchImpl: opts?.fetchImpl,
        })
      : new LogTransport();

  await transport.send({
    to: input.toEmail,
    subject: "HAVEN Hub sender test",
    html: `<p>This is a test message confirming HAVEN Hub can send from ${input.fromEmail}.</p>`,
    from: input.fromEmail,
    fromName: input.fromName ?? undefined,
  });

  await recordAudit({
    actorPersonId,
    action: "email.sender_test",
    entityType: "EmailSenderRule",
    after: { toEmail: input.toEmail, fromEmail: input.fromEmail },
  });
}
```

Note: `GraphTransport`'s constructor accepts `fetchImpl?`; passing `undefined` makes it use the global `fetch`, which is correct for production.

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_emailsender npx vitest run src/modules/admin/services/email.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/admin/services/email.ts src/modules/admin/services/email.test.ts
git commit -m "feat(email): synchronous sender test send"
```

---

### Task 7: Category sender UI in `/admin/email`

**Files:**
- Modify: `src/app/(app)/admin/email/page.tsx`

**Interfaces:**
- Consumes: `SENDER_CATEGORIES`, `listSenderRules`, `saveSenderRule`, `clearSenderRule`, `SenderRuleValidationError` from `@/platform/email/sender-rules`; `sendSenderTest` from `@/modules/admin/services/email`; `getSetting`.
- Produces: a "Send-from addresses" section with one row per category (email + display name + Save + Clear + Send test) plus banners.

- [ ] **Step 1: Add imports**

In `src/app/(app)/admin/email/page.tsx`, add:
```ts
import {
  SENDER_CATEGORIES,
  listSenderRules,
  saveSenderRule,
  clearSenderRule,
  SenderRuleValidationError,
} from "@/platform/email/sender-rules";
import { sendSenderTest } from "@/modules/admin/services/email";
import { getSetting } from "@/platform/settings/service";
import type { EmailSenderScope } from "@prisma/client";
```

- [ ] **Step 2: Load the rules, the global default, and the acting admin**

In the `Promise.all([...])` near the top of `EmailPage`, add `listSenderRules()` and the global default and the session. After the existing destructuring of `requirePermission`, capture the actor. Replace the `await requirePermission(...)` line and the data load with:
```ts
  const actor = await requirePermission("admin.manage_sync");
  const sp = await searchParams;
```
and extend the data load:
```ts
  const [{ rows, total, counts }, mailConn, mailCred, senderRules, globalSender] =
    await Promise.all([
      listEmails({ status: validatedStatus, template: validatedTemplate, q, page }),
      mailConnectionStatus(),
      prisma.mailCredential.findUnique({ where: { id: "mailer" } }),
      listSenderRules(),
      getSetting<string>("email.sender"),
    ]);

  const categoryRuleByGroup = new Map(
    senderRules.filter((r) => r.scope === "CATEGORY").map((r) => [r.target, r])
  );
```

Also read the acting admin's email for the default test recipient. Add after the data load (the Person id is on `actor.personId`):
```ts
  const actorPerson = await prisma.person.findUnique({
    where: { id: actor.personId },
    select: { email: true },
  });
  const actorEmail = actorPerson?.email ?? "";
```

- [ ] **Step 3: Add the new search-param keys**

Extend the `searchParams` type in `PageProps` with:
```ts
    senderSaved?: string;
    senderError?: string;
    senderTested?: string;
```
and compute banner flags near the other `sp.*` reads:
```ts
  const senderSavedSuccess = sp.senderSaved === "1";
  const senderTestedSuccess = sp.senderTested === "1";
  const senderErrorMessage = sp.senderError ? decodeURIComponent(sp.senderError) : null;
```

- [ ] **Step 4: Add the three server actions**

Inside `EmailPage`, next to the existing server actions, add:
```ts
  async function saveSenderAction(formData: FormData) {
    "use server";
    const a = await requirePermission("admin.manage_sync");
    const scope = formData.get("scope") as EmailSenderScope;
    const target = (formData.get("target") as string | null) ?? "";
    const fromEmail = ((formData.get("fromEmail") as string | null) ?? "").trim();
    const fromName = ((formData.get("fromName") as string | null) ?? "").trim();

    try {
      if (fromEmail === "") {
        await clearSenderRule(a.personId, scope, target);
      } else {
        await saveSenderRule(a.personId, scope, target, { fromEmail, fromName });
      }
    } catch (err) {
      if (err instanceof SenderRuleValidationError) {
        redirect(`/admin/email?senderError=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    revalidatePath("/admin/email");
    redirect("/admin/email?senderSaved=1");
  }

  async function testSenderAction(formData: FormData) {
    "use server";
    const a = await requirePermission("admin.manage_sync");
    const fromEmail = ((formData.get("fromEmail") as string | null) ?? "").trim();
    const fromName = ((formData.get("fromName") as string | null) ?? "").trim();
    const toEmail = ((formData.get("toEmail") as string | null) ?? "").trim();
    if (fromEmail === "" || toEmail === "") {
      redirect(`/admin/email?senderError=${encodeURIComponent("A from address and a recipient are required to send a test.")}`);
    }
    try {
      await sendSenderTest(a.personId, { toEmail, fromEmail, fromName: fromName || null });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Test send failed.";
      redirect(`/admin/email?senderError=${encodeURIComponent(message)}`);
    }
    redirect("/admin/email?senderTested=1");
  }
```

- [ ] **Step 5: Render the section and banners**

Add these banners next to the existing ones (after `connectedSuccess`):
```tsx
      {senderSavedSuccess && !errorMessage && (
        <Alert tone="success">Sender address saved.</Alert>
      )}
      {senderTestedSuccess && !errorMessage && (
        <Alert tone="success">Test message sent. Check the inbox to confirm.</Alert>
      )}
      {senderErrorMessage && <Alert tone="error">{senderErrorMessage}</Alert>}
```

Add the section just below the mailer connection panel (before the health stat cards):
```tsx
      {/* Per-category send-from addresses */}
      <div className="rounded-2xl border border-border bg-surface p-5 space-y-4">
        <div>
          <p className="text-sm font-medium text-foreground-soft">Send-from addresses</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose the address each category of email sends from. Leave blank to use the
            global default ({globalSender}). The connected mailbox must have Send-As rights
            on any address you enter. Use Send test to confirm.
          </p>
        </div>
        {SENDER_CATEGORIES.map((cat) => {
          const rule = categoryRuleByGroup.get(cat.group);
          return (
            <form
              key={cat.group}
              action={saveSenderAction}
              className="flex flex-wrap items-end gap-3 border-t border-border pt-4"
            >
              <input type="hidden" name="scope" value="CATEGORY" />
              <input type="hidden" name="target" value={cat.group} />
              <input type="hidden" name="toEmail" value={actorEmail} />
              <div className="w-40">
                <p className="text-sm font-medium">{cat.label}</p>
              </div>
              <div className="w-64">
                <Input
                  name="fromEmail"
                  type="email"
                  defaultValue={rule?.fromEmail ?? ""}
                  placeholder={globalSender}
                  aria-label={`${cat.label} from address`}
                />
              </div>
              <div className="w-48">
                <Input
                  name="fromName"
                  defaultValue={rule?.fromName ?? ""}
                  placeholder="Display name (optional)"
                  aria-label={`${cat.label} display name`}
                />
              </div>
              <Button type="submit" variant="outline" size="sm">
                Save
              </Button>
              <Button type="submit" formAction={testSenderAction} variant="ghost" size="sm">
                Send test
              </Button>
            </form>
          );
        })}
      </div>
```

Note: the `Send test` button uses `formAction` to post the same form to `testSenderAction`. Confirm the `Button` primitive forwards `formAction` (it renders a native `<button>`; if it does not forward arbitrary props, wrap the test action in its own nested form posting the hidden fields instead).

- [ ] **Step 6: Typecheck**

Run:
```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 7: Manual smoke check**

Run the dev server and visit `/admin/email` as an admin. Confirm: the Send-from section lists the four categories with the global default as placeholder; saving an address persists on reload; clearing (empty + Save) reverts to placeholder; Send test in log mode shows the success banner. (In dev the transport is `log`, so the test only logs.)

- [ ] **Step 8: Commit**

```bash
git add "src/app/(app)/admin/email/page.tsx"
git commit -m "feat(email): per-category send-from addresses in admin email page"
```

---

### Task 8: Per-template sender override

**Files:**
- Modify: `src/modules/admin/services/email-templates.ts`
- Modify: `src/app/(app)/admin/email/templates/[key]/page.tsx`
- Test: `src/modules/admin/services/email-templates.test.ts` (create or extend)

**Interfaces:**
- Consumes: `resolveInheritedSender`, `saveSenderRule`, `clearSenderRule`, `listSenderRules` from `@/platform/email/sender-rules`.
- Produces:
  - `TemplateForEdit` gains `senderFromEmail: string | null`, `senderFromName: string | null`, `inheritedSender: ResolvedSender`, `hasSenderOverride: boolean`.
  - `TemplateSummary` gains `hasSenderOverride: boolean`.

- [ ] **Step 1: Write the failing test**

Create `src/modules/admin/services/email-templates.test.ts` (or extend if it exists):
```ts
import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { _resetSettingsCache } from "@/platform/settings/service";
import { prisma } from "@/platform/db";
import { saveSenderRule } from "@/platform/email/sender-rules";
import { getTemplateForEdit } from "./email-templates";

beforeEach(async () => {
  await resetDb();
  _resetSettingsCache();
});

describe("getTemplateForEdit sender info", () => {
  it("reports no override and the inherited global default", async () => {
    await prisma.setting.create({ data: { key: "email.sender", value: "hfc.it@yale.edu" } });
    _resetSettingsCache();
    const t = await getTemplateForEdit("recruitment.acceptance");
    expect(t.hasSenderOverride).toBe(false);
    expect(t.senderFromEmail).toBeNull();
    expect(t.inheritedSender.fromEmail).toBe("hfc.it@yale.edu");
  });

  it("reports a template-level override and inherits from the category for the placeholder", async () => {
    await saveSenderRule(null, "CATEGORY", "recruitment", { fromEmail: "recruit@yale.edu" });
    await saveSenderRule(null, "TEMPLATE", "recruitment.acceptance", {
      fromEmail: "special@yale.edu",
      fromName: "Special",
    });
    const t = await getTemplateForEdit("recruitment.acceptance");
    expect(t.hasSenderOverride).toBe(true);
    expect(t.senderFromEmail).toBe("special@yale.edu");
    expect(t.senderFromName).toBe("Special");
    expect(t.inheritedSender.fromEmail).toBe("recruit@yale.edu");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_emailsender npx vitest run src/modules/admin/services/email-templates.test.ts
```
Expected: FAIL (the new `TemplateForEdit` fields do not exist).

- [ ] **Step 3: Extend the service**

In `src/modules/admin/services/email-templates.ts`:

Add imports:
```ts
import {
  resolveInheritedSender,
  listSenderRules,
  type ResolvedSender,
} from "@/platform/email/sender-rules";
```

Extend `TemplateForEdit` with:
```ts
  /** TEMPLATE-scope sender override for this key, or null when inheriting. */
  senderFromEmail: string | null;
  senderFromName: string | null;
  /** What a blank override inherits (category rule or global default), for the placeholder. */
  inheritedSender: ResolvedSender;
  hasSenderOverride: boolean;
```

In `getTemplateForEdit`, after computing `layoutSource`, add:
```ts
  const senderRules = await listSenderRules();
  const templateRule = senderRules.find((r) => r.scope === "TEMPLATE" && r.target === key) ?? null;
  const inheritedSender = await resolveInheritedSender(key);
```
and add these fields to the returned object:
```ts
    senderFromEmail: templateRule?.fromEmail ?? null,
    senderFromName: templateRule?.fromName ?? null,
    inheritedSender,
    hasSenderOverride: templateRule !== null,
```

Extend `TemplateSummary` with `hasSenderOverride: boolean;` and update `listTemplateSummaries`:
```ts
export async function listTemplateSummaries(): Promise<TemplateSummary[]> {
  const [overrides, senderRules] = await Promise.all([
    prisma.emailTemplate.findMany({ select: { key: true } }),
    listSenderRules(),
  ]);
  const overridden = new Set(overrides.map((o) => o.key));
  const senderOverridden = new Set(
    senderRules.filter((r) => r.scope === "TEMPLATE").map((r) => r.target)
  );
  return listDescriptors().map((d) => ({
    key: d.key,
    name: d.name,
    category: d.category,
    hasOverride: overridden.has(d.key),
    hasSenderOverride: senderOverridden.has(d.key),
  }));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_emailsender npx vitest run src/modules/admin/services/email-templates.test.ts
```
Expected: PASS.

- [ ] **Step 5: Add the sender form to the template editor page**

In `src/app/(app)/admin/email/templates/[key]/page.tsx`:

Add imports:
```ts
import { saveSenderRule, clearSenderRule, SenderRuleValidationError } from "@/platform/email/sender-rules";
import { sendSenderTest } from "@/modules/admin/services/email";
import { requirePersonSession } from "@/platform/auth/session";
import { prisma } from "@/platform/db";
import { Input } from "@/platform/ui/input";
```
(If `requirePersonSession` is not the right helper to read the actor email here, reuse the existing `requirePermission` return value, which already exposes `personId`, and read the email with `prisma.person.findUnique`. Match whatever the surrounding code uses.)

Add two server actions inside the component:
```ts
  async function saveSenderAction(formData: FormData) {
    "use server";
    const a = await requirePermission("admin.manage_email_templates");
    const fromEmail = ((formData.get("fromEmail") as string | null) ?? "").trim();
    const fromName = ((formData.get("fromName") as string | null) ?? "").trim();
    try {
      if (fromEmail === "") {
        await clearSenderRule(a.personId, "TEMPLATE", decodedKey);
      } else {
        await saveSenderRule(a.personId, "TEMPLATE", decodedKey, { fromEmail, fromName });
      }
    } catch (err) {
      if (err instanceof SenderRuleValidationError) {
        redirect(`/admin/email/templates/${key}?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    revalidatePath(`/admin/email/templates/${key}`);
    redirect(`/admin/email/templates/${key}`);
  }

  async function testSenderAction(formData: FormData) {
    "use server";
    const a = await requirePermission("admin.manage_email_templates");
    const fromEmail = ((formData.get("fromEmail") as string | null) ?? "").trim();
    const fromName = ((formData.get("fromName") as string | null) ?? "").trim();
    const person = await prisma.person.findUnique({ where: { id: a.personId }, select: { email: true } });
    const toEmail = person?.email ?? "";
    if (fromEmail === "" || toEmail === "") {
      redirect(`/admin/email/templates/${key}?error=${encodeURIComponent("A from address and your account email are required to send a test.")}`);
    }
    try {
      await sendSenderTest(a.personId, { toEmail, fromEmail, fromName: fromName || null });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Test send failed.";
      redirect(`/admin/email/templates/${key}?error=${encodeURIComponent(message)}`);
    }
    revalidatePath(`/admin/email/templates/${key}`);
    redirect(`/admin/email/templates/${key}`);
  }
```

Render a sender form below the existing subject/body form (and above or below the reset block):
```tsx
      <form action={saveSenderAction} className="space-y-3 rounded-2xl border border-border bg-surface p-5">
        <div>
          <p className="text-sm font-medium text-foreground-soft">Send from</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Leave blank to inherit ({t.inheritedSender.fromEmail}). The connected mailbox
            must have Send-As rights on any address you enter.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-64">
            <Input
              name="fromEmail"
              type="email"
              defaultValue={t.senderFromEmail ?? ""}
              placeholder={t.inheritedSender.fromEmail}
              aria-label="From address"
            />
          </div>
          <div className="w-48">
            <Input
              name="fromName"
              defaultValue={t.senderFromName ?? ""}
              placeholder="Display name (optional)"
              aria-label="From display name"
            />
          </div>
          <Button type="submit" variant="outline">Save sender</Button>
          <Button type="submit" formAction={testSenderAction} variant="ghost">Send test</Button>
        </div>
      </form>
```

- [ ] **Step 6: Typecheck**

Run:
```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 7: Manual smoke check**

Visit `/admin/email/templates/recruitment.acceptance`. Confirm: the "Send from" field shows the inherited address as placeholder; saving an override persists on reload; clearing it reverts to placeholder; Send test (log mode) does not error.

- [ ] **Step 8: Commit**

```bash
git add "src/modules/admin/services/email-templates.ts" "src/app/(app)/admin/email/templates/[key]/page.tsx" "src/modules/admin/services/email-templates.test.ts"
git commit -m "feat(email): per-template sender override in template editor"
```

---

### Task 9: Full suite, typecheck, and final commit

**Files:** none (verification)

- [ ] **Step 1: Run the full test suite**

Run:
```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_emailsender npm test
```
Expected: green except the known pre-existing cert `/tmp` ENOENT flakes.

- [ ] **Step 2: Typecheck the whole project**

Run:
```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Confirm no stray em-dashes in changed files**

Run:
```bash
git diff main --name-only | xargs grep -lP '\x{2014}' 2>/dev/null || echo "no em-dashes"
```
Expected: "no em-dashes".

- [ ] **Step 4: Push and open a PR (only when the user asks)**

Do not push or open a PR until the user requests it.

---

## Self-Review

**Spec coverage:**
- Same login Send-As: Task 4 (transport sends as per-message from with the existing token). Covered.
- Granularity (category + per-template override): Tasks 3, 7, 8. Covered.
- Free-text address + send test guardrail: Tasks 3 (free-text storage + validation), 6 (test send), 7/8 (test buttons). Covered.
- `group` on descriptors: Task 2. Covered.
- `EmailSenderRule` table + `EmailLog` snapshot columns: Task 1. Covered.
- Cached resolution + chokepoint snapshot: Tasks 3, 5. Covered.
- `GraphTransport` from + display name: Task 4. Covered.
- Category UI + per-template UI + list marker: Tasks 7, 8. Covered.
- Edge cases (empty email = no rule, fromName gated, format validation, fail-safe queue): Tasks 3 (validation, empty handling), 4/5 (fail-safe path unchanged), 7/8 (empty -> clear). Covered.
- Tests enumerated in the spec: Tasks 2-6, 8 each carry the matching tests. Covered.
- Out-of-scope items (second OAuth, allow-list, per-cycle, per-campaign) are intentionally not implemented. Correct.

**Placeholder scan:** No TBD/TODO. The two "confirm/match the surrounding code" notes (audit model accessor in Task 6, actor-email helper in Task 8) are verification instructions with a concrete fallback, not deferred work.

**Type consistency:** `ResolvedSender`, `SenderRuleView`, `groupForTemplate`, `resolveSenderForTemplate`, `resolveInheritedSender`, `saveSenderRule`, `clearSenderRule`, `listSenderRules`, `_resetSenderRulesCache`, and `sendSenderTest` signatures are used identically across Tasks 3, 5, 6, 7, 8. `EmailSenderScope` values `CATEGORY`/`TEMPLATE` are used consistently. The Prisma compound-unique key `scope_target` is used in Task 3 only and matches `@@unique([scope, target])` from Task 1.
