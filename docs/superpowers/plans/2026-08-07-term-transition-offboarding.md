# Term Transition and Bulk Offboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give ops a term transition report that identifies who is not returning next term, lets them bulk flag and bulk offboard those people, and exports a CSV of emails for manual Teams removal.

**Architecture:** A new `transition.ts` service in the volunteers module derives three buckets (Returning, Pending, Not returning) from the active-term roster against the next PLANNING term, and its two bulk mutations loop the existing per-person `flagForOffboarding` and `executeOffboard` so no offboarding logic is duplicated. `/volunteers/offboarding` becomes a three-tab page. A pure CSV writer in the platform layer backs one export route serving two scopes.

**Tech Stack:** Next.js App Router (server components, server actions, route handlers), Prisma, PostgreSQL, Vitest against a real test database, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-07-term-transition-offboarding-design.md`

## Global Constraints

- **No em-dashes anywhere**, including code comments and docs. CI enforces `local/no-em-dash`.
- **No schema change.** This feature adds no Prisma models, columns, or migrations.
- **No `tailwind-merge`.** Use the local `cx` helper from `@/platform/ui/cx`.
- Tests run with `npx vitest run <path>`. The test database must be up: `npm run db:up && npm run test:prepare`.
- Full lint before any push is `npx eslint src e2e`, not `npm run lint` (the latter walks a gitignored design-system directory).
- Never read a piped test summary for pass/fail. Read the actual counts.
- Prisma `{ not: x }` filters exclude NULL rows. Not needed in this plan, but do not introduce one.
- Route handlers in this codebase return **401** for both unauthenticated and unauthorized, matching `src/app/api/support/epic/generate/route.ts` and `src/app/api/learning/upload-url/route.ts`. The spec says 403; follow the codebase.

---

### Task 1: Shared pure helpers (CSV writer and Yale address derivation)

Two small pure functions the rest of the feature builds on. Each gets its own test cycle and commit.

**Files:**
- Create: `src/platform/csv.ts`
- Create: `src/platform/csv.test.ts`
- Modify: `src/platform/auth/match-person.ts` (add `yaleEmailForNetId` after `netIdFromUpn`, around line 39)
- Modify: `src/platform/auth/match-person.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `toCsv(headers: string[], rows: string[][]): string`
  - `yaleEmailForNetId(netId: string): string`

- [ ] **Step 1: Write the failing CSV tests**

Create `src/platform/csv.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { toCsv } from "./csv";

describe("toCsv", () => {
  it("joins plain fields without quoting", () => {
    expect(toCsv(["a", "b"], [["1", "2"]])).toBe("a,b\r\n1,2");
  });

  it("quotes a field containing a comma", () => {
    expect(toCsv(["name"], [["O'Brien, Jr."]])).toBe('name\r\n"O\'Brien, Jr."');
  });

  it("doubles and quotes an embedded double quote", () => {
    expect(toCsv(["name"], [['He said "hi"']])).toBe('name\r\n"He said ""hi"""');
  });

  it("quotes a field containing a newline", () => {
    expect(toCsv(["note"], [["line one\nline two"]])).toBe('note\r\n"line one\nline two"');
  });

  it("quotes a field containing a carriage return", () => {
    expect(toCsv(["note"], [["a\rb"]])).toBe('note\r\n"a\rb"');
  });

  it("returns headers only for an empty row list", () => {
    expect(toCsv(["a", "b"], [])).toBe("a,b");
  });

  it("emits an empty field for a blank value rather than dropping the column", () => {
    expect(toCsv(["name", "email"], [["Jane", ""]])).toBe("name,email\r\nJane,");
  });
});
```

- [ ] **Step 2: Run the CSV tests to verify they fail**

Run: `npx vitest run src/platform/csv.test.ts`
Expected: FAIL, cannot resolve `./csv`.

- [ ] **Step 3: Implement the CSV writer**

Create `src/platform/csv.ts`:

```ts
/**
 * Minimal RFC 4180 CSV writer.
 *
 * Pure formatting only, with no domain knowledge: callers build their own rows
 * and pass strings. Fields are quoted only when they have to be (they contain a
 * comma, a double quote, CR, or LF), and an internal double quote is doubled.
 * Rows are joined with CRLF, which is what RFC 4180 specifies and what Excel
 * expects.
 *
 * A blank value stays an empty field rather than being dropped, so every row
 * keeps the same column count as the header.
 */
export function toCsv(headers: string[], rows: string[][]): string {
  return [headers, ...rows]
    .map((row) => row.map(escapeField).join(","))
    .join("\r\n");
}

function escapeField(value: string): string {
  if (!/[",\r\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}
```

- [ ] **Step 4: Run the CSV tests to verify they pass**

