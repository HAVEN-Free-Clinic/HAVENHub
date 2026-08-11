# Intercom Fin MCP Server (foundation + phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a read-only MCP server that Intercom Fin can call to answer a member's scheduling questions, with identity verified server-side rather than trusted from a tool argument.

**Architecture:** An `mcp-handler` route inside the existing Next.js app, so tools import the real RBAC helpers, Prisma client, and audit log in-process and there is only one authorization model. Identity arrives as a claimed `Person.id` bound by Intercom to the verified contact attribute, and the server re-verifies it against Intercom's REST API before trusting it. Tools are narrow verbs that return computed answers, never rows.

**Tech Stack:** Next.js 16 App Router, `mcp-handler` 2.x, `@modelcontextprotocol/server` 2.x, zod 4.4.3, Prisma 6, Vitest.

## Global Constraints

- **No em-dashes anywhere.** CI enforces `local/no-em-dash` and it fails lint. Use `--` in prose and comments.
- **Lint with `npx eslint src e2e`**, not `npm run lint`. The latter walks a gitignored design directory and reports false failures.
- **Never trust a piped test exit code.** `npx vitest run ... | tail` exits 0 even when the suite fails. Read the printed `Test Files` and `Tests` counts.
- **Tests need a per-worktree database.** Prefix every vitest command with `TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_intercomsupport"`. That database already exists and has migrations applied.
- **`import/no-restricted-paths` is enforced.** Platform code (`src/platform`) must not import module code (`src/modules`), and modules must not import each other. Anything composing across modules lives in `src/app`.
- **No tool may ever return** `TechRequest.govId`, `Person.dateOfBirth`, `MemberLoginToken` fields, `photoKey`, or any storage key.
- **No tool input schema may accept a person identifier.** Identity comes only from the verified Intercom contact. Task 4 enforces this with a test.
- **Feature stays off unless fully configured.** Every new env var missing means the endpoint 404s.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/platform/intercom/config.ts` (modify) | Add MCP env accessors and `isMcpConfigured()`. Imports nothing from modules. |
| `src/platform/intercom/identity.ts` (create) | Resolve and verify a claimed `Person.id` against Intercom plus the live Person row. |
| `src/platform/intercom/audit.ts` (create) | Record one audit row per tool call. |
| `src/app/api/mcp/tools/index.ts` (create) | Tool registry type and array. Legal place to import modules. |
| `src/app/api/mcp/tools/scheduling.ts` (create) | Phase 1 scheduling tools. |
| `src/app/api/mcp/route.ts` (create) | MCP transport endpoint, bearer auth, identity gate, audit. |
| `.env.example` (modify) | Document the three new vars. |

---

### Task 1: MCP configuration and env

**Files:**
- Modify: `src/platform/intercom/config.ts`
- Modify: `.env.example`
- Test: `src/platform/intercom/config.test.ts` (create)

**Interfaces:**
- Consumes: existing `isIntercomConfigured()` from the shipped Messenger work.
- Produces: `intercomAccessToken(): string | null`, `mcpBearerToken(): string | null`, `isMcpConfigured(): boolean`.

- [ ] **Step 1: Write the failing test**

Create `src/platform/intercom/config.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from "vitest";
import { isMcpConfigured, intercomAccessToken, mcpBearerToken } from "./config";

afterEach(() => {
  vi.unstubAllEnvs();
});

function configureAll() {
  vi.stubEnv("NEXT_PUBLIC_INTERCOM_APP_ID", "unyx5lb2");
  vi.stubEnv("INTERCOM_MESSENGER_SECRET", "messenger-secret");
  vi.stubEnv("INTERCOM_ACCESS_TOKEN", "access-token");
  vi.stubEnv("INTERCOM_MCP_BEARER_TOKEN", "bearer-token");
}

