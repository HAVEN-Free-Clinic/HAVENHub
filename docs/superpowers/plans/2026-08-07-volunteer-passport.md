# Volunteer Passport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every HAVEN member a service record they can download as a certificate PDF, publish as a verifiable credential page, and carry as a term-scoped Apple/Google Wallet badge.

**Architecture:** One computation (`computeServiceRecord`) produces a typed record. Issuing snapshots it into a `ServiceCredential` row, and every artifact renders that frozen snapshot rather than recomputing, so the PDF, the public page, and the badge cannot disagree. The wallet vendor sits behind three methods and is the only external dependency.

**Tech Stack:** Next.js 16 App Router, Prisma/Postgres, `@react-pdf/renderer` (already a dependency), Vitest against a real test database, Playwright for e2e, walletwallet.dev REST API.

**Spec:** `docs/superpowers/specs/2026-08-07-volunteer-passport-design.md`

## Global Constraints

- **No em-dashes or en-dashes anywhere in `src/` or `e2e/`.** CI enforces `local/no-em-dash` and lint failure blocks the build. Use commas, colons, or parentheses.
- **Run `npx eslint src e2e` before pushing.** A bare `npx eslint` walks the gitignored design system directory and fails on files you did not touch. Typecheck and tests do not cover the eslint boundary rules.
- **All data crossing a server action or server component boundary into a client component must be JSON-safe.** ISO strings, not `Date`. Plain objects, not Prisma model instances.
- **Dates anchored at noon UTC** when they represent calendar days, matching `Term.clinicDates` and the availability arrays. Compare by UTC day key.
- **`prisma migrate dev` folds pre-existing drift into your migration.** Read the generated SQL and delete any statement you did not intend. Never accept a `DROP` of an object you do not recognize.
- **Tests run serially against one shared test database** (`fileParallelism: false`). Call `resetDb()` in `beforeEach`.
- **Vendor calls never run inside a Prisma transaction.**
- **NEVER run `npx playwright test` locally.** `playwright.config.ts:57` starts its own dev server with `npm run dev`, which loads `.env`, whose `DATABASE_URL` points at **production Neon**. Running e2e locally writes test rows into production; it has already happened once in this repo. Author the `.spec.ts` files as specified and stop there. CI runs the full Playwright suite against its own database, and that is where e2e is verified.
- **Local verification is exactly three commands:** `npx tsc --noEmit`, `npx eslint src e2e`, `npx vitest run <paths>`. Vitest is safe: `vitest.setup.ts:2` redirects `DATABASE_URL` to `TEST_DATABASE_URL` on localhost:5434.

## Deviation from the spec, recorded

The spec sketched `ServiceCredential.personId` as a plain indexed column, implying many credential rows per person. This plan makes it **`@unique`**: one credential row per person, re-issued in place. Re-issuing is a member-initiated action that should update what they publish, and the invariant that matters (a public page never silently recomputes on read) holds either way. This is a strict simplification with no behavior lost.

## Deliberate gap: admin credential revocation has no UI

The spec calls credential revocation "a separate, deliberate admin action for falsified service or a record issued in error," and says it should be "rare enough to be manual." No task builds a screen for it.

What the plan does build: the `revokedAt` column (Task 2) and the read-path guard that makes a revoked credential return null from `getCredentialByToken`, so the public page 404s (Task 6, tested). Revoking is therefore a one-line database update against a column whose behavior is covered by a test.

That is the right trade for an action expected roughly never, and building an admin screen for it now would be speculative UI on an unproven need. If it turns out to happen more than once, it wants a real audited service call rather than someone hand-editing production, and that is the moment to build it.

---

### Task 1: Compute the service record

**Files:**
- Create: `src/modules/passport/services/service-record.ts`
- Test: `src/modules/passport/services/service-record.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `computeServiceRecord(personId: string, client?: PrismaClientOrTx): Promise<ServiceRecord>`, plus exported types `ServiceRecord`, `ServiceTermRow`, `PrismaClientOrTx`.

- [ ] **Step 1: Write the failing test**

Create `src/modules/passport/services/service-record.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { computeServiceRecord } from "./service-record";

async function person(name = "Ada Lovelace") {
  return prisma.person.create({ data: { name } });
}

async function term(code: string, start: string, status: "ACTIVE" | "ARCHIVED" = "ARCHIVED") {
  return prisma.term.create({
    data: {
      code,
      name: `Term ${code}`,
      startDate: new Date(`${start}T12:00:00Z`),
      endDate: new Date(`${start}T12:00:00Z`),
      status,
    },
  });
}

async function department(code = "ITCM", name = "Internal Medicine") {
  return prisma.department.upsert({ where: { code }, update: {}, create: { code, name } });
}

