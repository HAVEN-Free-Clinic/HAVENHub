# Weekly Teams Triage Chats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an Executive Director create the weekly Ancillary and Clinical Teams triage group chats from the Hub, with membership and the opening roster derived from the clinic schedule.

**Architecture:** A pure roster resolver turns one clinic date's `ShiftAssignment` rows into the chat's members and the bulleted roster block from a single pass, so the two can never disagree. A thin Microsoft Graph client resolves each member to an Entra object id (stored, else directory lookup), creates the group chat, adds directory-resolved members individually, and posts the opening message. Everything is human-triggered and synchronous: no cron, no queue.

**Tech Stack:** Next.js App Router (Server Components + server actions), Prisma/Postgres, Microsoft Graph v1.0 via the existing delegated mailer token, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-17-triage-chats-design.md`

## Global Constraints

- **No em-dash (U+2014) anywhere in `src/**/*.{ts,tsx}`.** CI-enforced by the `local/no-em-dash` eslint rule. Use a comma, colon, parentheses, or hyphen.
- **Clinic dates are anchored at 12:00 UTC.** Compare them by UTC day key using `isoDateKey` from `@/platform/dates`. Never compare a clinic date by raw timestamp.
- **Use the shared UI primitives** from `@/platform/ui` (`Button`, `Input`, `Select`, `Textarea`, `Checkbox`, `Card`, `Alert`, `PageHeader`, `SubmitButton`). A raw styled `<button>`/`<input>`/`<select>`/`<textarea>` is an eslint error.
- **No `tailwind-merge`.** The project does not use it; compose classes with `cx` from `@/platform/ui/cx`.
- **Imports use the `@/` alias**, never deep relative paths across module boundaries.
- **Lint with `npx eslint src e2e`**, not `npm run lint`, which walks the gitignored design-system directory.
- **Before any push run `npx vitest run src/platform`** in addition to your own tests: the platform guard tests assert registry/schema invariants and fire from anywhere.
- **Test database required** for any test importing `@/platform/db`. One-time setup: `npm run db:up && npm run db:wait && npm run test:prepare`.
- **Every new Prisma model must be added to the `TRUNCATE` list in `src/platform/test/db.ts`** or its rows leak between test files.
- Run a single test file with `npx vitest run <path>`. Never pipe test output through `tail`: a piped run reports exit code 0 even when the suite failed. Read the pass/fail counts.

---

### Task 1: Schema, migration, and test-database wiring

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `src/platform/test/db.ts` (the `TRUNCATE` list)
- Create: `src/modules/schedule/services/triage-chats.schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: Prisma models `TriageChatPreset`, `TriageChatPresetDepartment`, `TriageChat`, `TriageChatMember`, with the client types of the same names.

- [ ] **Step 1: Write the failing test**

Create `src/modules/schedule/services/triage-chats.schema.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";

beforeEach(resetDb);

async function seedPreset() {
  const dept = await prisma.department.create({
    data: { code: "BVHD", name: "Behavioral Health" },
  });
  const preset = await prisma.triageChatPreset.create({
    data: {
      name: "Ancillary",
      nameTemplate: "{{clinicDateShort}} Ancillary Triage Chat",
      messageTemplate: "Hi everyone,\n\n{{rosterBlock}}",
      departments: { create: [{ departmentId: dept.id }] },
    },
    include: { departments: true },
  });
  return { dept, preset };
}

describe("triage chat schema", () => {
  it("stores a preset with its departments", async () => {
    const { dept, preset } = await seedPreset();
    expect(preset.departments).toHaveLength(1);
    expect(preset.departments[0].departmentId).toBe(dept.id);
    expect(preset.isActive).toBe(true);
  });

  it("refuses a second chat for the same preset and clinic date", async () => {
    const { preset } = await seedPreset();
    const term = await prisma.term.create({
      data: { code: "SU26", name: "Summer 2026", startDate: new Date("2026-05-01T12:00:00Z"), endDate: new Date("2026-08-01T12:00:00Z") },
    });
    const clinicDate = new Date("2026-05-30T12:00:00Z");
    const base = {
      presetId: preset.id,
      termId: term.id,
      clinicDate,
      topic: "05.30.26 Ancillary Triage Chat",
      graphChatId: "chat-1",
      webUrl: "https://teams.microsoft.com/l/chat/1",
    };

    await prisma.triageChat.create({ data: base });
    await expect(
      prisma.triageChat.create({ data: { ...base, graphChatId: "chat-2" } }),
    ).rejects.toThrow();
  });

  it("records per-member add outcomes", async () => {
    const { preset } = await seedPreset();
    const term = await prisma.term.create({
      data: { code: "SU26", name: "Summer 2026", startDate: new Date("2026-05-01T12:00:00Z"), endDate: new Date("2026-08-01T12:00:00Z") },
    });
    const person = await prisma.person.create({ data: { name: "Goeun Lee", netId: "gl123" } });
    const chat = await prisma.triageChat.create({
      data: {
        presetId: preset.id,
        termId: term.id,
        clinicDate: new Date("2026-05-30T12:00:00Z"),
        topic: "05.30.26 Ancillary Triage Chat",
        graphChatId: "chat-1",
        webUrl: "https://teams.microsoft.com/l/chat/1",
        members: {
          create: [
            { personId: person.id, personName: "Goeun Lee", departmentName: "Behavioral Health", addedOk: false, error: "not found in directory" },
          ],
        },
      },
      include: { members: true },
    });
    expect(chat.members[0].addedOk).toBe(false);
    expect(chat.members[0].error).toBe("not found in directory");
    expect(chat.messagePostedAt).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/modules/schedule/services/triage-chats.schema.test.ts`
Expected: FAIL, `prisma.triageChatPreset` is undefined.

- [ ] **Step 3: Add the models to `prisma/schema.prisma`**

Append near the other schedule models:

```prisma
/// Reusable configuration for one weekly Teams triage chat (Ancillary, Clinical).
/// Soft-deleted via isActive so a TriageChat created from a retired preset still
/// resolves to a name.
model TriageChatPreset {
  id              String                        @id @default(cuid())
  /// Shown on the card, e.g. "Ancillary".
  name            String
  /// Rendered into the Teams chat topic, e.g. "{{clinicDateShort}} Ancillary Triage Chat".
  nameTemplate    String
  /// Plain-text opening message with {{placeholders}}. Converted to Teams HTML at send.
  messageTemplate String
  isActive        Boolean                       @default(true)
  order           Int                           @default(0)
  createdAt       DateTime                      @default(now())
  updatedAt       DateTime                      @updatedAt
  departments     TriageChatPresetDepartment[]
  chats           TriageChat[]

  @@index([isActive, order])
}

/// The departments a preset draws triage-tagged directors from.
model TriageChatPresetDepartment {
  id           String           @id @default(cuid())
  presetId     String
  departmentId String
  preset       TriageChatPreset @relation(fields: [presetId], references: [id], onDelete: Cascade)
  department   Department       @relation(fields: [departmentId], references: [id], onDelete: Cascade)

  @@unique([presetId, departmentId])
  @@index([departmentId])
}

/// One Teams group chat actually created. The (presetId, clinicDate) unique
/// constraint IS the idempotency guard: a double-click, a resubmitted form, or a
/// retry after a partial failure must never produce two chats for the same week.
model TriageChat {
  id              String             @id @default(cuid())
  presetId        String
  termId          String
  /// Anchored at 12:00 UTC like every other clinic date. Compare by UTC day key.
  clinicDate      DateTime
  /// The rendered chat name, as sent to Graph.
  topic           String
  graphChatId     String
  webUrl          String
  /// Null until the opening message actually posts. Keeping the row with a null
  /// here is what lets a retry post the message instead of creating a second chat.
  messagePostedAt DateTime?
  createdById     String?
  createdAt       DateTime           @default(now())
  /// Restrict: a preset with chat history cannot be hard-deleted (deactivate it).
  preset          TriageChatPreset   @relation(fields: [presetId], references: [id], onDelete: Restrict)
  term            Term               @relation(fields: [termId], references: [id], onDelete: Restrict)
  /// SetNull: the chat record outlives the ED who created it.
  createdBy       Person?            @relation("triageChatCreatedBy", fields: [createdById], references: [id], onDelete: SetNull)
  members         TriageChatMember[]

  @@unique([presetId, clinicDate])
  @@index([termId, clinicDate])
}

/// Snapshot of who was in the chat that week, and who Graph refused. Deliberately
/// a snapshot rather than a live join: it must stay true after the schedule changes.
model TriageChatMember {
  id             String     @id @default(cuid())
  triageChatId   String
  personId       String?
  /// Denormalised on purpose, so the record survives a person being deleted.
  personName     String
  departmentName String
  addedOk        Boolean
  /// Graph's error, or the reason no Entra id could be resolved.
  error          String?
  triageChat     TriageChat @relation(fields: [triageChatId], references: [id], onDelete: Cascade)
  person         Person?    @relation("triageChatMemberPerson", fields: [personId], references: [id], onDelete: SetNull)

  @@index([triageChatId])
  @@index([personId])
}
```

- [ ] **Step 4: Add the back-relations**

In `model Department`, beside `courseDepartments`:

```prisma
  triageChatPresets          TriageChatPresetDepartment[]
```

In `model Person`, beside the other named relations:

```prisma
  /// Triage chats this person created.
  triageChatsCreated             TriageChat[]               @relation("triageChatCreatedBy")
  /// Triage chat memberships recorded for this person.
  triageChatMemberships          TriageChatMember[]         @relation("triageChatMemberPerson")
```

In `model Term`, beside `shiftAssignments`:

```prisma
  triageChats                TriageChat[]
```

- [ ] **Step 5: Create the migration**

Run: `npm run db:migrate -- --name triage_chats`

Then **open the generated SQL under `prisma/migrations/` and read it.** `prisma migrate dev` folds any pre-existing drift into the new migration. If the file contains statements unrelated to the four new tables, delete those lines before committing.

- [ ] **Step 6: Apply the migration to the test database**

Run: `npm run test:prepare`

- [ ] **Step 7: Add the new tables to the truncate list**

In `src/platform/test/db.ts`, add `"TriageChatMember", "TriageChat", "TriageChatPresetDepartment", "TriageChatPreset",` to the `TRUNCATE` list, before `"ShiftRequest"`. Order does not matter (CASCADE handles FK ordering) but keep related tables together.

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run src/modules/schedule/services/triage-chats.schema.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 9: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/platform/test/db.ts src/modules/schedule/services/triage-chats.schema.test.ts
git commit -m "feat(schedule): add the triage chat preset and record models"
```

---

### Task 2: The pure roster resolver

**Files:**
- Create: `src/modules/schedule/services/triage-chats.ts`
- Create: `src/modules/schedule/services/triage-chats.test.ts`

**Interfaces:**
- Consumes: `ShiftRole` from `@prisma/client`.
- Produces:
  - `type TriageRosterAssignment = { personId, role, triage, department: {id, code, name}, person: {id, name, netId, contactEmail, entraObjectId} }`
  - `type TriageRosterMember = { personId, name, netId, contactEmail, entraObjectId, departmentName }`
  - `type TriageRoster = { members: TriageRosterMember[], rosterBlock: string, sessionCoordinators: string[], clinicalAdvisors: string[], emptyDepartments: string[] }`
  - `function resolveTriageRoster(input: { assignments, selectedDepartments, alwaysIncludeDepartments }): TriageRoster`

- [ ] **Step 1: Write the failing test**

Create `src/modules/schedule/services/triage-chats.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveTriageRoster, type TriageRosterAssignment } from "./triage-chats";

const BVHD = { id: "d-bvhd", code: "BVHD", name: "Behavioral Health" };
const LABR = { id: "d-labr", code: "LABR", name: "Laboratory" };
const EXEC = { id: "d-exec", code: "EXEC", name: "Executive Directors" };
const PCAR = { id: "d-pcar", code: "PCAR", name: "Primary Care Clinical Advisors" };

function assignment(
  over: Partial<TriageRosterAssignment> & { name: string; department: typeof BVHD },
): TriageRosterAssignment {
  const personId = over.personId ?? `p-${over.name.toLowerCase().replace(/\W+/g, "-")}`;
  return {
    personId,
    role: over.role ?? "DIRECTOR",
    triage: over.triage ?? true,
    department: over.department,
    person: {
      id: personId,
      name: over.name,
      netId: over.person?.netId ?? "nid",
      contactEmail: over.person?.contactEmail ?? null,
      entraObjectId: over.person?.entraObjectId ?? "oid",
    },
  };
}

