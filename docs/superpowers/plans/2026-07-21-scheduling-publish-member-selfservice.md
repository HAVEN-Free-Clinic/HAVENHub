# Scheduling Spec 2 (Publish Gate + Member Next-Term Self-Service) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let directors publish a built next-term schedule to members per department (reversibly), and let members edit next-term availability (pre-publish) and view + swap their next-term schedule (post-publish), with request routing following each request's own term.

**Architecture:** Add a `SchedulePublication` row per (term, department) that exists iff currently published. Member reads (`mySchedule`) span the member's terms via `getPersonTerms` but show next-term assignments only for published departments — the deliberate replacement for today's accidental active-term filtering. Member availability + request services stop resolving `getActiveTerm()` and take the relevant term explicitly. The live term is never publish-gated (byte-identical current behavior).

**Tech Stack:** Next.js App Router (RSC + inline server actions), Prisma (+ one additive migration), React `cache()`, Vitest against a local Postgres test DB.

## Global Constraints

- New `SchedulePublication` model; row exists iff that (term, department) is currently published. Publish = create (audited); unpublish = delete (audited).
- The publish gate applies ONLY to non-live terms. The `ACTIVE` (live) term is always visible to members with no publication row — current-term behavior byte-identical.
- Member + request services take the relevant term explicitly; they must NOT resolve `getActiveTerm()` internally for term-spanning reads/writes. `shift-reminders` cron stays live-term (`getActiveTerm`), unchanged.
- `mySchedule` shows next-term assignments ONLY for departments in `publishedDepartmentIds(nextTermId)` — the no-leak invariant, dedicated-tested.
- Publish/unpublish are scope-guarded by `manageableScheduleDepartmentIds` and reject a live (`ACTIVE`) or `ARCHIVED` term.
- Behavior identical when only one term is in flight.
- `countPendingApprovals` (dashboard widget) stays live-term this spec.
- No em-dashes in code/comments (repo eslint `local/no-em-dash`). Modules import cross-module code only via `src/platform`. Run the FULL `npm run lint` before any push.
- Tests run against the local Postgres test DB (`havenhub_test` on `:5434`) with `resetDb()` in `beforeEach`; `resetDb` (`src/platform/test/db.ts`) TRUNCATEs an explicit table list — the new `SchedulePublication` table must be added to that TRUNCATE list.

---

## File Structure

**Schema/infra:**
- `prisma/schema.prisma` — add `SchedulePublication` model + back-relations on `Term`, `Department`, `Person`.
- `prisma/migrations/<ts>_schedule_publication/migration.sql` — additive table.
- `src/platform/test/db.ts` — add `"SchedulePublication"` to the TRUNCATE list.

**Create:**
- `src/modules/schedule/services/publication.ts` — `publishSchedule`, `unpublishSchedule`, `publishedDepartmentIds`, `isPublished`, typed `PublicationError`.
- `src/modules/schedule/services/publication.test.ts`.

**Modify:**
- `src/modules/schedule/services/schedule.ts` — `mySchedule` term-spanning + publish-gated; `updateMyAvailability` takes `termId`.
- `src/modules/schedule/services/schedule.test.ts` — new gate/availability tests.
- `src/modules/schedule/services/requests.ts` — `requestApproverRecipients(departmentId, termId)`; `createRequest`/`eligibleSwapPartners`/`listDepartmentRequests` term-aware; publish re-check on next-term create.
- `src/modules/schedule/services/requests.test.ts` — routing + term tests.
- `src/app/api/cron/schedule-reminders/route.ts` — route per request's own term.
- `src/app/(app)/schedule/page.tsx` — term-grouped member page (next-term section: availability + gated schedule + swaps).
- `src/app/(app)/schedule/builder/page.tsx` — publish/unpublish control (next-term only); un-gate requests panel to the working term.

---

## Task 1: `SchedulePublication` model, migration, and publish service

> **Controller note:** this task touches the schema, the migration, and the shared Prisma client. Apply the migration to the LOCAL test DB only (commands below); do NOT let `prisma migrate dev` auto-apply to the `.env` DATABASE_URL (which points at shared Neon). Because it needs `prisma generate`, run this task carefully.

**Files:**
- Modify: `prisma/schema.prisma`, `src/platform/test/db.ts`
- Create: `src/modules/schedule/services/publication.ts`, `src/modules/schedule/services/publication.test.ts`, `prisma/migrations/<ts>_schedule_publication/migration.sql`

**Interfaces:**
- Produces: `publishSchedule(actorId, { termId, departmentId }): Promise<void>`; `unpublishSchedule(actorId, { termId, departmentId }): Promise<void>`; `publishedDepartmentIds(termId: string): Promise<Set<string>>`; `isPublished(termId: string, departmentId: string): Promise<boolean>`; `class PublicationError extends Error`.

- [ ] **Step 1: Add the model + back-relations to `prisma/schema.prisma`**