describe("computeServiceRecord", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("returns a row per ACTIVE membership, ascending by term start", async () => {
    const p = await person();
    const d = await department();
    const older = await term("SP26", "2026-01-12");
    const newer = await term("SU26", "2026-05-01");
    for (const t of [newer, older]) {
      await prisma.termMembership.create({
        data: { personId: p.id, termId: t.id, departmentId: d.id, kind: "VOLUNTEER" },
      });
    }

    const record = await computeServiceRecord(p.id);

    expect(record.terms.map((r) => r.termCode)).toEqual(["SP26", "SU26"]);
    expect(record.terms[0].departmentName).toBe("Internal Medicine");
    expect(record.terms[0].track).toBe("VOLUNTEER");
    expect(record.terms[0].source).toBe("MEMBERSHIP");
  });

  it("excludes REMOVED memberships", async () => {
    const p = await person();
    const d = await department();
    const t = await term("SU26", "2026-05-01");
    await prisma.termMembership.create({
      data: { personId: p.id, termId: t.id, departmentId: d.id, kind: "VOLUNTEER", status: "REMOVED" },
    });

    const record = await computeServiceRecord(p.id);

    expect(record.terms).toHaveLength(0);
  });

  it("distinguishes a term with no shift data (null) from a term where the member had none (0)", async () => {
    const p = await person();
    const other = await person("Someone Else");
    const d = await department();
    const noData = await term("SP26", "2026-01-12");
    const hasData = await term("SU26", "2026-05-01");
    for (const t of [noData, hasData]) {
      await prisma.termMembership.create({
        data: { personId: p.id, termId: t.id, departmentId: d.id, kind: "VOLUNTEER" },
      });
    }
    // Shift data exists for SU26, but belongs to a different person.
    await prisma.shiftAssignment.create({
      data: {
        termId: hasData.id,
        departmentId: d.id,
        personId: other.id,
        clinicDate: new Date("2026-06-03T12:00:00Z"),
        role: "VOLUNTEER",
      },
    });

    const record = await computeServiceRecord(p.id);

    expect(record.terms.find((r) => r.termCode === "SP26")!.shifts).toBeNull();
    expect(record.terms.find((r) => r.termCode === "SU26")!.shifts).toBe(0);
  });

  it("counts the member's own shifts in a term that has shift data", async () => {
    const p = await person();
    const d = await department();
    const t = await term("SU26", "2026-05-01");
    await prisma.termMembership.create({
      data: { personId: p.id, termId: t.id, departmentId: d.id, kind: "VOLUNTEER" },
    });
    for (const day of ["2026-06-03", "2026-06-10", "2026-06-17"]) {
      await prisma.shiftAssignment.create({
        data: {
          termId: t.id,
          departmentId: d.id,
          personId: p.id,
          clinicDate: new Date(`${day}T12:00:00Z`),
          role: "VOLUNTEER",
        },
      });
    }

    const record = await computeServiceRecord(p.id);

    expect(record.terms[0].shifts).toBe(3);
  });

  it("reconstructs a pre-roster term from an ONBOARDED + ACCEPTED recruitment outcome", async () => {
    const p = await person();
    await department();
    const applicant = await prisma.historicalApplicant.create({
      data: { primaryEmail: "ada@example.com", firstName: "Ada", lastName: "Lovelace", personId: p.id },
    });
    await prisma.historicalApplication.create({
      data: {
        applicantId: applicant.id,
        sourceBaseId: "app1",
        sourceTableId: "tbl1",
        sourceRecordId: "rec1",
        cycleCode: "V-FA23",
        cycleLabel: "Fall 2023 Volunteer Recruitment",
        track: "VOLUNTEER",
        termCode: "FA23",
        resultDepartment: "ITCM",
        furthestStage: "ONBOARDED",
        outcome: "ACCEPTED",
        decidedAt: new Date("2023-09-15T12:00:00Z"),
      },
    });

    const record = await computeServiceRecord(p.id);

    expect(record.terms).toHaveLength(1);
    expect(record.terms[0].source).toBe("RECRUITMENT");
    expect(record.terms[0].termCode).toBe("FA23");
    expect(record.terms[0].departmentName).toBe("Internal Medicine");
    expect(record.terms[0].shifts).toBeNull();
    expect(record.memberSince).toEqual({ label: "Fall 2023 Volunteer Recruitment", source: "RECRUITMENT" });
  });

  it("ignores recruitment outcomes that did not reach ONBOARDED + ACCEPTED", async () => {
    const p = await person();
    const applicant = await prisma.historicalApplicant.create({
      data: { primaryEmail: "ada@example.com", firstName: "Ada", lastName: "Lovelace", personId: p.id },
    });
    await prisma.historicalApplication.create({
      data: {
        applicantId: applicant.id,
        sourceBaseId: "app1",
        sourceTableId: "tbl1",
        sourceRecordId: "rec2",
        cycleCode: "V-FA22",
        cycleLabel: "Fall 2022 Volunteer Recruitment",
        track: "VOLUNTEER",
        termCode: "FA22",
        furthestStage: "FINAL_ROUND",
        outcome: "REJECTED",
        decidedAt: new Date("2022-09-15T12:00:00Z"),
      },
    });

    const record = await computeServiceRecord(p.id);

    expect(record.terms).toHaveLength(0);
  });

  it("drops the recruitment row when a membership covers the same term", async () => {
    const p = await person();
    const d = await department();
    const t = await term("SU26", "2026-05-01");
    await prisma.termMembership.create({
      data: { personId: p.id, termId: t.id, departmentId: d.id, kind: "DIRECTOR" },
    });
    const applicant = await prisma.historicalApplicant.create({
      data: { primaryEmail: "ada@example.com", firstName: "Ada", lastName: "Lovelace", personId: p.id },
    });
    await prisma.historicalApplication.create({
      data: {
        applicantId: applicant.id,
        sourceBaseId: "app1",
        sourceTableId: "tbl1",
        sourceRecordId: "rec3",
        cycleCode: "V-SU26",
        cycleLabel: "Summer 2026 Volunteer Recruitment",
        track: "VOLUNTEER",
        termCode: "SU26",
        furthestStage: "ONBOARDED",
        outcome: "ACCEPTED",
        decidedAt: new Date("2026-04-01T12:00:00Z"),
      },
    });

    const record = await computeServiceRecord(p.id);

    expect(record.terms).toHaveLength(1);
    expect(record.terms[0].source).toBe("MEMBERSHIP");
    expect(record.terms[0].track).toBe("DIRECTOR");
  });

  it("carries verified capabilities and a SCHEDULED basis", async () => {
    const p = await prisma.person.create({
      data: { name: "Ada Lovelace", spanishVerified: true, licensedRN: true },
    });

    const record = await computeServiceRecord(p.id);

    expect(record.capabilities).toEqual({ spanishVerified: true, licensedRN: true });
    expect(record.basis).toBe("SCHEDULED");
    expect(record.name).toBe("Ada Lovelace");
    expect(record.memberSince).toBeNull();
  });

  it("returns JSON-safe values only", async () => {
    const p = await person();
    const d = await department();
    const t = await term("SU26", "2026-05-01");
    await prisma.termMembership.create({
      data: { personId: p.id, termId: t.id, departmentId: d.id, kind: "VOLUNTEER" },
    });

    const record = await computeServiceRecord(p.id);

    expect(typeof record.terms[0].startDate).toBe("string");
    expect(typeof record.generatedAt).toBe("string");
    expect(JSON.parse(JSON.stringify(record))).toEqual(record);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/modules/passport/services/service-record.test.ts`
Expected: FAIL, cannot resolve `./service-record`.

- [ ] **Step 3: Write the implementation**

Create `src/modules/passport/services/service-record.ts`:

```ts
/**
 * The volunteer service record: one computation, three renderings.
 *
 * This is the only place that decides what a member's service history IS.
 * The PDF, the public credential page, and the wallet pass all render a
 * SNAPSHOT of this value (see credential.ts), never a fresh computation, so
 * they cannot drift apart or surface a record the member never published.
 *
 * Two data limits shape the output and must not be papered over:
 *
 *   1. ShiftAssignment rows begin at the SU26 cutover import. A term with no
 *      shift data at all yields `shifts: null`; a term that HAS data where this
 *      member held none yields `shifts: 0`. Rendering those identically would
 *      claim a member did nothing when the truth is that we were not counting.
 *      Whether a term has data is PROBED, never hardcoded, so the boundary
 *      moves on its own if anyone backfills.
 *
 *   2. TermMembership rows begin at SP26. Earlier service is reconstructed from
 *      HistoricalApplication rows that reached ONBOARDED + ACCEPTED, which is
 *      evidence of joining, not of duration. Those rows always carry
 *      `shifts: null` and are marked `source: "RECRUITMENT"` so the renderer can
 *      label them honestly.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/platform/db";

/** Either the singleton client or a transaction client, so the offboard hook can snapshot in-transaction. */
export type PrismaClientOrTx = PrismaClient | Prisma.TransactionClient;

export type ServiceTermRow = {
  termCode: string;
  termName: string;
  /** ISO string. JSON-safe: this value crosses into client components. */
  startDate: string;
  departmentName: string;
  track: "VOLUNTEER" | "DIRECTOR";
  /** null = the term has no shift records at all. 0 = it does, and this member had none. */
  shifts: number | null;
  source: "MEMBERSHIP" | "RECRUITMENT";
};

export type ServiceRecord = {
  name: string;
  /** Null when the person has no membership and no onboarded recruitment outcome. */
  memberSince: { label: string; source: "MEMBERSHIP" | "RECRUITMENT" } | null;
  /** Ascending by term start. */
  terms: ServiceTermRow[];
  capabilities: { spanishVerified: boolean; licensedRN: boolean };
  /** Upgrades to "ATTENDED" only if attendance capture is ever built. */
  basis: "SCHEDULED";
  generatedAt: string;
};

export async function computeServiceRecord(
  personId: string,
  client: PrismaClientOrTx = prisma,
): Promise<ServiceRecord> {
  const person = await client.person.findUnique({
    where: { id: personId },
    select: { name: true, spanishVerified: true, licensedRN: true },
  });
  if (!person) throw new Error(`No person ${personId}`);

  const memberships = await client.termMembership.findMany({
    where: { personId, status: "ACTIVE" },
    select: {
      kind: true,
      department: { select: { name: true } },
      term: { select: { id: true, code: true, name: true, startDate: true } },
    },
  });

  const termIds = memberships.map((m) => m.term.id);

  // Which of these terms have ANY shift data, for anyone. This is the probe that
  // keeps the SU26 boundary out of the code.
  const termsWithData = new Set(
    termIds.length === 0
      ? []
      : (
          await client.shiftAssignment.groupBy({
            by: ["termId"],
            where: { termId: { in: termIds } },
          })
        ).map((row) => row.termId),
  );

  const ownCounts = new Map(
    termIds.length === 0
      ? []
      : (
          await client.shiftAssignment.groupBy({
            by: ["termId"],
            where: { personId, termId: { in: termIds } },
            _count: { _all: true },
          })
        ).map((row) => [row.termId, row._count._all] as const),
  );

  const membershipRows: ServiceTermRow[] = memberships.map((m) => ({
    termCode: m.term.code,
    termName: m.term.name,
    startDate: m.term.startDate.toISOString(),
    departmentName: m.department.name,
    track: m.kind,
    shifts: termsWithData.has(m.term.id) ? (ownCounts.get(m.term.id) ?? 0) : null,
    source: "MEMBERSHIP" as const,
  }));

  const covered = new Set(membershipRows.map((r) => r.termCode));

  // Pre-roster service, reconstructed from recruitment outcomes. Only an
  // ONBOARDED + ACCEPTED row means the person actually joined; anything short of
  // that is an application, not service.
  const historical = await client.historicalApplication.findMany({
    where: {
      applicant: { personId },
      furthestStage: "ONBOARDED",
      outcome: "ACCEPTED",
    },
    select: {
      cycleCode: true,
      cycleLabel: true,
      termCode: true,
      resultDepartment: true,
      track: true,
      decidedAt: true,
      submittedAt: true,
    },
  });

  // resultDepartment is a department CODE resolved at import time. The department
  // may since have been renamed or retired, so fall back to the raw code rather
  // than dropping the row or inventing a name.
  const codes = historical.map((h) => h.resultDepartment).filter((c): c is string => Boolean(c));
  const departmentNames = new Map(
    codes.length === 0
      ? []
      : (
          await client.department.findMany({
            where: { code: { in: codes } },
            select: { code: true, name: true },
          })
        ).map((d) => [d.code, d.name] as const),
  );

  const recruitmentRows: ServiceTermRow[] = [];
  for (const h of historical) {
    const code = h.termCode ?? h.cycleCode;
    if (covered.has(code)) continue; // A roster row for this term wins.
    // Without a date we cannot place the row in time, and an unplaceable row
    // would sort unpredictably against real terms. Skip rather than guess.
    const anchor = h.decidedAt ?? h.submittedAt;
    if (!anchor) continue;
    covered.add(code);
    recruitmentRows.push({
      termCode: code,
      termName: h.cycleLabel,
      startDate: anchor.toISOString(),
      departmentName: h.resultDepartment
        ? (departmentNames.get(h.resultDepartment) ?? h.resultDepartment)
        : "Department not recorded",
      track: h.track,
      shifts: null,
      source: "RECRUITMENT",
    });
  }

  const terms = [...membershipRows, ...recruitmentRows].sort((a, b) =>
    a.startDate.localeCompare(b.startDate),
  );

  // Derived from the first row rather than computed separately, so the headline
  // and the table can never disagree about when service began.
  const first = terms[0];

  return {
    name: person.name,
    memberSince: first ? { label: first.termName, source: first.source } : null,
    terms,
    capabilities: {
      spanishVerified: person.spanishVerified,
      licensedRN: person.licensedRN,
    },
    basis: "SCHEDULED",
    generatedAt: new Date().toISOString(),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/modules/passport/services/service-record.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Lint and commit**

```bash
npx eslint src
git add src/modules/passport/services/service-record.ts src/modules/passport/services/service-record.test.ts
git commit -m "feat(passport): compute a member's service record from memberships, shifts, and recruitment history"
```

---

### Task 2: Snapshot the record into a ServiceCredential

**Files:**
- Modify: `prisma/schema.prisma` (add `ServiceCredential`, add the back-relation on `Person`)
- Create: `prisma/migrations/<timestamp>_add_service_credential/migration.sql` (generated)
- Create: `src/modules/passport/services/credential.ts`
- Test: `src/modules/passport/services/credential.test.ts`

**Interfaces:**
- Consumes: `computeServiceRecord`, `ServiceRecord`, `PrismaClientOrTx` from Task 1.
- Produces: `issueServiceCredential(personId, client?): Promise<IssuedCredential>`, `getCredential(personId): Promise<IssuedCredential | null>`, type `IssuedCredential`.

- [ ] **Step 1: Add the model**

In `prisma/schema.prisma`, add to `model Person` alongside the other relations:

```prisma
  serviceCredential              ServiceCredential?
```

And add the model:

```prisma
/// A member's service record, frozen at issuance. One row per person, re-issued
/// in place when the member regenerates.
///
/// The record is stored rather than recomputed on read so that the certificate
/// PDF and the public credential page always agree, and so a public URL can
/// never surface a record the member did not publish (a corrected term, a
/// department they left, a shift count that moved).
model ServiceCredential {
  id          String    @id @default(cuid())
  personId    String    @unique
  /// Unguessable public token. Null until the member opts into publishing, and
  /// nulled again on unpublish, which is what makes the public page 404.
  publicToken String?   @unique
  /// The full ServiceRecord as issued. Never recomputed on read.
  record      Json
  issuedAt    DateTime  @default(now())
  /// Set only by a deliberate admin revocation (falsified service, record issued
  /// in error). Offboarding does NOT set this: the credential is a past-tense
  /// claim and a member who graduates normally did serve those terms.
  revokedAt   DateTime?
  person      Person    @relation(fields: [personId], references: [id], onDelete: Cascade)
}
```

- [ ] **Step 2: Generate the migration**

```bash
npx prisma migrate dev --name add_service_credential
```

Open the generated `migration.sql` and confirm it contains ONLY the `CREATE TABLE "ServiceCredential"` plus its two unique indexes and the foreign key. Delete any other statement: `migrate dev` folds pre-existing schema drift into whatever migration you happen to be generating.

- [ ] **Step 3: Write the failing test**

Create `src/modules/passport/services/credential.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { getCredential, issueServiceCredential } from "./credential";

async function seedMember() {
  const person = await prisma.person.create({ data: { name: "Ada Lovelace" } });
  const dept = await prisma.department.upsert({
    where: { code: "ITCM" },
    update: {},
    create: { code: "ITCM", name: "Internal Medicine" },
  });
  const term = await prisma.term.create({
    data: {
      code: "SU26",
      name: "Summer 2026",
      startDate: new Date("2026-05-01T12:00:00Z"),
      endDate: new Date("2026-08-31T12:00:00Z"),
      status: "ACTIVE",
    },
  });
  await prisma.termMembership.create({
    data: { personId: person.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER" },
  });
  return { person, term, dept };
}

describe("issueServiceCredential", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("stores the computed record and returns it", async () => {
    const { person } = await seedMember();

    const issued = await issueServiceCredential(person.id);

    expect(issued.record.name).toBe("Ada Lovelace");
    expect(issued.record.terms).toHaveLength(1);
    expect(issued.publicToken).toBeNull();
    expect(issued.revokedAt).toBeNull();

    const row = await prisma.serviceCredential.findUnique({ where: { personId: person.id } });
    expect(row).not.toBeNull();
  });

  it("re-issues in place rather than creating a second row", async () => {
    const { person, dept } = await seedMember();
    await issueServiceCredential(person.id);

    const second = await prisma.term.create({
      data: {
        code: "FA26",
        name: "Fall 2026",
        startDate: new Date("2026-09-01T12:00:00Z"),
        endDate: new Date("2026-12-20T12:00:00Z"),
        status: "ACTIVE",
      },
    });
    await prisma.termMembership.create({
      data: { personId: person.id, termId: second.id, departmentId: dept.id, kind: "DIRECTOR" },
    });

    const reissued = await issueServiceCredential(person.id);

    expect(reissued.record.terms).toHaveLength(2);
    expect(await prisma.serviceCredential.count()).toBe(1);
  });

  it("preserves the public token across a re-issue", async () => {
    const { person } = await seedMember();
    await issueServiceCredential(person.id);
    await prisma.serviceCredential.update({
      where: { personId: person.id },
      data: { publicToken: "tok_existing" },
    });

    const reissued = await issueServiceCredential(person.id);

    expect(reissued.publicToken).toBe("tok_existing");
  });

  it("returns JSON-safe data", async () => {
    const { person } = await seedMember();

    const issued = await issueServiceCredential(person.id);

    expect(JSON.parse(JSON.stringify(issued))).toEqual(issued);
  });
});

describe("getCredential", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("returns null when nothing has been issued", async () => {
    const { person } = await seedMember();
    expect(await getCredential(person.id)).toBeNull();
  });

  it("returns the issued credential", async () => {
    const { person } = await seedMember();
    await issueServiceCredential(person.id);

    const found = await getCredential(person.id);

    expect(found!.record.name).toBe("Ada Lovelace");
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run src/modules/passport/services/credential.test.ts`
Expected: FAIL, cannot resolve `./credential`.

- [ ] **Step 5: Write the implementation**

Create `src/modules/passport/services/credential.ts`:

```ts
/**
 * Issuing and reading a member's service credential.
 *
 * Issuance SNAPSHOTS the computed record (see service-record.ts). Nothing in the
 * app renders a live computation: the certificate PDF and the public credential
 * page both read this frozen JSON, which is what keeps them in agreement and
 * what stops a public URL from surfacing a record the member never published.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import {
  computeServiceRecord,
  type PrismaClientOrTx,
  type ServiceRecord,
} from "./service-record";

export type IssuedCredential = {
  id: string;
  record: ServiceRecord;
  publicToken: string | null;
  issuedAt: string;
  revokedAt: string | null;
};

function toIssued(row: {
  id: string;
  record: Prisma.JsonValue;
  publicToken: string | null;
  issuedAt: Date;
  revokedAt: Date | null;
}): IssuedCredential {
  return {
    id: row.id,
    record: row.record as unknown as ServiceRecord,
    publicToken: row.publicToken,
    issuedAt: row.issuedAt.toISOString(),
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
  };
}

/**
 * Compute and freeze the member's record. Re-issuing updates the existing row in
 * place and deliberately preserves publicToken, so regenerating does not break a
 * link the member has already shared.
 *
 * Pass `client` to snapshot inside a caller's transaction (the offboard hook
 * does this, so a graduating member's final term is captured before their
 * membership is flipped to REMOVED).
 */
export async function issueServiceCredential(
  personId: string,
  client: PrismaClientOrTx = prisma,
): Promise<IssuedCredential> {
  const record = await computeServiceRecord(personId, client);
  const serialized = record as unknown as Prisma.InputJsonValue;

  const row = await client.serviceCredential.upsert({
    where: { personId },
    create: { personId, record: serialized },
    update: { record: serialized, issuedAt: new Date() },
    select: { id: true, record: true, publicToken: true, issuedAt: true, revokedAt: true },
  });

  await recordAudit({
    actorPersonId: personId,
    action: "passport.issue",
    entityType: "ServiceCredential",
    entityId: row.id,
  });

  return toIssued(row);
}

export async function getCredential(personId: string): Promise<IssuedCredential | null> {
  const row = await prisma.serviceCredential.findUnique({
    where: { personId },
    select: { id: true, record: true, publicToken: true, issuedAt: true, revokedAt: true },
  });
  return row ? toIssued(row) : null;
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run src/modules/passport/services/credential.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 7: Lint and commit**

```bash
npx eslint src
git add prisma/schema.prisma prisma/migrations src/modules/passport/services/credential.ts src/modules/passport/services/credential.test.ts
git commit -m "feat(passport): snapshot the service record into an issued credential"
```

---

### Task 3: Snapshot on offboard, before memberships flip

**Files:**
- Modify: `src/platform/people.ts` (inside the `OFFBOARDED` branch of `setPersonStatusField`, before `termMembership.updateMany`)
- Test: `src/modules/passport/services/offboard-snapshot.test.ts`

**Interfaces:**
- Consumes: `issueServiceCredential(personId, client)` from Task 2.
- Produces: no new exports. Behavior only.

**Why this task exists:** `OFFBOARDABLE_TERM` (`src/platform/people.ts:39`) scopes the offboard sweep to non-archived terms, so offboarding flips the CURRENT term's membership to `REMOVED`. A record computed after that point silently loses the member's final term, which is the one a graduating student most wants on their certificate.

- [ ] **Step 1: Write the failing test**

Create `src/modules/passport/services/offboard-snapshot.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { setPersonStatus } from "@/platform/people";
import { getCredential } from "./credential";
import { computeServiceRecord } from "./service-record";

async function seedActiveMember() {
  const person = await prisma.person.create({ data: { name: "Ada Lovelace" } });
  const dept = await prisma.department.upsert({
    where: { code: "ITCM" },
    update: {},
    create: { code: "ITCM", name: "Internal Medicine" },
  });
  const term = await prisma.term.create({
    data: {
      code: "SU26",
      name: "Summer 2026",
      startDate: new Date("2026-05-01T12:00:00Z"),
      endDate: new Date("2026-08-31T12:00:00Z"),
      status: "ACTIVE",
    },
  });
  await prisma.termMembership.create({
    data: { personId: person.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER" },
  });
  return person;
}

describe("offboarding snapshots the service record first", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("captures the current term before the membership is flipped to REMOVED", async () => {
    const person = await seedActiveMember();

    await setPersonStatus(person.id, "OFFBOARDED");

    // The membership really was removed ...
    const memberships = await prisma.termMembership.findMany({ where: { personId: person.id } });
    expect(memberships.every((m) => m.status === "REMOVED")).toBe(true);

    // ... and a live recomputation would now show nothing ...
    const live = await computeServiceRecord(person.id);
    expect(live.terms).toHaveLength(0);

    // ... but the snapshot taken during offboarding still has the final term.
    const credential = await getCredential(person.id);
    expect(credential!.record.terms).toHaveLength(1);
    expect(credential!.record.terms[0].termCode).toBe("SU26");
  });

  it("does not issue a credential when the status change is not an offboard", async () => {
    const person = await seedActiveMember();

    await setPersonStatus(person.id, "ACTIVE");

    expect(await getCredential(person.id)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/modules/passport/services/offboard-snapshot.test.ts`
Expected: FAIL on the first test, `credential` is null.

Note: if `setPersonStatus` is not the exported name in `src/platform/people.ts`, read the file and use the exported offboard entry point. The test must exercise the real transaction, not `setPersonStatusField` internals.

- [ ] **Step 3: Write the implementation**

In `src/platform/people.ts`, add the import at the top:

```ts
import { issueServiceCredential } from "@/modules/passport/services/credential";
```

Then inside the `if (status === "OFFBOARDED")` branch of the `prisma.$transaction` callback, immediately BEFORE the `tx.termMembership.updateMany` call that sets `REMOVED`:

```ts
      // Freeze the service record while the current term's membership is still
      // ACTIVE. OFFBOARDABLE_TERM scopes the sweep below to non-archived terms,
      // so a graduating member's final term is about to become REMOVED and a
      // record computed after this point would silently omit it.
      //
      // Best-effort: a credential failure must never block an offboard, which is
      // a safety-relevant operation (it revokes access). Log and continue.
      try {
        await issueServiceCredential(personId, tx);
      } catch (error) {
        log.error("[passport] offboard snapshot failed", errorAttrs(error, { personId }));
      }
```

Confirm `log` and `errorAttrs` are already imported in `people.ts`; if not, add `import { log, errorAttrs } from "@/platform/logging";`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/modules/passport/services/offboard-snapshot.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Run the surrounding suites to check nothing regressed**

Run: `npx vitest run src/platform/people.test.ts src/modules/my-info`
Expected: PASS. Offboarding is widely exercised; a new write inside its transaction is exactly the kind of change that surfaces here.

- [ ] **Step 6: Lint and commit**

```bash
npx eslint src
git add src/platform/people.ts src/modules/passport/services/offboard-snapshot.test.ts
git commit -m "feat(passport): snapshot the service record before offboarding removes memberships"
```

---

### Task 4: Render the certificate PDF

**Files:**
- Create: `src/modules/passport/components/passport-pdf.tsx`
- Test: `src/modules/passport/components/passport-pdf.test.ts`

**Interfaces:**
- Consumes: `ServiceRecord` from Task 1.
- Produces: `PassportDocument` (a React component taking `{ record, orgName, brandColor, credentialUrl }`) and `formatShifts(shifts: number | null): string`.

- [ ] **Step 1: Write the failing test**

Create `src/modules/passport/components/passport-pdf.test.ts`:

```ts
import { createElement } from "react";
import { renderToBuffer, type DocumentProps } from "@react-pdf/renderer";
import { describe, expect, it } from "vitest";
import type { ReactElement } from "react";
import type { ServiceRecord } from "../services/service-record";
import { PassportDocument, formatShifts } from "./passport-pdf";

const RECORD: ServiceRecord = {
  name: "Ada Lovelace",
  memberSince: { label: "Fall 2023 Volunteer Recruitment", source: "RECRUITMENT" },
  terms: [
    {
      termCode: "FA23",
      termName: "Fall 2023 Volunteer Recruitment",
      startDate: "2023-09-15T12:00:00.000Z",
      departmentName: "Internal Medicine",
      track: "VOLUNTEER",
      shifts: null,
      source: "RECRUITMENT",
    },
    {
      termCode: "SU26",
      termName: "Summer 2026",
      startDate: "2026-05-01T12:00:00.000Z",
      departmentName: "Internal Medicine",
      track: "DIRECTOR",
      shifts: 14,
      source: "MEMBERSHIP",
    },
  ],
  capabilities: { spanishVerified: true, licensedRN: false },
  basis: "SCHEDULED",
  generatedAt: "2026-08-07T12:00:00.000Z",
};

describe("formatShifts", () => {
  it("renders a real count", () => {
    expect(formatShifts(14)).toBe("14 scheduled");
  });

  it("renders zero as an explicit zero, not as missing data", () => {
    expect(formatShifts(0)).toBe("0 scheduled");
  });

  it("renders missing shift data as a dash, never as zero", () => {
    expect(formatShifts(null)).toBe("Not recorded");
  });
});

describe("PassportDocument", () => {
  it("renders to a PDF buffer", async () => {
    const buffer = await renderToBuffer(
      createElement(PassportDocument, {
        record: RECORD,
        orgName: "HAVEN Free Clinic",
        brandColor: "#00356b",
        credentialUrl: null,
      }) as ReactElement<DocumentProps>,
    );

    expect(buffer.byteLength).toBeGreaterThan(1000);
    expect(buffer.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("renders with a credential URL without throwing", async () => {
    const buffer = await renderToBuffer(
      createElement(PassportDocument, {
        record: RECORD,
        orgName: "HAVEN Free Clinic",
        brandColor: "#00356b",
        credentialUrl: "https://hub.example.org/credential/abc",
      }) as ReactElement<DocumentProps>,
    );

    expect(buffer.byteLength).toBeGreaterThan(1000);
  });

  it("renders an empty record without throwing", async () => {
    const empty: ServiceRecord = {
      name: "New Member",
      memberSince: null,
      terms: [],
      capabilities: { spanishVerified: false, licensedRN: false },
      basis: "SCHEDULED",
      generatedAt: "2026-08-07T12:00:00.000Z",
    };

    const buffer = await renderToBuffer(
      createElement(PassportDocument, {
        record: empty,
        orgName: "HAVEN Free Clinic",
        brandColor: "#00356b",
        credentialUrl: null,
      }) as ReactElement<DocumentProps>,
    );

    expect(buffer.subarray(0, 4).toString()).toBe("%PDF");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/modules/passport/components/passport-pdf.test.ts`
Expected: FAIL, cannot resolve `./passport-pdf`.

- [ ] **Step 3: Write the implementation**

Create `src/modules/passport/components/passport-pdf.tsx`, following the structure of `src/modules/clinic/avs/avs-pdf.tsx`:

```tsx
import { Fragment } from "react";
import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import type { ServiceRecord, ServiceTermRow } from "../services/service-record";

const INK = "#1c2b2d";
const MUTED = "#5c7073";
const RULE = "#d8e0e1";

/**
 * A term with no shift records must never read as a zero. "Not recorded" says
 * the clinic was not counting; "0 scheduled" says the member held no shifts.
 * Collapsing the two would understate a long-serving member on a document that
 * goes to residency programs.
 */
export function formatShifts(shifts: number | null): string {
  return shifts === null ? "Not recorded" : `${shifts} scheduled`;
}

function trackLabel(track: ServiceTermRow["track"]): string {
  return track === "DIRECTOR" ? "Director" : "Volunteer";
}

const styles = StyleSheet.create({
  page: { padding: 48, fontSize: 10, color: INK, fontFamily: "Helvetica" },
  org: { fontSize: 9, letterSpacing: 1, color: MUTED, textTransform: "uppercase" },
  title: { fontSize: 20, marginTop: 6, marginBottom: 2 },
  name: { fontSize: 15, marginTop: 14 },
  since: { fontSize: 10, color: MUTED, marginTop: 2 },
  sectionHeading: { fontSize: 9, letterSpacing: 1, color: MUTED, textTransform: "uppercase", marginTop: 24, marginBottom: 6 },
  headRow: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: INK, paddingBottom: 4 },
  row: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: RULE, paddingVertical: 6 },
  cTerm: { width: "34%" },
  cDept: { width: "30%" },
  cRole: { width: "18%" },
  cShifts: { width: "18%", textAlign: "right" },
  provenance: { fontSize: 8, color: MUTED },
  note: { fontSize: 8, color: MUTED, marginTop: 16, lineHeight: 1.5 },
  footer: { position: "absolute", bottom: 36, left: 48, right: 48, fontSize: 8, color: MUTED },
});

export function PassportDocument({
  record,
  orgName,
  brandColor,
  credentialUrl,
}: {
  record: ServiceRecord;
  orgName: string;
  brandColor: string;
  credentialUrl: string | null;
}) {
  const issued = new Date(record.generatedAt).toISOString().slice(0, 10);
  const capabilities = [
    record.capabilities.spanishVerified ? "Spanish (verified by the interpreting department)" : null,
    record.capabilities.licensedRN ? "Licensed RN (self-reported)" : null,
  ].filter((c): c is string => Boolean(c));

  return (
    <Document title={`Service record for ${record.name}`}>
      <Page size="LETTER" style={styles.page}>
        <Text style={styles.org}>{orgName}</Text>
        <Text style={{ ...styles.title, color: brandColor }}>Record of Service</Text>

        <Text style={styles.name}>{record.name}</Text>
        {record.memberSince ? (
          <Text style={styles.since}>Member since {record.memberSince.label}</Text>
        ) : null}

        <Text style={styles.sectionHeading}>Service history</Text>
        <View style={styles.headRow}>
          <Text style={styles.cTerm}>Term</Text>
          <Text style={styles.cDept}>Department</Text>
          <Text style={styles.cRole}>Role</Text>
          <Text style={styles.cShifts}>Clinic shifts</Text>
        </View>
        {record.terms.length === 0 ? (
          <View style={styles.row}>
            <Text style={styles.provenance}>No service recorded.</Text>
          </View>
        ) : (
          record.terms.map((row) => (
            <Fragment key={`${row.source}-${row.termCode}`}>
              <View style={styles.row}>
                <View style={styles.cTerm}>
                  <Text>{row.termName}</Text>
                  {row.source === "RECRUITMENT" ? (
                    <Text style={styles.provenance}>Joined via recruitment</Text>
                  ) : null}
                </View>
                <Text style={styles.cDept}>{row.departmentName}</Text>
                <Text style={styles.cRole}>{trackLabel(row.track)}</Text>
                <Text style={styles.cShifts}>{formatShifts(row.shifts)}</Text>
              </View>
            </Fragment>
          ))
        )}

        {capabilities.length > 0 ? (
          <Fragment>
            <Text style={styles.sectionHeading}>Verified capabilities</Text>
            {capabilities.map((c) => (
              <Text key={c}>{c}</Text>
            ))}
          </Fragment>
        ) : null}

        <Text style={styles.note}>
          Clinic shift counts reflect published schedule assignments, not attendance. Terms marked
          &quot;Not recorded&quot; predate {orgName}&apos;s scheduling records and carry no shift count;
          this reflects the clinic&apos;s record-keeping history, not the member&apos;s service.
        </Text>

        <Text style={styles.footer} fixed>
          Issued {issued} by {orgName}.
          {credentialUrl ? ` Verify at ${credentialUrl}` : ""}
        </Text>
      </Page>
    </Document>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/modules/passport/components/passport-pdf.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Lint and commit**

```bash
npx eslint src
git add src/modules/passport/components/passport-pdf.tsx src/modules/passport/components/passport-pdf.test.ts
git commit -m "feat(passport): render the service record as a certificate PDF"
```

---

### Task 5: Wire the /my-info service record card

**Files:**
- Create: `src/modules/passport/components/service-record-card.tsx` (client component)
- Modify: `src/app/(app)/my-info/page.tsx`
- Test: `e2e/my-info.spec.ts` (add a case)

**Interfaces:**
- Consumes: `issueServiceCredential` and `getCredential` (Task 2), `PassportDocument` (Task 4).
- Produces: `ServiceRecordCard` component; a server action `issueAction(): Promise<IssuedCredential>` defined in the page.

- [ ] **Step 1: Write the client component**

Create `src/modules/passport/components/service-record-card.tsx`. The PDF import is dynamic and the blob URL revocation is deferred, both matching `avs-tool.tsx`:

```tsx
"use client";

import { useState } from "react";
import { Button } from "@/platform/ui/button";
import { Card } from "@/platform/ui/card";
import { Alert } from "@/platform/ui/alert";
import type { IssuedCredential } from "../services/credential";

export function ServiceRecordCard({
  orgName,
  brandColor,
  issue,
}: {
  orgName: string;
  brandColor: string;
  /** Server action: freezes the record and returns the snapshot. */
  issue: () => Promise<IssuedCredential>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    setBusy(true);
    setError(null);
    try {
      const credential = await issue();
      const { pdf } = await import("@react-pdf/renderer");
      const { PassportDocument } = await import("./passport-pdf");
      const blob = await pdf(
        <PassportDocument
          record={credential.record}
          orgName={orgName}
          brandColor={brandColor}
          credentialUrl={null}
        />,
      ).toBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `Service-record-${credential.record.name.replace(/\s+/g, "-")}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Deferred: revoking in the same tick as click() can invalidate the URL
      // before the browser starts the download (Firefox/Safari).
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch {
      setError("Could not generate your service record. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h2 className="text-lg font-semibold">Service record</h2>
      <p className="mt-1 text-sm text-fg-muted">
        A dated certificate of your terms, departments, roles, and clinic shifts, suitable for
        residency and fellowship applications.
      </p>
      {error ? (
        <div className="mt-3">
          <Alert variant="error">{error}</Alert>
        </div>
      ) : null}
      <div className="mt-4">
        <Button onClick={download} disabled={busy}>
          {busy ? "Preparing..." : "Download certificate"}
        </Button>
      </div>
    </Card>
  );
}
```

Before running, open `src/platform/ui/card.tsx`, `button.tsx`, and `alert.tsx` and confirm the prop names used here (`variant="error"` on Alert, `onClick`/`disabled` on Button). Adjust to match; do not add a new variant.

- [ ] **Step 2: Wire it into the page**

In `src/app/(app)/my-info/page.tsx`, add imports:

```ts
import { getSetting } from "@/platform/settings/service";
import { issueServiceCredential, type IssuedCredential } from "@/modules/passport/services/credential";
import { ServiceRecordCard } from "@/modules/passport/components/service-record-card";
```

Add the setting to the existing parallel fetch, then define the action and render the card alongside the other cards:

```tsx
  const [brandColor, orgName] = await Promise.all([
    getSetting<string>("branding.brandColor"),
    getSetting<string>("branding.orgName"),
  ]);

  async function issueAction(): Promise<IssuedCredential> {
    "use server";
    const session = await requireModuleAccess("my-info");
    return issueServiceCredential(session.personId);
  }
```

```tsx
      <ServiceRecordCard orgName={orgName} brandColor={brandColor} issue={issueAction} />
```

The action re-derives `personId` from the session rather than accepting it as an argument, matching `updateAction` in the same file. A client-supplied person id would let any member issue a credential for anyone.

- [ ] **Step 3: Add the e2e case**

Append to `e2e/my-info.spec.ts`, following the existing login helper usage in that file:

```ts
test("a member can download their service record", async ({ page }) => {
  await loginAs(page, "volunteer");
  await page.goto("/my-info");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download certificate" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toContain("Service-record");
});
```

`loginAs` comes from `e2e/auth.ts` and is almost certainly already imported at the top of `my-info.spec.ts`; check before adding a duplicate import. Without it the test would run signed out and be redirected to `/login`, which is the failure mode this note exists to prevent.

- [ ] **Step 4: Run typecheck, lint, and the e2e**

```bash
npx tsc --noEmit
npx eslint src e2e
```

Expected: both pass. Do NOT run Playwright (see Global Constraints: the local e2e server points at production). The spec file is authored here and verified by CI.

- [ ] **Step 5: Commit**

```bash
git add src/modules/passport/components/service-record-card.tsx "src/app/(app)/my-info/page.tsx" e2e/my-info.spec.ts
git commit -m "feat(passport): let a member download their service record from /my-info"
```

---

### Task 6: Publish and unpublish a credential token

**Files:**
- Modify: `src/modules/passport/services/credential.ts`
- Modify: `src/modules/passport/services/credential.test.ts`
- Modify: `src/platform/posthog/scrub-url.ts`
- Modify: `src/platform/posthog/scrub-url.test.ts`

**Interfaces:**
- Consumes: `issueServiceCredential`, `getCredential` (Task 2).
- Produces: `publishCredential(personId): Promise<string>` returning the token, `unpublishCredential(personId): Promise<void>`, `getCredentialByToken(token): Promise<IssuedCredential | null>`.

- [ ] **Step 1: Write the failing tests**

Add to `src/modules/passport/services/credential.test.ts`:

```ts
import { getCredentialByToken, publishCredential, unpublishCredential } from "./credential";

describe("publishing", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("mints an unguessable token and makes the credential findable by it", async () => {
    const { person } = await seedMember();
    await issueServiceCredential(person.id);

    const token = await publishCredential(person.id);

    expect(token.length).toBeGreaterThanOrEqual(32);
    const found = await getCredentialByToken(token);
    expect(found!.record.name).toBe("Ada Lovelace");
  });

  it("is idempotent: publishing twice keeps the same token", async () => {
    const { person } = await seedMember();
    await issueServiceCredential(person.id);

    const first = await publishCredential(person.id);
    const second = await publishCredential(person.id);

    expect(second).toBe(first);
  });

  it("issues the credential first when the member has never generated one", async () => {
    const { person } = await seedMember();

    const token = await publishCredential(person.id);

    expect(await getCredentialByToken(token)).not.toBeNull();
  });

  it("unpublishing makes the token stop resolving", async () => {
    const { person } = await seedMember();
    const token = await publishCredential(person.id);

    await unpublishCredential(person.id);

    expect(await getCredentialByToken(token)).toBeNull();
  });

  it("does not resolve a revoked credential", async () => {
    const { person } = await seedMember();
    const token = await publishCredential(person.id);
    await prisma.serviceCredential.update({
      where: { personId: person.id },
      data: { revokedAt: new Date() },
    });

    expect(await getCredentialByToken(token)).toBeNull();
  });
});
```

Add to `src/platform/posthog/scrub-url.test.ts`:

```ts
it("redacts a credential token in the path", () => {
  expect(scrubPath("/credential/abc123def")).toBe("/credential/[redacted]");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/modules/passport/services/credential.test.ts src/platform/posthog/scrub-url.test.ts`
Expected: FAIL on the new cases.

- [ ] **Step 3: Add the scrub prefix**

In `src/platform/posthog/scrub-url.ts`, extend the constant and its doc comment:

```ts
/** Path prefixes whose NEXT segment is a credential, not an identifier. */
const SECRET_PATH_PREFIXES = ["/onboard/", "/credential/"];
```

Add to the file's header comment, in the list of routes that carry a live credential in the URL:

```
 *   /credential/<token>       published service record, no expiry until unpublished
```

- [ ] **Step 4: Implement publish, unpublish, and lookup**

Add to `src/modules/passport/services/credential.ts`:

```ts
import { randomBytes } from "node:crypto";
```

```ts
/**
 * 32 random bytes, base64url. The public credential page is unauthenticated, so
 * this token is the only thing standing between a URL and a member's name and
 * service history. It must never be derived from the person id or anything
 * else enumerable.
 *
 * The token also travels in a URL path, which posthog-js captures verbatim on
 * every pageview, so "/credential/" is registered in the PostHog scrub list
 * (src/platform/posthog/scrub-url.ts). That scrub is load-bearing, not cosmetic.
 */
function mintToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Publish the member's credential and return its public token, issuing the
 * credential first if they have never generated one. Idempotent: an
 * already-published credential keeps its token so a shared link never breaks.
 */
export async function publishCredential(personId: string): Promise<string> {
  const existing = await getCredential(personId);
  if (!existing) await issueServiceCredential(personId);
  if (existing?.publicToken) return existing.publicToken;

  const token = mintToken();
  await prisma.serviceCredential.update({
    where: { personId },
    data: { publicToken: token },
  });
  await recordAudit({
    actorPersonId: personId,
    action: "passport.publish",
    entityType: "ServiceCredential",
    entityId: personId,
  });
  return token;
}

/** Retract the public URL. The credential itself survives; only the token is dropped. */
export async function unpublishCredential(personId: string): Promise<void> {
  await prisma.serviceCredential.updateMany({
    where: { personId },
    data: { publicToken: null },
  });
  await recordAudit({
    actorPersonId: personId,
    action: "passport.unpublish",
    entityType: "ServiceCredential",
    entityId: personId,
  });
}

/**
 * Resolve a published credential for the PUBLIC page. Returns null for an
 * unknown token, an unpublished credential, or a revoked one, so every one of
 * those cases renders the same 404 and the page never distinguishes "wrong
 * token" from "retracted".
 */
export async function getCredentialByToken(token: string): Promise<IssuedCredential | null> {
  if (!token) return null;
  const row = await prisma.serviceCredential.findUnique({
    where: { publicToken: token },
    select: { id: true, record: true, publicToken: true, issuedAt: true, revokedAt: true },
  });
  if (!row || row.revokedAt) return null;
  return toIssued(row);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/modules/passport/services/credential.test.ts src/platform/posthog/scrub-url.test.ts`
Expected: PASS.

- [ ] **Step 6: Lint and commit**

```bash
npx eslint src
git add src/modules/passport/services/credential.ts src/modules/passport/services/credential.test.ts src/platform/posthog/scrub-url.ts src/platform/posthog/scrub-url.test.ts
git commit -m "feat(passport): publish a credential behind an unguessable token, scrubbed from analytics"
```

---

### Task 7: The public credential page

**Files:**
- Create: `src/app/credential/[token]/page.tsx`
- Create: `src/app/credential/[token]/not-found.tsx`
- Modify: `src/modules/passport/components/service-record-card.tsx` (publish controls)
- Modify: `src/app/(app)/my-info/page.tsx` (publish and unpublish actions, pass current token)
- Test: `e2e/credential-page.spec.ts`

**Interfaces:**
- Consumes: `getCredentialByToken`, `publishCredential`, `unpublishCredential` (Task 6).
- Produces: the public route. No new exported functions.

**Placement matters:** this page lives OUTSIDE the `(app)` route group. That is what keeps it clear of `requirePersonSession` and the onboarding gate structurally, without an allowlist entry, matching `/apply`, `/login`, and `/welcome`. Never add an `(app)` path to the onboarding allowlist to make a page public.

- [ ] **Step 1: Write the failing e2e**

Create `e2e/credential-page.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { cleanupPerson, prisma, tag } from "./fixtures";

test.describe("public credential page", () => {
  let personId: string;
  let token: string;

  test.beforeAll(async () => {
    token = `e2e-token-${tag()}`;
    const person = await prisma.person.create({ data: { name: `Credential Member ${tag()}` } });
    personId = person.id;
    await prisma.serviceCredential.create({
      data: {
        personId,
        publicToken: token,
        record: {
          name: person.name,
          memberSince: { label: "Summer 2026", source: "MEMBERSHIP" },
          terms: [
            {
              termCode: "SU26",
              termName: "Summer 2026",
              startDate: "2026-05-01T12:00:00.000Z",
              departmentName: "Internal Medicine",
              track: "VOLUNTEER",
              shifts: 4,
              source: "MEMBERSHIP",
            },
          ],
          capabilities: { spanishVerified: false, licensedRN: false },
          basis: "SCHEDULED",
          generatedAt: "2026-08-07T12:00:00.000Z",
        },
      },
    });
  });

  test.afterAll(async () => {
    await prisma.serviceCredential.deleteMany({ where: { personId } });
    await cleanupPerson(personId);
  });

  test("an unknown token renders not found", async ({ page }) => {
    const response = await page.goto("/credential/definitely-not-a-real-token");
    expect(response?.status()).toBe(404);
  });

  test("a published credential renders without a session", async ({ browser }) => {
    // A fresh context with no storage state: the whole point is that this works
    // signed out. If the route ever drifts inside the (app) group, this fails.
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    await page.goto(`/credential/${token}`);
    await expect(page.getByRole("heading", { name: "Record of Service" })).toBeVisible();
    await expect(page.getByText("Internal Medicine")).toBeVisible();
    await context.close();
  });
});
```

`cleanupPerson` does not know about `ServiceCredential`, which is why the credential row is deleted first. Consider adding the delete to `cleanupPerson` itself so future specs do not have to remember it.

- [ ] **Step 2: Confirm the spec typechecks**

Run: `npx tsc --noEmit`
Expected: PASS.

Do NOT run Playwright (see Global Constraints: the local e2e server points at production Neon). This task's red-green cycle runs on the Vitest tests instead; the e2e is authored here and verified by CI. The `prisma.serviceCredential.create` call in the spec is the meaningful typecheck here: it fails to compile until the Task 2 model exists.

- [ ] **Step 3: Write the page**

Create `src/app/credential/[token]/page.tsx`:

```tsx
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { buildPageMetadata } from "@/platform/branding/metadata";
import { getSetting } from "@/platform/settings/service";
import { getCredentialByToken } from "@/modules/passport/services/credential";
import { formatShifts } from "@/modules/passport/components/passport-pdf";

export const dynamic = "force-dynamic";

/**
 * Public, unauthenticated verification page for a member's service record.
 *
 * Deliberately outside the (app) route group so it never inherits
 * requirePersonSession or the onboarding gate. Rendered from the SNAPSHOT, never
 * a live computation, so this URL can only ever show what the member published.
 */
export async function generateMetadata(): Promise<Metadata> {
  const base = await buildPageMetadata({
    title: "Record of Service",
    description: "A verified record of clinic service.",
  });
  // Never indexed: this page carries a real person's name and affiliation.
  return { ...base, robots: { index: false, follow: false } };
}

export default async function CredentialPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const credential = await getCredentialByToken(token);
  if (!credential) notFound();

  const orgName = await getSetting<string>("branding.orgName");
  const { record } = credential;
  const issued = new Date(credential.issuedAt).toISOString().slice(0, 10);

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <p className="text-xs uppercase tracking-widest text-fg-muted">{orgName}</p>
      <h1 className="mt-2 text-2xl font-semibold">Record of Service</h1>

      <p className="mt-8 text-lg">{record.name}</p>
      {record.memberSince ? (
        <p className="text-sm text-fg-muted">Member since {record.memberSince.label}</p>
      ) : null}

      <h2 className="mt-10 text-xs uppercase tracking-widest text-fg-muted">Service history</h2>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-fg text-left">
              <th className="py-2 font-normal">Term</th>
              <th className="py-2 font-normal">Department</th>
              <th className="py-2 font-normal">Role</th>
              <th className="py-2 text-right font-normal">Clinic shifts</th>
            </tr>
          </thead>
          <tbody>
            {record.terms.map((row) => (
              <tr key={`${row.source}-${row.termCode}`} className="border-b border-subtle">
                <td className="py-2">
                  {row.termName}
                  {row.source === "RECRUITMENT" ? (
                    <span className="block text-xs text-fg-muted">Joined via recruitment</span>
                  ) : null}
                </td>
                <td className="py-2">{row.departmentName}</td>
                <td className="py-2">{row.track === "DIRECTOR" ? "Director" : "Volunteer"}</td>
                <td className="py-2 text-right">{formatShifts(row.shifts)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-10 text-xs leading-relaxed text-fg-muted">
        Clinic shift counts reflect published schedule assignments, not attendance. Terms marked
        &quot;Not recorded&quot; predate {orgName}&apos;s scheduling records. Issued {issued} by{" "}
        {orgName}.
      </p>
    </main>
  );
}
```

Check the utility class names against an existing public page (`src/app/welcome/page.tsx` or the login page) and use whatever this codebase's tokens actually are for muted foreground and subtle borders. Do not invent token names.

Create `src/app/credential/[token]/not-found.tsx`:

```tsx
export default function CredentialNotFound() {
  return (
    <main className="mx-auto max-w-md px-6 py-24 text-center">
      <h1 className="text-xl font-semibold">Record not available</h1>
      <p className="mt-2 text-sm text-fg-muted">
        This link is no longer active, or it was never published.
      </p>
    </main>
  );
}
```

- [ ] **Step 4: Add the publish controls**

In `src/app/(app)/my-info/page.tsx`, add two more actions and pass the current token in:

```tsx
  async function publishAction(): Promise<string> {
    "use server";
    const session = await requireModuleAccess("my-info");
    return publishCredential(session.personId);
  }

  async function unpublishAction(): Promise<void> {
    "use server";
    const session = await requireModuleAccess("my-info");
    await unpublishCredential(session.personId);
  }
```

Load the existing credential for the initial state and pass it plus a base URL:

```tsx
  const existingCredential = await getCredential(person.personId);
  const baseUrl = await getSetting<string>("app.baseUrl");
```

```tsx
      <ServiceRecordCard
        orgName={orgName}
        brandColor={brandColor}
        baseUrl={baseUrl}
        initialToken={existingCredential?.publicToken ?? null}
        issue={issueAction}
        publish={publishAction}
        unpublish={unpublishAction}
      />
```

In `service-record-card.tsx`, extend the props and add the publish UI. The QR on the PDF is wired here by passing `credentialUrl` when a token exists:

```tsx
export function ServiceRecordCard({
  orgName,
  brandColor,
  baseUrl,
  initialToken,
  issue,
  publish,
  unpublish,
}: {
  orgName: string;
  brandColor: string;
  baseUrl: string;
  initialToken: string | null;
  issue: () => Promise<IssuedCredential>;
  publish: () => Promise<string>;
  unpublish: () => Promise<void>;
}) {
  const [token, setToken] = useState<string | null>(initialToken);
```

The `credentialUrl` passed to `PassportDocument` becomes:

```tsx
          credentialUrl={token ? `${baseUrl}/credential/${token}` : null}
```

And add below the download button:

```tsx
      <div className="mt-4 border-t border-subtle pt-4">
        {token ? (
          <>
            <p className="text-sm">
              Your record is published at{" "}
              <code className="break-all">{`${baseUrl}/credential/${token}`}</code>
            </p>
            <p className="mt-1 text-xs text-fg-muted">
              Anyone with this link can see your name and service history. It is not listed in search
              engines.
            </p>
            <Button
              className="mt-3"
              onClick={async () => {
                await unpublish();
                setToken(null);
              }}
            >
              Unpublish
            </Button>
          </>
        ) : (
          <>
            <p className="text-sm text-fg-muted">
              Publishing creates a shareable link that verifies this record. Off by default.
            </p>
            <Button
              className="mt-3"
              onClick={async () => {
                setToken(await publish());
              }}
            >
              Publish a shareable link
            </Button>
          </>
        )}
      </div>
```

Add the matching imports to the page: `publishCredential`, `unpublishCredential`, `getCredential`.

- [ ] **Step 5: Run everything**

```bash
npx tsc --noEmit
npx eslint src e2e
npx vitest run src/modules/passport
```

Expected: all pass. Do NOT run Playwright (see Global Constraints).

- [ ] **Step 6: Commit**

```bash
git add src/app/credential src/modules/passport "src/app/(app)/my-info/page.tsx" e2e/credential-page.spec.ts
git commit -m "feat(passport): add the opt-in public credential page"
```

---

### Task 8: The wallet vendor client

**Files:**
- Create: `src/modules/passport/services/wallet-client.ts`
- Test: `src/modules/passport/services/wallet-client.test.ts`
- Modify: `src/platform/config.ts` (add `WALLETWALLET_API_KEY`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `createPass(input: PassInput): Promise<PassResult | null>`, `updatePass(serial, input): Promise<boolean>`, `revokePass(serial): Promise<boolean>`, `isWalletEnabled(): boolean`, types `PassInput` and `PassResult`.

- [ ] **Step 1: Add the config key**

In `src/platform/config.ts`, add alongside the other optional secrets:

```ts
    WALLETWALLET_API_KEY: z.string().optional(),
```

Absent key means the wallet feature is off, which is how the first three tasks ship with this path dark.

- [ ] **Step 2: Write the failing test**

Create `src/modules/passport/services/wallet-client.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPass, revokePass, updatePass } from "./wallet-client";

const OK = {
  serialNumber: "ser_123",
  googleSaveUrl: "https://pay.google.com/save/abc",
  applePass: "BASE64",
  shareUrl: "https://walletwallet.dev/p/ser_123",
};

const INPUT = {
  organizationName: "HAVEN Free Clinic",
  logoText: "HAVEN Free Clinic",
  description: "Volunteer badge",
  expirationDays: 90,
  primaryFields: [{ key: "role", label: "Role", value: "Volunteer" }],
  secondaryFields: [{ key: "dept", label: "Department", value: "Internal Medicine" }],
  barcodeValue: null,
};

describe("wallet client", () => {
  beforeEach(() => {
    vi.stubEnv("WALLETWALLET_API_KEY", "ww_live_test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("returns the created pass on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => OK });
    vi.stubGlobal("fetch", fetchMock);

    const result = await createPass(INPUT);

    expect(result).toEqual(OK);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/passes");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer ww_live_test");
  });

  it("returns null on a 429 rather than throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => "quota" }));

    expect(await createPass(INPUT)).toBeNull();
  });

  it("returns null on a network failure rather than throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));

    expect(await createPass(INPUT)).toBeNull();
  });

  it("returns null when no API key is configured", async () => {
    vi.stubEnv("WALLETWALLET_API_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await createPass(INPUT)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("revokes by serial and reports success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    expect(await revokePass("ser_123")).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/passes/ser_123");
    expect(init.method).toBe("DELETE");
  });

  it("treats a revoke failure as false rather than throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));

    expect(await revokePass("ser_123")).toBe(false);
  });

  it("updates by serial", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    expect(await updatePass("ser_123", INPUT)).toBe(true);
    expect(fetchMock.mock.calls[0][1].method).toBe("PUT");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/modules/passport/services/wallet-client.test.ts`
Expected: FAIL, cannot resolve `./wallet-client`.

- [ ] **Step 4: Write the implementation**

Create `src/modules/passport/services/wallet-client.ts`:

```ts
/**
 * Thin client over the walletwallet.dev pass API.
 *
 * The vendor exists ONLY behind this file. Passes are a disposable rendering of
 * data the Hub owns: they are signed with the vendor's certificate, so they
 * cannot be migrated to another signer, and the mitigation is that nothing
 * load-bearing depends on them. If this service disappears, members lose a badge
 * and keep their credential.
 *
 * Every call is best-effort and returns null or false instead of throwing. A
 * vendor outage, a 429 (the free tier is 1,000 passes per month counting
 * creations and updates), or a network failure must degrade the badge and never
 * break /my-info or an offboard.
 *
 * NEVER call these inside a Prisma transaction: a vendor timeout would hold a
 * database connection open across a network round trip and could roll back an
 * offboard.
 */

import { config } from "@/platform/config";
import { log, errorAttrs } from "@/platform/logging";

const BASE = "https://www.walletwallet.dev";

export type PassField = { key: string; label: string; value: string };

export type PassInput = {
  organizationName: string;
  logoText: string;
  description: string;
  /** 1 to 3650. Computed from the term end date at issuance. */
  expirationDays: number;
  primaryFields: PassField[];
  secondaryFields: PassField[];
  /** QR target, or null for a pass with no barcode. */
  barcodeValue: string | null;
};

export type PassResult = {
  serialNumber: string;
  googleSaveUrl: string;
  applePass: string;
  shareUrl: string;
};

export function isWalletEnabled(): boolean {
  return Boolean(config.WALLETWALLET_API_KEY);
}

function body(input: PassInput): Record<string, unknown> {
  return {
    organizationName: input.organizationName,
    logoText: input.logoText,
    description: input.description,
    expirationDays: input.expirationDays,
    primaryFields: input.primaryFields,
    secondaryFields: input.secondaryFields,
    // Custom color and logo are Pro-only; the free tier gets a preset.
    colorPreset: "blue",
    // Defaults true at the vendor, set explicitly so a default change cannot
    // silently make members' badges shareable.
    sharingProhibited: true,
    ...(input.barcodeValue
      ? { barcodeValue: input.barcodeValue, barcodeFormat: "QR" }
      : {}),
  };
}

async function call(
  path: string,
  method: "POST" | "PUT" | "DELETE",
  payload?: Record<string, unknown>,
): Promise<Response | null> {
  const key = config.WALLETWALLET_API_KEY;
  if (!key) return null;
  try {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    if (!response.ok) {
      log.error("[passport] wallet call failed", { path, method, status: response.status });
      return null;
    }
    return response;
  } catch (error) {
    log.error("[passport] wallet call threw", errorAttrs(error, { path, method }));
    return null;
  }
}

export async function createPass(input: PassInput): Promise<PassResult | null> {
  const response = await call("/api/passes", "POST", body(input));
  if (!response) return null;
  return (await response.json()) as PassResult;
}

export async function updatePass(serial: string, input: PassInput): Promise<boolean> {
  return Boolean(await call(`/api/passes/${encodeURIComponent(serial)}`, "PUT", body(input)));
}

/** Idempotent at the vendor: repeat deletes are documented no-ops. */
export async function revokePass(serial: string): Promise<boolean> {
  return Boolean(await call(`/api/passes/${encodeURIComponent(serial)}`, "DELETE"));
}
```

If `config` reads env at module load and does not see `vi.stubEnv`, change the tests to stub `@/platform/config` with `vi.mock` instead, matching how other tests in this repo handle config-dependent code. Check an existing example before adjusting.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/modules/passport/services/wallet-client.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Lint and commit**

```bash
npx eslint src
git add src/platform/config.ts src/modules/passport/services/wallet-client.ts src/modules/passport/services/wallet-client.test.ts
git commit -m "feat(passport): add a best-effort wallet pass client"
```

---

### Task 9: Issue and revoke term-scoped passes

**Files:**
- Modify: `prisma/schema.prisma` (add `WalletPass`, back-relations on `Person` and `Term`)
- Create: `prisma/migrations/<timestamp>_add_wallet_pass/migration.sql` (generated)
- Create: `src/modules/passport/services/wallet-pass.ts`
- Test: `src/modules/passport/services/wallet-pass.test.ts`
- Modify: `src/platform/people.ts` (revoke after the offboard transaction commits)

**Interfaces:**
- Consumes: `createPass`, `revokePass`, `isWalletEnabled` (Task 8); `computeServiceRecord` (Task 1).
- Produces: `issueWalletPass(personId): Promise<{ googleSaveUrl: string; shareUrl: string } | null>`, `revokeWalletPasses(personId): Promise<number>`.

- [ ] **Step 1: Add the model**

In `prisma/schema.prisma`, add to `model Person`:

```prisma
  walletPasses                   WalletPass[]
```

Add to `model Term`:

```prisma
  walletPasses         WalletPass[]
```

Add the model:

```prisma
/// A term-scoped wallet badge. One per person per term, expiring at term end.
///
/// The pass asserts PRESENT standing, which is why it is term-scoped and revoked
/// on offboard, unlike ServiceCredential (a past-tense record that survives
/// offboarding). serialNumber is the vendor's handle for update and revoke.
model WalletPass {
  id           String    @id @default(cuid())
  personId     String
  termId       String
  serialNumber String    @unique
  issuedAt     DateTime  @default(now())
  revokedAt    DateTime?
  person       Person    @relation(fields: [personId], references: [id], onDelete: Cascade)
  /// Restrict: a term with issued badges must not be deletable out from under them.
  term         Term      @relation(fields: [termId], references: [id], onDelete: Restrict)

  @@unique([personId, termId])
  @@index([personId])
}
```

- [ ] **Step 2: Generate the migration**

```bash
npx prisma migrate dev --name add_wallet_pass
```

Review the generated SQL and delete anything beyond the `CREATE TABLE`, its indexes, and its two foreign keys.

- [ ] **Step 3: Write the failing test**

Create `src/modules/passport/services/wallet-pass.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { issueWalletPass, revokeWalletPasses } from "./wallet-pass";
import { createPass, isWalletEnabled, revokePass } from "./wallet-client";

// vi.mock, not vi.spyOn: wallet-pass.ts imports these as named bindings, and
// spying on an ESM namespace object does not rebind what the importer already
// holds. This mirrors the partial-mock pattern in my-info.test.ts.
vi.mock("./wallet-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./wallet-client")>();
  return {
    ...actual,
    isWalletEnabled: vi.fn(() => true),
    createPass: vi.fn(),
    revokePass: vi.fn(),
  };
});

const createPassMock = vi.mocked(createPass);
const revokePassMock = vi.mocked(revokePass);
const isWalletEnabledMock = vi.mocked(isWalletEnabled);

async function seedActiveMember() {
  const person = await prisma.person.create({ data: { name: "Ada Lovelace" } });
  const dept = await prisma.department.upsert({
    where: { code: "ITCM" },
    update: {},
    create: { code: "ITCM", name: "Internal Medicine" },
  });
  const term = await prisma.term.create({
    data: {
      code: "SU26",
      name: "Summer 2026",
      startDate: new Date("2026-05-01T12:00:00Z"),
      endDate: new Date("2099-08-31T12:00:00Z"),
      status: "ACTIVE",
    },
  });
  await prisma.termMembership.create({
    data: { personId: person.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER" },
  });
  return { person, term };
}

const CREATED = {
  serialNumber: "ser_1",
  googleSaveUrl: "https://g",
  applePass: "b64",
  shareUrl: "https://s",
};

describe("issueWalletPass", () => {
  beforeEach(async () => {
    await resetDb();
    vi.clearAllMocks();
    isWalletEnabledMock.mockReturnValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("creates a pass and stores the serial", async () => {
    const { person, term } = await seedActiveMember();
    createPassMock.mockResolvedValue(CREATED);

    const result = await issueWalletPass(person.id);

    expect(result).toEqual({ googleSaveUrl: "https://g", shareUrl: "https://s" });
    const row = await prisma.walletPass.findUnique({
      where: { personId_termId: { personId: person.id, termId: term.id } },
    });
    expect(row!.serialNumber).toBe("ser_1");
  });

  it("computes expirationDays from the term end date", async () => {
    const { person } = await seedActiveMember();
    createPassMock.mockResolvedValue(CREATED);

    await issueWalletPass(person.id);

    const input = createPassMock.mock.calls[0][0];
    expect(input.expirationDays).toBeGreaterThan(0);
    expect(input.expirationDays).toBeLessThanOrEqual(3650);
  });

  it("puts the role, department, term, and member-since year on the pass", async () => {
    const { person } = await seedActiveMember();
    createPassMock.mockResolvedValue(CREATED);

    await issueWalletPass(person.id);

    const input = createPassMock.mock.calls[0][0];
    expect(input.primaryFields[0].value).toBe("Volunteer");
    const labels = input.secondaryFields.map((f) => f.label);
    expect(labels).toContain("Department");
    expect(labels).toContain("Term");
    expect(labels).toContain("Member since");
  });

  it("returns null and stores nothing when the vendor fails", async () => {
    const { person } = await seedActiveMember();
    createPassMock.mockResolvedValue(null);

    expect(await issueWalletPass(person.id)).toBeNull();
    expect(await prisma.walletPass.count()).toBe(0);
  });

  it("returns null when the member has no active membership", async () => {
    const person = await prisma.person.create({ data: { name: "No Term" } });

    expect(await issueWalletPass(person.id)).toBeNull();
    expect(createPassMock).not.toHaveBeenCalled();
  });
});

describe("revokeWalletPasses", () => {
  beforeEach(async () => {
    await resetDb();
    vi.clearAllMocks();
    isWalletEnabledMock.mockReturnValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("revokes at the vendor and marks the row", async () => {
    const { person, term } = await seedActiveMember();
    await prisma.walletPass.create({
      data: { personId: person.id, termId: term.id, serialNumber: "ser_1" },
    });
    revokePassMock.mockResolvedValue(true);

    expect(await revokeWalletPasses(person.id)).toBe(1);
    expect(revokePassMock).toHaveBeenCalledWith("ser_1");
    const row = await prisma.walletPass.findFirst({ where: { personId: person.id } });
    expect(row!.revokedAt).not.toBeNull();
  });

  it("leaves the row unmarked when the vendor call fails, so the sweep retries", async () => {
    const { person, term } = await seedActiveMember();
    await prisma.walletPass.create({
      data: { personId: person.id, termId: term.id, serialNumber: "ser_1" },
    });
    revokePassMock.mockResolvedValue(false);

    expect(await revokeWalletPasses(person.id)).toBe(0);
    const row = await prisma.walletPass.findFirst({ where: { personId: person.id } });
    expect(row!.revokedAt).toBeNull();
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run src/modules/passport/services/wallet-pass.test.ts`
Expected: FAIL, cannot resolve `./wallet-pass`.

- [ ] **Step 5: Write the implementation**

Create `src/modules/passport/services/wallet-pass.ts`:

```ts
/**
 * Term-scoped wallet badges.
 *
 * The badge asserts PRESENT standing, so it is scoped to the member's current
 * term, expires at term end without anyone acting, and is revoked on offboard.
 * The cumulative story (member since, every term served) deliberately lives on
 * the certificate and the credential page instead: a badge that outlived a
 * member's standing would let a former volunteer carry a plausible clinic
 * credential indefinitely.
 */

import { prisma } from "@/platform/db";
import { log } from "@/platform/logging";
import { getActiveTerm } from "@/platform/terms/active-term";
import { getSetting } from "@/platform/settings/service";
import { computeServiceRecord } from "./service-record";
import { createPass, isWalletEnabled, revokePass, type PassInput } from "./wallet-client";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Vendor accepts 1 to 3650. Clamp so a mis-set term end can never send an invalid value. */
function expirationDays(endDate: Date): number {
  const days = Math.ceil((endDate.getTime() - Date.now()) / DAY_MS);
  return Math.min(3650, Math.max(1, days));
}

export async function issueWalletPass(
  personId: string,
): Promise<{ googleSaveUrl: string; shareUrl: string } | null> {
  if (!isWalletEnabled()) return null;

  const term = await getActiveTerm();
  if (!term) return null;

  const membership = await prisma.termMembership.findFirst({
    where: { personId, termId: term.id, status: "ACTIVE" },
    select: { kind: true, department: { select: { name: true } }, person: { select: { name: true } } },
  });
  if (!membership) return null;

  // The badge is present-tense, so it carries only the since-year, never a
  // cumulative shift total. The full history lives on the certificate and the
  // credential page, which are the artifacts that survive offboarding.
  const record = await computeServiceRecord(personId);
  const [orgName, brandColor] = await Promise.all([
    getSetting<string>("branding.orgName"),
    getSetting<string>("branding.brandColor"),
  ]);
  void brandColor; // Custom color is Pro-only; read here so the Pro upgrade is a one-line change.

  const role = membership.kind === "DIRECTOR" ? "Director" : "Volunteer";
  const secondaryFields = [
    { key: "department", label: "Department", value: membership.department.name },
    { key: "term", label: "Term", value: term.name },
  ];
  if (record.memberSince) {
    secondaryFields.push({
      key: "since",
      label: "Member since",
      value: record.memberSince.label,
    });
  }

  const input: PassInput = {
    organizationName: orgName,
    logoText: orgName,
    description: `${role} badge`,
    expirationDays: expirationDays(term.endDate),
    primaryFields: [{ key: "role", label: "Role", value: role }],
    secondaryFields,
    barcodeValue: null,
  };

  const created = await createPass(input);
  if (!created) return null;

  await prisma.walletPass.upsert({
    where: { personId_termId: { personId, termId: term.id } },
    create: { personId, termId: term.id, serialNumber: created.serialNumber },
    update: { serialNumber: created.serialNumber, issuedAt: new Date(), revokedAt: null },
  });

  return { googleSaveUrl: created.googleSaveUrl, shareUrl: created.shareUrl };
}

/**
 * Revoke every live badge for a person. Returns how many were confirmed revoked
 * at the vendor. A failed vendor call deliberately leaves revokedAt null so the
 * reconciliation sweep retries: a badge we believe is dead but is not would be
 * worse than one we retry.
 */
export async function revokeWalletPasses(personId: string): Promise<number> {
  if (!isWalletEnabled()) return 0;

  const passes = await prisma.walletPass.findMany({
    where: { personId, revokedAt: null },
    select: { id: true, serialNumber: true },
  });

  let revoked = 0;
  for (const pass of passes) {
    const ok = await revokePass(pass.serialNumber);
    if (!ok) {
      log.error("[passport] wallet revoke failed, leaving for the sweep", { passId: pass.id });
      continue;
    }
    await prisma.walletPass.update({ where: { id: pass.id }, data: { revokedAt: new Date() } });
    revoked += 1;
  }
  return revoked;
}
```

Confirm `getActiveTerm()` returns an object with `id`, `name`, and `endDate`; adjust the select if not.

- [ ] **Step 6: Revoke on offboard, outside the transaction**

In `src/platform/people.ts`, add the import:

```ts
import { revokeWalletPasses } from "@/modules/passport/services/wallet-pass";
```

AFTER the `prisma.$transaction(...)` call completes (not inside it), in the `OFFBOARDED` path:

```ts
  // Outside the transaction on purpose: this makes a network call to the wallet
  // vendor, and a timeout inside the transaction would hold a database
  // connection open across a round trip and could roll back the offboard.
  // Best-effort; the reconciliation cron retries anything that fails here.
  if (status === "OFFBOARDED") {
    try {
      await revokeWalletPasses(personId);
    } catch (error) {
      log.error("[passport] offboard wallet revoke failed", errorAttrs(error, { personId }));
    }
  }
```

- [ ] **Step 7: Run the tests**

```bash
npx vitest run src/modules/passport
npx vitest run src/platform/people.test.ts
```

Expected: PASS.

- [ ] **Step 8: Lint and commit**

```bash
npx eslint src
git add prisma/schema.prisma prisma/migrations src/modules/passport/services/wallet-pass.ts src/modules/passport/services/wallet-pass.test.ts src/platform/people.ts
git commit -m "feat(passport): issue term-scoped wallet badges and revoke them on offboard"
```

---

### Task 10: Reconciliation sweep

**Files:**
- Create: `src/modules/passport/services/wallet-sweep.ts`
- Test: `src/modules/passport/services/wallet-sweep.test.ts`
- Create: `src/app/api/cron/wallet-passes/route.ts`
- Modify: `docs/cron-jobs.md`

**Interfaces:**
- Consumes: `revokePass`, `isWalletEnabled` (Task 8).
- Produces: `sweepWalletPasses(): Promise<{ revoked: number; failed: number }>`.

**Why this task exists:** the vendor documents no webhooks and no status endpoint, so nothing tells us a pass should have died. Every revoke path is best-effort, which means something has to retry.

- [ ] **Step 1: Write the failing test**

Create `src/modules/passport/services/wallet-sweep.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { sweepWalletPasses } from "./wallet-sweep";
import { isWalletEnabled, revokePass } from "./wallet-client";

// vi.mock, not vi.spyOn: see the note in wallet-pass.test.ts.
vi.mock("./wallet-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./wallet-client")>();
  return { ...actual, isWalletEnabled: vi.fn(() => true), revokePass: vi.fn() };
});

const revokePassMock = vi.mocked(revokePass);
const isWalletEnabledMock = vi.mocked(isWalletEnabled);

async function passFor(opts: { termStatus: "ACTIVE" | "ARCHIVED"; endDate: string; offboarded?: boolean }) {
  const person = await prisma.person.create({
    data: { name: "Ada", status: opts.offboarded ? "OFFBOARDED" : "ACTIVE" },
  });
  const term = await prisma.term.create({
    data: {
      code: `T${Math.random().toString(36).slice(2, 8)}`,
      name: "Term",
      startDate: new Date("2026-01-01T12:00:00Z"),
      endDate: new Date(opts.endDate),
      status: opts.termStatus,
    },
  });
  return prisma.walletPass.create({
    data: { personId: person.id, termId: term.id, serialNumber: `ser_${term.code}` },
  });
}

describe("sweepWalletPasses", () => {
  beforeEach(async () => {
    await resetDb();
    vi.clearAllMocks();
    isWalletEnabledMock.mockReturnValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("revokes a pass whose term has ended", async () => {
    await passFor({ termStatus: "ARCHIVED", endDate: "2020-01-01T12:00:00Z" });
    revokePassMock.mockResolvedValue(true);

    expect(await sweepWalletPasses()).toEqual({ revoked: 1, failed: 0 });
  });

  it("revokes a pass belonging to an offboarded person", async () => {
    await passFor({ termStatus: "ACTIVE", endDate: "2099-01-01T12:00:00Z", offboarded: true });
    revokePassMock.mockResolvedValue(true);

    expect(await sweepWalletPasses()).toEqual({ revoked: 1, failed: 0 });
  });

  it("leaves a live pass for an active member alone", async () => {
    await passFor({ termStatus: "ACTIVE", endDate: "2099-01-01T12:00:00Z" });
    revokePassMock.mockResolvedValue(true);

    expect(await sweepWalletPasses()).toEqual({ revoked: 0, failed: 0 });
    expect(revokePassMock).not.toHaveBeenCalled();
  });

  it("counts a vendor failure and leaves the row for the next run", async () => {
    const pass = await passFor({ termStatus: "ARCHIVED", endDate: "2020-01-01T12:00:00Z" });
    revokePassMock.mockResolvedValue(false);

    expect(await sweepWalletPasses()).toEqual({ revoked: 0, failed: 1 });
    const row = await prisma.walletPass.findUnique({ where: { id: pass.id } });
    expect(row!.revokedAt).toBeNull();
  });

  it("is idempotent: an already-revoked pass is not revoked again", async () => {
    const pass = await passFor({ termStatus: "ARCHIVED", endDate: "2020-01-01T12:00:00Z" });
    await prisma.walletPass.update({ where: { id: pass.id }, data: { revokedAt: new Date() } });
    revokePassMock.mockResolvedValue(true);

    expect(await sweepWalletPasses()).toEqual({ revoked: 0, failed: 0 });
    expect(revokePassMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/modules/passport/services/wallet-sweep.test.ts`
Expected: FAIL, cannot resolve `./wallet-sweep`.

- [ ] **Step 3: Write the sweep**

Create `src/modules/passport/services/wallet-sweep.ts`:

```ts
/**
 * Reconciliation for wallet badges.
 *
 * The vendor has no webhooks and no status endpoint, and every revoke path in
 * the app is best-effort, so nothing else guarantees a badge actually dies. This
 * sweep is that guarantee: it re-revokes anything whose term has ended or whose
 * person has been offboarded, and it is safe to run repeatedly because vendor
 * deletes are documented no-ops.
 */

import { prisma } from "@/platform/db";
import { log } from "@/platform/logging";
import { isWalletEnabled, revokePass } from "./wallet-client";

export async function sweepWalletPasses(): Promise<{ revoked: number; failed: number }> {
  if (!isWalletEnabled()) return { revoked: 0, failed: 0 };

  const stale = await prisma.walletPass.findMany({
    where: {
      revokedAt: null,
      OR: [{ term: { endDate: { lt: new Date() } } }, { person: { status: "OFFBOARDED" } }],
    },
    select: { id: true, serialNumber: true },
  });

  let revoked = 0;
  let failed = 0;
  for (const pass of stale) {
    if (await revokePass(pass.serialNumber)) {
      await prisma.walletPass.update({ where: { id: pass.id }, data: { revokedAt: new Date() } });
      revoked += 1;
    } else {
      failed += 1;
    }
  }

  if (revoked || failed) log.info("[passport] wallet sweep", { revoked, failed });
  return { revoked, failed };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/modules/passport/services/wallet-sweep.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Add the cron route**

Create `src/app/api/cron/wallet-passes/route.ts`, following `src/app/api/cron/schedule-reminders/route.ts` for the auth and heartbeat shape:

```ts
/**
 * Daily wallet badge reconciliation.
 *
 * Revokes badges whose term has ended or whose holder has been offboarded. The
 * vendor offers no webhooks, so this is the only thing that guarantees a badge
 * stops working after the app's best-effort revoke paths fail.
 *
 * Triggered DAILY by the external scheduler (cron-job.org) with
 * Authorization: Bearer $CRON_SECRET, alongside the other daily jobs.
 */
import { authorizeCron } from "@/platform/cron";
import { recordCronHeartbeat } from "@/platform/cron-heartbeat";
import { log, flushLogs } from "@/platform/logging";
import { sweepWalletPasses } from "@/modules/passport/services/wallet-sweep";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  const denied = authorizeCron(request);
  if (denied) return denied;

  try {
    const result = await sweepWalletPasses();
    await recordCronHeartbeat("wallet-passes");
    return Response.json(result);
  } catch (error) {
    log.error("[cron] wallet-passes failed", { error: String(error) });
    return Response.json({ error: "sweep failed" }, { status: 500 });
  } finally {
    await flushLogs();
  }
}
```

Open `src/platform/cron.ts` and `src/platform/cron-heartbeat.ts` and match the real signatures of `authorizeCron` and `recordCronHeartbeat`; the shapes above follow the existing route but must be verified, not assumed.

- [ ] **Step 6: Document the job**

Add a row to `docs/cron-jobs.md` matching the existing table format: path `/api/cron/wallet-passes`, daily, purpose "revoke expired and offboarded wallet badges".

- [ ] **Step 7: Full verification**

```bash
npx tsc --noEmit
npx eslint src e2e
npx vitest run
```

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/modules/passport/services/wallet-sweep.ts src/modules/passport/services/wallet-sweep.test.ts src/app/api/cron/wallet-passes docs/cron-jobs.md
git commit -m "feat(passport): reconcile wallet badges on a daily sweep"
```

---

## Post-implementation checklist

- [ ] `WALLETWALLET_API_KEY` added to Vercel env for preview and production (absent = wallet off, which is a valid state).
- [ ] `/api/cron/wallet-passes` registered with cron-job.org, daily, bearer `$CRON_SECRET`.
- [ ] Confirm on staging that `/credential/<token>` renders signed out and returns 404 for a bad token.
- [ ] Confirm in PostHog that a `/credential/...` pageview records the path as `/credential/[redacted]`.