describe("resolveTriageRoster", () => {
  it("takes only triage-tagged directors from the selected departments", () => {
    const roster = resolveTriageRoster({
      assignments: [
        assignment({ name: "Goeun Lee", department: BVHD }),
        assignment({ name: "Not On Triage", department: BVHD, triage: false }),
        assignment({ name: "A Volunteer", department: BVHD, role: "VOLUNTEER" }),
      ],
      selectedDepartments: [BVHD],
      alwaysIncludeDepartments: [],
    });
    expect(roster.members.map((m) => m.name)).toEqual(["Goeun Lee"]);
  });

  it("takes every director from the always-include departments regardless of the triage flag", () => {
    const roster = resolveTriageRoster({
      assignments: [
        assignment({ name: "Phil Xu", department: EXEC, triage: false }),
        assignment({ name: "Andy Gu", department: EXEC, triage: false }),
        assignment({ name: "Matt Anderson", department: PCAR, triage: false }),
        assignment({ name: "An Exec Volunteer", department: EXEC, role: "VOLUNTEER" }),
      ],
      selectedDepartments: [],
      alwaysIncludeDepartments: [EXEC, PCAR],
    });
    expect(roster.members.map((m) => m.name).sort()).toEqual(["Andy Gu", "Matt Anderson", "Phil Xu"]);
    expect(roster.sessionCoordinators).toEqual(["Andy Gu", "Phil Xu"]);
    expect(roster.clinicalAdvisors).toEqual(["Matt Anderson"]);
  });

  it("lists a person once even when they hold triage shifts in two selected departments", () => {
    const shared = { personId: "p-shared", name: "Ju Hyun Lee" };
    const roster = resolveTriageRoster({
      assignments: [
        assignment({ ...shared, department: BVHD }),
        assignment({ ...shared, department: LABR }),
      ],
      selectedDepartments: [BVHD, LABR],
      alwaysIncludeDepartments: [],
    });
    expect(roster.members).toHaveLength(1);
  });

  it("builds a roster block that names exactly the members", () => {
    const roster = resolveTriageRoster({
      assignments: [
        assignment({ name: "Jovan Stanisavic", department: LABR }),
        assignment({ name: "Goeun Lee", department: BVHD }),
      ],
      selectedDepartments: [BVHD, LABR],
      alwaysIncludeDepartments: [],
    });
    expect(roster.rosterBlock).toBe(
      "- Behavioral Health: Goeun Lee\n- Laboratory: Jovan Stanisavic",
    );
    for (const member of roster.members) {
      expect(roster.rosterBlock).toContain(member.name);
    }
  });

  it("names a selected department that has no triage director on shift", () => {
    const roster = resolveTriageRoster({
      assignments: [assignment({ name: "Goeun Lee", department: BVHD })],
      selectedDepartments: [BVHD, LABR],
      alwaysIncludeDepartments: [],
    });
    expect(roster.emptyDepartments).toEqual(["Laboratory"]);
  });

  it("carries the lookup candidates for each member", () => {
    const roster = resolveTriageRoster({
      assignments: [
        {
          ...assignment({ name: "Goeun Lee", department: BVHD }),
          person: { id: "p-1", name: "Goeun Lee", netId: "gl123", contactEmail: "gl@example.com", entraObjectId: null },
          personId: "p-1",
        },
      ],
      selectedDepartments: [BVHD],
      alwaysIncludeDepartments: [],
    });
    expect(roster.members[0]).toMatchObject({
      netId: "gl123",
      contactEmail: "gl@example.com",
      entraObjectId: null,
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/modules/schedule/services/triage-chats.test.ts`
Expected: FAIL, cannot resolve `./triage-chats`.

- [ ] **Step 3: Write the implementation**

Create `src/modules/schedule/services/triage-chats.ts`:

```ts
import type { ShiftRole } from "@prisma/client";

/** A department as the resolver needs it: identity plus the label it prints. */
export type TriageDepartment = { id: string; code: string; name: string };

/** One ShiftAssignment row, narrowed to what the roster rules read. */
export type TriageRosterAssignment = {
  personId: string;
  role: ShiftRole;
  triage: boolean;
  department: TriageDepartment;
  person: {
    id: string;
    name: string;
    netId: string | null;
    contactEmail: string | null;
    entraObjectId: string | null;
  };
};

/**
 * A person going into the chat. Carries every candidate the Graph layer can use
 * to resolve them to an Entra object id. The resolver itself never touches the
 * network, so reachability is decided later, by the layer that can ask.
 */
export type TriageRosterMember = {
  personId: string;
  name: string;
  netId: string | null;
  contactEmail: string | null;
  entraObjectId: string | null;
  departmentName: string;
};

export type TriageRoster = {
  members: TriageRosterMember[];
  /** Plain-text bulleted list, one line per contributing department. */
  rosterBlock: string;
  sessionCoordinators: string[];
  clinicalAdvisors: string[];
  /** Selected departments that contributed nobody, for a review-screen warning. */
  emptyDepartments: string[];
};

/** Department codes whose members also get their own template variable. */
const SESSION_COORDINATOR_CODE = "EXEC";
const CLINICAL_ADVISOR_CODE = "PCAR";

/**
 * Turn one clinic date's assignments into the chat's membership and the roster
 * block printed in the opening message. One pass produces both, which is the
 * point: a bulleted list that can name somebody who is not in the chat is the
 * bug this feature exists to remove.
 *
 * Selected departments contribute only their triage-tagged directors, because
 * "who is fielding triage calls for this department" is exactly the question the
 * chat asks. The always-include departments (EXEC, PCAR, PATS by default)
 * contribute every director on shift instead: they are small leadership and
 * coordination groups where the triage tag is not the relevant distinction.
 *
 * Callers must pass assignments ALREADY filtered to one clinic date and to
 * people holding an ACTIVE TermMembership in the department they are assigned
 * to. That filter is not optional and is not done here only because it needs the
 * database: offboarding removes the membership but leaves future assignments in
 * place until a director clears them, so without it an offboarded volunteer is
 * added to a twenty-person chat.
 */
export function resolveTriageRoster(input: {
  assignments: TriageRosterAssignment[];
  selectedDepartments: TriageDepartment[];
  alwaysIncludeDepartments: TriageDepartment[];
}): TriageRoster {
  const { assignments, selectedDepartments, alwaysIncludeDepartments } = input;

  const selectedIds = new Set(selectedDepartments.map((d) => d.id));
  const alwaysIds = new Set(alwaysIncludeDepartments.map((d) => d.id));

  const qualifies = (a: TriageRosterAssignment): boolean => {
    if (a.role !== "DIRECTOR") return false;
    if (alwaysIds.has(a.department.id)) return true;
    return selectedIds.has(a.department.id) && a.triage;
  };

  // Dedupe by person, keeping the FIRST department that qualified them once the
  // list is in a deterministic order. Sorting before the walk (rather than
  // relying on query order) is what makes the chosen department stable.
  const ordered = [...assignments].filter(qualifies).sort((a, b) => {
    const byDept = a.department.name.localeCompare(b.department.name);
    return byDept !== 0 ? byDept : a.person.name.localeCompare(b.person.name);
  });

  const seen = new Set<string>();
  const members: TriageRosterMember[] = [];
  const byDepartment = new Map<string, string[]>();

  for (const a of ordered) {
    const names = byDepartment.get(a.department.name) ?? [];
    if (!names.includes(a.person.name)) names.push(a.person.name);
    byDepartment.set(a.department.name, names);

    if (seen.has(a.personId)) continue;
    seen.add(a.personId);
    members.push({
      personId: a.personId,
      name: a.person.name,
      netId: a.person.netId,
      contactEmail: a.person.contactEmail,
      entraObjectId: a.person.entraObjectId,
      departmentName: a.department.name,
    });
  }

  const namesForCode = (code: string): string[] =>
    ordered
      .filter((a) => a.department.code === code)
      .map((a) => a.person.name)
      .filter((name, i, all) => all.indexOf(name) === i);

  const rosterBlock = [...byDepartment.entries()]
    .map(([department, names]) => `- ${department}: ${names.join(", ")}`)
    .join("\n");

  const contributing = new Set(ordered.map((a) => a.department.id));
  const emptyDepartments = selectedDepartments
    .filter((d) => !contributing.has(d.id))
    .map((d) => d.name)
    .sort();

  return {
    members,
    rosterBlock,
    sessionCoordinators: namesForCode(SESSION_COORDINATOR_CODE),
    clinicalAdvisors: namesForCode(CLINICAL_ADVISOR_CODE),
    emptyDepartments,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/modules/schedule/services/triage-chats.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/schedule/services/triage-chats.ts src/modules/schedule/services/triage-chats.test.ts
git commit -m "feat(schedule): resolve the triage chat roster from the week's shifts"
```

---

### Task 3: The Graph group-chat client and the new scopes

**Files:**
- Create: `src/platform/teams/group-chat.ts`
- Create: `src/platform/teams/group-chat.test.ts`
- Modify: `src/platform/email/oauth.ts` (the `SCOPES` string and `teamsScopesGranted`)
- Modify: `src/platform/email/oauth.test.ts` (extend the `teamsScopesGranted` cases)

**Interfaces:**
- Consumes: `getAccessToken` from `@/platform/email/oauth`.
- Produces:
  - `type GraphChatDeps = { fetchImpl?: typeof fetch; getToken?: () => Promise<string> }`
  - `async function lookupUserId(bind: string, deps?: GraphChatDeps): Promise<string | null>`
  - `async function createGroupChat(input: { topic: string; memberIds: string[] }, deps?: GraphChatDeps): Promise<{ chatId: string; webUrl: string }>`
  - `async function addChatMember(chatId: string, userId: string, deps?: GraphChatDeps): Promise<void>`
  - `async function postChatMessage(chatId: string, bodyHtml: string, deps?: GraphChatDeps): Promise<void>`
  - `class GraphChatError extends Error { readonly status: number; readonly body: string }`

- [ ] **Step 1: Write the failing test**

Create `src/platform/teams/group-chat.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  lookupUserId,
  createGroupChat,
  addChatMember,
  postChatMessage,
  GraphChatError,
} from "./group-chat";

const deps = (fetchImpl: typeof fetch) => ({ fetchImpl, getToken: async () => "tok" });

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("lookupUserId", () => {
  it("returns the object id of a directory match", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ value: [{ id: "oid-1" }] }));
    const id = await lookupUserId("gl123@yale.edu", deps(fetchImpl as unknown as typeof fetch));
    expect(id).toBe("oid-1");
    const url = String((fetchImpl.mock.calls[0] as unknown[])[0]);
    expect(url).toContain("userPrincipalName%20eq%20'gl123%40yale.edu'");
    expect(url).toContain("mail%20eq%20'gl123%40yale.edu'");
  });

  it("returns null when the directory has no match", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ value: [] }));
    expect(await lookupUserId("nobody@yale.edu", deps(fetchImpl as unknown as typeof fetch))).toBeNull();
  });

  it("returns null rather than throwing on a 404", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: {} }, 404));
    expect(await lookupUserId("nobody@yale.edu", deps(fetchImpl as unknown as typeof fetch))).toBeNull();
  });

  it("escapes a single quote so a name cannot break the filter", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ value: [] }));
    await lookupUserId("o'brien@yale.edu", deps(fetchImpl as unknown as typeof fetch));
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toContain("o''brien");
  });
});

describe("createGroupChat", () => {
  it("posts a group chat with a topic and one member entry each", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ id: "chat-1", webUrl: "https://teams.microsoft.com/l/chat/1" }),
    );
    const result = await createGroupChat(
      { topic: "05.30.26 Ancillary Triage Chat", memberIds: ["oid-1", "oid-2"] },
      deps(fetchImpl as unknown as typeof fetch),
    );
    expect(result).toEqual({ chatId: "chat-1", webUrl: "https://teams.microsoft.com/l/chat/1" });

    const init = (fetchImpl.mock.calls[0] as unknown[])[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.chatType).toBe("group");
    expect(body.topic).toBe("05.30.26 Ancillary Triage Chat");
    expect(body.members).toHaveLength(2);
    expect(body.members[0]["user@odata.bind"]).toBe(
      "https://graph.microsoft.com/v1.0/users('oid-1')",
    );
    expect(body.members[0].roles).toEqual(["owner"]);
  });

  it("throws a GraphChatError carrying the response body", async () => {
    const fetchImpl = vi.fn(async () => new Response("member not found", { status: 400 }));
    await expect(
      createGroupChat({ topic: "t", memberIds: ["oid-1"] }, deps(fetchImpl as unknown as typeof fetch)),
    ).rejects.toMatchObject({ status: 400, body: "member not found" });
    await expect(
      createGroupChat({ topic: "t", memberIds: ["oid-1"] }, deps(fetchImpl as unknown as typeof fetch)),
    ).rejects.toBeInstanceOf(GraphChatError);
  });

  it("refuses to call Graph with no members", async () => {
    const fetchImpl = vi.fn();
    await expect(
      createGroupChat({ topic: "t", memberIds: [] }, deps(fetchImpl as unknown as typeof fetch)),
    ).rejects.toThrow(/at least one member/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("addChatMember", () => {
  it("posts one member to the chat", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 201 }));
    await addChatMember("chat-1", "oid-9", deps(fetchImpl as unknown as typeof fetch));
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe("https://graph.microsoft.com/v1.0/chats/chat-1/members");
    const body = JSON.parse(String(init.body));
    expect(body["user@odata.bind"]).toBe("https://graph.microsoft.com/v1.0/users('oid-9')");
  });

  it("throws with the status and body when Graph refuses", async () => {
    const fetchImpl = vi.fn(async () => new Response("forbidden", { status: 403 }));
    await expect(
      addChatMember("chat-1", "oid-9", deps(fetchImpl as unknown as typeof fetch)),
    ).rejects.toMatchObject({ status: 403, body: "forbidden" });
  });
});

describe("postChatMessage", () => {
  it("posts an html body", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: "m-1" }, 201));
    await postChatMessage("chat-1", "<p>hi</p>", deps(fetchImpl as unknown as typeof fetch));
    const init = (fetchImpl.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      body: { contentType: "html", content: "<p>hi</p>" },
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/platform/teams/group-chat.test.ts`
Expected: FAIL, cannot resolve `./group-chat`.

- [ ] **Step 3: Write the implementation**

Create `src/platform/teams/group-chat.ts`:

```ts
/**
 * Microsoft Graph calls for the weekly triage group chats.
 *
 * Same shape as channel-link.ts: injectable fetch and token so tests never touch
 * the network, a bounded timeout on every call, and NO internal retry. Errors
 * carry Graph's response body, which is not decoration: a 403 for a missing
 * scope and a 403 for an account that may not chat with a recipient look
 * identical as a bare status code and have completely different fixes.
 */
import { getAccessToken } from "@/platform/email/oauth";

const GRAPH = "https://graph.microsoft.com/v1.0";

/** Bound every call so one hung request cannot hold a server action open. */
const TIMEOUT_MS = 8000;

export type GraphChatDeps = {
  fetchImpl?: typeof fetch;
  getToken?: () => Promise<string>;
};

export class GraphChatError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(operation: string, status: number, body: string) {
    super(`Graph ${operation} failed: ${status}${body ? ` -- ${body}` : ""}`);
    this.name = "GraphChatError";
    this.status = status;
    this.body = body;
  }
}

/** Read Graph's error body without ever letting that read fail the request. */
async function readErrorBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}

async function call(
  operation: string,
  url: string,
  init: RequestInit,
  deps: GraphChatDeps,
): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const token = await (deps.getToken ?? getAccessToken)();
  const res = await fetchImpl(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new GraphChatError(operation, res.status, await readErrorBody(res));
  return res;
}

/** OData string literals escape a single quote by doubling it. */
function odataLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function userBind(userId: string): string {
  return `${GRAPH}/users('${odataLiteral(userId)}')`;
}

/**
 * Resolve a sign-in name or email to an Entra object id, or null when the
 * directory has no match.
 *
 * Filters on userPrincipalName OR mail deliberately. Those are the same string
 * in many tenants but demonstrably not uniformly at Yale, and asking for both
 * means the Hub never has to know which one a given account uses.
 *
 * A miss is null, not a throw: "this person is not in the directory" is an
 * expected outcome the caller reports to the ED, not an error.
 */