describe("MCP configuration", () => {
  it("is configured only when every value is present", () => {
    configureAll();
    expect(isMcpConfigured()).toBe(true);
    expect(intercomAccessToken()).toBe("access-token");
    expect(mcpBearerToken()).toBe("bearer-token");
  });

  it("is off without the Intercom access token, since identity cannot be verified", () => {
    configureAll();
    vi.stubEnv("INTERCOM_ACCESS_TOKEN", "");
    expect(isMcpConfigured()).toBe(false);
  });

  it("is off without the MCP bearer token, since the endpoint would be unauthenticated", () => {
    configureAll();
    vi.stubEnv("INTERCOM_MCP_BEARER_TOKEN", "");
    expect(isMcpConfigured()).toBe(false);
  });

  it("is off when the Messenger itself is not configured", () => {
    configureAll();
    vi.stubEnv("INTERCOM_MESSENGER_SECRET", "");
    expect(isMcpConfigured()).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_intercomsupport" npx vitest run src/platform/intercom/config.test.ts`
Expected: FAIL, `isMcpConfigured` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/platform/intercom/config.ts`:

```ts
/**
 * Access token for Intercom's REST API, used to verify that a claimed Person id
 * really belongs to the contact in the conversation. Without it the MCP server
 * would have to take the caller's word for who they are, so its absence turns
 * the whole endpoint off.
 */
export function intercomAccessToken(): string | null {
  return process.env.INTERCOM_ACCESS_TOKEN?.trim() || null;
}

/** Shared secret Fin presents to the MCP endpoint. Absent = endpoint off. */
export function mcpBearerToken(): string | null {
  return process.env.INTERCOM_MCP_BEARER_TOKEN?.trim() || null;
}

/**
 * The MCP endpoint requires the Messenger to be configured as well: identity
 * originates in the Messenger JWT, so an MCP server without it would be
 * verifying contacts whose user_id nothing ever signed.
 */
export function isMcpConfigured(): boolean {
  return isIntercomConfigured() && intercomAccessToken() !== null && mcpBearerToken() !== null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_intercomsupport" npx vitest run src/platform/intercom/config.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Document the env vars**

In `.env.example`, inside the existing `# --- Intercom (support Messenger) ---` block, immediately after the `INTERCOM_MESSENGER_SECRET=` line, add:

```
#
# The two below additionally enable the Fin MCP server (/api/mcp). Both must be
# set on top of the pair above, or the endpoint 404s. INTERCOM_ACCESS_TOKEN is a
# workspace access token used server-side to confirm a claimed Person id really
# belongs to the contact in the conversation; without that check the server would
# be trusting an identity the AI asserted. INTERCOM_MCP_BEARER_TOKEN is the shared
# secret Fin presents when calling us -- generate a long random value.
INTERCOM_ACCESS_TOKEN=
INTERCOM_MCP_BEARER_TOKEN=
```

- [ ] **Step 6: Verify lint and types**

Run: `npx tsc --noEmit`
Expected: no output.
Run: `npx eslint src e2e`
Expected: `0 errors` (2 pre-existing `<img>` warnings are expected and fine).

- [ ] **Step 7: Commit**

```bash
git add src/platform/intercom/config.ts src/platform/intercom/config.test.ts .env.example
git commit -m "feat(mcp): add configuration gate for the Fin MCP server

All four values are required. The endpoint stays off without the Intercom
access token, because identity verification is impossible without it, and
without the bearer token, because the endpoint would be unauthenticated."
```

---

### Task 2: Identity resolution with server-side verification

**Files:**
- Create: `src/platform/intercom/identity.ts`
- Test: `src/platform/intercom/identity.test.ts`

**Interfaces:**
- Consumes: `intercomAccessToken()` from Task 1; `getActivePerson(personId)` from `@/platform/auth/match-person`, which returns a Person row or null.
- Produces: `resolveIntercomIdentity(claimedPersonId: string): Promise<ResolvedIdentity>` where
  `type ResolvedIdentity = { ok: true; personId: string; name: string | null } | { ok: false; reason: "unverified" | "unknown_person" | "lookup_failed" }`.

- [ ] **Step 1: Write the failing test**

Create `src/platform/intercom/identity.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/platform/auth/match-person", () => ({ getActivePerson: vi.fn() }));

import { getActivePerson } from "@/platform/auth/match-person";
import { resolveIntercomIdentity } from "./identity";

const mocked = (fn: unknown) => fn as unknown as ReturnType<typeof vi.fn>;

function mockFetchOnce(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    })
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("INTERCOM_ACCESS_TOKEN", "access-token");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("resolveIntercomIdentity", () => {
  it("resolves when the contact's external_id matches and the person is active", async () => {
    mockFetchOnce(200, { external_id: "p1" });
    mocked(getActivePerson).mockResolvedValue({ id: "p1", name: "Sam Rivera" });

    const result = await resolveIntercomIdentity("p1");

    expect(result).toEqual({ ok: true, personId: "p1", name: "Sam Rivera" });
  });

  it("refuses when Intercom returns a contact for a different external_id", async () => {
    mockFetchOnce(200, { external_id: "someone-else" });
    mocked(getActivePerson).mockResolvedValue({ id: "p1", name: "Sam Rivera" });

    const result = await resolveIntercomIdentity("p1");

    expect(result).toEqual({ ok: false, reason: "unverified" });
  });

  it("refuses when Intercom has no such contact", async () => {
    mockFetchOnce(404, {});

    const result = await resolveIntercomIdentity("p1");

    expect(result).toEqual({ ok: false, reason: "unverified" });
  });

  it("refuses an offboarded person even though Intercom still knows the contact", async () => {
    mockFetchOnce(200, { external_id: "p1" });
    mocked(getActivePerson).mockResolvedValue(null);

    const result = await resolveIntercomIdentity("p1");

    expect(result).toEqual({ ok: false, reason: "unknown_person" });
  });

  it("fails closed when the Intercom lookup throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const result = await resolveIntercomIdentity("p1");

    expect(result).toEqual({ ok: false, reason: "lookup_failed" });
  });

  it("fails closed when no access token is configured", async () => {
    vi.stubEnv("INTERCOM_ACCESS_TOKEN", "");

    const result = await resolveIntercomIdentity("p1");

    expect(result).toEqual({ ok: false, reason: "lookup_failed" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_intercomsupport" npx vitest run src/platform/intercom/identity.test.ts`
Expected: FAIL, cannot find module `./identity`.

- [ ] **Step 3: Write minimal implementation**

Create `src/platform/intercom/identity.ts`:

```ts
import { getActivePerson } from "@/platform/auth/match-person";
import { log, errorAttrs } from "@/platform/logging";
import { intercomAccessToken } from "./config";

const INTERCOM_API = "https://api.intercom.io";

export type ResolvedIdentity =
  | { ok: true; personId: string; name: string | null }
  | { ok: false; reason: "unverified" | "unknown_person" | "lookup_failed" };

/**
 * Turns a claimed Person id into a verified one, or refuses.
 *
 * Fin supplies the id by binding a tool input to the contact's user_id
 * attribute, which our Messenger JWT set and the browser cannot forge. That is
 * a strong chain, but its weakest link is configuration in Intercom's UI rather
 * than code: an input left on "let Fin decide" would silently downgrade the id
 * to something the model chose. So the claim is re-verified here against
 * Intercom's own record of the contact, and never taken at face value.
 *
 * Every failure path returns ok:false. There is deliberately no fallback that
 * answers with reduced scope, because a caller we cannot identify is a caller
 * we cannot authorize.
 */
export async function resolveIntercomIdentity(claimedPersonId: string): Promise<ResolvedIdentity> {
  const token = intercomAccessToken();
  if (!token) return { ok: false, reason: "lookup_failed" };

  let contact: { external_id?: string } | null = null;
  try {
    const res = await fetch(
      `${INTERCOM_API}/contacts/find_by_external_id/${encodeURIComponent(claimedPersonId)}`,
      {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        cache: "no-store",
      }
    );
    // A miss (404) is a refusal, not an error: it means the id does not name a
    // contact in this workspace, which is exactly what a forged claim looks like.
    if (!res.ok) return { ok: false, reason: "unverified" };
    contact = (await res.json()) as { external_id?: string };
  } catch (err) {
    log.warn("[intercom-mcp] contact lookup failed", errorAttrs(err));
    return { ok: false, reason: "lookup_failed" };
  }

  if (!contact || contact.external_id !== claimedPersonId) {
    return { ok: false, reason: "unverified" };
  }

  // Second gate: Intercom's record can outlive ours. This is the revocation
  // check, so an offboarded member stops resolving even while their contact
  // still exists in the workspace.
  const person = await getActivePerson(claimedPersonId);
  if (!person) return { ok: false, reason: "unknown_person" };

  return { ok: true, personId: person.id, name: person.name };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_intercomsupport" npx vitest run src/platform/intercom/identity.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/platform/intercom/identity.ts src/platform/intercom/identity.test.ts
git commit -m "feat(mcp): verify a claimed Person id against Intercom before trusting it

Fin binds the id to the contact's user_id attribute, which our Messenger JWT
set, but that binding is configuration in Intercom's UI rather than code. This
re-verifies the claim against Intercom's own contact record and re-checks the
person is still active, so both a forged id and an offboarded member fail
closed with no reduced-scope fallback."
```

---

### Task 3: Tool-call audit

**Files:**
- Create: `src/platform/intercom/audit.ts`
- Test: `src/platform/intercom/audit.test.ts`

**Interfaces:**
- Consumes: `recordAudit(entry: AuditEntry)` from `@/platform/audit`, where `AuditEntry` is `{ actorPersonId?: string | null; action: string; entityType: string; entityId?: string | null; before?: InputJsonValue; after?: InputJsonValue; ip?: string | null }`.
- Produces: `recordToolCall(params: { personId: string | null; tool: string; args: Record<string, unknown>; outcome: "ok" | "denied" | "unverified" }): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Create `src/platform/intercom/audit.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/platform/audit", () => ({ recordAudit: vi.fn() }));

import { recordAudit } from "@/platform/audit";
import { recordToolCall } from "./audit";

const mocked = (fn: unknown) => fn as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetAllMocks();
});

describe("recordToolCall", () => {
  it("records a successful call against the resolved person", async () => {
    await recordToolCall({
      personId: "p1",
      tool: "my_next_shift",
      args: { includeTags: true },
      outcome: "ok",
    });

    expect(mocked(recordAudit)).toHaveBeenCalledWith({
      actorPersonId: "p1",
      action: "intercom_mcp.ok",
      entityType: "IntercomMcpToolCall",
      entityId: "my_next_shift",
      after: { tool: "my_next_shift", args: { includeTags: true }, outcome: "ok" },
    });
  });

  it("records an unverified call with a null actor, so failed claims are still visible", async () => {
    await recordToolCall({
      personId: null,
      tool: "my_next_shift",
      args: {},
      outcome: "unverified",
    });

    expect(mocked(recordAudit)).toHaveBeenCalledWith(
      expect.objectContaining({ actorPersonId: null, action: "intercom_mcp.unverified" })
    );
  });

  it("records a denial distinctly from a success", async () => {
    await recordToolCall({ personId: "p1", tool: "my_next_shift", args: {}, outcome: "denied" });

    expect(mocked(recordAudit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "intercom_mcp.denied" })
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_intercomsupport" npx vitest run src/platform/intercom/audit.test.ts`
Expected: FAIL, cannot find module `./audit`.

- [ ] **Step 3: Write minimal implementation**

Create `src/platform/intercom/audit.ts`:

```ts
import { recordAudit } from "@/platform/audit";

/**
 * One audit row per MCP tool call.
 *
 * This is the primary detection mechanism for the identity binding being
 * misconfigured in Intercom. A burst of `intercom_mcp.unverified` rows, or one
 * person appearing as the actor for implausibly many distinct calls, is what
 * that failure looks like from here -- nothing in the codebase can see the
 * Intercom-side setting directly.
 */
export async function recordToolCall(params: {
  personId: string | null;
  tool: string;
  args: Record<string, unknown>;
  outcome: "ok" | "denied" | "unverified";
}): Promise<void> {
  await recordAudit({
    actorPersonId: params.personId,
    action: `intercom_mcp.${params.outcome}`,
    entityType: "IntercomMcpToolCall",
    entityId: params.tool,
    after: { tool: params.tool, args: params.args, outcome: params.outcome },
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_intercomsupport" npx vitest run src/platform/intercom/audit.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/platform/intercom/audit.ts src/platform/intercom/audit.test.ts
git commit -m "feat(mcp): audit every Fin tool call

Records the resolved actor, tool, arguments, and outcome. Unverified calls are
recorded with a null actor rather than dropped, because a burst of them is the
only signal available when the Intercom-side identity binding is misconfigured."
```

---

### Task 4: Tool registry and the free-form identity guard

**Files:**
- Create: `src/app/api/mcp/tools/index.ts`
- Test: `src/app/api/mcp/tools/index.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `type McpToolContext = { personId: string }`; `type McpTool = { name: string; title: string; description: string; inputSchema: z.ZodObject<z.ZodRawShape>; run: (ctx: McpToolContext, args: Record<string, unknown>) => Promise<string> }`; `const MCP_TOOLS: McpTool[]`; `const IDENTITY_ARGUMENT_PATTERN: RegExp`.

Note: `MCP_TOOLS` is an empty array in this task and gains its first entry in Task 5. The guard test is written now so it is impossible to add a tool later without it applying.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/mcp/tools/index.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { MCP_TOOLS, IDENTITY_ARGUMENT_PATTERN } from "./index";

describe("MCP tool registry", () => {
  it("has unique tool names", () => {
    const names = MCP_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  /**
   * The load-bearing test. Identity must arrive only from the verified Intercom
   * contact, so no tool may take a person identifier as an argument the model
   * can fill in. Without this, one tool shipped with a `personId` input would
   * quietly reintroduce LLM-asserted identity and nothing else would catch it.
   */
  it("exposes no tool that accepts a person identifier as an argument", () => {
    for (const tool of MCP_TOOLS) {
      for (const key of Object.keys(tool.inputSchema.shape)) {
        expect(
          IDENTITY_ARGUMENT_PATTERN.test(key),
          `Tool "${tool.name}" accepts identity-shaped input "${key}". Identity must come from the verified contact, never a tool argument.`
        ).toBe(false);
      }
    }
  });

  it("rejects identity-shaped keys and allows ordinary ones", () => {
    const rejected = ["personId", "person_id", "userId", "netId", "memberEmail", "actorId", "requesterId"];
    for (const key of rejected) {
      expect(IDENTITY_ARGUMENT_PATTERN.test(key), `${key} should be rejected`).toBe(true);
    }
    const allowed = ["date", "departmentCode", "limit", "includeTags"];
    for (const key of allowed) {
      expect(IDENTITY_ARGUMENT_PATTERN.test(key), `${key} should be allowed`).toBe(false);
    }
  });

  it("guards a tool that violates the rule", () => {
    const offender = z.object({ personId: z.string() });
    const violations = Object.keys(offender.shape).filter((k) => IDENTITY_ARGUMENT_PATTERN.test(k));
    expect(violations).toEqual(["personId"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_intercomsupport" npx vitest run src/app/api/mcp/tools/index.test.ts`
Expected: FAIL, cannot find module `./index`.

- [ ] **Step 3: Write minimal implementation**

Create `src/app/api/mcp/tools/index.ts`:

```ts
import type { z } from "zod";

/** The verified caller. Populated by the route from resolveIntercomIdentity, never from tool input. */
export type McpToolContext = { personId: string };

export type McpTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  /** Returns the answer as plain text. Return computed answers, never raw rows. */
  run: (ctx: McpToolContext, args: Record<string, unknown>) => Promise<string>;
};

/**
 * Input names that would let the model choose whose data is read.
 *
 * Kept deliberately broad: a false positive costs one rename, a false negative
 * costs the whole identity model. See the registry test.
 */
export const IDENTITY_ARGUMENT_PATTERN = /person|people|user|member|netid|actor|requester|assignee|email/i;

/**
 * Field names that must never appear in tool output. Tool responses can be
 * rendered straight into the chat and shared with the member, and these are the
 * values the spec forbids leaving the Hub at all. Phase 2 and later tools assert
 * their rendered output against this.
 */
export const FORBIDDEN_OUTPUT_PATTERN = /govId|dateOfBirth|photoKey|MemberLoginToken|passwordHash/i;

/**
 * Every tool Fin may call. Tools live here in the app layer rather than under
 * src/platform/intercom because import/no-restricted-paths forbids platform
 * code from importing src/modules, and forbids modules from importing each
 * other. A surface spanning schedule, compliance, roster, and recruitment can
 * only be composed where both are legal imports.
 */
export const MCP_TOOLS: McpTool[] = [];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_intercomsupport" npx vitest run src/app/api/mcp/tools/index.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/mcp/tools/index.ts src/app/api/mcp/tools/index.test.ts
git commit -m "feat(mcp): add the tool registry and its identity-argument guard

No tool may accept a person identifier as input, since identity must come from
the verified Intercom contact. The guard test ships before the first tool so it
is impossible to add one later without it applying."
```

---

### Task 5: Phase 1 scheduling tool

**Files:**
- Create: `src/app/api/mcp/tools/scheduling.ts`
- Modify: `src/app/api/mcp/tools/index.ts` (register the tool)
- Test: `src/app/api/mcp/tools/scheduling.test.ts`

**Interfaces:**
- Consumes: `McpTool`, `McpToolContext` from Task 4. `mySchedule(personId: string): Promise<{ terms: MyTermSchedule[] }>` from `@/modules/schedule/services/schedule`, where `MyTermSchedule` is `{ term: Term; isLive: boolean; shifts: MyShift[]; ... }` and `MyShift` is `{ clinicDate: Date; department: Department; role: ShiftRole; tags: { triage: boolean; walkin: boolean; cc: boolean; remote: boolean } }`.
- Produces: `myNextShiftTool: McpTool` with name `my_next_shift`, appended to `MCP_TOOLS`.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/mcp/tools/scheduling.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/modules/schedule/services/schedule", () => ({ mySchedule: vi.fn() }));

import { mySchedule } from "@/modules/schedule/services/schedule";
import { myNextShiftTool } from "./scheduling";

const mocked = (fn: unknown) => fn as unknown as ReturnType<typeof vi.fn>;

function shift(clinicDate: string, departmentName: string) {
  return {
    clinicDate: new Date(clinicDate),
    department: { name: departmentName },
    role: "VOLUNTEER",
    tags: { triage: false, walkin: false, cc: false, remote: false },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-10T12:00:00Z"));
});

describe("my_next_shift", () => {
  it("returns the earliest upcoming shift in the live term", async () => {
    mocked(mySchedule).mockResolvedValue({
      terms: [
        {
          isLive: true,
          shifts: [shift("2026-09-26T00:00:00Z", "Internal Medicine"), shift("2026-09-12T00:00:00Z", "Triage")],
        },
      ],
    });

    const text = await myNextShiftTool.run({ personId: "p1" }, {});

    expect(text).toContain("Triage");
    expect(text).not.toContain("Internal Medicine");
  });

  it("reports the calendar day the shift is actually on, not the day before", async () => {
    mocked(mySchedule).mockResolvedValue({
      terms: [{ isLive: true, shifts: [shift("2026-09-12T00:00:00Z", "Triage")] }],
    });

    const text = await myNextShiftTool.run({ personId: "p1" }, {});

    // clinicDate is stored at UTC midnight. Formatting it in America/New_York
    // would render "Sep 11" and quietly tell the member the wrong day.
    expect(text).toContain("Sep 12");
    expect(text).not.toContain("Sep 11");
  });

  it("ignores shifts in the past", async () => {
    mocked(mySchedule).mockResolvedValue({
      terms: [{ isLive: true, shifts: [shift("2026-09-01T00:00:00Z", "Triage")] }],
    });

    const text = await myNextShiftTool.run({ personId: "p1" }, {});

    expect(text).toMatch(/no upcoming shifts/i);
  });

  it("says so plainly when there are no shifts at all", async () => {
    mocked(mySchedule).mockResolvedValue({ terms: [] });

    const text = await myNextShiftTool.run({ personId: "p1" }, {});

    expect(text).toMatch(/no upcoming shifts/i);
  });

  it("reads only the caller's own schedule", async () => {
    mocked(mySchedule).mockResolvedValue({ terms: [] });

    await myNextShiftTool.run({ personId: "p1" }, {});

    expect(mocked(mySchedule)).toHaveBeenCalledWith("p1");
    expect(mocked(mySchedule)).toHaveBeenCalledTimes(1);
  });

  it("takes no input at all, so nothing about the request is model-chosen", () => {
    expect(Object.keys(myNextShiftTool.inputSchema.shape)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_intercomsupport" npx vitest run src/app/api/mcp/tools/scheduling.test.ts`
Expected: FAIL, cannot find module `./scheduling`.

- [ ] **Step 3: Write minimal implementation**

Create `src/app/api/mcp/tools/scheduling.ts`:

```ts
import { z } from "zod";
import { mySchedule } from "@/modules/schedule/services/schedule";
import { formatCalendarDate } from "@/platform/dates";
import type { McpTool } from "./index";

/**
 * "When is my next shift?", the highest-volume and lowest-sensitivity support
 * question there is.
 *
 * Takes no input on purpose. The caller is already known from the verified
 * Intercom contact, and adding even a date filter would hand the model a lever
 * over what gets read. The answer is a sentence, not a row: tool output can be
 * rendered straight into the chat and shared with the member.
 */
export const myNextShiftTool: McpTool = {
  name: "my_next_shift",
  title: "My next shift",
  description:
    "The signed-in member's next upcoming clinic shift, with the date and department. Use for questions like 'when is my next shift?' or 'am I on this week?'.",
  inputSchema: z.object({}),
  run: async (ctx) => {
    const { terms } = await mySchedule(ctx.personId);
    const live = terms.find((t) => t.isLive);
    if (!live) return "You have no upcoming shifts scheduled.";

    const now = new Date();
    const upcoming = live.shifts
      .filter((s) => s.clinicDate >= now)
      .sort((a, b) => a.clinicDate.getTime() - b.clinicDate.getTime());

    const next = upcoming[0];
    if (!next) return "You have no upcoming shifts scheduled.";

    // formatCalendarDate, NOT formatDateOnly. clinicDate is a date-only value
    // stored at UTC midnight, and formatCalendarDate renders calendar days in
    // UTC for exactly that reason. Passing it through a zoned formatter with
    // America/New_York would render UTC midnight as 8pm the previous evening
    // and report the wrong day, which on a shift reminder is the whole answer
    // being wrong.
    return `Your next shift is on ${formatCalendarDate(next.clinicDate)} with ${next.department.name}.`;
  },
};
```

- [ ] **Step 4: Register the tool**

In `src/app/api/mcp/tools/index.ts`, replace the empty registry with:

```ts
export const MCP_TOOLS: McpTool[] = [myNextShiftTool];
```

and add at the top of the file, below the existing imports:

```ts
import { myNextShiftTool } from "./scheduling";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_intercomsupport" npx vitest run src/app/api/mcp/tools`
Expected: PASS. Both files, 9 tests total. The registry guard now runs against a real tool.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/mcp/tools/scheduling.ts src/app/api/mcp/tools/scheduling.test.ts src/app/api/mcp/tools/index.ts
git commit -m "feat(mcp): add the my_next_shift tool

Takes no input: the caller is already known from the verified contact, and any
argument would hand the model a lever over what gets read. Returns a sentence
rather than a row, because tool output can be rendered straight into the chat."
```

---

### Task 6: MCP endpoint

**Files:**
- Create: `src/app/api/mcp/route.ts`
- Test: `src/app/api/mcp/route.test.ts`

**Interfaces:**
- Consumes: `isMcpConfigured()`, `mcpBearerToken()` (Task 1); `resolveIntercomIdentity()` (Task 2); `recordToolCall()` (Task 3); `MCP_TOOLS` (Tasks 4 and 5).
- Produces: `GET` and `POST` route handlers.

Install first:

```bash
npm install mcp-handler @modelcontextprotocol/server
```

The endpoint reads the claimed Person id from the `X-Intercom-Person-Id` request header rather than a tool argument. Fin sets it from the contact attribute at connector level, which keeps it out of the model's reach and out of every tool schema.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/mcp/route.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/platform/intercom/identity", () => ({ resolveIntercomIdentity: vi.fn() }));
vi.mock("@/platform/intercom/audit", () => ({ recordToolCall: vi.fn() }));

import { resolveIntercomIdentity } from "@/platform/intercom/identity";
import { recordToolCall } from "@/platform/intercom/audit";

const mocked = (fn: unknown) => fn as unknown as ReturnType<typeof vi.fn>;

function req(headers: Record<string, string>) {
  return new Request("https://hub.test/api/mcp", { method: "POST", headers });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("NEXT_PUBLIC_INTERCOM_APP_ID", "unyx5lb2");
  vi.stubEnv("INTERCOM_MESSENGER_SECRET", "messenger-secret");
  vi.stubEnv("INTERCOM_ACCESS_TOKEN", "access-token");
  vi.stubEnv("INTERCOM_MCP_BEARER_TOKEN", "bearer-token");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/mcp", () => {
  it("404s when the MCP server is not configured", async () => {
    vi.stubEnv("INTERCOM_MCP_BEARER_TOKEN", "");
    const { POST } = await import("./route");
    const res = await POST(req({}));
    expect(res.status).toBe(404);
  });

  it("401s without the bearer token", async () => {
    const { POST } = await import("./route");
    const res = await POST(req({ "X-Intercom-Person-Id": "p1" }));
    expect(res.status).toBe(401);
  });

  it("401s with the wrong bearer token", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      req({ Authorization: "Bearer wrong", "X-Intercom-Person-Id": "p1" })
    );
    expect(res.status).toBe(401);
  });

  it("403s and audits when the identity claim does not verify", async () => {
    mocked(resolveIntercomIdentity).mockResolvedValue({ ok: false, reason: "unverified" });
    const { POST } = await import("./route");

    const res = await POST(
      req({ Authorization: "Bearer bearer-token", "X-Intercom-Person-Id": "p1" })
    );

    expect(res.status).toBe(403);
    expect(mocked(recordToolCall)).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "unverified", personId: null })
    );
  });

  it("403s when no identity header is present at all", async () => {
    const { POST } = await import("./route");
    const res = await POST(req({ Authorization: "Bearer bearer-token" }));
    expect(res.status).toBe(403);
    expect(mocked(resolveIntercomIdentity)).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_intercomsupport" npx vitest run src/app/api/mcp/route.test.ts`
Expected: FAIL, cannot find module `./route`.

- [ ] **Step 3: Write minimal implementation**

Create `src/app/api/mcp/route.ts`:

**Correction (post-implementation):** the sketch originally here read the identity header off `ctx.requestInfo` inside the tool callback. That does not work and was abandoned during implementation: verified against the actual installed `mcp-handler` and `@modelcontextprotocol/server` packages, the tool handler's second argument carries protocol plumbing only -- there is no `requestInfo`, so a tool callback has no way to re-derive identity per call. What was actually built instead is a per-request-closure design: `guard()` resolves and verifies identity exactly once per request and returns `{ personId }`; `handle()` then calls `createMcpHandler` *inside the request path* (relying on mcp-handler building one fresh `McpServer` per HTTP request) with an `initializeServer` closure that registers every tool with `personId` already captured in scope. That closure is what makes it structurally impossible for a tool to see an unverified or wrong caller -- there is no per-call identity read to get wrong, because the only `personId` a tool can ever reach is the one already closed over when its handler was registered. The corrected sketch below matches the shipped `src/app/api/mcp/route.ts`; consult that file directly for the current implementation (it has since grown a try/catch/finally around each tool call -- see the design spec's follow-up on error handling).

```ts
import { createMcpHandler } from "mcp-handler";
import type { McpServer } from "@modelcontextprotocol/server";
import { isMcpConfigured, mcpBearerToken } from "@/platform/intercom/config";
import { resolveIntercomIdentity } from "@/platform/intercom/identity";
import { recordToolCall } from "@/platform/intercom/audit";
import { MCP_TOOLS } from "./tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Header Fin sets from the verified contact attribute. Never a tool argument. */
const IDENTITY_HEADER = "X-Intercom-Person-Id";

/**
 * Registers every tool against one request's MCP server, closing over the
 * personId `guard()` already verified for that request. This closure -- not a
 * per-call header read -- is what binds a tool call to a verified identity.
 */
function registerTools(server: McpServer, personId: string): void {
  for (const tool of MCP_TOOLS) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.inputSchema },
      async (args) => {
        const text = await tool.run({ personId }, args);
        await recordToolCall({ personId, tool: tool.name, args, outcome: "ok" });
        return { content: [{ type: "text" as const, text }] };
      }
    );
  }
}

/**
 * Gate every request before it reaches the MCP machinery, and hand back the
 * identity it verified so the caller can build a server scoped to it.
 *
 * Bearer auth proves the caller is our Fin connector. The identity header
 * proves which member the conversation belongs to, and is verified against
 * Intercom rather than trusted. Both must pass; there is no anonymous or
 * reduced-scope path, because a caller we cannot identify is one we cannot
 * authorize.
 */
async function guard(request: Request): Promise<Response | { personId: string }> {
  if (!isMcpConfigured()) {
    return Response.json({ error: "Not Found" }, { status: 404 });
  }

  const expected = mcpBearerToken();
  const presented = request.headers.get("authorization");
  if (!expected || presented !== `Bearer ${expected}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const claimed = request.headers.get(IDENTITY_HEADER);
  if (!claimed) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const identity = await resolveIntercomIdentity(claimed);
  if (!identity.ok) {
    await recordToolCall({ personId: null, tool: "(request)", args: {}, outcome: "unverified" });
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  return { personId: identity.personId };
}

async function handle(request: Request): Promise<Response> {
  const gate = await guard(request);
  if (gate instanceof Response) return gate;

  // Built here, inside the request path, so every request gets its own
  // McpServer and its own registerTools closure over gate.personId -- there
  // is no module-level handler for one caller's identity to leak through.
  const handler = createMcpHandler((server) => registerTools(server, gate.personId));
  return handler(request);
}

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}

export async function GET(request: Request): Promise<Response> {
  return handle(request);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_intercomsupport" npx vitest run src/app/api/mcp/route.test.ts`
Expected: PASS, 5 tests.

Verified against the actual installed `mcp-handler` and `@modelcontextprotocol/server` packages: the tool handler's second argument is `ServerContext`, protocol plumbing only, with no `requestInfo`. There is no per-tool identity re-check "in defence in depth" -- `guard()` is the only place identity is ever resolved, and `registerTools()` merely closes over what it already proved.

- [ ] **Step 5: Run the whole Intercom surface and verify**

Run: `TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_intercomsupport" npx vitest run src/platform/intercom src/app/api/intercom src/app/api/mcp`
Expected: PASS. Read the printed counts; do not rely on the exit code.

Run: `npx tsc --noEmit`
Expected: no output.

Run: `npx eslint src e2e`
Expected: `0 errors`.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/mcp/route.ts src/app/api/mcp/route.test.ts package.json package-lock.json
git commit -m "feat(mcp): add the Fin MCP endpoint

Bearer auth proves the caller is our connector; the identity header proves
which member the conversation belongs to and is verified against Intercom
rather than trusted. Both must pass, with no anonymous or reduced-scope path.
The endpoint 404s entirely unless every Intercom value is configured."
```

---

## After this plan

Phase 2 (compliance and training tools) can follow immediately using the same registry. **Phase 3 (roster) and phase 4 (recruitment) are blocked** on confirming in an Intercom sandbox that a tool input bound to the contact attribute really does reach the server, because those phases are where cross-person reads begin. Phases 1 and 2 are self-scoped, so a binding failure there is contained.

The `X-Intercom-Person-Id` header approach must also be confirmed against what Fin's custom MCP connector can actually set. If it can only populate tool inputs and not headers, the fallback is a single dedicated input on each tool bound to the contact attribute, which would require relaxing the Task 4 guard to allow exactly one reserved name. Resolve this in the same sandbox session.