Add the model (near the other schedule models like `ScheduleDay`):

```prisma
model SchedulePublication {
  id            String   @id @default(cuid())
  termId        String
  departmentId  String
  publishedAt   DateTime @default(now())
  publishedById String?

  term          Term       @relation(fields: [termId], references: [id], onDelete: Cascade)
  department    Department @relation(fields: [departmentId], references: [id], onDelete: Cascade)
  publishedBy   Person?    @relation("schedulePublishedBy", fields: [publishedById], references: [id], onDelete: SetNull)

  @@unique([termId, departmentId])
  @@index([termId])
}
```

Add back-relation fields: on `model Term` add `schedulePublications SchedulePublication[]`; on `model Department` add `schedulePublications SchedulePublication[]`; on `model Person` add `schedulePublications SchedulePublication[] @relation("schedulePublishedBy")`.

- [ ] **Step 2: Create the migration (local-only apply) + regenerate client**

Run, from the worktree root:

```bash
# create the migration SQL without auto-applying to the .env (Neon) DB:
npx prisma migrate dev --create-only --name schedule_publication
```

Open the generated `prisma/migrations/<ts>_schedule_publication/migration.sql` and confirm it ONLY creates the `SchedulePublication` table + its unique index/FK constraints (no unrelated drift; trim any unrelated statements). Then apply to the LOCAL test DB and regenerate the client:

```bash
DATABASE_URL='postgresql://haven:haven_dev@localhost:5434/havenhub_test' npx prisma migrate deploy
npx prisma generate
```

Expected: migrate deploy reports the new migration applied; generate succeeds. (If `generate` errors on the shared client, re-run once — the new model must be in the client for the service to compile.)

- [ ] **Step 3: Add the table to `resetDb`**

In `src/platform/test/db.ts`, add `"SchedulePublication"` to the `TRUNCATE` table list (place it near `"ScheduleDay"`), so tests reset it.

- [ ] **Step 4: Write the failing service test**

Create `src/modules/schedule/services/publication.test.ts`:

```ts
import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { publishSchedule, unpublishSchedule, publishedDepartmentIds, isPublished, PublicationError } from "./publication";

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

async function seed() {
  const live = await prisma.term.create({ data: { code: "SU26", name: "Summer", startDate: new Date("2026-05-30"), endDate: new Date("2026-09-26"), status: "ACTIVE" } });
  const next = await prisma.term.create({ data: { code: "FA26", name: "Fall", startDate: new Date("2026-09-01"), endDate: new Date("2027-01-01"), status: "PLANNING" } });
  const dept = await prisma.department.create({ data: { code: "SRHD", name: "SRHD" } });
  // director with active-term directorship in dept -> manageableScheduleDepartmentIds includes it
  const dir = await prisma.person.create({ data: { name: "Dir", status: "ACTIVE" } });
  await prisma.termMembership.create({ data: { personId: dir.id, termId: live.id, departmentId: dept.id, kind: "DIRECTOR", status: "ACTIVE" } });
  const outsider = await prisma.person.create({ data: { name: "Out", status: "ACTIVE" } });
  return { live, next, dept, dir, outsider };
}

it("publish creates a row, unpublish deletes it; isPublished + publishedDepartmentIds reflect it", async () => {
  const { next, dept, dir } = await seed();
  expect(await isPublished(next.id, dept.id)).toBe(false);
  await publishSchedule(dir.id, { termId: next.id, departmentId: dept.id });
  expect(await isPublished(next.id, dept.id)).toBe(true);
  expect([...(await publishedDepartmentIds(next.id))]).toEqual([dept.id]);
  await unpublishSchedule(dir.id, { termId: next.id, departmentId: dept.id });
  expect(await isPublished(next.id, dept.id)).toBe(false);
  expect((await prisma.schedulePublication.count())).toBe(0);
});

it("publish is idempotent (re-publish keeps a single row)", async () => {
  const { next, dept, dir } = await seed();
  await publishSchedule(dir.id, { termId: next.id, departmentId: dept.id });
  await publishSchedule(dir.id, { termId: next.id, departmentId: dept.id });
  expect(await prisma.schedulePublication.count()).toBe(1);
});

it("rejects publishing the live (ACTIVE) term and an ARCHIVED term", async () => {
  const { live, dept, dir } = await seed();
  const archived = await prisma.term.create({ data: { code: "SP26", name: "Spring", startDate: new Date("2026-01-01"), endDate: new Date("2026-05-01"), status: "ARCHIVED" } });
  await expect(publishSchedule(dir.id, { termId: live.id, departmentId: dept.id })).rejects.toBeInstanceOf(PublicationError);
  await expect(publishSchedule(dir.id, { termId: archived.id, departmentId: dept.id })).rejects.toBeInstanceOf(PublicationError);
});

it("rejects a publisher who does not manage the department", async () => {
  const { next, dept, outsider } = await seed();
  await expect(publishSchedule(outsider.id, { termId: next.id, departmentId: dept.id })).rejects.toBeInstanceOf(PublicationError);
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `npx vitest run src/modules/schedule/services/publication.test.ts`
Expected: FAIL (cannot find module `./publication`).

- [ ] **Step 6: Implement the service**

Create `src/modules/schedule/services/publication.ts`:

```ts
import { cache } from "react";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { manageableScheduleDepartmentIds } from "./builder";