export async function lookupUserId(
  bind: string,
  deps: GraphChatDeps = {},
): Promise<string | null> {
  const literal = odataLiteral(bind);
  const filter = `userPrincipalName eq '${literal}' or mail eq '${literal}'`;
  const url = `${GRAPH}/users?$filter=${encodeURIComponent(filter)}&$select=id&$top=2`;
  let res: Response;
  try {
    res = await call("user lookup", url, { method: "GET" }, deps);
  } catch (err) {
    // A 404 means no such user, which is a miss rather than a failure. Anything
    // else (401, 403, 429, 5xx, a timeout) is a real problem the caller must see.
    if (err instanceof GraphChatError && err.status === 404) return null;
    throw err;
  }
  const json = (await res.json()) as { value?: { id: string }[] };
  const matches = json.value ?? [];
  // More than one match means the bind is ambiguous, so trust none of them
  // rather than adding a coin-flip person to a twenty-person chat.
  if (matches.length !== 1) return null;
  return matches[0].id ?? null;
}

/**
 * Create the group chat. Atomic: if any member id is invalid Graph rejects the
 * whole call, which is why the caller passes only ids it knows are good and adds
 * the rest with addChatMember afterwards.
 */
export async function createGroupChat(
  input: { topic: string; memberIds: string[] },
  deps: GraphChatDeps = {},
): Promise<{ chatId: string; webUrl: string }> {
  if (input.memberIds.length === 0) {
    throw new Error("A group chat needs at least one member.");
  }
  const res = await call(
    "create group chat",
    `${GRAPH}/chats`,
    {
      method: "POST",
      body: JSON.stringify({
        chatType: "group",
        topic: input.topic,
        members: input.memberIds.map((id) => ({
          "@odata.type": "#microsoft.graph.aadUserConversationMember",
          roles: ["owner"],
          "user@odata.bind": userBind(id),
        })),
      }),
    },
    deps,
  );
  const json = (await res.json()) as { id: string; webUrl?: string };
  return { chatId: json.id, webUrl: json.webUrl ?? "" };
}

/** Add one member. Isolated per person so a bad id costs one seat, not the chat. */
export async function addChatMember(
  chatId: string,
  userId: string,
  deps: GraphChatDeps = {},
): Promise<void> {
  await call(
    "add chat member",
    `${GRAPH}/chats/${encodeURIComponent(chatId)}/members`,
    {
      method: "POST",
      body: JSON.stringify({
        "@odata.type": "#microsoft.graph.aadUserConversationMember",
        roles: ["owner"],
        "user@odata.bind": userBind(userId),
      }),
    },
    deps,
  );
}