Run: `npx vitest run src/platform/csv.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit the CSV writer**

```bash
git add src/platform/csv.ts src/platform/csv.test.ts
git commit -m "feat(platform): add an RFC 4180 CSV writer"
```

- [ ] **Step 6: Write the failing Yale-address test**

Append to `src/platform/auth/match-person.test.ts` (add `yaleEmailForNetId` to the existing import from `./match-person`):

```ts
describe("yaleEmailForNetId", () => {
  it("builds the Yale address from a NetID", () => {
    expect(yaleEmailForNetId("abc123")).toBe("abc123@yale.edu");
  });

  it("lowercases and trims so it round-trips against a stored emailLower", () => {
    expect(yaleEmailForNetId("  ABC123 ")).toBe("abc123@yale.edu");
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `npx vitest run src/platform/auth/match-person.test.ts -t yaleEmailForNetId`
Expected: FAIL, `yaleEmailForNetId is not a function`.

- [ ] **Step 8: Implement `yaleEmailForNetId`**

In `src/platform/auth/match-person.ts`, immediately after the `netIdFromUpn` function (which ends around line 39), add:

```ts
/**
 * The Yale address for a NetID, which is the account a Yale-managed service
 * (Teams, Entra) knows the person by.
 *
 * Lives here, next to netIdFromUpn, because this file already owns the
 * NetID-to-address relationship. The domain was previously hardcoded in
 * member-magic-link.ts and in the UPN parser above; do not add a fourth copy.
 *
 * Lowercased and trimmed so the result compares directly against stored
 * lowercase columns such as Applicant.emailLower.
 */
export function yaleEmailForNetId(netId: string): string {
  return `${netId.trim().toLowerCase()}@yale.edu`;
}
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `npx vitest run src/platform/auth/match-person.test.ts`
Expected: PASS, including the two new cases and every pre-existing case in the file.

- [ ] **Step 10: Commit**

```bash
git add src/platform/auth/match-person.ts src/platform/auth/match-person.test.ts
git commit -m "feat(auth): derive a Yale address from a NetID"
```

---

### Task 2: `transitionView`

The bucket computation. No mutations in this task.

**Files:**
- Create: `src/modules/volunteers/services/transition.ts`
- Create: `src/modules/volunteers/services/transition.test.ts`

**Interfaces:**
- Consumes: `yaleEmailForNetId` from Task 1.
- Produces:
  - `type TransitionBucket = "RETURNING" | "PENDING" | "NOT_RETURNING"`
  - `type TransitionRow` with fields `personId`, `name`, `netId`, `contactEmail`, `departments: { code: string; name: string }[]`, `role: "DIRECTOR" | "VOLUNTEER"`, `bucket`, `hasDraftApplication`, `flagged`, `selfWithdrew`, `selectable`
  - `type TransitionView = { activeTerm: TermRef | null; nextTerm: TermRef | null; rows: TransitionRow[] }` where `TermRef = { id: string; code: string; name: string }`
  - `transitionView(viewerPersonId: string): Promise<TransitionView>`

- [ ] **Step 1: Write the failing tests**

Create `src/modules/volunteers/services/transition.test.ts`:

```ts
/**
 * Tests for the term transition report.
 *
 * Bucket rules under test:
 *   RETURNING      - holds an ACTIVE membership in the next (PLANNING) term.
 *   PENDING        - no next-term membership, but a SUBMITTED application exists
 *                    in a cycle attached to the next term.
 *   NOT_RETURNING  - neither.
 *
 * The emailLower fallback case is the important one: an anonymous NEW applicant
 * has no Applicant.applicantPersonId, and misclassifying that person as
 * NOT_RETURNING would feed them into a default-checked bulk flag.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { transitionView } from "./transition";

async function createPerson(name: string, netId?: string, contactEmail?: string) {
  return prisma.person.create({ data: { name, netId, contactEmail } });
}

async function createTerm(
  status: "ACTIVE" | "ARCHIVED" | "PLANNING",
  code: string,
  startDate: string
) {
  return prisma.term.create({
    data: {
      code,
      name: `Term ${code}`,
      startDate: new Date(startDate),
      endDate: new Date(startDate),
      status,
    },
  });
}

async function createDepartment(code: string) {
  return prisma.department.upsert({
    where: { code },
    update: {},
    create: { code, name: `${code} Dept` },
  });
}

async function createMembership(
  personId: string,
  termId: string,
  departmentId: string,
  kind: "VOLUNTEER" | "DIRECTOR" = "VOLUNTEER",
  status: "ACTIVE" | "REMOVED" = "ACTIVE"
) {
  return prisma.termMembership.create({
    data: { personId, termId, departmentId, kind, status },
  });
}

async function grantPermission(personId: string, permission: string) {
  const role = await prisma.role.create({
    data: {
      name: `Role-${permission}-${personId}`,
      isSystem: false,
      grants: { create: [{ permission }] },
    },
  });
  await prisma.roleAssignment.create({ data: { roleId: role.id, personId, termId: null } });
}

/**
 * A cycle attached to `termId` with one application. `applicantPersonId` links
 * the applicant to a Person (the signed-in case); pass null to simulate an
 * anonymous applicant, which is what the emailLower fallback has to catch.
 */
async function createApplication(opts: {
  termId: string;
  email: string;
  applicantPersonId: string | null;
  status: "DRAFT" | "SUBMITTED";
  slug: string;
  /** RecruitmentCycle.createdById is required with a Restrict relation to Person. */
  createdById: string;
}) {
  const cycle = await prisma.recruitmentCycle.create({
    data: {
      track: "VOLUNTEER",
      termId: opts.termId,
      title: `Cycle ${opts.slug}`,
      publicSlug: opts.slug,
      departments: [],
      createdById: opts.createdById,
    },
  });
  const applicant = await prisma.applicant.create({
    data: {
      cycleId: cycle.id,
      applicantPersonId: opts.applicantPersonId,
      firstName: "A",
      lastName: "B",
      email: opts.email,
      emailLower: opts.email.toLowerCase(),
    },
  });
  return prisma.application.create({
    data: {
      cycleId: cycle.id,
      applicantId: applicant.id,
      answers: {},
      status: opts.status,
    },
  });
}

beforeEach(resetDb);

describe("transitionView", () => {
  it("returns nextTerm null and no rows when no term is in planning", async () => {
    const term = await createTerm("ACTIVE", "FA25", "2025-08-01");
    const dept = await createDepartment("ITCM");
    const viewer = await createPerson("Exec", "exec01");
    await grantPermission(viewer.id, "volunteers.manage_offboarding");
    const member = await createPerson("Member", "mem01");
    await createMembership(member.id, term.id, dept.id);

    const view = await transitionView(viewer.id);

    expect(view.activeTerm?.code).toBe("FA25");
    expect(view.nextTerm).toBeNull();
    expect(view.rows).toEqual([]);
  });

  it("buckets a person with a next-term membership as RETURNING", async () => {
    const active = await createTerm("ACTIVE", "FA25", "2025-08-01");
    const next = await createTerm("PLANNING", "SP26", "2026-01-01");
    const dept = await createDepartment("ITCM");
    const viewer = await createPerson("Exec", "exec01");
    await grantPermission(viewer.id, "volunteers.manage_offboarding");
    const member = await createPerson("Returner", "ret01");
    await createMembership(member.id, active.id, dept.id);
    await createMembership(member.id, next.id, dept.id);

    const view = await transitionView(viewer.id);

    const row = view.rows.find((r) => r.personId === member.id);
    expect(row?.bucket).toBe("RETURNING");
    expect(row?.selectable).toBe(false);
  });

  it("buckets a submitted application linked by applicantPersonId as PENDING", async () => {
    const active = await createTerm("ACTIVE", "FA25", "2025-08-01");
    const next = await createTerm("PLANNING", "SP26", "2026-01-01");
    const dept = await createDepartment("ITCM");
    const viewer = await createPerson("Exec", "exec01");
    await grantPermission(viewer.id, "volunteers.manage_offboarding");
    const member = await createPerson("Applicant", "app01", "app01@yale.edu");
    await createMembership(member.id, active.id, dept.id);
    await createApplication({
      termId: next.id,
      email: "app01@yale.edu",
      applicantPersonId: member.id,
      status: "SUBMITTED",
      slug: "linked",
      createdById: viewer.id,
    });

    const view = await transitionView(viewer.id);

    const row = view.rows.find((r) => r.personId === member.id);
    expect(row?.bucket).toBe("PENDING");
    expect(row?.selectable).toBe(true);
  });

  it("buckets a submitted application matched only by emailLower as PENDING", async () => {
    const active = await createTerm("ACTIVE", "FA25", "2025-08-01");
    const next = await createTerm("PLANNING", "SP26", "2026-01-01");
    const dept = await createDepartment("ITCM");
    const viewer = await createPerson("Exec", "exec01");
    await grantPermission(viewer.id, "volunteers.manage_offboarding");
    // netId drives the yaleEmailForNetId fallback; the applicant row carries no
    // applicantPersonId, which is the anonymous-NEW-applicant case.
    const member = await createPerson("Anon", "anon01");
    await createMembership(member.id, active.id, dept.id);
    await createApplication({
      termId: next.id,
      email: "Anon01@Yale.edu",
      applicantPersonId: null,
      status: "SUBMITTED",
      slug: "anon",
      createdById: viewer.id,
    });

    const view = await transitionView(viewer.id);

    const row = view.rows.find((r) => r.personId === member.id);
    expect(row?.bucket).toBe("PENDING");
  });

  it("buckets a draft application as NOT_RETURNING and sets the draft chip", async () => {
    const active = await createTerm("ACTIVE", "FA25", "2025-08-01");
    const next = await createTerm("PLANNING", "SP26", "2026-01-01");
    const dept = await createDepartment("ITCM");
    const viewer = await createPerson("Exec", "exec01");
    await grantPermission(viewer.id, "volunteers.manage_offboarding");
    const member = await createPerson("Drafter", "drf01", "drf01@yale.edu");
    await createMembership(member.id, active.id, dept.id);
    await createApplication({
      termId: next.id,
      email: "drf01@yale.edu",
      applicantPersonId: member.id,
      status: "DRAFT",
      slug: "draft",
      createdById: viewer.id,
    });

    const view = await transitionView(viewer.id);

    const row = view.rows.find((r) => r.personId === member.id);
    expect(row?.bucket).toBe("NOT_RETURNING");
    expect(row?.hasDraftApplication).toBe(true);
  });

  it("buckets a person with neither signal as NOT_RETURNING", async () => {
    const active = await createTerm("ACTIVE", "FA25", "2025-08-01");
    await createTerm("PLANNING", "SP26", "2026-01-01");
    const dept = await createDepartment("ITCM");
    const viewer = await createPerson("Exec", "exec01");
    await grantPermission(viewer.id, "volunteers.manage_offboarding");
    const member = await createPerson("Leaver", "lev01");
    await createMembership(member.id, active.id, dept.id, "DIRECTOR");

    const view = await transitionView(viewer.id);

    const row = view.rows.find((r) => r.personId === member.id);
    expect(row?.bucket).toBe("NOT_RETURNING");
    expect(row?.role).toBe("DIRECTOR");
    expect(row?.selectable).toBe(true);
    expect(row?.departments.map((d) => d.code)).toEqual(["ITCM"]);
  });

  it("marks an existing flag, and a self-raised flag as selfWithdrew", async () => {
    const active = await createTerm("ACTIVE", "FA25", "2025-08-01");
    await createTerm("PLANNING", "SP26", "2026-01-01");
    const dept = await createDepartment("ITCM");
    const viewer = await createPerson("Exec", "exec01");
    await grantPermission(viewer.id, "volunteers.manage_offboarding");
    const selfFlagged = await createPerson("Self", "self01");
    const otherFlagged = await createPerson("Other", "oth01");
    await createMembership(selfFlagged.id, active.id, dept.id);
    await createMembership(otherFlagged.id, active.id, dept.id);
    await prisma.offboardFlag.create({
      data: { personId: selfFlagged.id, termId: active.id, flaggedById: selfFlagged.id },
    });
    await prisma.offboardFlag.create({
      data: { personId: otherFlagged.id, termId: active.id, flaggedById: viewer.id },
    });

    const view = await transitionView(viewer.id);

    const selfRow = view.rows.find((r) => r.personId === selfFlagged.id);
    const otherRow = view.rows.find((r) => r.personId === otherFlagged.id);
    expect(selfRow?.flagged).toBe(true);
    expect(selfRow?.selfWithdrew).toBe(true);
    expect(otherRow?.flagged).toBe(true);
    expect(otherRow?.selfWithdrew).toBe(false);
  });

  it("scopes a director to their own departments", async () => {
    const active = await createTerm("ACTIVE", "FA25", "2025-08-01");
    await createTerm("PLANNING", "SP26", "2026-01-01");
    const mine = await createDepartment("ITCM");
    const theirs = await createDepartment("SRR");
    const director = await createPerson("Dir", "dir01");
    await createMembership(director.id, active.id, mine.id, "DIRECTOR");
    const inScope = await createPerson("Mine", "min01");
    const outOfScope = await createPerson("Theirs", "the01");
    await createMembership(inScope.id, active.id, mine.id);
    await createMembership(outOfScope.id, active.id, theirs.id);

    const view = await transitionView(director.id);

    const ids = view.rows.map((r) => r.personId);
    expect(ids).toContain(inScope.id);
    expect(ids).not.toContain(outOfScope.id);
  });

  it("shows clinic-wide rows to a manage_offboarding holder with no directorship", async () => {
    const active = await createTerm("ACTIVE", "FA25", "2025-08-01");
    await createTerm("PLANNING", "SP26", "2026-01-01");
    const dept = await createDepartment("SRR");
    const viewer = await createPerson("Exec", "exec01");
    await grantPermission(viewer.id, "volunteers.manage_offboarding");
    const member = await createPerson("Somebody", "som01");
    await createMembership(member.id, active.id, dept.id);

    const view = await transitionView(viewer.id);

    expect(view.rows.map((r) => r.personId)).toContain(member.id);
  });

  it("returns no rows for a viewer with neither the permission nor a directorship", async () => {
    const active = await createTerm("ACTIVE", "FA25", "2025-08-01");
    await createTerm("PLANNING", "SP26", "2026-01-01");
    const dept = await createDepartment("SRR");
    const viewer = await createPerson("Nobody", "nob01");
    const member = await createPerson("Somebody", "som01");
    await createMembership(viewer.id, active.id, dept.id);
    await createMembership(member.id, active.id, dept.id);

    const view = await transitionView(viewer.id);

    expect(view.rows).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/modules/volunteers/services/transition.test.ts`
Expected: FAIL, cannot resolve `./transition`.

- [ ] **Step 3: Implement `transitionView`**

Create `src/modules/volunteers/services/transition.ts`:

```ts
/**
 * Term transition report: who on the current roster is coming back next term.
 *
 * Derived live, with no stored state and no schema of its own. The inputs are
 * the ACTIVE term's roster, the next PLANNING term's roster, and the
 * applications attached to that next term's recruitment cycles.
 *
 * This module deliberately sits beside offboarding.ts rather than inside it.
 * offboarding.ts answers "flag and execute one person"; this answers "who is
 * going where next term". Keeping them apart also means a director opening the
 * Flagged tab does not pay for this roll-up.
 *
 * Read-only. The bulk mutations live in transition-actions.ts and loop the
 * per-person functions in offboarding.ts.
 */

import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { manageableDepartmentIds } from "@/platform/departments";
import { getActiveTerm } from "@/platform/terms/active-term";
import { getNextTerm } from "@/platform/terms/next-term";
import { yaleEmailForNetId } from "@/platform/auth/match-person";

export type TransitionBucket = "RETURNING" | "PENDING" | "NOT_RETURNING";

export type TermRef = { id: string; code: string; name: string };

export type TransitionRow = {
  personId: string;
  name: string;
  netId: string | null;
  contactEmail: string | null;
  /** ACTIVE memberships in the CURRENT term, for display and for the CSV. */
  departments: { code: string; name: string }[];
  /** DIRECTOR when any current membership is a directorship. */
  role: "DIRECTOR" | "VOLUNTEER";
  bucket: TransitionBucket;
  /** A DRAFT application exists for the next term. Does not change the bucket. */
  hasDraftApplication: boolean;
  /** An OffboardFlag already exists for this person in the current term. */
  flagged: boolean;
  /** That flag was raised by the person themselves (self-withdrawal). */
  selfWithdrew: boolean;
  /** False for RETURNING rows, which this tab must not sweep into a bulk action. */
  selectable: boolean;
};

export type TransitionView = {
  activeTerm: TermRef | null;
  nextTerm: TermRef | null;
  rows: TransitionRow[];
};

function termRef(term: { id: string; code: string; name: string }): TermRef {
  return { id: term.id, code: term.code, name: term.name };
}

export async function transitionView(viewerPersonId: string): Promise<TransitionView> {
  const activeTerm = await getActiveTerm();
  if (!activeTerm) return { activeTerm: null, nextTerm: null, rows: [] };

  const nextTerm = await getNextTerm();
  if (!nextTerm) return { activeTerm: termRef(activeTerm), nextTerm: null, rows: [] };

  // Same visibility split offboardingView already applies: the permission sees
  // clinic-wide, a director sees their own departments plus one-hop delegations.
  const isExecutor = await can(viewerPersonId, "volunteers.manage_offboarding");
  let departmentScope: string[] | null = null;
  if (!isExecutor) {
    departmentScope = await manageableDepartmentIds(viewerPersonId);
    if (departmentScope.length === 0) {
      return { activeTerm: termRef(activeTerm), nextTerm: termRef(nextTerm), rows: [] };
    }
  }

  const memberships = await prisma.termMembership.findMany({
    where: {
      termId: activeTerm.id,
      status: "ACTIVE",
      ...(departmentScope ? { departmentId: { in: departmentScope } } : {}),
    },
    include: {
      person: { select: { id: true, name: true, netId: true, contactEmail: true } },
      department: { select: { code: true, name: true } },
    },
  });

  const personIds = [...new Set(memberships.map((m) => m.personId))];
  if (personIds.length === 0) {
    return { activeTerm: termRef(activeTerm), nextTerm: termRef(nextTerm), rows: [] };
  }

  // Every lowercase address that could identify one of these people in an
  // Applicant row, mapped back to the person. Both the stored contact address
  // and the derived Yale address, because an anonymous applicant is matched by
  // whichever one they typed.
  const personByEmail = new Map<string, string>();
  const rosterEmails: string[] = [];
  for (const m of memberships) {
    const candidates = [
      m.person.contactEmail?.trim().toLowerCase(),
      m.person.netId ? yaleEmailForNetId(m.person.netId) : null,
    ];
    for (const email of candidates) {
      if (!email || personByEmail.has(email)) continue;
      personByEmail.set(email, m.personId);
      rosterEmails.push(email);
    }
  }

  const [nextMemberships, applications, flags] = await Promise.all([
    prisma.termMembership.findMany({
      where: { personId: { in: personIds }, termId: nextTerm.id, status: "ACTIVE" },
      select: { personId: true },
    }),
    // Bounded by the roster, not by cycle size: a cycle can carry 700
    // applications, and only the ones naming a current member matter here.
    prisma.application.findMany({
      where: {
        cycle: { termId: nextTerm.id },
        OR: [
          { applicant: { applicantPersonId: { in: personIds } } },
          ...(rosterEmails.length > 0
            ? [{ applicant: { emailLower: { in: rosterEmails } } }]
            : []),
        ],
      },
      select: {
        status: true,
        applicant: { select: { applicantPersonId: true, emailLower: true } },
      },
    }),
    prisma.offboardFlag.findMany({
      where: { personId: { in: personIds }, termId: activeTerm.id },
      select: { personId: true, flaggedById: true },
    }),
  ]);

  const returningIds = new Set(nextMemberships.map((m) => m.personId));

  const submittedIds = new Set<string>();
  const draftIds = new Set<string>();
  for (const app of applications) {
    // applicantPersonId is the clean link and is always set for RENEWAL and
    // TRANSFER (both gate on being signed in). emailLower is the fallback for an
    // anonymous NEW applicant, whose misclassification as NOT_RETURNING would
    // feed a default-checked bulk flag.
    const personId =
      app.applicant.applicantPersonId ?? personByEmail.get(app.applicant.emailLower) ?? null;
    if (!personId) continue;
    if (app.status === "SUBMITTED") submittedIds.add(personId);
    else draftIds.add(personId);
  }

  const flagByPersonId = new Map(flags.map((f) => [f.personId, f]));

  const byPerson = new Map<string, typeof memberships>();
  for (const m of memberships) {
    const list = byPerson.get(m.personId) ?? [];
    list.push(m);
    byPerson.set(m.personId, list);
  }

  const rows: TransitionRow[] = [];
  for (const personId of personIds) {
    const personMemberships = byPerson.get(personId) ?? [];
    if (personMemberships.length === 0) continue;
    const person = personMemberships[0].person;
    const flag = flagByPersonId.get(personId) ?? null;

    const bucket: TransitionBucket = returningIds.has(personId)
      ? "RETURNING"
      : submittedIds.has(personId)
        ? "PENDING"
        : "NOT_RETURNING";

    rows.push({
      personId,
      name: person.name,
      netId: person.netId,
      contactEmail: person.contactEmail,
      departments: [
        ...new Map(
          personMemberships.map((m) => [m.department.code, m.department])
        ).values(),
      ].sort((a, b) => a.code.localeCompare(b.code)),
      role: personMemberships.some((m) => m.kind === "DIRECTOR") ? "DIRECTOR" : "VOLUNTEER",
      bucket,
      hasDraftApplication: draftIds.has(personId),
      flagged: flag !== null,
      selfWithdrew: flag?.flaggedById === personId,
      selectable: bucket !== "RETURNING",
    });
  }

  rows.sort((a, b) => a.name.localeCompare(b.name));

  return { activeTerm: termRef(activeTerm), nextTerm: termRef(nextTerm), rows };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/modules/volunteers/services/transition.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/modules/volunteers/services/transition.ts src/modules/volunteers/services/transition.test.ts
git commit -m "feat(volunteers): derive a term transition report from the roster and next term"
```

---

### Task 3: Bulk flag and bulk offboard

**Files:**
- Create: `src/modules/volunteers/transition-limits.ts`
- Create: `src/modules/volunteers/services/transition-actions.ts`
- Create: `src/modules/volunteers/services/transition-actions.test.ts`

**Interfaces:**
- Consumes: `flagForOffboarding`, `executeOffboard`, `OffboardForbiddenError` from `./offboarding`; `LastAdminError` from `@/platform/rbac/last-admin`; `PersonNotFoundError` from `@/platform/people`.
- Produces:
  - `const MAX_BULK_OFFBOARD = 25` **from `src/modules/volunteers/transition-limits.ts`**, which imports nothing. The client tabs need this number and must not reach into `transition-actions.ts`, which pulls Prisma into the bundle. Client components import the constant from `transition-limits`; server code may import from either, but this plan has it import from `transition-limits` too so there is one path.
  - `class TransitionBatchTooLargeError extends Error` with `readonly max: number`
  - `type BulkOutcome = { personId: string; name: string }`
  - `type BulkSkip = BulkOutcome & { reason: string }`
  - `type BulkResult = { succeeded: BulkOutcome[]; skipped: BulkSkip[] }`
  - `bulkFlag(actorPersonId: string, personIds: string[], note?: string): Promise<BulkResult>`
  - `bulkExecuteOffboard(actorPersonId: string, personIds: string[]): Promise<BulkResult>`

- [ ] **Step 1: Write the failing tests**

Create `src/modules/volunteers/services/transition-actions.test.ts`:

```ts
/**
 * Tests for the bulk transition mutations.
 *
 * Both loop the per-person functions in offboarding.ts, so what is under test
 * here is the loop's behavior, not the offboard itself: failure isolation, the
 * batch cap, and the summary audit row.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { bulkFlag, bulkExecuteOffboard, TransitionBatchTooLargeError } from "./transition-actions";
import { MAX_BULK_OFFBOARD } from "../transition-limits";

async function createPerson(name: string, netId?: string) {
  return prisma.person.create({ data: { name, netId } });
}

async function createTerm(status: "ACTIVE" | "PLANNING" = "ACTIVE", code = "FA25") {
  return prisma.term.create({
    data: {
      code,
      name: `Term ${code}`,
      startDate: new Date("2025-08-01"),
      endDate: new Date("2025-12-20"),
      status,
    },
  });
}

async function createDepartment(code: string) {
  return prisma.department.upsert({
    where: { code },
    update: {},
    create: { code, name: `${code} Dept` },
  });
}

async function createMembership(
  personId: string,
  termId: string,
  departmentId: string,
  kind: "VOLUNTEER" | "DIRECTOR" = "VOLUNTEER"
) {
  return prisma.termMembership.create({
    data: { personId, termId, departmentId, kind, status: "ACTIVE" },
  });
}

async function grantPermission(personId: string, permission: string) {
  const role = await prisma.role.create({
    data: {
      name: `Role-${permission}-${personId}`,
      isSystem: false,
      grants: { create: [{ permission }] },
    },
  });
  await prisma.roleAssignment.create({ data: { roleId: role.id, personId, termId: null } });
}

beforeEach(resetDb);

describe("bulkFlag", () => {
  it("flags every person and writes one summary audit row", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const actor = await createPerson("Exec", "exec01");
    await grantPermission(actor.id, "volunteers.manage_offboarding");
    const a = await createPerson("A", "aaa01");
    const b = await createPerson("B", "bbb01");
    await createMembership(a.id, term.id, dept.id);
    await createMembership(b.id, term.id, dept.id);

    const result = await bulkFlag(actor.id, [a.id, b.id], "Did not renew");

    expect(result.succeeded.map((s) => s.personId).sort()).toEqual([a.id, b.id].sort());
    expect(result.skipped).toEqual([]);
    expect(await prisma.offboardFlag.count()).toBe(2);

    const summary = await prisma.auditLog.findFirst({
      where: { action: "offboard.bulk_flag" },
    });
    expect(summary).not.toBeNull();
    expect((summary?.after as Record<string, unknown>).flagged).toBe(2);
  });

  it("is a no-op on an already-flagged person and writes no second flag audit row", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const actor = await createPerson("Exec", "exec01");
    await grantPermission(actor.id, "volunteers.manage_offboarding");
    const target = await createPerson("Target", "tgt01");
    await createMembership(target.id, term.id, dept.id);

    await bulkFlag(actor.id, [target.id]);
    await bulkFlag(actor.id, [target.id]);

    expect(await prisma.offboardFlag.count()).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "offboard.flag" } })).toBe(1);
  });

  it("reports an out-of-scope person as skipped instead of throwing", async () => {
    const term = await createTerm();
    const mine = await createDepartment("ITCM");
    const theirs = await createDepartment("SRR");
    const director = await createPerson("Dir", "dir01");
    await createMembership(director.id, term.id, mine.id, "DIRECTOR");
    const inScope = await createPerson("Mine", "min01");
    const outOfScope = await createPerson("Theirs", "the01");
    await createMembership(inScope.id, term.id, mine.id);
    await createMembership(outOfScope.id, term.id, theirs.id);

    const result = await bulkFlag(director.id, [inScope.id, outOfScope.id]);

    expect(result.succeeded.map((s) => s.personId)).toEqual([inScope.id]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].personId).toBe(outOfScope.id);
    expect(result.skipped[0].name).toBe("Theirs");
    expect(result.skipped[0].reason).toMatch(/permission/i);
  });
});

describe("bulkExecuteOffboard", () => {
  it("offboards everyone selected and writes one summary audit row", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const actor = await createPerson("Exec", "exec01");
    await grantPermission(actor.id, "volunteers.manage_offboarding");
    const a = await createPerson("A", "aaa01");
    const b = await createPerson("B", "bbb01");
    await createMembership(a.id, term.id, dept.id);
    await createMembership(b.id, term.id, dept.id);

    const result = await bulkExecuteOffboard(actor.id, [a.id, b.id]);

    expect(result.succeeded).toHaveLength(2);
    expect(result.skipped).toEqual([]);
    expect(
      await prisma.person.count({ where: { id: { in: [a.id, b.id] }, status: "OFFBOARDED" } })
    ).toBe(2);
    expect(
      await prisma.termMembership.count({
        where: { personId: { in: [a.id, b.id] }, status: "REMOVED" },
      })
    ).toBe(2);

    const summary = await prisma.auditLog.findFirst({
      where: { action: "offboard.bulk_execute" },
    });
    expect((summary?.after as Record<string, unknown>).offboarded).toBe(2);
  });

  it("continues past a last-admin refusal and offboards the people after it", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const actor = await createPerson("Exec", "exec01");
    await grantPermission(actor.id, "volunteers.manage_offboarding");
    // The only admin.access holder. Offboarding them must be refused, because an
    // offboarded person can no longer authenticate.
    const lastAdmin = await createPerson("Last Admin", "adm01");
    await grantPermission(lastAdmin.id, "admin.access");
    const other = await createPerson("Other", "oth01");
    await createMembership(lastAdmin.id, term.id, dept.id);
    await createMembership(other.id, term.id, dept.id);

    const result = await bulkExecuteOffboard(actor.id, [lastAdmin.id, other.id]);

    expect(result.skipped.map((s) => s.personId)).toEqual([lastAdmin.id]);
    expect(result.succeeded.map((s) => s.personId)).toEqual([other.id]);
    const stillActive = await prisma.person.findUnique({ where: { id: lastAdmin.id } });
    expect(stillActive?.status).toBe("ACTIVE");
    const offboarded = await prisma.person.findUnique({ where: { id: other.id } });
    expect(offboarded?.status).toBe("OFFBOARDED");
  });

  it("throws without the manage_offboarding permission", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const actor = await createPerson("Nobody", "nob01");
    const target = await createPerson("Target", "tgt01");
    await createMembership(target.id, term.id, dept.id);

    await expect(bulkExecuteOffboard(actor.id, [target.id])).rejects.toThrow(
      /manage_offboarding/
    );
  });

  it("throws when the batch exceeds the cap", async () => {
    const actor = await createPerson("Exec", "exec01");
    await grantPermission(actor.id, "volunteers.manage_offboarding");
    const ids = Array.from({ length: MAX_BULK_OFFBOARD + 1 }, (_, i) => `person-${i}`);

    await expect(bulkExecuteOffboard(actor.id, ids)).rejects.toBeInstanceOf(
      TransitionBatchTooLargeError
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/modules/volunteers/services/transition-actions.test.ts`
Expected: FAIL, cannot resolve `./transition-actions`.

- [ ] **Step 3: Create the shared limits module**

Create `src/modules/volunteers/transition-limits.ts`:

```ts
/**
 * Limits shared by the bulk offboarding service and the client tabs that drive it.
 *
 * Deliberately its own module with NO imports. The tabs are "use client" and need
 * this number to disable their submit button, and importing it from
 * services/transition-actions.ts would drag Prisma and the audit writer into the
 * client bundle.
 */

/**
 * The largest batch bulkExecuteOffboard will accept.
 *
 * revokeWalletPasses runs an 8s vendor timeout per pass, outside the offboard
 * transaction. During a wallet outage a 38-person batch would spend past the
 * 300s function limit in that loop alone and lose its tail. 25 bounds the worst
 * case near 225s with headroom. The UI enforces the same number on selection, so
 * nothing is silently truncated.
 */
export const MAX_BULK_OFFBOARD = 25;
```

- [ ] **Step 4: Implement the bulk mutations**

Create `src/modules/volunteers/services/transition-actions.ts`:

```ts
/**
 * Bulk transition mutations.
 *
 * Both functions LOOP the per-person functions in offboarding.ts. They do not
 * reimplement any part of an offboard: the scope check, the last-admin guard,
 * the per-person audit rows, and the Epic, shift-request, credential, and wallet
 * side effects all come from that single-person path, so the bulk path cannot
 * drift from it.
 *
 * Failure is isolated per person. One refusal never blocks the rest of the
 * batch, and the successes stand. Repeat execution is safe: setPersonStatusField
 * gates the credential snapshot on a real ACTIVE to OFFBOARDED transition and
 * guards duplicate DEACTIVATE creation.
 *
 * Analytics deliberately live at the call site, not here, matching the
 * single-person page action which owns its own captureEvent.
 */

import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { can } from "@/platform/rbac/engine";
import { log, errorAttrs } from "@/platform/logging";
import { LastAdminError } from "@/platform/rbac/last-admin";
import { PersonNotFoundError } from "@/platform/people";
import { MAX_BULK_OFFBOARD } from "../transition-limits";
import { flagForOffboarding, executeOffboard, OffboardForbiddenError } from "./offboarding";

export class TransitionBatchTooLargeError extends Error {
  constructor(public readonly max: number = MAX_BULK_OFFBOARD) {
    super(`Select at most ${max} people to offboard at once.`);
    this.name = "TransitionBatchTooLargeError";
  }
}

export type BulkOutcome = { personId: string; name: string };
export type BulkSkip = BulkOutcome & { reason: string };
export type BulkResult = { succeeded: BulkOutcome[]; skipped: BulkSkip[] };

/** Names for the result rows, resolved up front so a deleted person still reports. */
async function nameMap(personIds: string[]): Promise<Map<string, string>> {
  const people = await prisma.person.findMany({
    where: { id: { in: personIds } },
    select: { id: true, name: true },
  });
  return new Map(people.map((p) => [p.id, p.name]));
}

function reasonFor(error: unknown, personId: string): string {
  if (error instanceof OffboardForbiddenError) return error.message;
  if (error instanceof LastAdminError) return error.message;
  if (error instanceof PersonNotFoundError) return "Person no longer exists.";
  log.error("[volunteers] bulk transition step failed", errorAttrs(error, { personId }));
  return "Unexpected error, see logs.";
}

export async function bulkFlag(
  actorPersonId: string,
  personIds: string[],
  note?: string
): Promise<BulkResult> {
  const names = await nameMap(personIds);
  const succeeded: BulkOutcome[] = [];
  const skipped: BulkSkip[] = [];

  for (const personId of personIds) {
    const name = names.get(personId) ?? "Unknown person";
    try {
      await flagForOffboarding(actorPersonId, personId, note);
      succeeded.push({ personId, name });
    } catch (error) {
      skipped.push({ personId, name, reason: reasonFor(error, personId) });
    }
  }

  // One summary row for the batch, alongside the per-person offboard.flag rows
  // flagForOffboarding already writes. Mirrors the roster.copy precedent.
  await recordAudit({
    actorPersonId,
    action: "offboard.bulk_flag",
    entityType: "Person",
    after: { requested: personIds.length, flagged: succeeded.length, skipped: skipped.length },
  });

  return { succeeded, skipped };
}

export async function bulkExecuteOffboard(
  actorPersonId: string,
  personIds: string[]
): Promise<BulkResult> {
  if (!(await can(actorPersonId, "volunteers.manage_offboarding"))) {
    throw new OffboardForbiddenError(
      "volunteers.manage_offboarding is required to execute offboarding."
    );
  }
  if (personIds.length > MAX_BULK_OFFBOARD) {
    throw new TransitionBatchTooLargeError();
  }

  const names = await nameMap(personIds);
  const succeeded: BulkOutcome[] = [];
  const skipped: BulkSkip[] = [];

  for (const personId of personIds) {
    const name = names.get(personId) ?? "Unknown person";
    try {
      await executeOffboard(actorPersonId, personId);
      succeeded.push({ personId, name });
    } catch (error) {
      skipped.push({ personId, name, reason: reasonFor(error, personId) });
    }
  }

  await recordAudit({
    actorPersonId,
    action: "offboard.bulk_execute",
    entityType: "Person",
    after: { requested: personIds.length, offboarded: succeeded.length, skipped: skipped.length },
  });

  return { succeeded, skipped };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/modules/volunteers/services/transition-actions.test.ts`
Expected: PASS, 7 tests.

If the last-admin test does not skip as expected, confirm the seeded `admin.access` holder is genuinely the only one by checking `peopleWithAnyPermission(["admin.access"])`; `resetDb` should leave no seeded admins, but a seeded fixture would invalidate the assertion.

- [ ] **Step 6: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/modules/volunteers/transition-limits.ts src/modules/volunteers/services/transition-actions.ts src/modules/volunteers/services/transition-actions.test.ts
git commit -m "feat(volunteers): add bulk flag and bulk offboard with per-person failure isolation"
```

---

### Task 4: CSV export service and route

**Files:**
- Create: `src/modules/volunteers/services/offboarding-export.ts`
- Create: `src/modules/volunteers/services/offboarding-export.test.ts`
- Create: `src/app/api/volunteers/offboarding/export/route.ts`
- Create: `src/app/api/volunteers/offboarding/export/route.test.ts`

**Interfaces:**
- Consumes: `toCsv` and `yaleEmailForNetId` from Task 1.
- Produces:
  - `type ExportRequest = { scope: "selection"; personIds: string[] } | { scope: "offboarded-term" }`
  - `buildOffboardingCsv(input: ExportRequest, now: Date): Promise<{ filename: string; csv: string; rowCount: number }>`
  - `POST /api/volunteers/offboarding/export`

- [ ] **Step 1: Write the failing service tests**

Create `src/modules/volunteers/services/offboarding-export.test.ts`:

```ts
/**
 * Tests for the offboarding CSV export.
 *
 * One row per person, never one per membership: the consumer is deduplicating a
 * Teams removal list. Email is netId@yale.edu when a netId exists, else the
 * contact address, else blank with the row still present.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { buildOffboardingCsv } from "./offboarding-export";

const NOW = new Date("2026-08-07T12:00:00Z");

async function createTerm(status: "ACTIVE" | "PLANNING" = "ACTIVE", code = "FA25") {
  return prisma.term.create({
    data: {
      code,
      name: `Term ${code}`,
      startDate: new Date("2025-08-01"),
      endDate: new Date("2025-12-20"),
      status,
    },
  });
}

async function createDepartment(code: string) {
  return prisma.department.upsert({
    where: { code },
    update: {},
    create: { code, name: `${code} Dept` },
  });
}

beforeEach(resetDb);

describe("buildOffboardingCsv", () => {
  it("exports the selection with a Yale address derived from the NetID", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const person = await prisma.person.create({
      data: { name: "Jane Doe", netId: "jd123", contactEmail: "jane@example.com" },
    });
    await prisma.termMembership.create({
      data: { personId: person.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" },
    });

    const result = await buildOffboardingCsv(
      { scope: "selection", personIds: [person.id] },
      NOW
    );

    expect(result.rowCount).toBe(1);
    expect(result.filename).toBe("haven-offboarding-FA25-2026-08-07.csv");
    const lines = result.csv.split("\r\n");
    expect(lines[0]).toBe("Name,Email,NetID,Contact email,Departments,Role");
    expect(lines[1]).toBe("Jane Doe,jd123@yale.edu,jd123,jane@example.com,ITCM,VOLUNTEER");
  });

  it("falls back to the contact address when there is no NetID, and exports a blank email when there is neither", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const withContact = await prisma.person.create({
      data: { name: "No NetId", contactEmail: "only@example.com" },
    });
    const withNeither = await prisma.person.create({ data: { name: "No Contact" } });
    for (const p of [withContact, withNeither]) {
      await prisma.termMembership.create({
        data: { personId: p.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" },
      });
    }

    const result = await buildOffboardingCsv(
      { scope: "selection", personIds: [withContact.id, withNeither.id] },
      NOW
    );

    expect(result.rowCount).toBe(2);
    expect(result.csv).toContain("No NetId,only@example.com,,only@example.com,ITCM,VOLUNTEER");
    expect(result.csv).toContain("No Contact,,,,ITCM,VOLUNTEER");
  });

  it("emits one row per person with departments joined and DIRECTOR winning the role", async () => {
    const term = await createTerm();
    const itcm = await createDepartment("ITCM");
    const srr = await createDepartment("SRR");
    const person = await prisma.person.create({ data: { name: "Two Hats", netId: "th01" } });
    await prisma.termMembership.create({
      data: { personId: person.id, termId: term.id, departmentId: itcm.id, kind: "VOLUNTEER", status: "ACTIVE" },
    });
    await prisma.termMembership.create({
      data: { personId: person.id, termId: term.id, departmentId: srr.id, kind: "DIRECTOR", status: "ACTIVE" },
    });

    const result = await buildOffboardingCsv(
      { scope: "selection", personIds: [person.id] },
      NOW
    );

    expect(result.rowCount).toBe(1);
    expect(result.csv).toContain('Two Hats,th01@yale.edu,th01,,"ITCM;SRR",DIRECTOR');
  });

  it("exports offboarded people who held a place in the active term for the offboarded-term scope", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const gone = await prisma.person.create({
      data: { name: "Gone", netId: "gon01", status: "OFFBOARDED" },
    });
    const stillHere = await prisma.person.create({ data: { name: "Here", netId: "her01" } });
    await prisma.termMembership.create({
      data: { personId: gone.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER", status: "REMOVED" },
    });
    await prisma.termMembership.create({
      data: { personId: stillHere.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" },
    });

    const result = await buildOffboardingCsv({ scope: "offboarded-term" }, NOW);

    expect(result.rowCount).toBe(1);
    expect(result.csv).toContain("Gone,gon01@yale.edu");
    expect(result.csv).not.toContain("Here");
  });

  it("returns a headers-only file and a no-term filename when there is no active term", async () => {
    const result = await buildOffboardingCsv({ scope: "offboarded-term" }, NOW);

    expect(result.rowCount).toBe(0);
    expect(result.filename).toBe("haven-offboarding-no-term-2026-08-07.csv");
    expect(result.csv).toBe("Name,Email,NetID,Contact email,Departments,Role");
  });
});
```

- [ ] **Step 2: Run the service tests to verify they fail**

Run: `npx vitest run src/modules/volunteers/services/offboarding-export.test.ts`
Expected: FAIL, cannot resolve `./offboarding-export`.

- [ ] **Step 3: Implement the export service**

Create `src/modules/volunteers/services/offboarding-export.ts`:

```ts
/**
 * CSV export of people to remove from Teams.
 *
 * The app holds no Graph permission to manage team or group membership (its
 * scopes are Mail.Send, Channel.ReadBasic.All, Chat.Create, ChatMessage.Send),
 * so removal is a manual task and this export is the hand-off.
 *
 * Two scopes share one row builder:
 *   selection       - exactly the people picked on the Transition tab, so the
 *                     list can be pulled before or after flagging.
 *   offboarded-term - everyone already OFFBOARDED who held a place in the active
 *                     term, which is the population whose Teams access should
 *                     already be gone.
 *
 * `now` is a parameter rather than a call to the clock so the filename is
 * deterministic in tests.
 *
 * Trusts its caller for permissions: the route gates on
 * volunteers.manage_offboarding.
 */

import { prisma } from "@/platform/db";
import { toCsv } from "@/platform/csv";
import { yaleEmailForNetId } from "@/platform/auth/match-person";
import { getActiveTerm } from "@/platform/terms/active-term";

export type ExportRequest =
  | { scope: "selection"; personIds: string[] }
  | { scope: "offboarded-term" };

const HEADERS = ["Name", "Email", "NetID", "Contact email", "Departments", "Role"];

type PersonRow = {
  id: string;
  name: string;
  netId: string | null;
  contactEmail: string | null;
  memberships: { kind: string; department: { code: string } }[];
};

/**
 * The address a Yale-managed service knows this person by. netId@yale.edu is the
 * Teams account; the stored contact address is the fallback. A person with
 * neither still gets a row with a blank email rather than vanishing from the
 * list, so whoever works it can see the gap.
 */
function accountEmail(person: { netId: string | null; contactEmail: string | null }): string {
  if (person.netId) return yaleEmailForNetId(person.netId);
  return person.contactEmail ?? "";
}

function buildRow(person: PersonRow): string[] {
  const codes = [...new Set(person.memberships.map((m) => m.department.code))].sort();
  const role = person.memberships.some((m) => m.kind === "DIRECTOR") ? "DIRECTOR" : "VOLUNTEER";
  return [
    person.name,
    accountEmail(person),
    person.netId ?? "",
    person.contactEmail ?? "",
    codes.join(";"),
    role,
  ];
}

export async function buildOffboardingCsv(
  input: ExportRequest,
  now: Date
): Promise<{ filename: string; csv: string; rowCount: number }> {
  const activeTerm = await getActiveTerm();

  let people: PersonRow[] = [];

  if (activeTerm) {
    const membershipFilter =
      input.scope === "selection"
        ? { termId: activeTerm.id, status: "ACTIVE" as const }
        : { termId: activeTerm.id, status: "REMOVED" as const };

    people = await prisma.person.findMany({
      where:
        input.scope === "selection"
          ? { id: { in: input.personIds } }
          : {
              status: "OFFBOARDED",
              memberships: { some: { termId: activeTerm.id, status: "REMOVED" } },
            },
      select: {
        id: true,
        name: true,
        netId: true,
        contactEmail: true,
        memberships: {
          where: membershipFilter,
          select: { kind: true, department: { select: { code: true } } },
        },
      },
      orderBy: { name: "asc" },
    });
  } else if (input.scope === "selection") {
    // No active term means no memberships to describe, but the selected people
    // are still real and still need removing, so export them with blank
    // department and a VOLUNTEER role rather than an empty file.
    people = await prisma.person.findMany({
      where: { id: { in: input.personIds } },
      select: {
        id: true,
        name: true,
        netId: true,
        contactEmail: true,
        memberships: { where: { id: "" }, select: { kind: true, department: { select: { code: true } } } },
      },
      orderBy: { name: "asc" },
    });
  }

  const rows = people.map(buildRow);
  const day = now.toISOString().slice(0, 10);

  return {
    filename: `haven-offboarding-${activeTerm?.code ?? "no-term"}-${day}.csv`,
    csv: toCsv(HEADERS, rows),
    rowCount: rows.length,
  };
}
```

- [ ] **Step 4: Run the service tests to verify they pass**

Run: `npx vitest run src/modules/volunteers/services/offboarding-export.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit the export service**

```bash
git add src/modules/volunteers/services/offboarding-export.ts src/modules/volunteers/services/offboarding-export.test.ts
git commit -m "feat(volunteers): build the offboarding removal-list CSV"
```

- [ ] **Step 6: Write the failing route tests**

Create `src/app/api/volunteers/offboarding/export/route.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";

// vi.mock factories are hoisted above ordinary top-level const declarations, so
// the mocks referenced inside them must come from vi.hoisted().
const { auth, getActivePerson, can, buildOffboardingCsv, recordAudit } = vi.hoisted(() => ({
  auth: vi.fn(),
  getActivePerson: vi.fn(),
  can: vi.fn(),
  buildOffboardingCsv: vi.fn(),
  recordAudit: vi.fn(),
}));

vi.mock("@/platform/auth/auth", () => ({ auth }));
vi.mock("@/platform/auth/match-person", () => ({ getActivePerson }));
vi.mock("@/platform/rbac/engine", () => ({ can }));
vi.mock("@/platform/audit", () => ({ recordAudit }));
vi.mock("@/modules/volunteers/services/offboarding-export", () => ({ buildOffboardingCsv }));

import { POST } from "./route";

function request(body: unknown): Request {
  return new Request("http://localhost/api/volunteers/offboarding/export", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  auth.mockReset().mockResolvedValue({ personId: "p1" });
  getActivePerson.mockReset().mockResolvedValue({ id: "p1" });
  can.mockReset().mockResolvedValue(true);
  recordAudit.mockReset().mockResolvedValue(undefined);
  buildOffboardingCsv.mockReset().mockResolvedValue({
    filename: "haven-offboarding-FA25-2026-08-07.csv",
    csv: "Name,Email\r\nJane,jane@yale.edu",
    rowCount: 1,
  });
});

describe("POST /api/volunteers/offboarding/export", () => {
  it("returns 401 without a session", async () => {
    auth.mockResolvedValue(null);
    const res = await POST(request({ scope: "offboarded-term" }));
    expect(res.status).toBe(401);
  });

  it("returns 401 without volunteers.manage_offboarding", async () => {
    can.mockResolvedValue(false);
    const res = await POST(request({ scope: "offboarded-term" }));
    expect(res.status).toBe(401);
    expect(can).toHaveBeenCalledWith("p1", "volunteers.manage_offboarding");
  });

  it("returns 400 for an unknown scope", async () => {
    const res = await POST(request({ scope: "everything" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for a selection with no person ids", async () => {
    const res = await POST(request({ scope: "selection", personIds: [] }));
    expect(res.status).toBe(400);
  });

  it("serves the CSV as an attachment for the offboarded-term scope", async () => {
    const res = await POST(request({ scope: "offboarded-term" }));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toContain(
      'filename="haven-offboarding-FA25-2026-08-07.csv"'
    );
    expect(await res.text()).toBe("Name,Email\r\nJane,jane@yale.edu");
    expect(buildOffboardingCsv).toHaveBeenCalledWith(
      { scope: "offboarded-term" },
      expect.any(Date)
    );
  });

  it("passes the selected ids through and audits the export", async () => {
    const res = await POST(request({ scope: "selection", personIds: ["a", "b"] }));

    expect(res.status).toBe(200);
    expect(buildOffboardingCsv).toHaveBeenCalledWith(
      { scope: "selection", personIds: ["a", "b"] },
      expect.any(Date)
    );
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorPersonId: "p1",
        action: "offboarding.export",
        after: { scope: "selection", rowCount: 1 },
      })
    );
  });
});
```

- [ ] **Step 7: Run the route tests to verify they fail**

Run: `npx vitest run src/app/api/volunteers/offboarding/export/route.test.ts`
Expected: FAIL, cannot resolve `./route`.

- [ ] **Step 8: Implement the route**

Create `src/app/api/volunteers/offboarding/export/route.ts`:

```ts
/**
 * POST /api/volunteers/offboarding/export
 *
 * Serves the removal-list CSV for the Transition tab (a selection) or the
 * Flagged tab (everyone offboarded this term). Member email addresses leave the
 * system here, so every call is audited.
 *
 * Auth: signed-in holder of volunteers.manage_offboarding. Returns 401 for both
 * unauthenticated and unauthorized, matching the other API routes in this
 * codebase; requirePermission is page-only because it redirects.
 */

import { NextResponse } from "next/server";
import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";
import { can } from "@/platform/rbac/engine";
import { recordAudit } from "@/platform/audit";
import { contentDisposition } from "@/platform/content-disposition";
import {
  buildOffboardingCsv,
  type ExportRequest,
} from "@/modules/volunteers/services/offboarding-export";

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.personId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const actor = await getActivePerson(session.personId);
  if (!actor || !(await can(actor.id, "volunteers.manage_offboarding"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json()) as { scope?: string; personIds?: string[] };

  let input: ExportRequest;
  if (body.scope === "offboarded-term") {
    input = { scope: "offboarded-term" };
  } else if (body.scope === "selection") {
    if (!body.personIds?.length) {
      return NextResponse.json({ error: "No people selected" }, { status: 400 });
    }
    input = { scope: "selection", personIds: body.personIds };
  } else {
    return NextResponse.json({ error: "Invalid scope" }, { status: 400 });
  }

  const { filename, csv, rowCount } = await buildOffboardingCsv(input, new Date());

  await recordAudit({
    actorPersonId: actor.id,
    action: "offboarding.export",
    entityType: "Person",
    after: { scope: input.scope, rowCount },
  });

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": contentDisposition(filename, { fallbackName: "offboarding.csv" }),
    },
  });
}
```

- [ ] **Step 9: Run the route tests to verify they pass**

Run: `npx vitest run src/app/api/volunteers/offboarding/export/route.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 10: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/app/api/volunteers/offboarding/export
git commit -m "feat(volunteers): serve the offboarding removal-list CSV over an audited route"
```

---

### Task 5: Split the offboarding page into tabs (no behavior change)

A pure refactor. The two existing sections move into components behind a tab row, and the existing Playwright spec is updated to match. No new feature surface in this task, so a reviewer can verify it changes nothing.

**Files:**
- Create: `src/modules/volunteers/components/department-tab.tsx`
- Create: `src/modules/volunteers/components/flagged-tab.tsx`
- Modify: `src/app/(app)/volunteers/offboarding/page.tsx` (rewrite the render; keep all three server actions)
- Modify: `e2e/volunteers.spec.ts` (the offboarding round-trip test, around lines 124 to 166)

**Interfaces:**
- Consumes: `offboardingView`, `DepartmentOffboarding`, `FlaggedRow` from `@/modules/volunteers/services/offboarding`; `transitionView` from Task 2 (only to decide the default tab).
- Produces:
  - `DepartmentTab({ departments, flagAction, unflagAction })`
  - `FlaggedTab({ flagged, unflagAction, executeOffboardAction })`

- [ ] **Step 1: Create the department tab component**

Create `src/modules/volunteers/components/department-tab.tsx`, moving the department-cards JSX out of the page verbatim:

```tsx
import { SectionHeader } from "@/platform/ui/section-header";
import { Badge } from "@/platform/ui/badge";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { Input } from "@/platform/ui/input";
import type { DepartmentOffboarding } from "@/modules/volunteers/services/offboarding";

/**
 * One card per department the viewer manages, listing that department's ACTIVE
 * members in the ACTIVE term with a Flag or Unflag control.
 *
 * Lifted out of page.tsx unchanged when the page became tabbed. Server
 * component: the actions arrive as props and bind to plain forms.
 */
export function DepartmentTab({
  departments,
  flagAction,
  unflagAction,
}: {
  departments: DepartmentOffboarding[];
  flagAction: (formData: FormData) => Promise<void>;
  unflagAction: (formData: FormData) => Promise<void>;
}) {
  if (departments.length === 0) {
    return (
      <div className="mt-12 flex flex-col items-center justify-center gap-3 text-center text-sm text-muted-foreground">
        <p>No departments to review.</p>
      </div>
    );
  }

  return (
    <div className="mt-8 flex flex-col gap-10">
      {departments.map(({ department, members }) => (
        <section key={department.id}>
          <SectionHeader level="title" className="mb-3">
            {department.code} · {department.name}
          </SectionHeader>

          <Table>
            <THead>
              <TR>
                <TH>Name</TH>
                <TH>Role</TH>
                <TH>Status</TH>
                <TH>Note</TH>
                <TH><span className="sr-only">Actions</span></TH>
              </TR>
            </THead>
            <tbody>
              {members.map((m) => (
                <TR key={m.person.id}>
                  <TD className="font-medium">{m.person.name}</TD>
                  <TD>
                    <Badge tone={m.kind === "DIRECTOR" ? "brand" : "default"}>
                      {m.kind === "DIRECTOR" ? "Director" : "Volunteer"}
                    </Badge>
                  </TD>
                  <TD>
                    {m.flag ? (
                      <Badge tone="warning">Flagged</Badge>
                    ) : (
                      <Badge tone="default">Active</Badge>
                    )}
                  </TD>
                  <TD className="text-muted-foreground text-sm">{m.flag?.note ?? "-"}</TD>
                  <TD>
                    <div className="flex items-center gap-2">
                      {m.flag ? (
                        <form action={unflagAction}>
                          <input type="hidden" name="personId" value={m.person.id} />
                          <ConfirmButton label="Unflag" confirmLabel="Confirm?" />
                        </form>
                      ) : (
                        <form action={flagAction} className="flex items-center gap-2">
                          <input type="hidden" name="personId" value={m.person.id} />
                          <Input
                            name="note"
                            placeholder="Note (optional)"
                            aria-label="Note (optional)"
                            className="w-40 text-xs py-1"
                          />
                          <ConfirmButton label="Flag" confirmLabel="Confirm?" />
                        </form>
                      )}
                    </div>
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </section>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Create the flagged tab component**

Create `src/modules/volunteers/components/flagged-tab.tsx`, moving the flagged-table JSX out of the page verbatim:

```tsx
import { SectionHeader } from "@/platform/ui/section-header";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { DateOnly } from "@/platform/dates/display";
import type { FlaggedRow } from "@/modules/volunteers/services/offboarding";

/**
 * The clinic-wide queue of people flagged for offboarding in the ACTIVE term,
 * with the per-person Unflag and Offboard controls.
 *
 * Lifted out of page.tsx unchanged when the page became tabbed.
 */
export function FlaggedTab({
  flagged,
  unflagAction,
  executeOffboardAction,
}: {
  flagged: FlaggedRow[];
  unflagAction: (formData: FormData) => Promise<void>;
  executeOffboardAction: (formData: FormData) => Promise<void>;
}) {
  return (
    <section className="mt-8">
      <SectionHeader level="title" className="mb-3">Flagged for offboarding</SectionHeader>

      <Table>
        <THead>
          <TR>
            <TH>Name</TH>
            <TH>Departments</TH>
            <TH>Flagged by</TH>
            <TH>Flagged date</TH>
            <TH>Note</TH>
            <TH><span className="sr-only">Actions</span></TH>
          </TR>
        </THead>
        <tbody>
          {flagged.length === 0 ? (
            <TR>
              <TD colSpan={6} className="text-center text-subtle-foreground text-sm py-6">
                No one is flagged.
              </TD>
            </TR>
          ) : (
            flagged.map(({ flag, person, flaggedByName, departmentNames }) => (
              <TR key={flag.id}>
                <TD className="font-medium">{person.name}</TD>
                <TD className="text-foreground-soft text-sm">
                  {departmentNames.join(", ") || "-"}
                </TD>
                <TD className="text-foreground-soft text-sm">{flaggedByName ?? "-"}</TD>
                <TD className="text-foreground-soft tabular-nums text-sm">
                  <DateOnly value={flag.createdAt} />
                </TD>
                <TD className="text-muted-foreground text-sm">{flag.note ?? "-"}</TD>
                <TD>
                  <div className="flex items-center gap-2">
                    <form action={unflagAction}>
                      <input type="hidden" name="personId" value={person.id} />
                      <ConfirmButton label="Unflag" confirmLabel="Confirm?" />
                    </form>
                    <form action={executeOffboardAction}>
                      <input type="hidden" name="personId" value={person.id} />
                      <ConfirmButton
                        label="Offboard"
                        confirmLabel={`Offboard ${person.name}? This removes all their active memberships.`}
                      />
                    </form>
                  </div>
                </TD>
              </TR>
            ))
          )}
        </tbody>
      </Table>
    </section>
  );
}
```

- [ ] **Step 3: Rewrite the page as a tabbed shell**

In `src/app/(app)/volunteers/offboarding/page.tsx`, keep the three server actions exactly as they are (`flagAction`, `unflagAction`, `executeOffboardAction`) and replace the imports and the returned JSX. The new file reads:

```tsx
import { requirePermission } from "@/platform/auth/session";
import { captureEvent } from "@/platform/posthog/capture";
import { activeTermGroup } from "@/platform/posthog/groups";
import { PageHeader } from "@/platform/ui/page-header";
import { TabRow } from "@/platform/ui/tab-row";
import {
  offboardingView,
  flagForOffboarding,
  unflag,
  executeOffboard,
  OffboardForbiddenError,
  OffboardNotFoundError,
} from "@/modules/volunteers/services/offboarding";
import { DepartmentTab } from "@/modules/volunteers/components/department-tab";
import { FlaggedTab } from "@/modules/volunteers/components/flagged-tab";
import { LastAdminError } from "@/platform/rbac/last-admin";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

// The volunteers layout gates module access. Here we additionally require
// volunteers.view for the page render and use volunteers.manage_offboarding
// defense-in-depth in the execute action, matching /volunteers/page.tsx pattern.

const BASE = "/volunteers/offboarding";

// Task 6 widens this with "transition" when it adds that tab.
type OffboardingTab = "departments" | "flagged";

export default async function OffboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; error?: string }>;
}) {
  const viewer = await requirePermission("volunteers.view");
  const { tab: rawTab } = await searchParams;

  const { departments, flagged } = await offboardingView(viewer.personId);

  // Task 6 adds the Transition tab and makes it the default during a rollover.
  // This task is a pure refactor, so the landing tab stays the department cards
  // the page has always opened on.
  const requested = rawTab as OffboardingTab | undefined;
  const tab: OffboardingTab =
    requested === "departments" || requested === "flagged" ? requested : "departments";

  const items = [
    { label: "By department", href: `${BASE}?tab=departments` },
    // The flagged queue is executor-only, exactly as the old inline section was:
    // offboardingView returns null for a viewer without manage_offboarding.
    ...(flagged !== null ? [{ label: "Flagged", href: `${BASE}?tab=flagged` }] : []),
  ];

  // ---------------------------------------------------------------------------
  // Server actions
  // ---------------------------------------------------------------------------

  async function flagAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("volunteers.view");
    const personId = formData.get("personId") as string;
    const note = (formData.get("note") as string | null) || undefined;
    if (!personId) return;
    try {
      await flagForOffboarding(actor.personId, personId, note);
    } catch (err) {
      if (err instanceof OffboardForbiddenError) {
        redirect(`${BASE}?tab=departments&error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    revalidatePath(BASE);
  }

  async function unflagAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("volunteers.view");
    const personId = formData.get("personId") as string;
    if (!personId) return;
    try {
      await unflag(actor.personId, personId);
    } catch (err) {
      if (err instanceof OffboardForbiddenError || err instanceof OffboardNotFoundError) {
        redirect(`${BASE}?tab=departments&error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    revalidatePath(BASE);
  }

  async function executeOffboardAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("volunteers.manage_offboarding");
    const personId = formData.get("personId") as string;
    if (!personId) return;
    try {
      await executeOffboard(actor.personId, personId);
      await captureEvent({
        distinctId: actor.personId,
        event: "volunteer_offboarded",
        properties: { offboarded_person_id: personId },
        groups: await activeTermGroup(),
      });
    } catch (err) {
      // #92: executeOffboard's last-admin guard throws LastAdminError; without this
      // it escaped to the error boundary as a 500 instead of the page's inline
      // amber alert. Mirror admin/people/[id]/page.tsx, which already catches it.
      if (err instanceof OffboardForbiddenError || err instanceof LastAdminError) {
        redirect(`${BASE}?tab=flagged&error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    revalidatePath(BASE);
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div>
      <PageHeader
        title="Offboarding"
        description="Flag and process volunteer offboarding."
      />

      <div className="mt-6">
        <TabRow
          items={items}
          label="Offboarding sections"
          isActive={(item) => item.href === `${BASE}?tab=${tab}`}
        />
      </div>

      {tab === "departments" && (
        <DepartmentTab
          departments={departments}
          flagAction={flagAction}
          unflagAction={unflagAction}
        />
      )}

      {tab === "flagged" && flagged !== null && (
        <FlaggedTab
          flagged={flagged}
          unflagAction={unflagAction}
          executeOffboardAction={executeOffboardAction}
        />
      )}

    </div>
  );
}
```

This task adds no new surface: the same two sections the page already rendered, now behind a tab row, opening on the same one. Task 6 adds the third tab.

- [ ] **Step 4: Update the existing Playwright spec for the tabs**

In `e2e/volunteers.spec.ts`, the offboarding round-trip test currently expects the department cards and the flagged section on one page. Change the navigation and add the tab hop.

Replace the two navigation lines (around line 128):

```ts
  await page.goto("/volunteers/offboarding?tab=departments");
  await page.waitForURL((url) => url.pathname === "/volunteers/offboarding");
```

Then, after the flag is confirmed and before the flagged section is located (around line 152), insert the tab hop:

```ts
  // The flagged queue is its own tab now, so hop to it before looking for the row.
  await page.getByRole("link", { name: "Flagged", exact: true }).click();
  await page.waitForURL((url) => url.searchParams.get("tab") === "flagged");
```

- [ ] **Step 5: Verify the refactor changed nothing**

```bash
npx tsc --noEmit
npx eslint src e2e
npx vitest run src/modules/volunteers
npx playwright test e2e/volunteers.spec.ts
```

Expected: typecheck clean, lint clean, all volunteers unit tests pass, and the Playwright spec passes with the tab navigation.

- [ ] **Step 6: Commit**

```bash
git add src/modules/volunteers/components src/app/\(app\)/volunteers/offboarding/page.tsx e2e/volunteers.spec.ts
git commit -m "refactor(volunteers): split the offboarding page into tabs"
```

---

### Task 6: Transition tab

**Files:**
- Create: `src/modules/volunteers/components/transition-tab.tsx`
- Modify: `src/app/(app)/volunteers/offboarding/page.tsx` (add two bulk server actions, load the transition view, replace the Task 5 placeholder)

**Interfaces:**
- Consumes: `transitionView`, `TransitionRow`, `TransitionView` from Task 2; `bulkFlag`, `bulkExecuteOffboard`, `MAX_BULK_OFFBOARD`, `TransitionBatchTooLargeError`, `BulkResult` from Task 3; the export route from Task 4.
- Produces: `TransitionTab({ view, canExecute, bulkFlagAction, bulkOffboardAction })`, and the page's `bulkFlagAction` / `bulkOffboardAction` server actions with signature `(prev: BulkResult | null, formData: FormData) => Promise<BulkResult | null>`.

- [ ] **Step 1: Create the transition tab component**

Create `src/modules/volunteers/components/transition-tab.tsx`:

```tsx
"use client";

import { useActionState, useState } from "react";
import { SectionHeader } from "@/platform/ui/section-header";
import { Badge } from "@/platform/ui/badge";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { Checkbox } from "@/platform/ui/checkbox";
import { Input } from "@/platform/ui/input";
import { Button } from "@/platform/ui/button";
import { Alert } from "@/platform/ui/alert";
import type { TransitionRow, TransitionView } from "@/modules/volunteers/services/transition";
// Type-only, so the server module is erased at compile time and never bundled.
import type { BulkResult } from "@/modules/volunteers/services/transition-actions";
// Value import, so it MUST come from the dependency-free limits module.
import { MAX_BULK_OFFBOARD } from "@/modules/volunteers/transition-limits";

type BulkAction = (prev: BulkResult | null, formData: FormData) => Promise<BulkResult | null>;

const BUCKET_LABELS = {
  NOT_RETURNING: "Not returning",
  PENDING: "Pending a decision",
  RETURNING: "Returning",
} as const;

const BUCKET_ORDER = ["NOT_RETURNING", "PENDING", "RETURNING"] as const;

const BUCKET_HINTS = {
  NOT_RETURNING: "No place next term and no application in flight.",
  PENDING: "Applied for next term and awaiting a decision. Checked only if you check them.",
  RETURNING: "Already holds a place next term. Nothing to do.",
} as const;

/**
 * The term transition report: who on the current roster is coming back, with
 * bulk flag, bulk offboard, and the Teams removal-list export.
 *
 * Client component because the whole tab is one selection. The bulk actions are
 * server actions that RETURN their result, rendered through useActionState, so
 * per-person skip reasons survive without a redirect and the selection is not
 * lost.
 */
export function TransitionTab({
  view,
  canExecute,
  bulkFlagAction,
  bulkOffboardAction,
}: {
  view: TransitionView;
  canExecute: boolean;
  bulkFlagAction: BulkAction;
  bulkOffboardAction: BulkAction;
}) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(view.rows.filter((r) => r.bucket === "NOT_RETURNING").map((r) => r.personId)),
  );
  const [exportError, setExportError] = useState<string | null>(null);
  const [flagResult, flagFormAction, flagPending] = useActionState(bulkFlagAction, null);
  const [offboardResult, offboardFormAction, offboardPending] = useActionState(
    bulkOffboardAction,
    null,
  );

  if (!view.nextTerm) {
    return (
      <div className="mt-12 flex flex-col items-center justify-center gap-3 text-center text-sm text-muted-foreground">
        <p>No term is in planning, so there is no transition to report on yet.</p>
        <p>
          Create the next term in Admin, Terms, then carry the roster forward or run recruitment
          against it.
        </p>
      </div>
    );
  }

  function toggle(personId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(personId)) next.delete(personId);
      else next.add(personId);
      return next;
    });
  }

  function toggleBucket(rows: TransitionRow[], on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const row of rows) {
        if (!row.selectable) continue;
        if (on) next.add(row.personId);
        else next.delete(row.personId);
      }
      return next;
    });
  }

  async function exportCsv() {
    setExportError(null);
    const res = await fetch("/api/volunteers/offboarding/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "selection", personIds: [...selected] }),
    });
    if (!res.ok) {
      setExportError("Export failed. Refresh and try again.");
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filenameFrom(res.headers.get("Content-Disposition"));
    link.click();
    URL.revokeObjectURL(url);
  }

  const selectedIds = [...selected];
  const overCap = selectedIds.length > MAX_BULK_OFFBOARD;

  return (
    <div className="mt-8 flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <SectionHeader level="title">
          {view.activeTerm?.code} to {view.nextTerm.code}
        </SectionHeader>
        <span className="text-sm text-muted-foreground">
          {view.rows.length} current members, {selectedIds.length} selected
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <form action={flagFormAction} className="flex flex-wrap items-center gap-2">
          {selectedIds.map((id) => (
            <input key={id} type="hidden" name="personId" value={id} />
          ))}
          <Input
            name="note"
            placeholder="Note applied to everyone selected (optional)"
            aria-label="Note applied to everyone selected (optional)"
            className="w-72 text-xs py-1"
          />
          <Button type="submit" disabled={flagPending || selectedIds.length === 0}>
            {flagPending ? "Flagging..." : `Flag ${selectedIds.length} for offboarding`}
          </Button>
        </form>

        {canExecute && (
          <form action={offboardFormAction} className="flex items-center gap-2">
            {selectedIds.map((id) => (
              <input key={id} type="hidden" name="personId" value={id} />
            ))}
            <Button
              type="submit"
              variant="danger"
              disabled={offboardPending || selectedIds.length === 0 || overCap}
            >
              {offboardPending ? "Offboarding..." : `Offboard ${selectedIds.length}`}
            </Button>
          </form>
        )}

        {canExecute && (
          <Button type="button" variant="outline" onClick={exportCsv} disabled={selectedIds.length === 0}>
            Export emails CSV
          </Button>
        )}
      </div>

      {overCap && (
        <Alert tone="warning">
          Offboarding runs up to {MAX_BULK_OFFBOARD} people at a time. Deselect{" "}
          {selectedIds.length - MAX_BULK_OFFBOARD} to continue, or flag them all now and offboard in
          batches.
        </Alert>
      )}

      {exportError && <Alert tone="error">{exportError}</Alert>}
      <BulkResultAlert verb="flagged" result={flagResult} />
      <BulkResultAlert verb="offboarded" result={offboardResult} />

      {BUCKET_ORDER.map((bucket) => {
        const rows = view.rows.filter((r) => r.bucket === bucket);
        if (rows.length === 0) return null;
        const selectableRows = rows.filter((r) => r.selectable);
        const allSelected =
          selectableRows.length > 0 && selectableRows.every((r) => selected.has(r.personId));

        return (
          <section key={bucket}>
            <SectionHeader level="title" className="mb-1">
              {BUCKET_LABELS[bucket]} ({rows.length})
            </SectionHeader>
            <p className="mb-3 text-sm text-muted-foreground">{BUCKET_HINTS[bucket]}</p>

            <Table>
              <THead>
                <TR>
                  <TH>
                    {selectableRows.length > 0 ? (
                      <>
                        <Checkbox
                          checked={allSelected}
                          onChange={(e) => toggleBucket(rows, e.target.checked)}
                          aria-label={`Select all ${BUCKET_LABELS[bucket]}`}
                        />
                        <span className="sr-only">Select</span>
                      </>
                    ) : (
                      <span className="sr-only">Select</span>
                    )}
                  </TH>
                  <TH>Name</TH>
                  <TH>Departments</TH>
                  <TH>Role</TH>
                  <TH>Notes</TH>
                </TR>
              </THead>
              <tbody>
                {rows.map((row) => (
                  <TR key={row.personId}>
                    <TD>
                      {row.selectable ? (
                        <Checkbox
                          checked={selected.has(row.personId)}
                          onChange={() => toggle(row.personId)}
                          aria-label={`Select ${row.name}`}
                        />
                      ) : null}
                    </TD>
                    <TD className="font-medium">{row.name}</TD>
                    <TD className="text-foreground-soft text-sm">
                      {row.departments.map((d) => d.code).join(", ") || "-"}
                    </TD>
                    <TD>
                      <Badge tone={row.role === "DIRECTOR" ? "brand" : "default"}>
                        {row.role === "DIRECTOR" ? "Director" : "Volunteer"}
                      </Badge>
                    </TD>
                    <TD>
                      <div className="flex flex-wrap items-center gap-1">
                        {row.flagged && <Badge tone="warning">Flagged</Badge>}
                        {row.selfWithdrew && <Badge tone="warning">Self-withdrew</Badge>}
                        {row.hasDraftApplication && <Badge tone="default">Draft application</Badge>}
                      </div>
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </section>
        );
      })}
    </div>
  );
}

function BulkResultAlert({ verb, result }: { verb: string; result: BulkResult | null }) {
  if (!result) return null;
  const tone = result.skipped.length > 0 ? "warning" : "success";
  return (
    <Alert tone={tone}>
      <span>
        {result.succeeded.length} {verb}
        {result.skipped.length > 0 && (
          <>
            , {result.skipped.length} skipped:
            <ul className="mt-1 list-disc pl-5">
              {result.skipped.map((s) => (
                <li key={s.personId}>
                  {s.name}: {s.reason}
                </li>
              ))}
            </ul>
          </>
        )}
      </span>
    </Alert>
  );
}

/** Pull the filename out of a Content-Disposition header, with a safe default. */
function filenameFrom(header: string | null): string {
  const match = header?.match(/filename="([^"]+)"/);
  return match?.[1] ?? "offboarding.csv";
}
```

`Button` accepts `variant` of `"primary" | "outline" | "danger" | "ghost"` and `size` of `"sm" | "md" | "lg"` (see `src/platform/ui/button.tsx`). There is no `secondary` variant; the export button above uses `outline`.

- [ ] **Step 2: Wire the transition tab into the page**

In `src/app/(app)/volunteers/offboarding/page.tsx`:

Add to the imports:

```tsx
import { transitionView } from "@/modules/volunteers/services/transition";
import {
  bulkFlag,
  bulkExecuteOffboard,
  TransitionBatchTooLargeError,
  type BulkResult,
} from "@/modules/volunteers/services/transition-actions";
import { TransitionTab } from "@/modules/volunteers/components/transition-tab";
import { can } from "@/platform/rbac/engine";
```

Replace the `const nextTerm = await getNextTerm();` line with:

```tsx
  const [nextTerm, canExecute] = await Promise.all([
    getNextTerm(),
    can(viewer.personId, "volunteers.manage_offboarding"),
  ]);

  // Only the active tab's data is queried, so a director opening Flagged does
  // not pay for the transition roll-up.
  const transition = tab === "transition" ? await transitionView(viewer.personId) : null;
```

Note that `tab` is computed above this line in the Task 5 version, so this assignment must sit after the `const tab: OffboardingTab = ...` block. Move the `offboardingView` call so it only runs for the other two tabs is NOT part of this task; leave it as is, since the tab list needs `flagged !== null` to decide whether to show the Flagged tab.

Add the two bulk server actions alongside the existing three:

```tsx
  async function bulkFlagAction(
    _prev: BulkResult | null,
    formData: FormData
  ): Promise<BulkResult | null> {
    "use server";
    const actor = await requirePermission("volunteers.view");
    const personIds = formData.getAll("personId").map(String).filter(Boolean);
    const note = (formData.get("note") as string | null)?.trim() || undefined;
    if (personIds.length === 0) return null;

    const result = await bulkFlag(actor.personId, personIds, note);
    revalidatePath(BASE);
    return result;
  }

  async function bulkOffboardAction(
    _prev: BulkResult | null,
    formData: FormData
  ): Promise<BulkResult | null> {
    "use server";
    const actor = await requirePermission("volunteers.manage_offboarding");
    const personIds = formData.getAll("personId").map(String).filter(Boolean);
    if (personIds.length === 0) return null;

    let result: BulkResult;
    try {
      result = await bulkExecuteOffboard(actor.personId, personIds);
    } catch (err) {
      // The cap is enforced in the service too, so a client that bypasses the
      // disabled button still gets a readable answer rather than a 500.
      if (err instanceof TransitionBatchTooLargeError) {
        return {
          succeeded: [],
          skipped: personIds.map((personId) => ({ personId, name: "Selection", reason: err.message })),
        };
      }
      throw err;
    }

    // Analytics per person, matching the single-person execute action.
    const groups = await activeTermGroup();
    for (const person of result.succeeded) {
      await captureEvent({
        distinctId: actor.personId,
        event: "volunteer_offboarded",
        properties: { offboarded_person_id: person.personId, bulk: true },
        groups,
      });
    }

    revalidatePath(BASE);
    return result;
  }
```

Replace the Task 5 placeholder with:

```tsx
      {tab === "transition" && transition && (
        <TransitionTab
          view={transition}
          canExecute={canExecute}
          bulkFlagAction={bulkFlagAction}
          bulkOffboardAction={bulkOffboardAction}
        />
      )}
```

- [ ] **Step 3: Verify it compiles and renders**

```bash
npx tsc --noEmit
npx eslint src
```

Expected: both clean. If eslint reports the module-boundary rule on the `@/modules/volunteers/...` import inside the page, that is expected to pass, since app routes may import from modules; only cross-module and platform-to-module imports are restricted.

- [ ] **Step 4: Check it by hand**

Start the app with `npm run dev`, sign in as a `volunteers.manage_offboarding` holder, and open `/volunteers/offboarding`. With no PLANNING term you should land on By department and the Transition tab should show the empty state. Create a PLANNING term in Admin, Terms, reload, and confirm the three bucket sections render with Not returning pre-checked.

- [ ] **Step 5: Commit**

```bash
git add src/modules/volunteers/components/transition-tab.tsx src/app/\(app\)/volunteers/offboarding/page.tsx
git commit -m "feat(volunteers): add the term transition tab with bulk flag, bulk offboard, and export"
```

---

### Task 7: Bulk execute and export on the Flagged tab

**Files:**
- Modify: `src/modules/volunteers/components/flagged-tab.tsx` (becomes a client component with selection)
- Modify: `src/app/(app)/volunteers/offboarding/page.tsx` (pass the bulk action and the executor flag into `FlaggedTab`)

**Interfaces:**
- Consumes: `bulkOffboardAction` and `MAX_BULK_OFFBOARD` from Task 6 and Task 3; the export route from Task 4.
- Produces: `FlaggedTab({ flagged, unflagAction, executeOffboardAction, bulkOffboardAction })`.

- [ ] **Step 1: Convert the flagged tab to a selectable client component**

Replace `src/modules/volunteers/components/flagged-tab.tsx` entirely. It becomes a client
component: the per-person Unflag and Offboard forms are unchanged, and a selection column, a bulk
bar, and the offboarded-this-term export are added around them.

```tsx
"use client";

import { useActionState, useState } from "react";
import { SectionHeader } from "@/platform/ui/section-header";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { Button } from "@/platform/ui/button";
import { Alert } from "@/platform/ui/alert";
import { Checkbox } from "@/platform/ui/checkbox";
import { DateOnly } from "@/platform/dates/display";
import type { FlaggedRow } from "@/modules/volunteers/services/offboarding";
// Type-only, so the server module is erased at compile time and never bundled.
import type { BulkResult } from "@/modules/volunteers/services/transition-actions";
// Value import, so it MUST come from the dependency-free limits module.
import { MAX_BULK_OFFBOARD } from "@/modules/volunteers/transition-limits";

type BulkAction = (prev: BulkResult | null, formData: FormData) => Promise<BulkResult | null>;

/**
 * The clinic-wide queue of people flagged for offboarding in the ACTIVE term.
 *
 * Renders only for volunteers.manage_offboarding holders (the page gates it on
 * offboardingView returning a non-null flagged list), which is why the export
 * button needs no further permission prop.
 *
 * Client component so the bulk offboard can carry a selection. The per-person
 * Unflag and Offboard controls are unchanged plain forms bound to the page's
 * server actions.
 */
export function FlaggedTab({
  flagged,
  unflagAction,
  executeOffboardAction,
  bulkOffboardAction,
}: {
  flagged: FlaggedRow[];
  unflagAction: (formData: FormData) => Promise<void>;
  executeOffboardAction: (formData: FormData) => Promise<void>;
  bulkOffboardAction: BulkAction;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [exportError, setExportError] = useState<string | null>(null);
  const [offboardResult, offboardFormAction, offboardPending] = useActionState(
    bulkOffboardAction,
    null,
  );

  function toggle(personId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(personId)) next.delete(personId);
      else next.add(personId);
      return next;
    });
  }

  async function exportOffboardedCsv() {
    setExportError(null);
    const res = await fetch("/api/volunteers/offboarding/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "offboarded-term" }),
    });
    if (!res.ok) {
      setExportError("Export failed. Refresh and try again.");
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    const match = res.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/);
    link.download = match?.[1] ?? "offboarding.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  const selectedIds = [...selected];
  const overCap = selectedIds.length > MAX_BULK_OFFBOARD;
  const allSelected = flagged.length > 0 && flagged.every((f) => selected.has(f.person.id));

  return (
    <section className="mt-8">
      <SectionHeader level="title" className="mb-3">Flagged for offboarding</SectionHeader>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <form action={offboardFormAction} className="flex items-center gap-2">
          {selectedIds.map((id) => (
            <input key={id} type="hidden" name="personId" value={id} />
          ))}
          <Button
            type="submit"
            variant="danger"
            disabled={offboardPending || selectedIds.length === 0 || overCap}
          >
            {offboardPending ? "Offboarding..." : `Offboard ${selectedIds.length}`}
          </Button>
        </form>

        <Button type="button" variant="outline" onClick={exportOffboardedCsv}>
          Export offboarded-this-term CSV
        </Button>
      </div>

      {overCap && (
        <Alert tone="warning" className="mb-4">
          Offboarding runs up to {MAX_BULK_OFFBOARD} people at a time. Deselect{" "}
          {selectedIds.length - MAX_BULK_OFFBOARD} to continue.
        </Alert>
      )}

      {exportError && <Alert tone="error" className="mb-4">{exportError}</Alert>}

      {offboardResult && (
        <Alert
          tone={offboardResult.skipped.length > 0 ? "warning" : "success"}
          className="mb-4"
        >
          <span>
            {offboardResult.succeeded.length} offboarded
            {offboardResult.skipped.length > 0 && (
              <>
                , {offboardResult.skipped.length} skipped:
                <ul className="mt-1 list-disc pl-5">
                  {offboardResult.skipped.map((s) => (
                    <li key={s.personId}>
                      {s.name}: {s.reason}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </span>
        </Alert>
      )}

      <Table>
        <THead>
          <TR>
            <TH>
              <Checkbox
                checked={allSelected}
                onChange={(e) =>
                  setSelected(e.target.checked ? new Set(flagged.map((f) => f.person.id)) : new Set())
                }
                aria-label="Select all flagged people"
              />
              <span className="sr-only">Select</span>
            </TH>
            <TH>Name</TH>
            <TH>Departments</TH>
            <TH>Flagged by</TH>
            <TH>Flagged date</TH>
            <TH>Note</TH>
            <TH><span className="sr-only">Actions</span></TH>
          </TR>
        </THead>
        <tbody>
          {flagged.length === 0 ? (
            <TR>
              <TD colSpan={7} className="text-center text-subtle-foreground text-sm py-6">
                No one is flagged.
              </TD>
            </TR>
          ) : (
            flagged.map(({ flag, person, flaggedByName, departmentNames }) => (
              <TR key={flag.id}>
                <TD>
                  <Checkbox
                    checked={selected.has(person.id)}
                    onChange={() => toggle(person.id)}
                    aria-label={`Select ${person.name}`}
                  />
                </TD>
                <TD className="font-medium">{person.name}</TD>
                <TD className="text-foreground-soft text-sm">
                  {departmentNames.join(", ") || "-"}
                </TD>
                <TD className="text-foreground-soft text-sm">{flaggedByName ?? "-"}</TD>
                <TD className="text-foreground-soft tabular-nums text-sm">
                  <DateOnly value={flag.createdAt} />
                </TD>
                <TD className="text-muted-foreground text-sm">{flag.note ?? "-"}</TD>
                <TD>
                  <div className="flex items-center gap-2">
                    <form action={unflagAction}>
                      <input type="hidden" name="personId" value={person.id} />
                      <ConfirmButton label="Unflag" confirmLabel="Confirm?" />
                    </form>
                    <form action={executeOffboardAction}>
                      <input type="hidden" name="personId" value={person.id} />
                      <ConfirmButton
                        label="Offboard"
                        confirmLabel={`Offboard ${person.name}? This removes all their active memberships.`}
                      />
                    </form>
                  </div>
                </TD>
              </TR>
            ))
          )}
        </tbody>
      </Table>
    </section>
  );
}
```


- [ ] **Step 2: Pass the bulk action from the page**

In `src/app/(app)/volunteers/offboarding/page.tsx`, add the prop to the existing render:

```tsx
      {tab === "flagged" && flagged !== null && (
        <FlaggedTab
          flagged={flagged}
          unflagAction={unflagAction}
          executeOffboardAction={executeOffboardAction}
          bulkOffboardAction={bulkOffboardAction}
        />
      )}
```

- [ ] **Step 3: Verify**

```bash
npx tsc --noEmit
npx eslint src
npx playwright test e2e/volunteers.spec.ts
```

Expected: clean, and the existing round-trip spec still passes. If the spec's row locator now matches the header checkbox row, scope it with `tbody tr` instead of `tr`.

- [ ] **Step 4: Commit**

```bash
git add src/modules/volunteers/components/flagged-tab.tsx src/app/\(app\)/volunteers/offboarding/page.tsx
git commit -m "feat(volunteers): bulk offboard and export from the flagged queue"
```

---

### Task 8: End-to-end coverage and full verification

**Files:**
- Create: `e2e/term-transition.spec.ts`
- Modify: `e2e/fixtures.ts` (add `seedPlanningTerm`)

**Interfaces:**
- Consumes: everything above.
- Produces: no application code.

- [ ] **Step 1: Add the planning-term fixture**

`seedComplianceMember(deptCode, opts)` already seeds an ACTIVE-term member and returns
`{ person, cleanup }`. It creates the person with a `contactEmail` and no `netId`, and gives them
no next-term membership and no application, so they land in the Not returning bucket. Reuse it as
is.

The spec also needs a PLANNING term, which no fixture provides yet. Add this to `e2e/fixtures.ts`
next to the other seed helpers:

```ts
/**
 * A PLANNING term far enough in the future to win getNextTerm's
 * `orderBy: { startDate: "desc" }`, so the transition report resolves to THIS
 * term even on a dev database that already has one in planning.
 */
export async function seedPlanningTerm(code: string) {
  const term = await prisma.term.create({
    data: {
      code,
      name: `E2E Planning ${code}`,
      startDate: new Date("2099-01-01"),
      endDate: new Date("2099-05-01"),
      status: "PLANNING",
    },
  });
  return {
    term,
    cleanup: async () => {
      await prisma.termMembership.deleteMany({ where: { termId: term.id } });
      await prisma.offboardFlag.deleteMany({ where: { termId: term.id } });
      await prisma.term.delete({ where: { id: term.id } }).catch((e) =>
        console.warn("[e2e cleanup] term delete failed, row may be leaked:", e instanceof Error ? e.message : e),
      );
    },
  };
}
```

- [ ] **Step 2: Write the spec**

Create `e2e/term-transition.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { devLogin } from "./auth";
import { seedComplianceMember, seedPlanningTerm } from "./fixtures";

let member: Awaited<ReturnType<typeof seedComplianceMember>>;
let planning: Awaited<ReturnType<typeof seedPlanningTerm>>;

test.beforeEach(async () => {
  // An ITCM member on the ACTIVE term with no next-term place and no
  // application, so they land in the Not returning bucket.
  member = await seedComplianceMember("ITCM", { status: "COMPLIANT" });
  planning = await seedPlanningTerm("SP99");
});

test.afterEach(async () => {
  await planning.cleanup();
  await member.cleanup();
});

/**
 * Flags via the Transition tab's bulk action, verifies the person reaches the
 * Flagged queue, then unflags to restore state.
 *
 * Deliberately does not execute the offboard: that would set the person
 * OFFBOARDED and break afterEach cleanup. bulkExecuteOffboard is covered by the
 * integration tests in transition-actions.test.ts.
 */
test("term transition: bulk flag from the Transition tab reaches the flagged queue", async ({
  page,
}) => {
  await devLogin(page, "j.carney@yale.edu");
  await page.goto("/volunteers/offboarding?tab=transition");
  await page.waitForURL((url) => url.searchParams.get("tab") === "transition");

  // The header names both terms, so the report resolved a next term.
  await expect(page.getByRole("heading", { name: /SP99/ })).toBeVisible();

  const personName = member.person.name;
  const row = page.locator("tbody tr").filter({ hasText: personName }).first();
  await expect(row).toBeVisible();

  // Not returning is pre-checked, so the person is already in the selection.
  await expect(row.getByRole("checkbox")).toBeChecked();

  await page.getByRole("button", { name: /^Flag \d+ for offboarding$/ }).click();
  await expect(page.getByText(/flagged/)).toBeVisible();

  await page.getByRole("link", { name: "Flagged", exact: true }).click();
  await page.waitForURL((url) => url.searchParams.get("tab") === "flagged");

  const flaggedRow = page.locator("tbody tr").filter({ hasText: personName }).first();
  await expect(flaggedRow).toBeVisible();

  // Restore state: unflag through the two-click ConfirmButton protocol.
  await flaggedRow.getByRole("button", { name: "Unflag", exact: true }).click();
  await flaggedRow.getByRole("button").filter({ hasText: /\?/ }).first().click();
  await expect(page.locator("tbody tr").filter({ hasText: personName })).toHaveCount(0);
});

test("term transition: the export downloads a CSV", async ({ page }) => {
  await devLogin(page, "j.carney@yale.edu");
  await page.goto("/volunteers/offboarding?tab=transition");
  await page.waitForURL((url) => url.searchParams.get("tab") === "transition");

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export emails CSV" }).click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toMatch(/^haven-offboarding-.*\.csv$/);
});
```

- [ ] **Step 3: Run the new spec**

Run: `npx playwright test e2e/term-transition.spec.ts`
Expected: both tests pass.

If the download test fails because the click happens before selection state settles, add `await expect(page.getByRole("button", { name: /^Offboard \d+$/ })).toBeEnabled();` before the download click, which proves the selection has rendered.

- [ ] **Step 4: Run full verification**

```bash
npx tsc --noEmit
npx eslint src e2e
npx vitest run
npx playwright test
```

Read the actual pass and fail counts from each. Do not pipe to `tail`, which returns 0 even when the suite fails.

- [ ] **Step 5: Commit**

```bash
git add e2e/term-transition.spec.ts e2e/fixtures.ts
git commit -m "test(volunteers): cover the term transition tab end to end"
```

---

## Notes for the implementer

- `bulkExecuteOffboard` in `transition-actions.ts` and `executeOffboard` in `offboarding.ts` are the only two places that offboard. Never add a third.
- If a task's test does not fail for the reason the plan predicts, stop and read the error before writing implementation. A test that fails for the wrong reason proves nothing.
- The clinic runs the next term ahead of the flip, so a member can legitimately hold a PLANNING-term membership. That is exactly what puts them in the Returning bucket, and it is why `executeOffboard` scopes its membership sweep to non-archived terms.