/** Publish is not allowed for this term/department (scope, or a non-PLANNING term). */
export class PublicationError extends Error {
  constructor(message: string) { super(message); this.name = "PublicationError"; }
}

async function assertPublishable(actorId: string, termId: string, departmentId: string): Promise<void> {
  const term = await prisma.term.findUnique({ where: { id: termId } });
  if (!term) throw new PublicationError("Unknown term.");
  // Publishing only makes sense for a next (PLANNING) term: the live term is always
  // visible to members, and an archived term is read-only.
  if (term.status !== "PLANNING") throw new PublicationError("Only a next (planning) term's schedule can be published.");
  const manageable = await manageableScheduleDepartmentIds(actorId);
  if (!manageable.includes(departmentId)) throw new PublicationError("You do not manage this department.");
}

/** Publish a department's schedule for a next term (create the row; idempotent). */
export async function publishSchedule(actorId: string, opts: { termId: string; departmentId: string }): Promise<void> {
  await assertPublishable(actorId, opts.termId, opts.departmentId);
  await prisma.schedulePublication.upsert({
    where: { termId_departmentId: { termId: opts.termId, departmentId: opts.departmentId } },
    create: { termId: opts.termId, departmentId: opts.departmentId, publishedById: actorId },
    update: {},
  });
  await recordAudit({ actorPersonId: actorId, action: "schedule.publish", entityType: "SchedulePublication", entityId: `${opts.termId}|${opts.departmentId}`, after: { termId: opts.termId, departmentId: opts.departmentId } });
}

/** Unpublish (delete the row). Idempotent. */
export async function unpublishSchedule(actorId: string, opts: { termId: string; departmentId: string }): Promise<void> {
  await assertPublishable(actorId, opts.termId, opts.departmentId);
  await prisma.schedulePublication.deleteMany({ where: { termId: opts.termId, departmentId: opts.departmentId } });
  await recordAudit({ actorPersonId: actorId, action: "schedule.unpublish", entityType: "SchedulePublication", entityId: `${opts.termId}|${opts.departmentId}`, before: { termId: opts.termId, departmentId: opts.departmentId } });
}

/** Department ids with a currently-published schedule for the term. Memoized per request. */
export const publishedDepartmentIds = cache(async (termId: string): Promise<Set<string>> => {
  const rows = await prisma.schedulePublication.findMany({ where: { termId }, select: { departmentId: true } });
  return new Set(rows.map((r) => r.departmentId));
});

export async function isPublished(termId: string, departmentId: string): Promise<boolean> {
  return (await prisma.schedulePublication.count({ where: { termId, departmentId } })) > 0;
}
```

- [ ] **Step 7: Run the service test + typecheck**

Run: `npx vitest run src/modules/schedule/services/publication.test.ts`
Expected: PASS (4 tests).
Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/platform/test/db.ts src/modules/schedule/services/publication.ts src/modules/schedule/services/publication.test.ts
git commit -m "feat(schedule): SchedulePublication model + publish/unpublish service (per-department, next-term only)"
```

---

## Task 2: Term-aware `updateMyAvailability`

**Files:**
- Modify: `src/modules/schedule/services/schedule.ts` (`updateMyAvailability`, ~line 323)
- Test: `src/modules/schedule/services/schedule.test.ts`

**Interfaces:**
- Consumes: `getPersonTerms` (`@/platform/terms/person-terms`).
- Produces: `updateMyAvailability(actorPersonId, { termId, dates, now? }): Promise<void>` — validates `termId` is one of the member's live/next terms, writes that term's memberships, validates dates against that term's `clinicDates`.

- [ ] **Step 1: Write the failing test**

Add to `src/modules/schedule/services/schedule.test.ts` (read the file first for its seed helpers; it already tests scheduling against a term). Add a test that a member with a next-term membership can set next-term availability while a live term differs:

```ts
it("updateMyAvailability writes the passed (next) term while a different term is live", async () => {
  // live term + next term, member active in BOTH; next term has clinic dates
  const live = await prisma.term.create({ data: { code: "SU26", name: "Summer", startDate: new Date("2026-05-30"), endDate: new Date("2026-09-26"), status: "ACTIVE", clinicDates: [] } });
  const nextDates = [new Date(Date.UTC(2026, 8, 5, 12))];
  const next = await prisma.term.create({ data: { code: "FA26", name: "Fall", startDate: new Date("2026-09-01"), endDate: new Date("2027-01-01"), status: "PLANNING", clinicDates: nextDates } });
  const dept = await prisma.department.create({ data: { code: "SRHD", name: "SRHD" } });
  const vol = await prisma.person.create({ data: { name: "Vol", status: "ACTIVE" } });
  await prisma.termMembership.create({ data: { personId: vol.id, termId: live.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" } });
  const m = await prisma.termMembership.create({ data: { personId: vol.id, termId: next.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" } });

  await updateMyAvailability(vol.id, { termId: next.id, dates: nextDates });
  const updated = await prisma.termMembership.findUniqueOrThrow({ where: { id: m.id } });
  expect(updated.selfAvailabilityDates.map((d) => d.getTime())).toEqual(nextDates.map((d) => d.getTime()));
  // the live-term membership is untouched
  const liveM = await prisma.termMembership.findFirstOrThrow({ where: { personId: vol.id, termId: live.id } });
  expect(liveM.selfAvailabilityDates).toEqual([]);
});

it("updateMyAvailability rejects a term the member is not an active member of", async () => {
  const other = await prisma.term.create({ data: { code: "XX26", name: "Other", startDate: new Date("2026-01-01"), endDate: new Date("2026-02-01"), status: "PLANNING", clinicDates: [] } });
  const vol = await prisma.person.create({ data: { name: "Vol", status: "ACTIVE" } });
  await expect(updateMyAvailability(vol.id, { termId: other.id, dates: [] })).rejects.toBeInstanceOf(AvailabilityValidationError);
});
```