/** Post the opening message. Same call the 1:1 Teams transport already makes. */
export async function postChatMessage(
  chatId: string,
  bodyHtml: string,
  deps: GraphChatDeps = {},
): Promise<void> {
  await call(
    "post chat message",
    `${GRAPH}/chats/${encodeURIComponent(chatId)}/messages`,
    {
      method: "POST",
      body: JSON.stringify({ body: { contentType: "html", content: bodyHtml } }),
    },
    deps,
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/platform/teams/group-chat.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Add the two new scopes**

In `src/platform/email/oauth.ts`, extend `SCOPES` (one line, keep the existing entries in place):

```ts
const SCOPES =
  "openid profile email offline_access https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.Send.Shared https://graph.microsoft.com/Channel.ReadBasic.All https://graph.microsoft.com/Chat.Create https://graph.microsoft.com/ChatMessage.Send https://graph.microsoft.com/Chat.ReadWrite https://graph.microsoft.com/User.ReadBasic.All";
```

Then extend the granted check in the same file:

```ts
/**
 * True when the stored credential scope string already includes every Teams
 * scope the app needs. Used by the admin UI to prompt for a reconnect after the
 * scopes grew.
 *
 * Chat.ReadWrite rather than the least-privileged ChatMember.ReadWrite that
 * Microsoft documents for adding a chat member: ChatMember.ReadWrite requires
 * tenant admin consent, and Chat.ReadWrite is the documented higher-privileged
 * alternative for the same call that a user may consent to themselves.
 */
export function teamsScopesGranted(scope: string | null): boolean {
  if (!scope) return false;
  return (
    scope.includes("Chat.Create") &&
    scope.includes("ChatMessage.Send") &&
    scope.includes("Chat.ReadWrite") &&
    scope.includes("User.ReadBasic.All")
  );
}
```

- [ ] **Step 6: Update the scope test**

In `src/platform/email/oauth.test.ts`, the existing case asserting
`teamsScopesGranted("Mail.Send Chat.Create ChatMessage.Send") === true` is now
false. Change that case and add coverage for the new scopes:

```ts
  it("is false when the chat scopes are present but the new ones are not", () => {
    expect(teamsScopesGranted("Mail.Send Chat.Create ChatMessage.Send")).toBe(false);
  });

  it("is false when User.ReadBasic.All is missing", () => {
    expect(
      teamsScopesGranted("Chat.Create ChatMessage.Send Chat.ReadWrite"),
    ).toBe(false);
  });

  it("is true once every Teams scope is granted", () => {
    expect(
      teamsScopesGranted(
        "Mail.Send Chat.Create ChatMessage.Send Chat.ReadWrite User.ReadBasic.All",
      ),
    ).toBe(true);
  });
```

- [ ] **Step 7: Run the oauth tests**

Run: `npx vitest run src/platform/email/oauth.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/platform/teams/group-chat.ts src/platform/teams/group-chat.test.ts src/platform/email/oauth.ts src/platform/email/oauth.test.ts
git commit -m "feat(teams): add a Graph group-chat client and the scopes it needs"
```

---

### Task 4: Resolving roster members to Entra object ids

**Files:**
- Create: `src/platform/teams/member-ids.ts`
- Create: `src/platform/teams/member-ids.test.ts`

**Interfaces:**
- Consumes: `lookupUserId` from `@/platform/teams/group-chat`. Deliberately NOT
  the schedule module's `TriageRosterMember`: `eslint.config.mjs` forbids
  `src/platform/**` from importing `@/modules/**` ("Platform code must not import
  module code"), so this file declares its own structural input type instead and
  the module's member type satisfies it without an adapter.
- Produces:
  - `type ChatMemberCandidate = { personId: string; name: string; netId: string | null; contactEmail: string | null; departmentName: string; entraObjectId: string | null }`
  - `type ResolvedMember<T extends ChatMemberCandidate = ChatMemberCandidate> = { member: T; userId: string | null; source: "stored" | "directory" | "unresolved"; reason?: string }`
  - `async function resolveMemberIds<T extends ChatMemberCandidate>(members: T[], deps?: { lookup?: (bind: string) => Promise<string | null> }): Promise<ResolvedMember<T>[]>`

Generic rather than a plain widening so Task 6 still sees the full
`TriageRosterMember` on `.member` instead of the narrowed platform type.

- [ ] **Step 1: Write the failing test**

Create `src/platform/teams/member-ids.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { resolveMemberIds, type ChatMemberCandidate } from "./member-ids";

function member(over: Partial<ChatMemberCandidate> = {}): ChatMemberCandidate {
  return {
    personId: "p-1",
    name: "Goeun Lee",
    netId: "gl123",
    contactEmail: "goeun@example.com",
    entraObjectId: null,
    departmentName: "Behavioral Health",
    ...over,
  };
}

describe("resolveMemberIds", () => {
  it("uses a stored entraObjectId without calling the directory", async () => {
    const lookup = vi.fn();
    const [resolved] = await resolveMemberIds([member({ entraObjectId: "oid-1" })], { lookup });
    expect(resolved).toMatchObject({ userId: "oid-1", source: "stored" });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("looks the person up by netId@yale.edu when no id is stored", async () => {
    const lookup = vi.fn(async (bind: string) => (bind === "gl123@yale.edu" ? "oid-2" : null));
    const [resolved] = await resolveMemberIds([member()], { lookup });
    expect(resolved).toMatchObject({ userId: "oid-2", source: "directory" });
    expect(lookup).toHaveBeenCalledWith("gl123@yale.edu");
  });

  it("falls through to the contact email when the netId misses", async () => {
    const lookup = vi.fn(async (bind: string) => (bind === "goeun@example.com" ? "oid-3" : null));
    const [resolved] = await resolveMemberIds([member()], { lookup });
    expect(resolved).toMatchObject({ userId: "oid-3", source: "directory" });
    expect(lookup).toHaveBeenNthCalledWith(1, "gl123@yale.edu");
    expect(lookup).toHaveBeenNthCalledWith(2, "goeun@example.com");
  });

  it("reports a person the directory does not know", async () => {
    const lookup = vi.fn(async () => null);
    const [resolved] = await resolveMemberIds([member()], { lookup });
    expect(resolved.userId).toBeNull();
    expect(resolved.source).toBe("unresolved");
    expect(resolved.reason).toMatch(/directory/i);
  });

  it("reports a person with nothing to look up", async () => {
    const lookup = vi.fn();
    const [resolved] = await resolveMemberIds(
      [member({ netId: null, contactEmail: null })],
      { lookup },
    );
    expect(resolved.source).toBe("unresolved");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("treats a lookup failure as unresolved rather than failing the batch", async () => {
    const lookup = vi.fn(async () => {
      throw new Error("Graph user lookup failed: 429");
    });
    const resolved = await resolveMemberIds([member(), member({ personId: "p-2" })], { lookup });
    expect(resolved).toHaveLength(2);
    expect(resolved.every((r) => r.source === "unresolved")).toBe(true);
    expect(resolved[0].reason).toContain("429");
  });

  it("keeps input order", async () => {
    const lookup = vi.fn(async () => "oid-x");
    const resolved = await resolveMemberIds(
      [member({ personId: "p-1", name: "A" }), member({ personId: "p-2", name: "B" })],
      { lookup },
    );
    expect(resolved.map((r) => r.member.name)).toEqual(["A", "B"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/platform/teams/member-ids.test.ts`
Expected: FAIL, cannot resolve `./member-ids`.

- [ ] **Step 3: Write the implementation**

Create `src/platform/teams/member-ids.ts`:

```ts
/**
 * Resolve roster members to the Entra object ids Graph needs to seat them in a
 * chat.
 *
 * The resolved ids are deliberately NOT written back to Person.entraObjectId.
 * That column is the SSO identity link match-person.ts uses to bind a login to a
 * person, and it is @unique: a directory lookup that matched the wrong Ellen
 * Smith would turn a display bug into an account takeover. Looking up fresh
 * costs about twenty cheap directory reads once a week.
 */
import { lookupUserId } from "./group-chat";

/**
 * What this module needs to resolve one person, declared here rather than
 * imported from the schedule module.
 *
 * Structural on purpose: eslint forbids src/platform from importing
 * @/modules (platform must not depend on module internals), and the schedule
 * module's TriageRosterMember already has every field below, so it satisfies
 * this shape with no adapter.
 */
export type ChatMemberCandidate = {
  personId: string;
  name: string;
  netId: string | null;
  contactEmail: string | null;
  departmentName: string;
  entraObjectId: string | null;
};

export type ResolvedMember<T extends ChatMemberCandidate = ChatMemberCandidate> = {
  member: T;
  userId: string | null;
  source: "stored" | "directory" | "unresolved";
  /** Why the member could not be resolved. Shown to the ED verbatim. */
  reason?: string;
};

/** Yale sign-in names. lookupUserId matches UPN or mail, so either form works. */
function candidates(member: ChatMemberCandidate): string[] {
  const out: string[] = [];
  if (member.netId) out.push(`${member.netId}@yale.edu`);
  if (member.contactEmail) out.push(member.contactEmail);
  return out;
}

/**
 * Bounded parallelism. A roster is about twenty people once a week, so this is
 * not about throughput: it keeps a burst of directory reads from tripping
 * Graph's rate limiter, which would turn one slow week into a page full of
 * unresolved members.
 */
const CONCURRENCY = 5;

export async function resolveMemberIds<T extends ChatMemberCandidate>(
  members: T[],
  deps: { lookup?: (bind: string) => Promise<string | null> } = {},
): Promise<ResolvedMember<T>[]> {
  const lookup = deps.lookup ?? ((bind: string) => lookupUserId(bind));
  const results: ResolvedMember<T>[] = new Array(members.length);

  async function resolveOne(index: number): Promise<void> {
    const member = members[index];
    if (member.entraObjectId) {
      results[index] = { member, userId: member.entraObjectId, source: "stored" };
      return;
    }
    const binds = candidates(member);
    if (binds.length === 0) {
      results[index] = {
        member,
        userId: null,
        source: "unresolved",
        reason: "No Yale net ID or contact email on file to look up.",
      };
      return;
    }
    for (const bind of binds) {
      try {
        const userId = await lookup(bind);
        if (userId) {
          results[index] = { member, userId, source: "directory" };
          return;
        }
      } catch (err) {
        // One person's failed lookup must not sink the batch: the ED still gets
        // a chat with everyone else and a named list of who to add by hand.
        results[index] = {
          member,
          userId: null,
          source: "unresolved",
          reason: err instanceof Error ? err.message : String(err),
        };
        return;
      }
    }
    results[index] = {
      member,
      userId: null,
      source: "unresolved",
      reason: "Not found in the Microsoft directory.",
    };
  }

  let next = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, members.length) }, async () => {
    while (next < members.length) {
      const index = next++;
      await resolveOne(index);
    }
  });
  await Promise.all(workers);
  return results;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/platform/teams/member-ids.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/platform/teams/member-ids.ts src/platform/teams/member-ids.test.ts
git commit -m "feat(teams): resolve chat members to Entra ids via the directory"
```

---

### Task 5: The draft loader and the always-include setting

**Files:**
- Create: `src/modules/schedule/services/triage-chat-draft.ts`
- Create: `src/modules/schedule/services/triage-chat-draft.test.ts`
- Modify: `src/platform/settings/registry.ts`

**Interfaces:**
- Consumes: `resolveTriageRoster` (Task 2), `resolveMemberIds` (Task 4).
- Produces:
  - `type TriageChatDraft = { preset, term, clinicDate, clinicDateKey, topic, messageBody, roster, resolved, warnings: string[], existingChat }`
  - `async function loadTriageChatDraft(presetId: string, deps?: { now?: Date; resolveIds?: typeof resolveMemberIds }): Promise<TriageChatDraft | null>`
  - `function renderTriageText(template: string, context: Record<string, unknown>): string`
  - `function textToTeamsHtml(text: string): string`

- [ ] **Step 1: Add the setting**

In `src/platform/settings/registry.ts`, add to the `SETTINGS` array beside the other Operations entries:

```ts
  define<string>({
    key: "triageChats.alwaysIncludeDepartmentCodes",
    category: "Operations",
    label: "Triage chat leadership departments",
    help: "Comma-separated department codes whose directors join EVERY triage chat, regardless of the triage tag. These are the small leadership and coordination groups (Executive Directors, Clinical Advisors, Patient Services), where 'who is on triage' is not the relevant question.",
    input: { type: "text" },
    // Format only. The codes cannot be checked against real departments here:
    // SettingValidateCtx carries config and getSetting and no database handle,
    // and registry.ts is imported widely enough that reaching for prisma would
    // buy an import cycle. The draft loader reports an unmatched code as a
    // warning on the review screen instead, next to the roster it affects.
    schema: z
      .string()
      .regex(/^[A-Z0-9]+(,[A-Z0-9]+)*$/, "Comma-separated uppercase department codes, e.g. EXEC,PCAR,PATS"),
    envDefault: () => "EXEC,PCAR,PATS",
    secret: false,
  }),
```

- [ ] **Step 2: Write the failing test**

Create `src/modules/schedule/services/triage-chat-draft.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { setSetting } from "@/platform/settings/service";
import {
  loadTriageChatDraft,
  renderTriageText,
  textToTeamsHtml,
} from "./triage-chat-draft";

beforeEach(resetDb);

const CLINIC_DATE = new Date("2026-05-30T12:00:00Z");
const NOW = new Date("2026-05-27T14:00:00Z");

async function seed(options: { triage?: boolean; membershipStatus?: "ACTIVE" | "OFFBOARDED" } = {}) {
  const { triage = true, membershipStatus = "ACTIVE" } = options;
  const term = await prisma.term.create({
    data: {
      code: "SU26",
      name: "Summer 2026",
      startDate: new Date("2026-05-01T12:00:00Z"),
      endDate: new Date("2026-08-01T12:00:00Z"),
      status: "ACTIVE",
      clinicDates: [CLINIC_DATE],
    },
  });
  const bvhd = await prisma.department.create({ data: { code: "BVHD", name: "Behavioral Health" } });
  const exec = await prisma.department.create({ data: { code: "EXEC", name: "Executive Directors" } });

  const goeun = await prisma.person.create({
    data: { name: "Goeun Lee", netId: "gl123", entraObjectId: "oid-goeun" },
  });
  const phil = await prisma.person.create({
    data: { name: "Phil Xu", netId: "px9", entraObjectId: "oid-phil" },
  });

  for (const [person, dept] of [[goeun, bvhd], [phil, exec]] as const) {
    await prisma.termMembership.create({
      data: { termId: term.id, departmentId: dept.id, personId: person.id, status: membershipStatus },
    });
    await prisma.shiftAssignment.create({
      data: {
        termId: term.id,
        departmentId: dept.id,
        personId: person.id,
        clinicDate: CLINIC_DATE,
        role: "DIRECTOR",
        triage: dept.code === "EXEC" ? false : triage,
      },
    });
  }

  const preset = await prisma.triageChatPreset.create({
    data: {
      name: "Ancillary",
      nameTemplate: "{{clinicDateShort}} Ancillary Triage Chat",
      messageTemplate: "Hi everyone! Clinic is {{clinicDate}}.\n\n{{rosterBlock}}",
      departments: { create: [{ departmentId: bvhd.id }] },
    },
  });
  return { term, preset, bvhd, exec, goeun, phil };
}

describe("renderTriageText", () => {
  it("substitutes variables and leaves an unknown one empty", () => {
    expect(renderTriageText("A {{x}} B {{missing}}C", { x: "1" })).toBe("A 1 BC");
  });
});

describe("textToTeamsHtml", () => {
  it("escapes html and turns newlines into breaks", () => {
    expect(textToTeamsHtml("a <b>\nc & d")).toBe("a &lt;b&gt;<br>c &amp; d");
  });
});

describe("loadTriageChatDraft", () => {
  it("builds the topic, message, and roster for the upcoming clinic date", async () => {
    const { preset } = await seed();
    const draft = await loadTriageChatDraft(preset.id, {
      now: NOW,
      resolveIds: async (members) =>
        members.map((member) => ({ member, userId: "oid", source: "stored" as const })),
    });
    expect(draft).not.toBeNull();
    expect(draft!.topic).toBe("05.30.26 Ancillary Triage Chat");
    expect(draft!.messageBody).toContain("Clinic is Saturday, May 30, 2026");
    expect(draft!.messageBody).toContain("- Behavioral Health: Goeun Lee");
    expect(draft!.roster.members.map((m) => m.name).sort()).toEqual(["Goeun Lee", "Phil Xu"]);
    expect(draft!.roster.sessionCoordinators).toEqual(["Phil Xu"]);
  });

  it("drops a person whose membership is no longer active", async () => {
    const { preset } = await seed({ membershipStatus: "OFFBOARDED" });
    const draft = await loadTriageChatDraft(preset.id, {
      now: NOW,
      resolveIds: async (members) =>
        members.map((member) => ({ member, userId: "oid", source: "stored" as const })),
    });
    expect(draft!.roster.members).toHaveLength(0);
  });

  it("warns when a selected department has no triage director on shift", async () => {
    const { preset } = await seed({ triage: false });
    const draft = await loadTriageChatDraft(preset.id, {
      now: NOW,
      resolveIds: async (members) =>
        members.map((member) => ({ member, userId: "oid", source: "stored" as const })),
    });
    expect(draft!.warnings.join(" ")).toContain("Behavioral Health");
  });

  it("warns about an always-include code that matches no department", async () => {
    const { preset } = await seed();
    // Through the settings service, never a raw Setting insert: the resolver
    // holds a process-global cache that a raw write would leave stale.
    await setSetting("triageChats.alwaysIncludeDepartmentCodes", "EXEC,NOPE");
    const draft = await loadTriageChatDraft(preset.id, {
      now: NOW,
      resolveIds: async (members) =>
        members.map((member) => ({ member, userId: "oid", source: "stored" as const })),
    });
    expect(draft!.warnings.join(" ")).toContain("NOPE");
  });

  it("surfaces an existing chat for the same preset and clinic date", async () => {
    const { preset, term } = await seed();
    await prisma.triageChat.create({
      data: {
        presetId: preset.id,
        termId: term.id,
        clinicDate: CLINIC_DATE,
        topic: "05.30.26 Ancillary Triage Chat",
        graphChatId: "chat-1",
        webUrl: "https://teams.microsoft.com/l/chat/1",
      },
    });
    const draft = await loadTriageChatDraft(preset.id, {
      now: NOW,
      resolveIds: async (members) =>
        members.map((member) => ({ member, userId: "oid", source: "stored" as const })),
    });
    expect(draft!.existingChat?.graphChatId).toBe("chat-1");
  });
});
```

Note: delete the malformed `prisma.setting.create` line above when writing the
file; the `setSetting` call on the following lines is the real setup. It is
shown here only to flag that settings must be written through the service, never
inserted raw, because the resolver caches.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/modules/schedule/services/triage-chat-draft.test.ts`
Expected: FAIL, cannot resolve `./triage-chat-draft`.

- [ ] **Step 4: Write the implementation**

Create `src/modules/schedule/services/triage-chat-draft.ts`:

```ts
/**
 * Assemble everything the review screen needs for one preset: the clinic date,
 * the roster, the rendered chat name and opening message, any warnings, and the
 * chat that already exists for this week if there is one.
 *
 * The member ids (including the directory lookups) are resolved HERE rather than
 * at confirm time so the ED sees who cannot be added before committing, not
 * after.
 */
import { prisma } from "@/platform/db";
import { getSetting } from "@/platform/settings/service";
import { getActiveTerm } from "@/platform/terms/active-term";
import {
  selectCurrentClinicDate,
  formatClinicDate,
  getCurrentClinicChannelLink,
} from "@/platform/teams/channel-link";
import { resolveMemberIds, type ResolvedMember } from "@/platform/teams/member-ids";
import { formatCalendarDate, isoDateKey } from "@/platform/dates";
import { renderTemplate } from "@/platform/email/render/render";
import { esc } from "@/platform/email/render/escape";
import { resolveTriageRoster, type TriageRoster, type TriageRosterMember } from "./triage-chats";

/**
 * Plain text in, plain text out. The ED edits the message as text, so the
 * template is text too; the HTML conversion happens once, at send.
 */
export function renderTriageText(template: string, context: Record<string, unknown>): string {
  return renderTemplate(template, context, { escape: false });
}

/**
 * Convert the ED's plain-text message to the HTML Teams renders.
 *
 * Escape first, then break lines. Doing it in the other order would escape the
 * <br> tags this function just inserted.
 */
export function textToTeamsHtml(text: string): string {
  return esc(text).replace(/\r?\n/g, "<br>");
}

export type TriageChatDraft = {
  preset: { id: string; name: string; nameTemplate: string; messageTemplate: string };
  term: { id: string; name: string };
  clinicDate: Date;
  clinicDateKey: string;
  topic: string;
  messageBody: string;
  roster: TriageRoster;
  resolved: ResolvedMember<TriageRosterMember>[];
  warnings: string[];
  existingChat: { id: string; graphChatId: string; webUrl: string; messagePostedAt: Date | null } | null;
};

export type DraftDeps = {
  now?: Date;
  resolveIds?: typeof resolveMemberIds;
};

/** Read the leadership department codes, tolerating whitespace around commas. */
async function alwaysIncludeCodes(): Promise<string[]> {
  const raw = await getSetting<string>("triageChats.alwaysIncludeDepartmentCodes");
  return raw
    .split(",")
    .map((code) => code.trim().toUpperCase())
    .filter(Boolean);
}

export async function loadTriageChatDraft(
  presetId: string,
  deps: DraftDeps = {},
): Promise<TriageChatDraft | null> {
  const { now = new Date(), resolveIds = resolveMemberIds } = deps;

  const preset = await prisma.triageChatPreset.findUnique({
    where: { id: presetId },
    include: { departments: { include: { department: true } } },
  });
  if (!preset) return null;

  const term = await getActiveTerm();
  if (!term) return null;

  // Same selector the clinic channel link and the shift reminders use, so all
  // three always agree on which Saturday "this week" means.
  const clinicDate = selectCurrentClinicDate(term.clinicDates, now);
  if (!clinicDate) return null;
  const clinicDateKey = isoDateKey(clinicDate);

  const warnings: string[] = [];

  const codes = await alwaysIncludeCodes();
  const alwaysDepartments = await prisma.department.findMany({
    where: { code: { in: codes } },
    select: { id: true, code: true, name: true },
  });
  const missingCodes = codes.filter((code) => !alwaysDepartments.some((d) => d.code === code));
  if (missingCodes.length > 0) {
    warnings.push(
      `The leadership department setting names ${missingCodes.join(", ")}, which matches no department. Fix it in Admin > Settings.`,
    );
  }

  const selectedDepartments = preset.departments.map((d) => ({
    id: d.department.id,
    code: d.department.code,
    name: d.department.name,
  }));

  const departmentIds = [
    ...new Set([...selectedDepartments, ...alwaysDepartments].map((d) => d.id)),
  ];

  // Load the term's assignments, then filter to the clinic date by UTC day key.
  // Never compare a clinic date by raw timestamp.
  const rows = await prisma.shiftAssignment.findMany({
    where: { termId: term.id, departmentId: { in: departmentIds } },
    select: {
      personId: true,
      departmentId: true,
      clinicDate: true,
      role: true,
      triage: true,
      department: { select: { id: true, code: true, name: true } },
      person: {
        select: { id: true, name: true, netId: true, contactEmail: true, entraObjectId: true },
      },
    },
  });
  const dated = rows.filter((r) => isoDateKey(r.clinicDate) === clinicDateKey);

  // Only people STILL active in the department they are assigned to. Offboarding
  // removes the membership but leaves future assignments until a director clears
  // them, so without this an offboarded volunteer joins a twenty-person chat.
  const activeMemberships = await prisma.termMembership.findMany({
    where: {
      termId: term.id,
      status: "ACTIVE",
      personId: { in: [...new Set(dated.map((r) => r.personId))] },
    },
    select: { personId: true, departmentId: true },
  });
  const activeInDept = new Set(activeMemberships.map((m) => `${m.personId}:${m.departmentId}`));

  const roster = resolveTriageRoster({
    assignments: dated
      .filter((r) => activeInDept.has(`${r.personId}:${r.departmentId}`))
      .map((r) => ({
        personId: r.personId,
        role: r.role,
        triage: r.triage,
        department: r.department,
        person: r.person,
      })),
    selectedDepartments,
    alwaysIncludeDepartments: alwaysDepartments,
  });

  for (const name of roster.emptyDepartments) {
    warnings.push(`${name} has no triage director on shift for this clinic date.`);
  }
  if (roster.members.length === 0) {
    warnings.push("Nobody is on shift for this clinic date, so there is nobody to add.");
  }

  // Never throws and degrades to null, so a Graph blip costs the link and not
  // the draft.
  const channelLink = await getCurrentClinicChannelLink({ now });

  const context = {
    clinicDate: formatCalendarDate(clinicDate, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    }),
    clinicDateShort: formatClinicDate(clinicDate).replace(/-/g, "."),
    sessionCoordinators: roster.sessionCoordinators.join(", "),
    clinicalAdvisors: roster.clinicalAdvisors.join(", "),
    rosterBlock: roster.rosterBlock,
    teamsChannelUrl: channelLink?.webUrl ?? "",
  };

  const resolved = await resolveIds(roster.members);
  const unresolved = resolved.filter((r) => r.source === "unresolved");
  if (unresolved.length > 0) {
    warnings.push(
      `${unresolved.length} ${unresolved.length === 1 ? "person" : "people"} cannot be added automatically and must be added by hand in Teams.`,
    );
  }

  const existingChat = await prisma.triageChat.findUnique({
    where: { presetId_clinicDate: { presetId: preset.id, clinicDate } },
    select: { id: true, graphChatId: true, webUrl: true, messagePostedAt: true },
  });

  return {
    preset: {
      id: preset.id,
      name: preset.name,
      nameTemplate: preset.nameTemplate,
      messageTemplate: preset.messageTemplate,
    },
    term: { id: term.id, name: term.name },
    clinicDate,
    clinicDateKey,
    topic: renderTriageText(preset.nameTemplate, context),
    messageBody: renderTriageText(preset.messageTemplate, context),
    roster,
    resolved,
    warnings,
    existingChat,
  };
}

export type { TriageRosterMember };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/modules/schedule/services/triage-chat-draft.test.ts`
Expected: PASS, 7 tests. If `formatCalendarDate` renders a different long-date
string than the test expects, match the test to the helper rather than changing
the helper.

- [ ] **Step 6: Run the settings guard tests**

Run: `npx vitest run src/platform/settings`
Expected: PASS. The registry has guard tests asserting every entry is
well-formed; a malformed `define` fails here.

- [ ] **Step 7: Commit**

```bash
git add src/modules/schedule/services/triage-chat-draft.ts src/modules/schedule/services/triage-chat-draft.test.ts src/platform/settings/registry.ts
git commit -m "feat(schedule): assemble the triage chat draft from the week's schedule"
```

---

### Task 6: Creating the chat

**Files:**
- Create: `src/modules/schedule/services/triage-chat-create.ts`
- Create: `src/modules/schedule/services/triage-chat-create.test.ts`

**Interfaces:**
- Consumes: `loadTriageChatDraft` (Task 5), the Graph client (Task 3), `recordAudit` from `@/platform/audit`.
- Produces:
  - `class TriageChatConflictError extends Error`
  - `type TriageChatGraph = { createGroupChat; addChatMember; postChatMessage; lookupUserId }`
  - `async function createTriageChat(input: { presetId, actorPersonId, topic, messageBody, includePersonIds }, deps?): Promise<{ chatId: string; webUrl: string; messagePosted: boolean; failures: { name: string; reason: string }[] }>`
  - `async function retryTriageChatMessage(triageChatId: string, deps?): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `src/modules/schedule/services/triage-chat-create.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { createTriageChat, TriageChatConflictError } from "./triage-chat-create";
import type { TriageChatDraft } from "./triage-chat-draft";

beforeEach(resetDb);

const CLINIC_DATE = new Date("2026-05-30T12:00:00Z");

async function seedDraftFixtures() {
  const term = await prisma.term.create({
    data: {
      code: "SU26",
      name: "Summer 2026",
      startDate: new Date("2026-05-01T12:00:00Z"),
      endDate: new Date("2026-08-01T12:00:00Z"),
      status: "ACTIVE",
      clinicDates: [CLINIC_DATE],
    },
  });
  const dept = await prisma.department.create({ data: { code: "BVHD", name: "Behavioral Health" } });
  const stored = await prisma.person.create({
    data: { name: "Goeun Lee", netId: "gl1", entraObjectId: "oid-stored" },
  });
  const looked = await prisma.person.create({ data: { name: "Never Signed In", netId: "ns1" } });
  const preset = await prisma.triageChatPreset.create({
    data: { name: "Ancillary", nameTemplate: "{{clinicDateShort}} Ancillary", messageTemplate: "hi" },
  });
  return { term, dept, stored, looked, preset };
}

function draftFor(fixtures: Awaited<ReturnType<typeof seedDraftFixtures>>): TriageChatDraft {
  const member = (id: string, name: string, entraObjectId: string | null) => ({
    personId: id,
    name,
    netId: "n",
    contactEmail: null,
    entraObjectId,
    departmentName: "Behavioral Health",
  });
  const storedMember = member(fixtures.stored.id, "Goeun Lee", "oid-stored");
  const lookedMember = member(fixtures.looked.id, "Never Signed In", null);
  return {
    preset: { id: fixtures.preset.id, name: "Ancillary", nameTemplate: "", messageTemplate: "" },
    term: { id: fixtures.term.id, name: "Summer 2026" },
    clinicDate: CLINIC_DATE,
    clinicDateKey: "2026-05-30",
    topic: "05.30.26 Ancillary",
    messageBody: "Hi everyone",
    roster: {
      members: [storedMember, lookedMember],
      rosterBlock: "- Behavioral Health: Goeun Lee, Never Signed In",
      sessionCoordinators: [],
      clinicalAdvisors: [],
      emptyDepartments: [],
    },
    resolved: [
      { member: storedMember, userId: "oid-stored", source: "stored" },
      { member: lookedMember, userId: "oid-looked", source: "directory" },
    ],
    warnings: [],
    existingChat: null,
  };
}

function graphStub(over: Partial<Parameters<typeof createTriageChat>[1]> = {}) {
  return {
    createGroupChat: vi.fn(async () => ({ chatId: "chat-1", webUrl: "https://teams/1" })),
    addChatMember: vi.fn(async () => {}),
    postChatMessage: vi.fn(async () => {}),
    serviceAccountId: async () => "oid-service",
    ...over,
  };
}

describe("createTriageChat", () => {
  it("creates with the stored ids and adds the directory-resolved ones after", async () => {
    const fixtures = await seedDraftFixtures();
    const draft = draftFor(fixtures);
    const graph = graphStub();

    const result = await createTriageChat(
      {
        presetId: fixtures.preset.id,
        actorPersonId: fixtures.stored.id,
        topic: draft.topic,
        messageBody: draft.messageBody,
        includePersonIds: [fixtures.stored.id, fixtures.looked.id],
      },
      { ...graph, loadDraft: async () => draft },
    );

    expect(graph.createGroupChat).toHaveBeenCalledWith({
      topic: "05.30.26 Ancillary",
      memberIds: ["oid-service", "oid-stored"],
    });
    expect(graph.addChatMember).toHaveBeenCalledWith("chat-1", "oid-looked");
    expect(graph.postChatMessage).toHaveBeenCalledTimes(1);
    expect(result.messagePosted).toBe(true);
    expect(result.failures).toEqual([]);

    const saved = await prisma.triageChat.findFirstOrThrow({ include: { members: true } });
    expect(saved.graphChatId).toBe("chat-1");
    expect(saved.messagePostedAt).not.toBeNull();
    expect(saved.members).toHaveLength(2);
    expect(saved.members.every((m) => m.addedOk)).toBe(true);
  });

  it("records a chat with no posted message when the message fails", async () => {
    const fixtures = await seedDraftFixtures();
    const draft = draftFor(fixtures);
    const graph = graphStub({
      postChatMessage: vi.fn(async () => {
        throw new Error("Graph post chat message failed: 502");
      }),
    });

    const result = await createTriageChat(
      {
        presetId: fixtures.preset.id,
        actorPersonId: fixtures.stored.id,
        topic: draft.topic,
        messageBody: draft.messageBody,
        includePersonIds: [fixtures.stored.id],
      },
      { ...graph, loadDraft: async () => draft },
    );

    expect(result.messagePosted).toBe(false);
    const saved = await prisma.triageChat.findFirstOrThrow();
    expect(saved.graphChatId).toBe("chat-1");
    expect(saved.messagePostedAt).toBeNull();
  });

  it("records a failed member add without losing the chat", async () => {
    const fixtures = await seedDraftFixtures();
    const draft = draftFor(fixtures);
    const graph = graphStub({
      addChatMember: vi.fn(async () => {
        throw new Error("Graph add chat member failed: 403 -- forbidden");
      }),
    });

    const result = await createTriageChat(
      {
        presetId: fixtures.preset.id,
        actorPersonId: fixtures.stored.id,
        topic: draft.topic,
        messageBody: draft.messageBody,
        includePersonIds: [fixtures.stored.id, fixtures.looked.id],
      },
      { ...graph, loadDraft: async () => draft },
    );

    expect(result.failures).toEqual([
      { name: "Never Signed In", reason: expect.stringContaining("403") },
    ]);
    const saved = await prisma.triageChat.findFirstOrThrow({ include: { members: true } });
    const failed = saved.members.find((m) => m.personName === "Never Signed In");
    expect(failed?.addedOk).toBe(false);
  });

  it("refuses a second chat for the same preset and clinic date", async () => {
    const fixtures = await seedDraftFixtures();
    const draft = draftFor(fixtures);
    const graph = graphStub();
    const input = {
      presetId: fixtures.preset.id,
      actorPersonId: fixtures.stored.id,
      topic: draft.topic,
      messageBody: draft.messageBody,
      includePersonIds: [fixtures.stored.id],
    };

    await createTriageChat(input, { ...graph, loadDraft: async () => draft });
    await expect(
      createTriageChat(input, { ...graph, loadDraft: async () => draft }),
    ).rejects.toBeInstanceOf(TriageChatConflictError);
    expect(await prisma.triageChat.count()).toBe(1);
    expect(graph.createGroupChat).toHaveBeenCalledTimes(1);
  });

  it("ignores a person id that is not in the resolved roster", async () => {
    const fixtures = await seedDraftFixtures();
    const draft = draftFor(fixtures);
    const graph = graphStub();
    const outsider = await prisma.person.create({
      data: { name: "Outsider", netId: "out1", entraObjectId: "oid-outsider" },
    });

    await createTriageChat(
      {
        presetId: fixtures.preset.id,
        actorPersonId: fixtures.stored.id,
        topic: draft.topic,
        messageBody: draft.messageBody,
        includePersonIds: [fixtures.stored.id, outsider.id],
      },
      { ...graph, loadDraft: async () => draft },
    );

    expect(graph.createGroupChat).toHaveBeenCalledWith({
      topic: "05.30.26 Ancillary",
      memberIds: ["oid-service", "oid-stored"],
    });
  });

  it("leaves nothing recorded when the chat itself cannot be created", async () => {
    const fixtures = await seedDraftFixtures();
    const draft = draftFor(fixtures);
    const graph = graphStub({
      createGroupChat: vi.fn(async () => {
        throw new Error("Graph create group chat failed: 400");
      }),
    });

    await expect(
      createTriageChat(
        {
          presetId: fixtures.preset.id,
          actorPersonId: fixtures.stored.id,
          topic: draft.topic,
          messageBody: draft.messageBody,
          includePersonIds: [fixtures.stored.id],
        },
        { ...graph, loadDraft: async () => draft },
      ),
    ).rejects.toThrow(/400/);
    expect(await prisma.triageChat.count()).toBe(0);
  });

  it("writes an audit entry", async () => {
    const fixtures = await seedDraftFixtures();
    const draft = draftFor(fixtures);
    await createTriageChat(
      {
        presetId: fixtures.preset.id,
        actorPersonId: fixtures.stored.id,
        topic: draft.topic,
        messageBody: draft.messageBody,
        includePersonIds: [fixtures.stored.id],
      },
      { ...graphStub(), loadDraft: async () => draft },
    );
    const audit = await prisma.auditLog.findFirstOrThrow();
    expect(audit.action).toBe("triage_chat.create");
    expect(audit.entityType).toBe("TriageChat");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/modules/schedule/services/triage-chat-create.test.ts`
Expected: FAIL, cannot resolve `./triage-chat-create`.

- [ ] **Step 3: Write the implementation**

Create `src/modules/schedule/services/triage-chat-create.ts`:

```ts
/**
 * Create one weekly triage chat.
 *
 * Deliberately synchronous and NOT routed through notify()/drainTeamsQueue. That
 * queue retries on a fixed interval and falls back to email after an attempt
 * budget: retrying a create that partly succeeded would produce duplicate chats,
 * and there is no sensible email fallback for "create a group chat". A human is
 * watching this action and can simply be told what happened.
 */
import { prisma } from "@/platform/db";
import { Prisma } from "@prisma/client";
import { recordAudit } from "@/platform/audit";
import { log, errorAttrs } from "@/platform/logging";
import { mailConnectionStatus } from "@/platform/email/oauth";
import {
  createGroupChat as graphCreateGroupChat,
  addChatMember as graphAddChatMember,
  postChatMessage as graphPostChatMessage,
  lookupUserId,
} from "@/platform/teams/group-chat";
import { loadTriageChatDraft, textToTeamsHtml, type TriageChatDraft } from "./triage-chat-draft";

/** Raised when a chat already exists for this preset and clinic date. */
export class TriageChatConflictError extends Error {
  constructor() {
    super("A triage chat has already been created for this preset and clinic date.");
    this.name = "TriageChatConflictError";
  }
}

/** Raised when the service account cannot be identified, so nobody could own the chat. */
export class TriageChatNotConnectedError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "TriageChatNotConnectedError";
  }
}

export type CreateTriageChatDeps = {
  loadDraft?: (presetId: string) => Promise<TriageChatDraft | null>;
  createGroupChat?: typeof graphCreateGroupChat;
  addChatMember?: typeof graphAddChatMember;
  postChatMessage?: typeof graphPostChatMessage;
  serviceAccountId?: () => Promise<string>;
};

/**
 * The Entra object id of the connected service account.
 *
 * Resolved through the directory rather than binding the stored account string
 * directly: that string is the mailbox address, and this tenant's UPN and mail
 * do not always match (hfc.admin@yale.edu by mail, hfc.admin@yu.yale.edu by UPN).
 */
async function defaultServiceAccountId(): Promise<string> {
  const status = await mailConnectionStatus();
  if (!status.connected || !status.account) {
    throw new TriageChatNotConnectedError(
      "No Microsoft account is connected. Connect the mailbox in Admin > Email before creating a chat.",
    );
  }
  const id = await lookupUserId(status.account);
  if (!id) {
    throw new TriageChatNotConnectedError(
      `The connected account ${status.account} could not be found in the directory.`,
    );
  }
  return id;
}

export type CreateTriageChatResult = {
  triageChatId: string;
  chatId: string;
  webUrl: string;
  messagePosted: boolean;
  /** People Graph refused, named so the ED can add them by hand. */
  failures: { name: string; reason: string }[];
};

export async function createTriageChat(
  input: {
    presetId: string;
    actorPersonId: string;
    topic: string;
    messageBody: string;
    includePersonIds: string[];
  },
  deps: CreateTriageChatDeps = {},
): Promise<CreateTriageChatResult> {
  const {
    loadDraft = (presetId: string) => loadTriageChatDraft(presetId),
    createGroupChat = graphCreateGroupChat,
    addChatMember = graphAddChatMember,
    postChatMessage = graphPostChatMessage,
    serviceAccountId = defaultServiceAccountId,
  } = deps;

  // Re-resolve server side. The form contributes only a set of person ids to
  // KEEP; it never supplies identities or Entra ids, so a tampered field cannot
  // name an arbitrary person into the chat.
  const draft = await loadDraft(input.presetId);
  if (!draft) throw new Error("This preset has no clinic date to build a chat for.");

  const keep = new Set(input.includePersonIds);
  const selected = draft.resolved.filter((r) => keep.has(r.member.personId));

  const stored = selected.filter((r) => r.source === "stored" && r.userId);
  const directory = selected.filter((r) => r.source === "directory" && r.userId);
  const unresolved = selected.filter((r) => !r.userId);

  if (stored.length === 0 && directory.length === 0) {
    throw new Error("Nobody in this roster can be added to a chat.");
  }

  const ownerId = await serviceAccountId();

  // Seed the create with ids that came from a real sign-in, which cannot be
  // wrong. A create is atomic, so one bad id would fail the chat for everyone.
  // When there are none, promote a single directory-resolved member so the chat
  // is still valid, and add the rest individually as usual.
  const promoted = stored.length === 0 ? directory.slice(0, 1) : [];
  const createMembers = [...stored, ...promoted];
  const incremental = directory.filter((r) => !promoted.includes(r));

  // Claim the week BEFORE calling Graph. The unique constraint is the guard: a
  // double submit loses the insert here rather than creating a second chat.
  let claimed;
  try {
    claimed = await prisma.triageChat.create({
      data: {
        presetId: input.presetId,
        termId: draft.term.id,
        clinicDate: draft.clinicDate,
        topic: input.topic,
        graphChatId: "",
        webUrl: "",
        createdById: input.actorPersonId,
      },
      select: { id: true },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new TriageChatConflictError();
    }
    throw err;
  }

  let chat: { chatId: string; webUrl: string };
  try {
    chat = await createGroupChat({
      topic: input.topic,
      memberIds: [ownerId, ...createMembers.map((r) => r.userId!)],
    });
  } catch (err) {
    // Nothing exists in Teams, so the claim must go too or the week is locked
    // out of a retry that would have worked.
    await prisma.triageChat.delete({ where: { id: claimed.id } }).catch(() => {});
    throw err;
  }

  const failures: { name: string; reason: string }[] = [];
  const memberRows: Prisma.TriageChatMemberCreateManyInput[] = createMembers.map((r) => ({
    triageChatId: claimed.id,
    personId: r.member.personId,
    personName: r.member.name,
    departmentName: r.member.departmentName,
    addedOk: true,
  }));

  for (const r of incremental) {
    try {
      await addChatMember(chat.chatId, r.userId!);
      memberRows.push({
        triageChatId: claimed.id,
        personId: r.member.personId,
        personName: r.member.name,
        departmentName: r.member.departmentName,
        addedOk: true,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failures.push({ name: r.member.name, reason });
      memberRows.push({
        triageChatId: claimed.id,
        personId: r.member.personId,
        personName: r.member.name,
        departmentName: r.member.departmentName,
        addedOk: false,
        error: reason,
      });
    }
  }

  for (const r of unresolved) {
    const reason = r.reason ?? "Could not be resolved to a Microsoft account.";
    failures.push({ name: r.member.name, reason });
    memberRows.push({
      triageChatId: claimed.id,
      personId: r.member.personId,
      personName: r.member.name,
      departmentName: r.member.departmentName,
      addedOk: false,
      error: reason,
    });
  }

  let messagePosted = false;
  try {
    await postChatMessage(chat.chatId, textToTeamsHtml(input.messageBody));
    messagePosted = true;
  } catch (err) {
    // Keep the row. That is the whole point: with graphChatId recorded, a retry
    // posts the message instead of creating a second chat.
    log.error("[triage-chats] opening message failed", errorAttrs(err, { chatId: chat.chatId }));
  }

  await prisma.$transaction([
    prisma.triageChat.update({
      where: { id: claimed.id },
      data: {
        graphChatId: chat.chatId,
        webUrl: chat.webUrl,
        messagePostedAt: messagePosted ? new Date() : null,
      },
    }),
    prisma.triageChatMember.createMany({ data: memberRows }),
  ]);

  await recordAudit({
    actorPersonId: input.actorPersonId,
    action: "triage_chat.create",
    entityType: "TriageChat",
    entityId: claimed.id,
    after: {
      topic: input.topic,
      clinicDate: draft.clinicDateKey,
      membersAdded: memberRows.filter((m) => m.addedOk).length,
      membersFailed: failures.length,
      messagePosted,
    },
  });

  return {
    triageChatId: claimed.id,
    chatId: chat.chatId,
    webUrl: chat.webUrl,
    messagePosted,
    failures,
  };
}

/** Post the opening message for a chat that was created without one. */
export async function retryTriageChatMessage(
  triageChatId: string,
  messageBody: string,
  deps: { postChatMessage?: typeof graphPostChatMessage } = {},
): Promise<void> {
  const post = deps.postChatMessage ?? graphPostChatMessage;
  const chat = await prisma.triageChat.findUniqueOrThrow({
    where: { id: triageChatId },
    select: { graphChatId: true, messagePostedAt: true },
  });
  if (chat.messagePostedAt) return;
  await post(chat.graphChatId, textToTeamsHtml(messageBody));
  await prisma.triageChat.update({
    where: { id: triageChatId },
    data: { messagePostedAt: new Date() },
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/modules/schedule/services/triage-chat-create.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/schedule/services/triage-chat-create.ts src/modules/schedule/services/triage-chat-create.test.ts
git commit -m "feat(schedule): create the weekly triage chat through Graph"
```

---

### Task 7: Preset CRUD

**Files:**
- Create: `src/modules/schedule/services/triage-chat-presets.ts`
- Create: `src/modules/schedule/services/triage-chat-presets.test.ts`

**Interfaces:**
- Produces:
  - `class TriageChatPresetValidationError extends Error`
  - `async function listTriageChatPresets(): Promise<PresetSummary[]>`
  - `async function listTriageChatCards(clinicDate: Date | null): Promise<PresetCard[]>`
  - `async function createTriageChatPreset(actorPersonId, input): Promise<{ id: string }>`
  - `async function updateTriageChatPreset(actorPersonId, presetId, input): Promise<void>`
  - `async function deactivateTriageChatPreset(actorPersonId, presetId): Promise<void>`
  - `const DEFAULT_MESSAGE_TEMPLATE: string`

- [ ] **Step 1: Write the failing test**

Create `src/modules/schedule/services/triage-chat-presets.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  listTriageChatPresets,
  createTriageChatPreset,
  updateTriageChatPreset,
  deactivateTriageChatPreset,
  TriageChatPresetValidationError,
  DEFAULT_MESSAGE_TEMPLATE,
} from "./triage-chat-presets";

beforeEach(resetDb);

const ACTOR = "actor-1";

async function departments() {
  const a = await prisma.department.create({ data: { code: "BVHD", name: "Behavioral Health" } });
  const b = await prisma.department.create({ data: { code: "LABR", name: "Laboratory" } });
  return { a, b };
}

describe("triage chat presets", () => {
  it("creates a preset with its departments", async () => {
    const { a, b } = await departments();
    const { id } = await createTriageChatPreset(ACTOR, {
      name: "Ancillary",
      nameTemplate: "{{clinicDateShort}} Ancillary Triage Chat",
      messageTemplate: DEFAULT_MESSAGE_TEMPLATE,
      departmentIds: [a.id, b.id],
    });
    const saved = await prisma.triageChatPreset.findUniqueOrThrow({
      where: { id },
      include: { departments: true },
    });
    expect(saved.departments).toHaveLength(2);
  });

  it("rejects a blank name", async () => {
    await expect(
      createTriageChatPreset(ACTOR, {
        name: "  ",
        nameTemplate: "x",
        messageTemplate: "y",
        departmentIds: [],
      }),
    ).rejects.toBeInstanceOf(TriageChatPresetValidationError);
  });

  it("rejects a name template that would produce an empty chat name", async () => {
    await expect(
      createTriageChatPreset(ACTOR, {
        name: "Ancillary",
        nameTemplate: "   ",
        messageTemplate: "y",
        departmentIds: [],
      }),
    ).rejects.toBeInstanceOf(TriageChatPresetValidationError);
  });

  it("replaces the department set on update rather than appending", async () => {
    const { a, b } = await departments();
    const { id } = await createTriageChatPreset(ACTOR, {
      name: "Ancillary",
      nameTemplate: "x",
      messageTemplate: "y",
      departmentIds: [a.id],
    });
    await updateTriageChatPreset(ACTOR, id, {
      name: "Ancillary",
      nameTemplate: "x",
      messageTemplate: "y",
      departmentIds: [b.id],
    });
    const saved = await prisma.triageChatPreset.findUniqueOrThrow({
      where: { id },
      include: { departments: true },
    });
    expect(saved.departments.map((d) => d.departmentId)).toEqual([b.id]);
  });

  it("deactivates rather than deletes, so chat history still resolves", async () => {
    const { a } = await departments();
    const { id } = await createTriageChatPreset(ACTOR, {
      name: "Ancillary",
      nameTemplate: "x",
      messageTemplate: "y",
      departmentIds: [a.id],
    });
    await deactivateTriageChatPreset(ACTOR, id);
    expect((await prisma.triageChatPreset.findUniqueOrThrow({ where: { id } })).isActive).toBe(false);
    expect(await listTriageChatPresets()).toHaveLength(0);
  });

  it("lists active presets in order with their department names", async () => {
    const { a } = await departments();
    await createTriageChatPreset(ACTOR, {
      name: "Clinical",
      nameTemplate: "x",
      messageTemplate: "y",
      departmentIds: [a.id],
      order: 1,
    });
    await createTriageChatPreset(ACTOR, {
      name: "Ancillary",
      nameTemplate: "x",
      messageTemplate: "y",
      departmentIds: [a.id],
      order: 0,
    });
    const presets = await listTriageChatPresets();
    expect(presets.map((p) => p.name)).toEqual(["Ancillary", "Clinical"]);
    expect(presets[0].departmentNames).toEqual(["Behavioral Health"]);
  });

  it("marks a preset that already has a chat for the clinic date", async () => {
    const { a } = await departments();
    const { id } = await createTriageChatPreset(ACTOR, {
      name: "Ancillary",
      nameTemplate: "x",
      messageTemplate: "y",
      departmentIds: [a.id],
    });
    const term = await prisma.term.create({
      data: {
        code: "SU26",
        name: "Summer 2026",
        startDate: new Date("2026-05-01T12:00:00Z"),
        endDate: new Date("2026-08-01T12:00:00Z"),
      },
    });
    const clinicDate = new Date("2026-05-30T12:00:00Z");
    await prisma.triageChat.create({
      data: {
        presetId: id,
        termId: term.id,
        clinicDate,
        topic: "05.30.26 Ancillary",
        graphChatId: "chat-1",
        webUrl: "https://teams/1",
      },
    });

    const [thisWeek] = await listTriageChatCards(clinicDate);
    expect(thisWeek.existingChat?.webUrl).toBe("https://teams/1");

    // A different clinic date is a different chat, so the card offers Create again.
    const [nextWeek] = await listTriageChatCards(new Date("2026-06-06T12:00:00Z"));
    expect(nextWeek.existingChat).toBeNull();
  });

  it("returns presets with no chat when there is no clinic date", async () => {
    const { a } = await departments();
    await createTriageChatPreset(ACTOR, {
      name: "Ancillary",
      nameTemplate: "x",
      messageTemplate: "y",
      departmentIds: [a.id],
    });
    const cards = await listTriageChatCards(null);
    expect(cards).toHaveLength(1);
    expect(cards[0].existingChat).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/modules/schedule/services/triage-chat-presets.test.ts`
Expected: FAIL, cannot resolve `./triage-chat-presets`.

- [ ] **Step 3: Write the implementation**

Create `src/modules/schedule/services/triage-chat-presets.ts`:

```ts
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";

export class TriageChatPresetValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TriageChatPresetValidationError";
  }
}

/**
 * The starting message, matching what the EDs write by hand today. Plain text:
 * the ED edits it as text and it is converted to Teams HTML once, at send.
 */
export const DEFAULT_MESSAGE_TEMPLATE = `Hi everyone! This chat will be used for you all to communicate across departments regarding scheduled patients for the upcoming clinic on {{clinicDate}} and respond to patient calls pertinent to your department. {{sessionCoordinators}} will be the session coordinators.

Please respond to all triages within 24 hours and communicate all information regarding triages here for awareness.

{{rosterBlock}}`;

export type PresetSummary = {
  id: string;
  name: string;
  nameTemplate: string;
  messageTemplate: string;
  order: number;
  departmentIds: string[];
  departmentNames: string[];
};

export type PresetInput = {
  name: string;
  nameTemplate: string;
  messageTemplate: string;
  departmentIds: string[];
  order?: number;
};

function validate(input: PresetInput): PresetInput {
  const name = input.name.trim();
  const nameTemplate = input.nameTemplate.trim();
  const messageTemplate = input.messageTemplate.trim();
  if (!name) throw new TriageChatPresetValidationError("Give the preset a name.");
  if (!nameTemplate) {
    throw new TriageChatPresetValidationError(
      "Give the preset a chat name pattern, e.g. {{clinicDateShort}} Ancillary Triage Chat.",
    );
  }
  if (!messageTemplate) {
    throw new TriageChatPresetValidationError("Give the preset an opening message.");
  }
  return { ...input, name, nameTemplate, messageTemplate };
}

export async function listTriageChatPresets(): Promise<PresetSummary[]> {
  const rows = await prisma.triageChatPreset.findMany({
    where: { isActive: true },
    orderBy: [{ order: "asc" }, { name: "asc" }],
    include: { departments: { include: { department: { select: { id: true, name: true } } } } },
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    nameTemplate: row.nameTemplate,
    messageTemplate: row.messageTemplate,
    order: row.order,
    departmentIds: row.departments.map((d) => d.departmentId),
    departmentNames: row.departments
      .map((d) => d.department.name)
      .sort((a, b) => a.localeCompare(b)),
  }));
}

export type PresetCard = PresetSummary & {
  /** The chat already created for the upcoming clinic date, if there is one. */
  existingChat: { webUrl: string; messagePostedAt: Date | null } | null;
};

/**
 * The index page's data: presets plus whether each already has a chat for the
 * given clinic date.
 *
 * Deliberately NOT loadTriageChatDraft per preset. A draft resolves every member
 * against the Microsoft directory, so building one per card would fire dozens of
 * Graph lookups on every page load to render a button label. The index needs two
 * queries; the lookups belong on the review screen, where their answer is
 * actually shown.
 */
export async function listTriageChatCards(clinicDate: Date | null): Promise<PresetCard[]> {
  const presets = await listTriageChatPresets();
  if (!clinicDate || presets.length === 0) {
    return presets.map((preset) => ({ ...preset, existingChat: null }));
  }
  const chats = await prisma.triageChat.findMany({
    where: { clinicDate, presetId: { in: presets.map((p) => p.id) } },
    select: { presetId: true, webUrl: true, messagePostedAt: true },
  });
  const byPreset = new Map(chats.map((c) => [c.presetId, c]));
  return presets.map((preset) => {
    const chat = byPreset.get(preset.id);
    return {
      ...preset,
      existingChat: chat
        ? { webUrl: chat.webUrl, messagePostedAt: chat.messagePostedAt }
        : null,
    };
  });
}

export async function createTriageChatPreset(
  actorPersonId: string,
  input: PresetInput,
): Promise<{ id: string }> {
  const clean = validate(input);
  const preset = await prisma.triageChatPreset.create({
    data: {
      name: clean.name,
      nameTemplate: clean.nameTemplate,
      messageTemplate: clean.messageTemplate,
      order: clean.order ?? 0,
      departments: {
        create: [...new Set(clean.departmentIds)].map((departmentId) => ({ departmentId })),
      },
    },
    select: { id: true },
  });
  await recordAudit({
    actorPersonId,
    action: "triage_chat_preset.create",
    entityType: "TriageChatPreset",
    entityId: preset.id,
    after: { name: clean.name, departments: clean.departmentIds.length },
  });
  return preset;
}

export async function updateTriageChatPreset(
  actorPersonId: string,
  presetId: string,
  input: PresetInput,
): Promise<void> {
  const clean = validate(input);
  // Replace the department set rather than appending: the form submits the whole
  // selection, so a department the ED unticked must actually go away.
  await prisma.$transaction([
    prisma.triageChatPresetDepartment.deleteMany({ where: { presetId } }),
    prisma.triageChatPreset.update({
      where: { id: presetId },
      data: {
        name: clean.name,
        nameTemplate: clean.nameTemplate,
        messageTemplate: clean.messageTemplate,
        order: clean.order ?? 0,
        departments: {
          create: [...new Set(clean.departmentIds)].map((departmentId) => ({ departmentId })),
        },
      },
    }),
  ]);
  await recordAudit({
    actorPersonId,
    action: "triage_chat_preset.update",
    entityType: "TriageChatPreset",
    entityId: presetId,
    after: { name: clean.name, departments: clean.departmentIds.length },
  });
}

/**
 * Soft delete. A hard delete is blocked by TriageChat's Restrict FK anyway, and
 * a retired preset must still resolve to a name for the chats it created.
 */
export async function deactivateTriageChatPreset(
  actorPersonId: string,
  presetId: string,
): Promise<void> {
  await prisma.triageChatPreset.update({ where: { id: presetId }, data: { isActive: false } });
  await recordAudit({
    actorPersonId,
    action: "triage_chat_preset.deactivate",
    entityType: "TriageChatPreset",
    entityId: presetId,
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/modules/schedule/services/triage-chat-presets.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/schedule/services/triage-chat-presets.ts src/modules/schedule/services/triage-chat-presets.test.ts
git commit -m "feat(schedule): manage triage chat presets"
```

---

### Task 8: The permission, the nav tab, and the index page

**Files:**
- Modify: `src/platform/modules/registry.ts`
- Create: `src/app/(app)/schedule/triage-chats/page.tsx`
- Create: `src/app/(app)/schedule/triage-chats/actions.ts`
- Create: `src/app/(app)/schedule/triage-chats/preset-form.tsx`
- Create: `src/app/(app)/schedule/triage-chats/[presetId]/edit/page.tsx`
- Create: `src/app/(app)/schedule/triage-chats/new/page.tsx`

**Interfaces:**
- Consumes: `listTriageChatPresets`, `createTriageChatPreset`, `updateTriageChatPreset`, `deactivateTriageChatPreset` (Task 7).
- Produces: the permission string `schedule.manage_triage_chats`, the route `/schedule/triage-chats`.

- [ ] **Step 1: Register the permission and the nav tab**

In `src/platform/modules/registry.ts`, inside the `schedule` manifest's
`permissions` array, add after `"schedule.manage_attendings"`:

```ts
      // Unscoped like the two above, and for the same kind of reason: there is
      // ONE weekly triage chat per preset for the whole clinic, created by an
      // Executive Director. A department-scoped grant could not express that.
      "schedule.manage_triage_chats",
```

In the same manifest's `nav` array, add after the Specialties entry:

```ts
      {
        label: "Triage chats",
        href: "/schedule/triage-chats",
        permission: "schedule.manage_triage_chats",
      },
```

Do NOT add an href to the `dynamicGate` list in `schedule/layout.tsx`. This tab
gates on a plain permission string, so `filterNavItems` handles it, which is the
documented rule in that file.

Do NOT add the permission to any entry in `src/platform/rbac/system-roles.ts`.
Admins grant it per role or per person, like `clinic.access`.

- [ ] **Step 2: Verify the registry guard tests still pass**

Run: `npx vitest run src/platform/modules src/platform/rbac`
Expected: PASS.

- [ ] **Step 3: Write the server actions**

Create `src/app/(app)/schedule/triage-chats/actions.ts`:

```ts
"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/platform/auth/session";
import {
  createTriageChatPreset,
  updateTriageChatPreset,
  deactivateTriageChatPreset,
  TriageChatPresetValidationError,
} from "@/modules/schedule/services/triage-chat-presets";
import type { ActionResult } from "@/platform/ui/run-action";

const PERMISSION = "schedule.manage_triage_chats";

function presetInputFrom(formData: FormData) {
  return {
    name: String(formData.get("name") ?? ""),
    nameTemplate: String(formData.get("nameTemplate") ?? ""),
    messageTemplate: String(formData.get("messageTemplate") ?? ""),
    departmentIds: formData.getAll("departmentIds").map(String),
  };
}

export async function savePresetAction(
  presetId: string | null,
  formData: FormData,
): Promise<ActionResult> {
  const session = await requirePermission(PERMISSION);
  try {
    if (presetId) {
      await updateTriageChatPreset(session.personId, presetId, presetInputFrom(formData));
    } else {
      await createTriageChatPreset(session.personId, presetInputFrom(formData));
    }
  } catch (err) {
    if (err instanceof TriageChatPresetValidationError) return { error: err.message };
    throw err;
  }
  revalidatePath("/schedule/triage-chats");
  return {};
}

export async function deactivatePresetAction(presetId: string): Promise<ActionResult> {
  const session = await requirePermission(PERMISSION);
  await deactivateTriageChatPreset(session.personId, presetId);
  revalidatePath("/schedule/triage-chats");
  return {};
}
```

- [ ] **Step 4: Write the index page**

Create `src/app/(app)/schedule/triage-chats/page.tsx`:

```tsx
import Link from "next/link";
import { requirePermission } from "@/platform/auth/session";
import { listTriageChatCards } from "@/modules/schedule/services/triage-chat-presets";
import { getActiveTerm } from "@/platform/terms/active-term";
import { selectCurrentClinicDate } from "@/platform/teams/channel-link";
import { buildPageMetadata } from "@/platform/branding/metadata";
import { PageHeader } from "@/platform/ui/page-header";
import { Card } from "@/platform/ui/card";
// buttonClasses, not <Button> wrapping a <Link>: Button renders a real <button>
// and has no asChild, so wrapping would nest a link inside a button. Styling the
// Link is the pattern the rest of the schedule module already uses.
import { buttonClasses } from "@/platform/ui/button";
import { Alert } from "@/platform/ui/alert";
import { formatCalendarDate } from "@/platform/dates";

export async function generateMetadata() {
  return buildPageMetadata({
    title: "Triage chats",
    description: "Create the weekly Teams triage group chats from the clinic schedule.",
  });
}

export default async function TriageChatsPage() {
  await requirePermission("schedule.manage_triage_chats");
  const term = await getActiveTerm();
  const clinicDate = term ? selectCurrentClinicDate(term.clinicDates, new Date()) : null;
  const presets = await listTriageChatCards(clinicDate);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Triage chats"
        description="Create this week's Teams triage group chats. Members and the roster come from the clinic schedule."
        action={
          <Link className={buttonClasses("secondary", "md")} href="/schedule/triage-chats/new">
            New preset
          </Link>
        }
      />

      {presets.length === 0 && (
        <Alert tone="info">
          No presets yet. Create one for each weekly chat (for example Ancillary and Clinical).
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {presets.map((preset) => (
          <Card key={preset.id}>
            <div className="space-y-3">
              <div>
                <h2 className="text-lg font-semibold">{preset.name}</h2>
                <p className="text-sm text-muted-foreground">
                  {preset.departmentNames.length} department
                  {preset.departmentNames.length === 1 ? "" : "s"}
                  {clinicDate
                    ? ` - clinic ${formatCalendarDate(clinicDate, { month: "long", day: "numeric" })}`
                    : ""}
                </p>
              </div>

              {!clinicDate && (
                <Alert tone="warning">
                  No upcoming clinic date in the active term, so there is nothing to build.
                </Alert>
              )}

              {preset.existingChat ? (
                <div className="space-y-2">
                  <Alert tone="success">Created for this clinic date.</Alert>
                  <a
                    className={buttonClasses("secondary", "md")}
                    href={preset.existingChat.webUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open in Teams
                  </a>
                </div>
              ) : (
                clinicDate && (
                  <Link
                    className={buttonClasses("primary", "md")}
                    href={`/schedule/triage-chats/${preset.id}/new`}
                  >
                    Review and create
                  </Link>
                )
              )}

              <div>
                <Link
                  className="text-sm underline"
                  href={`/schedule/triage-chats/${preset.id}/edit`}
                >
                  Edit preset
                </Link>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Write the preset form**

Create `src/app/(app)/schedule/triage-chats/preset-form.tsx`:

```tsx
"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Input, Textarea } from "@/platform/ui/input";
import { Checkbox } from "@/platform/ui/checkbox";
import { Alert } from "@/platform/ui/alert";
import { SubmitButton } from "@/platform/ui/submit-button";
import { runAction } from "@/platform/ui/run-action";
import { savePresetAction } from "./actions";

export type PresetFormProps = {
  presetId: string | null;
  initial: {
    name: string;
    nameTemplate: string;
    messageTemplate: string;
    departmentIds: string[];
  };
  departments: { id: string; code: string; name: string }[];
};

export function PresetForm({ presetId, initial, departments }: PresetFormProps) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const selected = new Set(initial.departmentIds);

  async function onSubmit(formData: FormData) {
    // runAction turns a REJECTED action into { error } too. Without it a Prisma
    // failure inside the transition is an unhandled rejection: no Alert renders,
    // the pending flag flips back, and the form looks like it saved.
    const result = await runAction(() => savePresetAction(presetId, formData));
    if (result.error) {
      setError(result.error);
      return;
    }
    setError(null);
    startTransition(() => router.push("/schedule/triage-chats"));
  }

  return (
    <form action={onSubmit} className="space-y-5">
      {error && <Alert tone="error">{error}</Alert>}

      <label className="block space-y-1">
        <span className="text-sm font-medium">Preset name</span>
        <Input name="name" defaultValue={initial.name} required placeholder="Ancillary" />
      </label>

      <label className="block space-y-1">
        <span className="text-sm font-medium">Chat name pattern</span>
        <Input
          name="nameTemplate"
          defaultValue={initial.nameTemplate}
          required
          placeholder="{{clinicDateShort}} Ancillary Triage Chat"
        />
        <span className="text-xs text-muted-foreground">
          Available: {"{{clinicDateShort}}"} (05.30.26) and {"{{clinicDate}}"} (Saturday, May 30, 2026).
        </span>
      </label>

      <label className="block space-y-1">
        <span className="text-sm font-medium">Opening message</span>
        <Textarea name="messageTemplate" defaultValue={initial.messageTemplate} rows={14} required />
        <span className="text-xs text-muted-foreground">
          Available: {"{{clinicDate}}"}, {"{{sessionCoordinators}}"}, {"{{clinicalAdvisors}}"},
          {" "}{"{{rosterBlock}}"}, {"{{teamsChannelUrl}}"}. Plain text; you can edit it again before sending.
        </span>
      </label>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Departments</legend>
        <p className="text-xs text-muted-foreground">
          Each contributes its triage-tagged directors on shift. The leadership departments
          configured in Admin &gt; Settings are always included and do not need ticking here.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          {departments.map((dept) => (
            <label key={dept.id} className="flex items-center gap-2 text-sm">
              <Checkbox
                name="departmentIds"
                value={dept.id}
                defaultChecked={selected.has(dept.id)}
              />
              <span>
                {dept.code} - {dept.name}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <SubmitButton pendingLabel="Saving...">Save preset</SubmitButton>
    </form>
  );
}
```

- [ ] **Step 6: Write the two preset pages**

Create `src/app/(app)/schedule/triage-chats/new/page.tsx`:

```tsx
import { requirePermission } from "@/platform/auth/session";
import { prisma } from "@/platform/db";
import { DEFAULT_MESSAGE_TEMPLATE } from "@/modules/schedule/services/triage-chat-presets";
import { buildPageMetadata } from "@/platform/branding/metadata";
import { PageHeader } from "@/platform/ui/page-header";
import { PresetForm } from "../preset-form";

export function generateMetadata() {
  return buildPageMetadata({
    title: "New triage chat preset",
    description: "Configure a weekly Teams triage chat: its departments, name, and opening message.",
  });
}

export default async function NewTriageChatPresetPage() {
  await requirePermission("schedule.manage_triage_chats");
  const departments = await prisma.department.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
    select: { id: true, code: true, name: true },
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="New triage chat preset"
        description="One preset per weekly chat, for example Ancillary and Clinical."
      />
      <PresetForm
        presetId={null}
        initial={{
          name: "",
          nameTemplate: "{{clinicDateShort}} Triage Chat",
          messageTemplate: DEFAULT_MESSAGE_TEMPLATE,
          departmentIds: [],
        }}
        departments={departments}
      />
    </div>
  );
}
```

Create `src/app/(app)/schedule/triage-chats/[presetId]/edit/page.tsx`:

```tsx
import { notFound } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { prisma } from "@/platform/db";
import { buildPageMetadata } from "@/platform/branding/metadata";
import { PageHeader } from "@/platform/ui/page-header";
import { PresetForm } from "../../preset-form";

export function generateMetadata() {
  return buildPageMetadata({
    title: "Edit triage chat preset",
    description: "Change a weekly Teams triage chat's departments, name, or opening message.",
  });
}

export default async function EditTriageChatPresetPage({
  params,
}: {
  params: Promise<{ presetId: string }>;
}) {
  await requirePermission("schedule.manage_triage_chats");
  const { presetId } = await params;

  const [preset, departments] = await Promise.all([
    prisma.triageChatPreset.findUnique({
      where: { id: presetId },
      include: { departments: true },
    }),
    prisma.department.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, code: true, name: true },
    }),
  ]);
  if (!preset) notFound();

  return (
    <div className="space-y-6">
      <PageHeader title={`Edit ${preset.name}`} />
      <PresetForm
        presetId={preset.id}
        initial={{
          name: preset.name,
          nameTemplate: preset.nameTemplate,
          messageTemplate: preset.messageTemplate,
          departmentIds: preset.departments.map((d) => d.departmentId),
        }}
        departments={departments}
      />
    </div>
  );
}
```

Confirm the `params` shape against a neighbouring dynamic route before writing:
this project is on a Next version where `params` is a Promise, and
`src/app/(app)/schedule/specialties/[id]/page.tsx` is the reference.

- [ ] **Step 7: Typecheck and lint**

Run: `npm run typecheck && npx eslint src e2e`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/platform/modules/registry.ts "src/app/(app)/schedule/triage-chats"
git commit -m "feat(schedule): add the triage chats tab and preset management"
```

---

### Task 9: The review screen, the confirm action, and the e2e gate

**Files:**
- Create: `src/app/(app)/schedule/triage-chats/[presetId]/new/page.tsx`
- Create: `src/app/(app)/schedule/triage-chats/[presetId]/new/review-form.tsx`
- Modify: `src/app/(app)/schedule/triage-chats/actions.ts` (add the create action)
- Create: `src/app/(app)/schedule/triage-chats/[presetId]/created/page.tsx`
- Create: `e2e/triage-chats.spec.ts`
- Modify: `docs/` operator note (see step 6)

**Interfaces:**
- Consumes: `loadTriageChatDraft` (Task 5), `createTriageChat` (Task 6).
- Produces: the route `/schedule/triage-chats/[presetId]/new` and `createTriageChatAction`.

- [ ] **Step 1: Add the create action**

Append to `src/app/(app)/schedule/triage-chats/actions.ts`:

```ts
export async function createTriageChatAction(
  presetId: string,
  formData: FormData,
): Promise<ActionResult & { triageChatId?: string }> {
  const session = await requirePermission(PERMISSION);
  try {
    const result = await createTriageChat({
      presetId,
      actorPersonId: session.personId,
      topic: String(formData.get("topic") ?? ""),
      messageBody: String(formData.get("messageBody") ?? ""),
      includePersonIds: formData.getAll("includePersonIds").map(String),
    });
    revalidatePath("/schedule/triage-chats");
    return { triageChatId: result.triageChatId };
  } catch (err) {
    if (err instanceof TriageChatConflictError || err instanceof TriageChatNotConnectedError) {
      return { error: err.message };
    }
    // Graph errors carry the response body, which is the one thing that tells an
    // operator a missing scope from a rejected member. Surface it verbatim.
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
```