(Import `AvailabilityValidationError` in the test if not already imported.)

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/modules/schedule/services/schedule.test.ts -t "passed (next) term"`
Expected: FAIL to compile (the current `updateMyAvailability` takes `(actorPersonId, dates, now?)`, not `{ termId, dates }`).

- [ ] **Step 3: Rewrite `updateMyAvailability`**

Add the import near the top of `schedule.ts`:

```ts
import { getPersonTerms } from "@/platform/terms/person-terms";
```

Change the signature and term resolution. Replace the head of the function (the signature through the `getActiveTerm`/membership fetch + the not-on-roster throw) with:

```ts
export async function updateMyAvailability(
  actorPersonId: string,
  input: { termId: string; dates: Date[]; now?: Date },
): Promise<void> {
  const now = input.now ?? new Date();

  // The term must be one the member is currently an active member of (live or next).
  const terms = await getPersonTerms(actorPersonId);
  const term = terms.find((t) => t.id === input.termId);
  if (!term) {
    throw new AvailabilityValidationError("You are not on that term's roster.");
  }

  const memberships = await prisma.termMembership.findMany({
    where: { termId: term.id, personId: actorPersonId, status: "ACTIVE" },
    orderBy: { id: "asc" },
  });
  if (memberships.length === 0) {
    throw new AvailabilityValidationError("You are not on that term's roster.");
  }
```

Then, in the rest of the body, replace `dates` with `input.dates` (the dedupe loop) and `now` is already a local. Everything else (canonicalByKey from `term.clinicDates`, validation, the `$transaction` updates, the audit) stays as-is.

- [ ] **Step 4: Run the schedule test file**

Run: `npx vitest run src/modules/schedule/services/schedule.test.ts`
Expected: PASS (new tests + existing; existing `updateMyAvailability` tests must be updated to the new `{ termId, dates }` shape — pass `termId: <the fixture's active term id>` and `dates: [...]`).

- [ ] **Step 5: Commit**

```bash
git add src/modules/schedule/services/schedule.ts src/modules/schedule/services/schedule.test.ts
git commit -m "feat(schedule): updateMyAvailability takes an explicit termId (next-term availability)"
```

---

## Task 3: Publish-gated, term-spanning `mySchedule`

**Files:**
- Modify: `src/modules/schedule/services/schedule.ts` (`mySchedule`, ~line 75)
- Modify: `src/app/(app)/page.tsx` (the dashboard — a second `mySchedule` consumer)
- Test: `src/modules/schedule/services/schedule.test.ts`

**Interfaces:**
- Consumes: `getPersonTerms`, `getActiveTerm`, `publishedDepartmentIds` (Task 1).
- Produces: `mySchedule(personId): Promise<{ terms: MyTermSchedule[] }>` where each `MyTermSchedule` is `{ term: Term; isLive: boolean; shifts: MyShift[]; availability: ResolvedAvailability | null; legacyNote: string | null; clinicDates: Date[]; pendingRequests: Map<string, PendingRequest> }`. For a non-live term, `shifts` include only assignments in published departments.

> This changes `mySchedule`'s return shape (was a single-term object; now a per-term list). It has TWO consumers: the member schedule page (`schedule/page.tsx`, rewired in Task 6) and the dashboard (`(app)/page.tsx`, updated in Step 5 of THIS task so it keeps compiling). Between this task and Task 6, `tsc` errors in `schedule/page.tsx` are expected; the dashboard must NOT be left broken (it is not a page task), so it is fixed here.

- [ ] **Step 1: Write the failing test**

Add to `schedule.test.ts` a test proving the publish gate:

```ts
it("mySchedule hides next-term assignments until the department is published, then shows them", async () => {
  const live = await prisma.term.create({ data: { code: "SU26", name: "Summer", startDate: new Date("2026-05-30"), endDate: new Date("2026-09-26"), status: "ACTIVE", clinicDates: [] } });
  const d1 = new Date(Date.UTC(2026, 8, 5, 12));
  const next = await prisma.term.create({ data: { code: "FA26", name: "Fall", startDate: new Date("2026-09-01"), endDate: new Date("2027-01-01"), status: "PLANNING", clinicDates: [d1] } });
  const dept = await prisma.department.create({ data: { code: "SRHD", name: "SRHD" } });
  const dir = await prisma.person.create({ data: { name: "Dir", status: "ACTIVE" } });
  await prisma.termMembership.create({ data: { personId: dir.id, termId: live.id, departmentId: dept.id, kind: "DIRECTOR", status: "ACTIVE" } });
  const vol = await prisma.person.create({ data: { name: "Vol", status: "ACTIVE" } });
  await prisma.termMembership.create({ data: { personId: vol.id, termId: next.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" } });
  await prisma.shiftAssignment.create({ data: { termId: next.id, departmentId: dept.id, clinicDate: d1, personId: vol.id, role: "VOLUNTEER", triage: false, walkin: false, cc: false, remote: false } });

  const before = await mySchedule(vol.id);
  const nextBefore = before.terms.find((t) => t.term.id === next.id)!;
  expect(nextBefore.shifts).toEqual([]); // not published -> hidden

  await publishSchedule(dir.id, { termId: next.id, departmentId: dept.id });
  const after = await mySchedule(vol.id);
  const nextAfter = after.terms.find((t) => t.term.id === next.id)!;
  expect(nextAfter.shifts.length).toBe(1); // published -> visible
});
```

(Import `publishSchedule` from `./publication` and `mySchedule` — already imported.)

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/modules/schedule/services/schedule.test.ts -t "until the department is published"`
Expected: FAIL to compile (`mySchedule` returns the old single-term shape; no `terms` array).

- [ ] **Step 3: Rewrite `mySchedule` to span terms with the publish gate**

Add imports (if missing): `getPersonTerms`, `getActiveTerm` (already there), `publishedDepartmentIds` from `./publication`. Extract today's single-term body into a helper `myScheduleForTerm(personId, term, isLive)`, and make `mySchedule` iterate the member's terms. Add a `MyTermSchedule` type:

```ts
export type MyTermSchedule = {
  term: Term;
  isLive: boolean;
  shifts: MyShift[];
  availability: ResolvedAvailability | null;
  legacyNote: string | null;
  clinicDates: Date[];
  pendingRequests: Map<string, PendingRequest>;
};

async function myScheduleForTerm(personId: string, term: Term, isLive: boolean): Promise<MyTermSchedule> {
  // For a non-live term, only show assignments in departments that have published.
  const publishedDepts = isLive ? null : await publishedDepartmentIds(term.id);

  const [rawShifts, rawPendingRequests] = await Promise.all([
    prisma.shiftAssignment.findMany({
      where: {
        termId: term.id,
        personId,
        ...(publishedDepts ? { departmentId: { in: [...publishedDepts] } } : {}),
      },
      include: { department: true },
      orderBy: { clinicDate: "asc" },
    }),
    prisma.shiftRequest.findMany({
      where: { termId: term.id, requesterId: personId, status: "PENDING" },
      include: { target: { select: { name: true } } },
    }),
  ]);

  const shifts: MyShift[] = rawShifts.map((s) => ({
    clinicDate: s.clinicDate,
    department: s.department,
    role: s.role,
    tags: { triage: s.triage, walkin: s.walkin, cc: s.cc, remote: s.remote },
  }));

  const pendingRequests = new Map<string, PendingRequest>();
  for (const req of rawPendingRequests) {
    pendingRequests.set(`${isoDateKey(req.requesterDate)}|${req.departmentId}`, req);
  }

  const memberships = await prisma.termMembership.findMany({
    where: { termId: term.id, personId, status: "ACTIVE" },
    include: { department: { select: { code: true } } },
    orderBy: { department: { code: "asc" } },
  });

  let availability: ResolvedAvailability | null = null;
  let legacyNote: string | null = null;
  if (memberships.length > 0) {
    const first = memberships[0];
    availability = resolveAvailability({
      baseline: first.baselineAvailability,
      selfDates: first.selfAvailabilityDates,
      selfUpdatedAt: first.availabilityUpdatedAt,
      directorDates: first.directorAvailabilityDates,
      directorSetAt: first.directorAvailabilitySetAt,
    });
    for (const m of memberships) {
      if (m.selfUpdatedAvailability != null) { legacyNote = m.selfUpdatedAvailability; break; }
    }
  }

  return { term, isLive, shifts, availability, legacyNote, clinicDates: term.clinicDates, pendingRequests };
}

export async function mySchedule(personId: string): Promise<{ terms: MyTermSchedule[] }> {
  const [personTerms, live] = await Promise.all([getPersonTerms(personId), getActiveTerm()]);
  const terms: MyTermSchedule[] = [];
  for (const term of personTerms) {
    terms.push(await myScheduleForTerm(personId, term, term.id === live?.id));
  }
  return { terms };
}
```

- [ ] **Step 4: Run the schedule test file**

Run: `npx vitest run src/modules/schedule/services/schedule.test.ts`
Expected: PASS (new gate test + Task 2 tests; any existing `mySchedule` tests must be updated to read from `.terms` — update them to find the live term entry and assert against it).

- [ ] **Step 5: Update the dashboard consumer to read the live-term entry**

The dashboard (`src/app/(app)/page.tsx`) is a live-term view. Read `src/app/(app)/page.tsx` around lines 184-306. It currently does `const { term, shifts } = schedule;` (~line 195) and `schedule.pendingRequests.size` (~line 306), where `schedule = await mySchedule(...)`. Replace the destructure with a live-entry derivation just after `schedule` is available:

```ts
  const liveEntry = schedule.terms.find((t) => t.isLive) ?? null;
  const term = liveEntry?.term ?? null;
  const shifts = liveEntry?.shifts ?? [];
```

and change the `pendingSwapCount` input (~line 306) to:

```ts
    pendingSwapCount: liveEntry?.pendingRequests.size ?? 0,
```

The dashboard is deliberately live-term only (its "upcoming shift" / "pending swap" cards are about the running term); next-term shifts/requests do not belong on it. Confirm no other field of the old `schedule` shape is read (grep `schedule\.` in the file).

- [ ] **Step 6: Typecheck the two consumers touched here**

Run: `npx tsc --noEmit 2>&1 | grep -E "\(app\)/page.tsx" || echo "dashboard clean"`
Expected: "dashboard clean" (the dashboard compiles against the new shape). The member `schedule/page.tsx` still shows expected errors until Task 6.

- [ ] **Step 7: Commit**

```bash
git add src/modules/schedule/services/schedule.ts src/modules/schedule/services/schedule.test.ts "src/app/(app)/page.tsx"
git commit -m "feat(schedule): mySchedule spans a member's terms, gating next-term on publish"
```

---

## Task 4: Term-aware request services + approver routing

**Files:**
- Modify: `src/modules/schedule/services/requests.ts`
- Test: `src/modules/schedule/services/requests.test.ts`

**Interfaces:**
- Consumes: `getPersonTerms`, `isPublished` (Task 1).
- Produces: `requestApproverRecipients(departmentId, termId)`; `createRequest(actorPersonId, input)` where `input` gains `termId`; `eligibleSwapPartners(actorPersonId, requesterDateKey, departmentId, termId)`; `listDepartmentRequests(viewerPersonId, departmentId, termId)`.

> These signature changes break callers (`createRequest`/`eligibleSwapPartners` in the member page; `listDepartmentRequests` in the builder page; `requestApproverRecipients` in the cron). Callers are rewired in Tasks 5 and 6; expected `tsc` errors there until then.

- [ ] **Step 1: Write the failing test**

Add to `requests.test.ts` (read its seed helpers first) a routing test proving `requestApproverRecipients` uses the passed term, plus a create test proving the request is stamped with the passed term:

```ts
it("requestApproverRecipients resolves the passed term's directors, not the active term's", async () => {
  // dept directed by dirA in the live term and dirB in the next term
  const live = await prisma.term.create({ data: { code: "SU26", name: "Summer", startDate: new Date("2026-05-30"), endDate: new Date("2026-09-26"), status: "ACTIVE" } });
  const next = await prisma.term.create({ data: { code: "FA26", name: "Fall", startDate: new Date("2026-09-01"), endDate: new Date("2027-01-01"), status: "PLANNING" } });
  const dept = await prisma.department.create({ data: { code: "SRHD", name: "SRHD" } });
  const dirA = await prisma.person.create({ data: { name: "DirA", status: "ACTIVE", contactEmail: "a@x.edu" } });
  const dirB = await prisma.person.create({ data: { name: "DirB", status: "ACTIVE", contactEmail: "b@x.edu" } });
  await prisma.termMembership.create({ data: { personId: dirA.id, termId: live.id, departmentId: dept.id, kind: "DIRECTOR", status: "ACTIVE" } });
  await prisma.termMembership.create({ data: { personId: dirB.id, termId: next.id, departmentId: dept.id, kind: "DIRECTOR", status: "ACTIVE" } });

  const nextRecipients = await requestApproverRecipients(dept.id, next.id);
  expect(nextRecipients.map((r) => r.id)).toContain(dirB.id);
  expect(nextRecipients.map((r) => r.id)).not.toContain(dirA.id);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/modules/schedule/services/requests.test.ts -t "passed term's directors"`
Expected: FAIL to compile (`requestApproverRecipients` takes only `departmentId`).

- [ ] **Step 3: Make `requestApproverRecipients` term-aware**

In `requests.ts`, change the signature and drop the internal `getActiveTerm`:

```ts
export async function requestApproverRecipients(
  departmentId: string,
  termId: string,
): Promise<Array<{ id: string; name: string; contactEmail: string | null }>> {
  const [directorIds, memberships] = await Promise.all([
    departmentDirectorPersonIds(departmentId),
    prisma.termMembership.findMany({
      where: { termId, departmentId, status: "ACTIVE" },
      select: { personId: true },
    }),
  ]);
  // ... rest unchanged (memberIds -> manageRequestsMemberIds -> personIds -> person.findMany) ...
```

Note: `departmentDirectorPersonIds` remains active-term-derived (a documented cross-term deferral; the ACTIVE-membership half now correctly uses `termId`). Update the two callers inside `requests.ts`: `createRequest`'s approver notify (~line 464) passes `term.id`; `remindDirectors` (~line 1121) passes `req.termId`.

- [ ] **Step 4: Make `createRequest` term-aware + publish re-check**

Change `createRequest`'s `input` to include `termId: string`. Replace the `getActiveTerm()` head with a resolve-and-validate against the member's terms, and re-check publish for a non-live term:

```ts
export async function createRequest(
  actorPersonId: string,
  input: { termId: string; requesterDateKey: string; departmentId: string; targetId?: string; targetDateKey?: string; note?: string },
): Promise<ShiftRequest> {
  const terms = await getPersonTerms(actorPersonId);
  const term = terms.find((t) => t.id === input.termId);
  if (!term) throw new RequestValidationError("You are not on that term's roster.");
  // Next-term requests are only valid once the department is published (defense in
  // depth: a member can only see a published next-term assignment to request on).
  if (term.status !== "ACTIVE" && !(await isPublished(term.id, input.departmentId))) {
    throw new RequestValidationError("That schedule is not published.");
  }
  // ... rest unchanged, using `term.clinicDates` / `term.id` as today ...
```

(Add `import { getPersonTerms } from "@/platform/terms/person-terms";` and `import { isPublished } from "./publication";`.)

- [ ] **Step 5: Make `eligibleSwapPartners` + `listDepartmentRequests` term-aware**

`eligibleSwapPartners(actorPersonId, requesterDateKey, departmentId, termId)`: replace `const term = await getActiveTerm(); if (!term) return [];` with a load of the passed term: `const term = await prisma.term.findUnique({ where: { id: termId } }); if (!term) return [];`. The rest (which uses `term.id`, `term.clinicDates`) is unchanged.

`listDepartmentRequests(viewerPersonId, departmentId, termId)`: after the `scopeCheck`, replace `const term = await getActiveTerm(); if (!term) return [];` with `const term = await prisma.term.findUnique({ where: { id: termId } }); if (!term) return [];`. The rest is unchanged.

- [ ] **Step 6: Run the requests test file**

Run: `npx vitest run src/modules/schedule/services/requests.test.ts`
Expected: PASS (new routing test + existing; existing `createRequest`/`eligibleSwapPartners`/`listDepartmentRequests` test calls must be updated to pass the fixture's `termId`).

- [ ] **Step 7: Commit**

```bash
git add src/modules/schedule/services/requests.ts src/modules/schedule/services/requests.test.ts
git commit -m "feat(schedule): term-aware request services + approver routing (per request term)"
```

---

## Task 5: `schedule-reminders` cron routes per request's own term

**Files:**
- Modify: `src/app/api/cron/schedule-reminders/route.ts`

**Interfaces:**
- Consumes: term-aware `requestApproverRecipients(departmentId, termId)` (Task 4).

- [ ] **Step 1: Update the approver cache + lookup to key on (department, term)**

The cron memoizes approvers per department. Since routing is now per-term, key the cache on `${departmentId}|${termId}` and pass the request's `termId`. Change the cache + helper:

```ts
const approverCache = new Map<string, Array<{ id: string; name: string; contactEmail: string | null }>>();
async function approversFor(departmentId: string, termId: string) {
  const key = `${departmentId}|${termId}`;
  const cached = approverCache.get(key);
  if (cached) return cached;
  const recipients = await requestApproverRecipients(departmentId, termId);
  approverCache.set(key, recipients);
  return recipients;
}
```

Then, in the loop over `pendingRequests`, replace the `approversForDept(pending.departmentId)` call with `approversFor(pending.departmentId, pending.termId)`.

- [ ] **Step 2: Typecheck + lint**

Run: `npx tsc --noEmit 2>&1 | grep -E "schedule-reminders" || echo "no errors in the cron"`
Expected: no errors in the cron file. (Other files, e.g. the member/builder pages, still show expected errors from Tasks 3-4 until Tasks 6-7.)
Run: `npx eslint "src/app/api/cron/schedule-reminders/route.ts"`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add "src/app/api/cron/schedule-reminders/route.ts"
git commit -m "fix(schedule): route pending-request reminders via each request's own term"
```

---

## Task 6: Term-grouped member `/schedule` page

**Files:**
- Modify: `src/app/(app)/schedule/page.tsx`

**Interfaces:**
- Consumes: the term-list `mySchedule` (Task 3); the term-aware `updateMyAvailability` (Task 2); `createRequest`/`eligibleSwapPartners` (Task 4).

UI wiring; deliverable is `tsc` + full `npm run lint` clean and correct term-grouped rendering. Read the whole page first.

- [ ] **Step 1: Read `src/app/(app)/schedule/page.tsx` fully**

Understand how it consumes today's single-term `mySchedule` (shifts, availability, clinicDates, pendingRequests) and how its availability form + swap actions call the services.

- [ ] **Step 2: Iterate `data.terms` and render one section per term**

Replace the single-term consumption with a map over `data.terms` (from `mySchedule`). For each `t of data.terms`, render a section headed by the term name (show the term heading only when `data.terms.length > 1`, so the single-term page looks unchanged). The live section (`t.isLive`) renders exactly as today. A non-live section:
- Always renders the availability editor (bound to `t.term`), because availability is editable pre-publish.
- Renders the schedule grid + swap actions only when `t.shifts.length > 0` (i.e. a published department contributed assignments); otherwise a placeholder: `Your {t.term.name} schedule isn't published yet. It will show here once it's ready.`

- [ ] **Step 3: Thread `termId` through the availability + request actions**

- The availability submit action calls `updateMyAvailability(actor.personId, { termId: <this section's term id>, dates })` (was positional `dates`).
- The swap/drop request action calls `createRequest(actor.personId, { termId: <section term id>, ... })` and any `eligibleSwapPartners(actor.personId, dateKey, departmentId, <section term id>)`.
- Each server action must carry its section's term id (via a hidden `termId` form field or a bound arg).

- [ ] **Step 4: Typecheck + full lint**

Run: `npx tsc --noEmit`
Expected: no errors from the member page (Task 3-4 breakage here resolved).
Run: `npx eslint "src/app/(app)/schedule/page.tsx"`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/schedule/page.tsx"
git commit -m "feat(schedule): term-grouped member schedule page (next-term availability + published view + swaps)"
```

---

## Task 7: Builder publish control + working-term requests panel

**Files:**
- Modify: `src/app/(app)/schedule/builder/page.tsx`

**Interfaces:**
- Consumes: `publishSchedule`/`unpublishSchedule`/`isPublished` (Task 1); term-aware `listDepartmentRequests` (Task 4).

UI wiring; deliverable is `tsc` + full `npm run lint` clean. Read the page (it is already term-aware from Spec 1: it has `workingTerm`, `liveTerm`, `editable`, `termParam`).

- [ ] **Step 1: Add publish/unpublish server actions + control**

Add two inline server actions (`publishAction`, `unpublishAction`) calling `publishSchedule`/`unpublishSchedule(actor.personId, { termId: workingTerm.id, departmentId: dept.id })`, wrapped in the page's existing `runAction` pattern, with `PublicationError` in `domainErrors` and redirects preserving `term: termParam`. Render a control (button) near the top of the builder that shows **only when the working term is the next (PLANNING) term** (i.e. `workingTerm.status === "PLANNING"`): "Publish {dept.code}'s {workingTerm.name} schedule" when not yet published, or "Unpublish" when `await isPublished(workingTerm.id, dept.id)`. Do not render it for the live or archived term.

- [ ] **Step 2: Un-gate the requests panel to the working term**

Spec 1 gated the requests panel to the live term only. Now show the working term's requests: change the requests load to pass the working term, and render the panel whenever the term is editable (live or next), not only live:

```ts
const canManageRequests = editable && (await canManageRequestsForDept(session.personId, dept.id));
const requestRows = canManageRequests ? await listDepartmentRequests(session.personId, dept.id, workingTerm.id) : [];
```

(Archived stays read-only: `editable` is false, so no panel.)

- [ ] **Step 3: Typecheck + full lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors (all intermediate breakage from Tasks 3-4 now resolved across the branch).

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/schedule/builder/page.tsx"
git commit -m "feat(schedule): builder publish control (next-term) + working-term requests panel"
```

---

## Final verification

- [ ] **Run the affected suites**

Run: `npx vitest run src/modules/schedule src/platform/terms`
Expected: PASS.

- [ ] **Full typecheck + lint (pre-push gate)**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Manual smoke (optional, if a dev DB with two terms exists):** as a director, open the builder on the next term, publish a department; as a member of that next term, confirm `/schedule` shows a next-term section (availability editable before publish; the schedule + swap appear after publish; unpublish hides them again). Confirm the live-term member page and current-term scheduling are unchanged.