Add the matching imports at the top of the file:

```ts
import {
  createTriageChat,
  TriageChatConflictError,
  TriageChatNotConnectedError,
} from "@/modules/schedule/services/triage-chat-create";
```

- [ ] **Step 2: Write the review page**

Create `src/app/(app)/schedule/triage-chats/[presetId]/new/page.tsx`:

```tsx
import { notFound, redirect } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { mailConnectionStatus, teamsScopesGranted } from "@/platform/email/oauth";
import { prisma } from "@/platform/db";
import { loadTriageChatDraft } from "@/modules/schedule/services/triage-chat-draft";
import { buildPageMetadata } from "@/platform/branding/metadata";
import { PageHeader } from "@/platform/ui/page-header";
import { Alert } from "@/platform/ui/alert";
import { ReviewForm } from "./review-form";

export function generateMetadata() {
  return buildPageMetadata({
    title: "Create triage chat",
    description: "Review this week's roster and opening message before creating the Teams chat.",
  });
}

export default async function NewTriageChatPage({
  params,
}: {
  params: Promise<{ presetId: string }>;
}) {
  await requirePermission("schedule.manage_triage_chats");
  const { presetId } = await params;

  const draft = await loadTriageChatDraft(presetId);
  if (!draft) notFound();
  // Already created this week: send them to the record rather than offering a
  // Create button the unique constraint would reject.
  if (draft.existingChat) redirect(`/schedule/triage-chats/${presetId}/created`);

  // Check the connection up front. Finding out at the moment of creation, after
  // an ED has reviewed twenty names, is the worst time to learn the mailbox is
  // not connected.
  const status = await mailConnectionStatus();
  const credential = await prisma.mailCredential.findUnique({
    where: { id: "mailer" },
    select: { scope: true },
  });
  const scopesOk = teamsScopesGranted(credential?.scope ?? null);

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Create ${draft.preset.name} triage chat`}
        description="Everything below comes from this week's schedule. Edit anything before creating."
      />

      {!status.connected && (
        <Alert tone="error">
          No Microsoft account is connected. Connect the mailbox in Admin &gt; Email first.
        </Alert>
      )}
      {status.connected && !scopesOk && (
        <Alert tone="error">
          The connected account is missing the Teams chat permissions. Reconnect it in
          Admin &gt; Email to grant them.
        </Alert>
      )}

      <ReviewForm draft={draft} disabled={!status.connected || !scopesOk} />
    </div>
  );
}
```

Create `src/app/(app)/schedule/triage-chats/[presetId]/new/review-form.tsx`:

```tsx
"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Input, Textarea } from "@/platform/ui/input";
import { Checkbox } from "@/platform/ui/checkbox";
import { Alert } from "@/platform/ui/alert";
import { SubmitButton } from "@/platform/ui/submit-button";
import { runAction } from "@/platform/ui/run-action";
import type { TriageChatDraft } from "@/modules/schedule/services/triage-chat-draft";
import { createTriageChatAction } from "../../actions";

export function ReviewForm({
  draft,
  disabled,
}: {
  draft: TriageChatDraft;
  disabled: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // Group for display by the same department name the roster block uses, so the
  // list on screen and the list in the message read the same way.
  const groups = new Map<string, typeof draft.resolved>();
  for (const entry of draft.resolved) {
    const key = entry.member.departmentName;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }

  async function onSubmit(formData: FormData) {
    const result = await runAction(() => createTriageChatAction(draft.preset.id, formData));
    if (result.error) {
      setError(result.error);
      return;
    }
    setError(null);
    startTransition(() =>
      router.push(`/schedule/triage-chats/${draft.preset.id}/created`),
    );
  }

  return (
    <form action={onSubmit} className="space-y-5">
      {error && <Alert tone="error">{error}</Alert>}
      {draft.warnings.map((warning) => (
        <Alert key={warning} tone="warning">
          {warning}
        </Alert>
      ))}

      <label className="block space-y-1">
        <span className="text-sm font-medium">Chat name</span>
        <Input name="topic" defaultValue={draft.topic} required />
      </label>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">
          Members ({draft.resolved.filter((r) => r.userId).length} can be added)
        </legend>
        {[...groups.entries()].map(([department, entries]) => (
          <div key={department} className="space-y-1">
            <p className="text-sm font-semibold">{department}</p>
            {entries.map((entry) => {
              const unresolved = !entry.userId;
              return (
                <label
                  key={entry.member.personId}
                  className="flex items-start gap-2 text-sm"
                >
                  <Checkbox
                    name="includePersonIds"
                    value={entry.member.personId}
                    defaultChecked={!unresolved}
                    disabled={unresolved}
                  />
                  <span>
                    {entry.member.name}
                    {unresolved && (
                      <span className="block text-xs text-muted-foreground">
                        Cannot be added automatically: {entry.reason}
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
          </div>
        ))}
      </fieldset>

      <label className="block space-y-1">
        <span className="text-sm font-medium">Opening message</span>
        <Textarea name="messageBody" defaultValue={draft.messageBody} rows={16} required />
      </label>

      <SubmitButton pendingLabel="Creating..." disabled={disabled}>
        Create chat and post message
      </SubmitButton>
    </form>
  );
}
```

- [ ] **Step 3: Write the confirmation page**

Create `src/app/(app)/schedule/triage-chats/[presetId]/created/page.tsx`:

```tsx
import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { prisma } from "@/platform/db";
import { buildPageMetadata } from "@/platform/branding/metadata";
import { PageHeader } from "@/platform/ui/page-header";
import { Alert } from "@/platform/ui/alert";
import { buttonClasses } from "@/platform/ui/button";
import { retryMessageAction } from "../../actions";
import { SubmitButton } from "@/platform/ui/submit-button";

export function generateMetadata() {
  return buildPageMetadata({
    title: "Triage chat created",
    description: "The weekly Teams triage chat, who was added, and who still needs adding by hand.",
  });
}

export default async function TriageChatCreatedPage({
  params,
}: {
  params: Promise<{ presetId: string }>;
}) {
  await requirePermission("schedule.manage_triage_chats");
  const { presetId } = await params;

  const chat = await prisma.triageChat.findFirst({
    where: { presetId },
    orderBy: { createdAt: "desc" },
    include: { members: { orderBy: [{ departmentName: "asc" }, { personName: "asc" }] } },
  });
  if (!chat) notFound();

  const added = chat.members.filter((m) => m.addedOk);
  const failed = chat.members.filter((m) => !m.addedOk);

  return (
    <div className="space-y-6">
      <PageHeader title={chat.topic} description={`${added.length} people added.`} />

      <a
        className={buttonClasses("primary", "md")}
        href={chat.webUrl}
        target="_blank"
        rel="noreferrer"
      >
        Open in Teams
      </a>

      {chat.messagePostedAt === null && (
        <Alert tone="warning">
          <div className="space-y-2">
            <p>The chat was created but the opening message was not posted.</p>
            <form action={retryMessageAction.bind(null, chat.id)}>
              <SubmitButton pendingLabel="Posting...">Post the message</SubmitButton>
            </form>
          </div>
        </Alert>
      )}

      {failed.length > 0 && (
        <Alert tone="warning">
          <div className="space-y-1">
            <p>
              {failed.length} {failed.length === 1 ? "person" : "people"} could not be added.
              Add them by hand in Teams:
            </p>
            <p className="select-all font-medium">
              {failed.map((m) => m.personName).join(", ")}
            </p>
          </div>
        </Alert>
      )}

      <ul className="space-y-1 text-sm">
        {added.map((m) => (
          <li key={m.id}>
            {m.personName} <span className="text-muted-foreground">({m.departmentName})</span>
          </li>
        ))}
      </ul>

      <Link className="text-sm underline" href="/schedule/triage-chats">
        Back to triage chats
      </Link>
    </div>
  );
}
```

Add the retry action to `actions.ts`:

```ts
export async function retryMessageAction(triageChatId: string): Promise<ActionResult> {
  await requirePermission(PERMISSION);
  const chat = await prisma.triageChat.findUnique({
    where: { id: triageChatId },
    select: { presetId: true },
  });
  if (!chat) return { error: "That chat no longer exists." };
  // Re-render the message from the preset rather than trusting a form field:
  // this action takes no body, so there is nothing a client could tamper with.
  const draft = await loadTriageChatDraft(chat.presetId);
  if (!draft) return { error: "There is no clinic date to rebuild the message from." };
  try {
    await retryTriageChatMessage(triageChatId, draft.messageBody);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  revalidatePath(`/schedule/triage-chats/${chat.presetId}/created`);
  return {};
}
```

with the imports it needs at the top of `actions.ts`:

```ts
import { prisma } from "@/platform/db";
import { loadTriageChatDraft } from "@/modules/schedule/services/triage-chat-draft";
import { retryTriageChatMessage } from "@/modules/schedule/services/triage-chat-create";
```

- [ ] **Step 4: Write the e2e gate test**

Create `e2e/triage-chats.spec.ts`. `loginAs` and the seeded identities come from
`e2e/auth.ts`: `admin` is a Platform Admin holding `*` (so it reaches the new
permission through the wildcard), and `volunteer` holds only `schedule.view` and
`learning.access`.

```ts
import { expect, test } from "@playwright/test";
import { loginAs } from "./auth";

test.describe("triage chats tab", () => {
  test("is hidden from a schedule viewer without the permission", async ({ page }) => {
    await loginAs(page, "volunteer");
    await page.goto("/schedule");
    // Exact name match: "Triage chats" must not be satisfied by some other
    // control whose label merely contains the word.
    await expect(page.getByRole("link", { name: /^Triage chats$/ })).toHaveCount(0);

    await page.goto("/schedule/triage-chats");
    await expect(page).toHaveURL(/\/no-access/);
  });

  test("is reachable by a permission holder", async ({ page }) => {
    await loginAs(page, "admin");
    await page.goto("/schedule");
    await expect(page.getByRole("link", { name: /^Triage chats$/ })).toBeVisible();

    await page.goto("/schedule/triage-chats");
    await expect(page.getByRole("heading", { name: /^Triage chats$/ })).toBeVisible();
  });
});
```

Anchor every text match with an exact regex rather than a substring: a previous
spec matched "OPEN" against the word "Opens" and flaked for weeks.

- [ ] **Step 5: Run the full local verification**

```bash
npm run typecheck
npx eslint src e2e
npx vitest run src/modules/schedule src/platform/teams src/platform/settings src/platform/modules src/platform/rbac
npx vitest run src/platform
```

Expected: all pass. Read the pass/fail counts; do not pipe through `tail`.

- [ ] **Step 6: Document the reconnect requirement**

Add a short note to the operator docs (follow whatever file `docs/` already uses
for Admin > Email; grep for `teamsScopesGranted` or "reconnect" to find it):
the Teams scopes grew by `Chat.ReadWrite` and `User.ReadBasic.All`, so the
service account must be reconnected once in Admin > Email before triage chats
can be created, and `/admin/email` will prompt for it.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(app)/schedule/triage-chats" e2e/triage-chats.spec.ts docs
git commit -m "feat(schedule): review and create the weekly triage chat"
```

---

## Post-implementation checklist

- [ ] The service account has been reconnected in Admin > Email so the two new scopes are granted (`/admin/email` shows no reconnect prompt).
- [ ] Two presets exist in production: Ancillary and Clinical, with their department sets.
- [ ] `schedule.manage_triage_chats` has been granted to the Executive Director role.
- [ ] `triageChats.alwaysIncludeDepartmentCodes` reads `EXEC,PCAR,PATS` in Admin > Settings.
- [ ] One chat has been created against the real tenant and the confirmation screen listed zero unresolved members. If it listed several, the directory lookup is not matching Yale accounts on `netId@yale.edu`, and `candidates()` in `src/platform/teams/member-ids.ts` is the one place to change.
