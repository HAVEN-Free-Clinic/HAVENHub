# Offboard Epic Revocation and YNHH Deactivation Request: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make offboarding revoke a person's Epic (EHR) access by cancelling their open access requests and queuing a tracked deactivation task, block completing access grants for non-active people, and let an ITCM admin batch pending deactivations into a YNHH service request (PDF + spreadsheet + email).

**Architecture:** `EpicRequest` is the single source of truth for an Epic access change that is owed or in flight. The offboard convergence point (`setPersonStatusField`) cancels open grant requests and creates a `PENDING DEACTIVATE` request when the person has a recorded `epicId`. `completeRequest` gains a status guard. The ITCM generator gains deactivate request types that reconcile existing pending deactivations onto a new `YnhhTicket`.

**Tech Stack:** Next.js App Router (React 19, server actions), Prisma 6 + Postgres, pdf-lib, ExcelJS, Vitest.

## Global Constraints

- No em-dashes in any prose, comment, or copy. Use colons, parentheses, commas, or "to" instead.
- Product name in UI/prose is "HAVEN Hub" (two words); code identifiers stay `havenhub`.
- `epicId` is NEVER cleared automatically, including on deactivation completion (it is a historical record).
- The hook lives in `setPersonStatusField` (the single offboard convergence point), not only in `executeOffboard`.
- Services trust their callers for permissions; pages and server actions gate via `requirePermission`. Do not add permission checks inside service functions beyond what already exists.
- Tests run against a dedicated test database via `TEST_DATABASE_URL`; vitest ignores `.env`. Worktrees must use a per-worktree DB to avoid cross-worktree deadlocks.
- Audit contract: `setPersonStatusField` emits exactly ONE audit row per status change. New data rides on that row's `after` payload, never as extra rows.
- Phase 1 (Tasks 0 to 3) closes issue #87 on its own and is independently shippable. Phase 2 (Tasks 4 to 9) adds the deactivation service-request generation.

---

## Task 0: Schema enum and test-database setup

**Files:**
- Modify: `prisma/schema.prisma` (the `EpicRequestKind` enum, lines 334 to 338)
- Create: `prisma/migrations/<timestamp>_add_epic_deactivate_kind/migration.sql` (generated)

**Interfaces:**
- Produces: the `DEACTIVATE` value of `EpicRequestKind`, importable as a Prisma enum member and usable in `prisma.epicRequest` writes.

- [ ] **Step 1: Add the enum value**

In `prisma/schema.prisma`, change:

```prisma
enum EpicRequestKind {
  NEW
  MODIFY
  RENEW
}
```

to:

```prisma
enum EpicRequestKind {
  NEW
  MODIFY
  RENEW
  DEACTIVATE
}
```

- [ ] **Step 2: Create a per-worktree test database**

Run (the local Postgres is the docker compose service on port 5434):

```bash
docker compose exec -T postgres psql -U haven -d havenhub -c 'CREATE DATABASE havenhub_test_offboard_epic' || true
```

Expected: `CREATE DATABASE` (or a "already exists" notice on a re-run, which the `|| true` swallows).

- [ ] **Step 3: Generate the migration and apply it to the dev database**

Run:

```bash
npx prisma migrate dev --name add_epic_deactivate_kind
```

Expected: a new folder under `prisma/migrations/` containing an `ALTER TYPE "EpicRequestKind" ADD VALUE 'DEACTIVATE'` statement, and "Your database is now in sync with your schema."

- [ ] **Step 4: Apply migrations to the test database**

Run:

```bash
DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_offboard_epic \
DATABASE_URL_UNPOOLED=postgresql://haven:haven_dev@localhost:5434/havenhub_test_offboard_epic \
npx prisma migrate deploy
```

Expected: "All migrations have been applied" (the new migration included).

- [ ] **Step 5: Confirm the Prisma client regenerated**

Run:

```bash
npx prisma generate >/dev/null && node -e "const {EpicRequestKind}=require('@prisma/client'); if(!EpicRequestKind.DEACTIVATE) throw new Error('DEACTIVATE missing'); console.log('OK', EpicRequestKind.DEACTIVATE)"
```

Expected: `OK DEACTIVATE`

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(epic): add DEACTIVATE EpicRequestKind"
```

**Note for all later test runs in this plan:** prefix vitest commands with
`TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_offboard_epic`
so they hit this worktree's database.

---

## Task 1: Offboard cancels open grants and enqueues a deactivation task

**Files:**
- Modify: `src/platform/people.ts` (`setPersonStatusField`, lines 231 to 284)
- Test: `src/platform/people.test.ts` (add to the existing `describe("setPersonStatusField", ...)` block)

**Interfaces:**
- Consumes: `DEACTIVATE` from Task 0.
- Produces: `setPersonStatusField(actorPersonId, personId, "OFFBOARDED")` now, within its existing transaction, cancels the person's open `NEW`/`MODIFY`/`RENEW` requests and creates one `PENDING DEACTIVATE` request when `epicId` is set; `"ACTIVE"` cancels any open `DEACTIVATE`. The `person.offboard` audit `after` gains `cancelledEpicRequestIds: string[]` and `deactivationRequestId: string | null`; `person.reactivate` `after` gains `cancelledDeactivationRequestIds: string[]`.

- [ ] **Step 1: Write the failing tests**

Add these imports near the top of `src/platform/people.test.ts` if not already present: the file already imports `prisma`, `resetDb`, and `setPersonStatusField`. Append inside `describe("setPersonStatusField", () => { ... })`:

```ts
it("offboard cancels open NEW/MODIFY/RENEW requests and enqueues one PENDING DEACTIVATE when epicId is set", async () => {
  const actor = await prisma.person.create({ data: { name: "Actor" } });
  const person = await prisma.person.create({
    data: { name: "Leaver", epicId: "E123", status: "ACTIVE" },
  });
  const open = await prisma.epicRequest.create({
    data: { personId: person.id, kind: "MODIFY", status: "PENDING", requestedById: actor.id, notes: "prior" },
  });

  await setPersonStatusField(actor.id, person.id, "OFFBOARDED");

  const cancelled = await prisma.epicRequest.findUnique({ where: { id: open.id } });
  expect(cancelled?.status).toBe("CANCELLED");
  expect(cancelled?.notes).toBe("prior\nCancelled: person offboarded");

  const deact = await prisma.epicRequest.findMany({ where: { personId: person.id, kind: "DEACTIVATE" } });
  expect(deact).toHaveLength(1);
  expect(deact[0].status).toBe("PENDING");
  expect(deact[0].requestedById).toBe(actor.id);

  const log = await prisma.auditLog.findFirst({
    where: { entityId: person.id, action: "person.offboard" },
    orderBy: { createdAt: "desc" },
  });
  const after = log?.after as Record<string, unknown>;
  expect(after.cancelledEpicRequestIds).toEqual([open.id]);
  expect(after.deactivationRequestId).toBe(deact[0].id);
});

it("offboard creates NO deactivation request when the person has no epicId", async () => {
  const actor = await prisma.person.create({ data: { name: "Actor" } });
  const person = await prisma.person.create({ data: { name: "NoEpic", epicId: null, status: "ACTIVE" } });

  await setPersonStatusField(actor.id, person.id, "OFFBOARDED");

  const deact = await prisma.epicRequest.findMany({ where: { personId: person.id, kind: "DEACTIVATE" } });
  expect(deact).toHaveLength(0);
});

it("offboard is idempotent: a second offboard does not create a duplicate DEACTIVATE", async () => {
  const actor = await prisma.person.create({ data: { name: "Actor" } });
  const person = await prisma.person.create({ data: { name: "Leaver", epicId: "E123", status: "ACTIVE" } });

  await setPersonStatusField(actor.id, person.id, "OFFBOARDED");
  await setPersonStatusField(actor.id, person.id, "OFFBOARDED");

  const deact = await prisma.epicRequest.findMany({ where: { personId: person.id, kind: "DEACTIVATE" } });
  expect(deact).toHaveLength(1);
});

it("reactivation cancels an open DEACTIVATE request", async () => {
  const actor = await prisma.person.create({ data: { name: "Actor" } });
  const person = await prisma.person.create({ data: { name: "Leaver", epicId: "E123", status: "ACTIVE" } });
  await setPersonStatusField(actor.id, person.id, "OFFBOARDED");

  await setPersonStatusField(actor.id, person.id, "ACTIVE");

  const deact = await prisma.epicRequest.findMany({ where: { personId: person.id, kind: "DEACTIVATE" } });
  expect(deact).toHaveLength(1);
  expect(deact[0].status).toBe("CANCELLED");

  const log = await prisma.auditLog.findFirst({
    where: { entityId: person.id, action: "person.reactivate" },
    orderBy: { createdAt: "desc" },
  });
  const after = log?.after as Record<string, unknown>;
  expect(after.cancelledDeactivationRequestIds).toEqual([deact[0].id]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_offboard_epic \
npx vitest run src/platform/people.test.ts -t "setPersonStatusField"
```

Expected: the four new tests FAIL (no DEACTIVATE created; `after` fields undefined).

- [ ] **Step 3: Implement the transaction changes**

In `src/platform/people.ts`, replace the body of `setPersonStatusField` from the `let removedMemberships = 0;` line through the end of the `recordAudit` call with:

```ts
  let removedMemberships = 0;
  let cancelledEpicRequestIds: string[] = [];
  let deactivationRequestId: string | null = null;
  let cancelledDeactivationRequestIds: string[] = [];

  const updated = await prisma.$transaction(async (tx) => {
    if (status === "OFFBOARDED") {
      const { count } = await tx.termMembership.updateMany({
        where: { personId, status: "ACTIVE" },
        data: { status: "REMOVED" },
      });
      removedMemberships = count;

      // Cancel open access-granting requests. A person who has left should not
      // have a NEW/MODIFY/RENEW request lingering as actionable in the queue.
      // DEACTIVATE is intentionally excluded: it is the revocation task itself.
      const openGrants = await tx.epicRequest.findMany({
        where: {
          personId,
          status: { in: ["PENDING", "SUBMITTED"] },
          kind: { in: ["NEW", "MODIFY", "RENEW"] },
        },
        select: { id: true, notes: true },
      });
      for (const r of openGrants) {
        const line = "Cancelled: person offboarded";
        await tx.epicRequest.update({
          where: { id: r.id },
          data: { status: "CANCELLED", notes: r.notes ? `${r.notes}\n${line}` : line },
        });
      }
      cancelledEpicRequestIds = openGrants.map((r) => r.id);

      // Enqueue a deactivation task when there is recorded Epic access to
      // revoke and no open DEACTIVATE request already exists (idempotent).
      if (existing.epicId) {
        const openDeact = await tx.epicRequest.findFirst({
          where: { personId, status: { in: ["PENDING", "SUBMITTED"] }, kind: "DEACTIVATE" },
          select: { id: true },
        });
        if (!openDeact) {
          const created = await tx.epicRequest.create({
            data: { personId, kind: "DEACTIVATE", status: "PENDING", requestedById: actorPersonId },
            select: { id: true },
          });
          deactivationRequestId = created.id;
        }
      }
    } else {
      // Reactivation: a returning person no longer owes a revocation.
      const openDeact = await tx.epicRequest.findMany({
        where: { personId, status: { in: ["PENDING", "SUBMITTED"] }, kind: "DEACTIVATE" },
        select: { id: true, notes: true },
      });
      for (const r of openDeact) {
        const line = "Cancelled: person reactivated";
        await tx.epicRequest.update({
          where: { id: r.id },
          data: { status: "CANCELLED", notes: r.notes ? `${r.notes}\n${line}` : line },
        });
      }
      cancelledDeactivationRequestIds = openDeact.map((r) => r.id);
    }

    return tx.person.update({
      where: { id: personId },
      data: { status },
    });
  });

  const action = status === "OFFBOARDED" ? "person.offboard" : "person.reactivate";

  // Await audit. recordAudit never throws, so this cannot abort the mutation.
  // One audit row per status change is the contract callers rely on; the
  // membership count and Epic-request effects ride on that single row.
  await recordAudit({
    actorPersonId,
    action,
    entityType: "Person",
    entityId: personId,
    before: { status: existing.status },
    after: {
      status: updated.status,
      ...(status === "OFFBOARDED"
        ? { removedMemberships, cancelledEpicRequestIds, deactivationRequestId }
        : { cancelledDeactivationRequestIds }),
    },
  });

  return updated;
```

Also update the function's doc comment above it to note the new Epic behavior (cancels open grant requests, enqueues a DEACTIVATE when epicId is set, cancels DEACTIVATE on reactivation).

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_offboard_epic \
npx vitest run src/platform/people.test.ts
```

Expected: all tests in the file PASS (including the pre-existing offboard/reactivate audit tests, which still see their expected actions and counts).

- [ ] **Step 5: Commit**

```bash
git add src/platform/people.ts src/platform/people.test.ts
git commit -m "feat(offboard): cancel open Epic grants and enqueue a DEACTIVATE task on offboard"
```

---

## Task 2: completeRequest blocks grants for non-active people and handles DEACTIVATE

**Files:**
- Modify: `src/modules/volunteers/services/epic.ts` (`completeRequest`, lines 475 to 522)
- Test: `src/modules/volunteers/services/epic.test.ts` (add to the existing `completeRequest` describe block)

**Interfaces:**
- Consumes: `DEACTIVATE` from Task 0.
- Produces: `completeRequest(actorPersonId, requestId, epicId?)` throws `EpicStateError` for a `NEW`/`MODIFY`/`RENEW` request whose person is not `ACTIVE`; for a `DEACTIVATE` request it ignores `epicId`, marks the request `COMPLETED`, and leaves `Person.epicId` unchanged.

- [ ] **Step 1: Write the failing tests**

In `src/modules/volunteers/services/epic.test.ts`, inside the `describe` block for `completeRequest`, add (the file's `createPerson` helper accepts `{ epicId, status }`, and `grantPermission`-style helpers exist; reuse the file's existing manager-permission helper to give the actor `volunteers.manage_epic`). Use the same manager-setup the other `completeRequest` tests use:

```ts
it("rejects completing a NEW request when the person is not ACTIVE", async () => {
  const manager = await createPerson("Mgr");
  await grantManageEpic(manager.id); // same helper the other completeRequest tests use
  const person = await createPerson("Leaver", { status: "OFFBOARDED" });
  const req = await prisma.epicRequest.create({
    data: { personId: person.id, kind: "NEW", status: "SUBMITTED", requestedById: manager.id },
  });

  await expect(completeRequest(manager.id, req.id, "NEWID")).rejects.toBeInstanceOf(EpicStateError);

  const after = await prisma.person.findUnique({ where: { id: person.id } });
  expect(after?.epicId).toBeNull();
});

it("completes a DEACTIVATE request for an OFFBOARDED person without clearing epicId", async () => {
  const manager = await createPerson("Mgr");
  await grantManageEpic(manager.id);
  const person = await createPerson("Leaver", { epicId: "E123", status: "OFFBOARDED" });
  const req = await prisma.epicRequest.create({
    data: { personId: person.id, kind: "DEACTIVATE", status: "PENDING", requestedById: manager.id },
  });

  await completeRequest(manager.id, req.id);

  const done = await prisma.epicRequest.findUnique({ where: { id: req.id } });
  expect(done?.status).toBe("COMPLETED");
  expect(done?.completedAt).not.toBeNull();
  const after = await prisma.person.findUnique({ where: { id: person.id } });
  expect(after?.epicId).toBe("E123"); // never cleared
});
```

If the file does not already define a `grantManageEpic` helper, add one near the top helpers, modeled on the existing role-grant pattern in `offboarding.test.ts`:

```ts
async function grantManageEpic(personId: string) {
  const role = await prisma.role.create({
    data: {
      name: `Role-epic-${Date.now()}-${Math.random()}`,
      isSystem: false,
      grants: { create: [{ permission: "volunteers.manage_epic" }] },
    },
  });
  await prisma.roleAssignment.create({ data: { roleId: role.id, personId, termId: null } });
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_offboard_epic \
npx vitest run src/modules/volunteers/services/epic.test.ts -t "completeRequest"
```

Expected: the NEW-non-active test FAILS (no guard yet, request completes), and the DEACTIVATE test FAILS (current code throws "epicId required" for non NEW/MODIFY only; DEACTIVATE falls through, but `req.status` PENDING is fine, so it may pass marking COMPLETED; the test that asserts behavior with the new guard ordering should still be exercised). Confirm at least the NEW-non-active assertion fails before implementing.

- [ ] **Step 3: Implement the guard and DEACTIVATE handling**

In `src/modules/volunteers/services/epic.ts`, in `completeRequest`, after loading `req` and validating its status (`PENDING`/`SUBMITTED`), load the person and add the guard before the kind branch:

```ts
  const person = await prisma.person.findUnique({ where: { id: req.personId } });
  if (!person) throw new EpicNotFoundError("Person for this request no longer exists.");

  // Access-granting kinds may only be completed for an ACTIVE person. This
  // prevents stamping a fresh epicId onto someone who has been offboarded and
  // removes the inconsistency with createEpicRequest (which already refuses a
  // non-active person). DEACTIVATE is exempt: completing it is the whole point
  // for a person who has left.
  if (req.kind !== "DEACTIVATE" && person.status !== "ACTIVE") {
    throw new EpicStateError(
      `Cannot complete a ${req.kind} request for a non-active person (status: ${person.status}).`
    );
  }
```

Then adjust the kind branch so `DEACTIVATE` writes nothing to the person:

```ts
  let writtenEpicId: string | null = null;

  if (req.kind === "NEW" || req.kind === "MODIFY") {
    if (!epicId || !epicId.trim()) {
      throw new EpicStateError(`An epicId is required to complete a ${req.kind} request.`);
    }
    writtenEpicId = epicId.trim();
    try {
      await updatePersonFields(actorPersonId, req.personId, { epicId: writtenEpicId });
    } catch (err) {
      if (err instanceof PersonNotFoundError) {
        throw new EpicNotFoundError("Person for this request no longer exists.");
      }
      throw err;
    }
  }
  // RENEW and DEACTIVATE: leave Person.epicId untouched. DEACTIVATE keeps the
  // epicId as a historical record per product decision; revocation happens at
  // YNHH and is tracked by the request status, not by clearing the field.
```

Update the `completeRequest` doc comment to describe the non-active guard and the DEACTIVATE path.

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_offboard_epic \
npx vitest run src/modules/volunteers/services/epic.test.ts
```

Expected: the whole `epic.test.ts` file PASSES, including pre-existing `completeRequest` tests (the existing NEW/RENEW tests use ACTIVE people, so the new guard does not affect them).

- [ ] **Step 5: Commit**

```bash
git add src/modules/volunteers/services/epic.ts src/modules/volunteers/services/epic.test.ts
git commit -m "fix(epic): block completing access grants for non-active people; handle DEACTIVATE"
```

---

## Task 3: executeOffboard end-to-end revocation test

**Files:**
- Test: `src/modules/volunteers/services/offboarding.test.ts` (add to the `executeOffboard` describe block)

**Interfaces:**
- Consumes: `executeOffboard` (unchanged) which delegates the status flip to `setPersonStatusField` (Task 1). No production code changes; this task proves the convergence end to end.

- [ ] **Step 1: Write the failing test**

In `src/modules/volunteers/services/offboarding.test.ts`, add inside the `executeOffboard` describe block (the file already has `createPerson`, `createTerm`, `createDepartment`, `createMembership`, `grantPermission`):

```ts
it("offboarding a person with an epicId cancels open grants and queues a DEACTIVATE", async () => {
  const term = await createTerm("ACTIVE");
  const dept = await createDepartment("EPIC");
  const actor = await createPerson("Exec");
  await grantPermission(actor.id, "volunteers.manage_offboarding");

  const person = await prisma.person.create({ data: { name: "Leaver", epicId: "E999", status: "ACTIVE" } });
  await createMembership(person.id, term.id, dept.id, "VOLUNTEER", "ACTIVE");
  const openReq = await prisma.epicRequest.create({
    data: { personId: person.id, kind: "MODIFY", status: "PENDING", requestedById: actor.id },
  });

  await executeOffboard(actor.id, person.id);

  const updated = await prisma.person.findUnique({ where: { id: person.id } });
  expect(updated?.status).toBe("OFFBOARDED");

  const grant = await prisma.epicRequest.findUnique({ where: { id: openReq.id } });
  expect(grant?.status).toBe("CANCELLED");

  const deact = await prisma.epicRequest.findMany({ where: { personId: person.id, kind: "DEACTIVATE" } });
  expect(deact).toHaveLength(1);
  expect(deact[0].status).toBe("PENDING");
});
```

- [ ] **Step 2: Run to verify it passes (Tasks 1 and 2 already implement the behavior)**

Run:

```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_offboard_epic \
npx vitest run src/modules/volunteers/services/offboarding.test.ts
```

Expected: PASS. (This is a characterization test confirming convergence; if it fails, the offboard path is not routing through the Task 1 logic and must be investigated before proceeding.)

- [ ] **Step 3: Commit**

```bash
git add src/modules/volunteers/services/offboarding.test.ts
git commit -m "test(offboard): executeOffboard revokes Epic via the convergence point"
```

**Phase 1 complete.** Issue #87 is closed: open grants are cancelled, a revocation task is tracked, and completing a grant for an offboarded person is blocked. Run the full suite once before moving on:

```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_offboard_epic npm test
```

---

## Task 4: listPendingDeactivations query

**Files:**
- Modify: `src/modules/admin/services/itcm.ts` (add the function and its exported type)
- Test: `src/modules/admin/services/itcm.test.ts` (create if absent; otherwise append)

**Interfaces:**
- Produces: `listPendingDeactivations(): Promise<PendingDeactivation[]>` where
  `type PendingDeactivation = { id: string; name: string; netId: string | null; contactEmail: string | null; epicId: string | null; departmentNames: string[] }`.
  Returns one row per person who has an open (`PENDING`) `DEACTIVATE` request, sorted by name.

- [ ] **Step 1: Write the failing test**

Create or append `src/modules/admin/services/itcm.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { listPendingDeactivations } from "./itcm";

describe("listPendingDeactivations", () => {
  beforeEach(resetDb);

  it("returns only people with an open PENDING DEACTIVATE request", async () => {
    const actor = await prisma.person.create({ data: { name: "Actor" } });
    const a = await prisma.person.create({ data: { name: "Alice", epicId: "EA", status: "OFFBOARDED" } });
    const b = await prisma.person.create({ data: { name: "Bob", epicId: "EB", status: "OFFBOARDED" } });
    const c = await prisma.person.create({ data: { name: "Carol", epicId: "EC", status: "ACTIVE" } });

    await prisma.epicRequest.create({ data: { personId: a.id, kind: "DEACTIVATE", status: "PENDING", requestedById: actor.id } });
    await prisma.epicRequest.create({ data: { personId: b.id, kind: "DEACTIVATE", status: "COMPLETED", requestedById: actor.id } });
    await prisma.epicRequest.create({ data: { personId: c.id, kind: "NEW", status: "PENDING", requestedById: actor.id } });

    const rows = await listPendingDeactivations();
    expect(rows.map((r) => r.name)).toEqual(["Alice"]);
    expect(rows[0].epicId).toBe("EA");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run:

```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_offboard_epic \
npx vitest run src/modules/admin/services/itcm.test.ts
```

Expected: FAIL with "listPendingDeactivations is not a function".

- [ ] **Step 3: Implement the query**

Append to `src/modules/admin/services/itcm.ts`:

```ts
// ---------------------------------------------------------------------------
// listPendingDeactivations
// ---------------------------------------------------------------------------

export type PendingDeactivation = {
  id: string;
  name: string;
  netId: string | null;
  contactEmail: string | null;
  epicId: string | null;
  departmentNames: string[];
};

/**
 * Returns people who have an open (PENDING) DEACTIVATE EpicRequest: the people
 * an admin can batch into a YNHH deactivation service request. Offboarded
 * people are no longer active members, so they do not appear in
 * listDepartmentsWithMembers; this is the person source for the deactivate flow.
 *
 * departmentNames is best-effort: the person's most recent term memberships
 * (any status) for display only.
 */
export async function listPendingDeactivations(): Promise<PendingDeactivation[]> {
  const requests = await prisma.epicRequest.findMany({
    where: { kind: "DEACTIVATE", status: "PENDING" },
    include: {
      person: {
        select: {
          id: true,
          name: true,
          netId: true,
          contactEmail: true,
          epicId: true,
          memberships: {
            select: { department: { select: { name: true } } },
            orderBy: { term: { startDate: "desc" } },
          },
        },
      },
    },
    orderBy: { person: { name: "asc" } },
  });

  // De-duplicate by person (a person should have at most one open DEACTIVATE,
  // but guard against duplicates) and dedupe department names.
  const byPerson = new Map<string, PendingDeactivation>();
  for (const r of requests) {
    if (byPerson.has(r.person.id)) continue;
    const departmentNames = [...new Set(r.person.memberships.map((m) => m.department.name))];
    byPerson.set(r.person.id, {
      id: r.person.id,
      name: r.person.name,
      netId: r.person.netId,
      contactEmail: r.person.contactEmail,
      epicId: r.person.epicId,
      departmentNames,
    });
  }
  return [...byPerson.values()];
}
```

Note: confirm the Person to TermMembership relation field name is `memberships` in `prisma/schema.prisma`. If it differs (for example `termMemberships`), use that name. Verify with:

```bash
grep -nE "TermMembership(\[\])?\s" prisma/schema.prisma
```

- [ ] **Step 4: Run to verify it passes**

Run:

```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_offboard_epic \
npx vitest run src/modules/admin/services/itcm.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/admin/services/itcm.ts src/modules/admin/services/itcm.test.ts
git commit -m "feat(itcm): listPendingDeactivations query for the deactivate flow"
```

---

## Task 5: reconcileDeactivationRequests helper

**Files:**
- Modify: `src/modules/admin/services/itcm.ts`
- Test: `src/modules/admin/services/itcm.test.ts`

**Interfaces:**
- Produces: `reconcileDeactivationRequests(actorPersonId: string, personIds: string[], ticketId: string): Promise<void>`. For each person id: if an open (`PENDING`/`SUBMITTED`) `DEACTIVATE` request exists, attach it to `ticketId` and set status `SUBMITTED`; otherwise create a `SUBMITTED DEACTIVATE` request attached to `ticketId`. Never creates a duplicate when one is reused.

- [ ] **Step 1: Write the failing test**

Append to `src/modules/admin/services/itcm.test.ts`:

```ts
import { reconcileDeactivationRequests } from "./itcm";

describe("reconcileDeactivationRequests", () => {
  beforeEach(resetDb);

  it("attaches an existing pending DEACTIVATE to the ticket without duplicating, and creates one when missing", async () => {
    const actor = await prisma.person.create({ data: { name: "Actor" } });
    const withReq = await prisma.person.create({ data: { name: "HasReq", epicId: "E1", status: "OFFBOARDED" } });
    const withoutReq = await prisma.person.create({ data: { name: "NoReq", epicId: "E2", status: "OFFBOARDED" } });
    const existing = await prisma.epicRequest.create({
      data: { personId: withReq.id, kind: "DEACTIVATE", status: "PENDING", requestedById: actor.id },
    });
    const ticket = await prisma.ynhhTicket.create({ data: { submittedById: actor.id, status: "OPEN" } });

    await reconcileDeactivationRequests(actor.id, [withReq.id, withoutReq.id], ticket.id);

    const reused = await prisma.epicRequest.findUnique({ where: { id: existing.id } });
    expect(reused?.status).toBe("SUBMITTED");
    expect(reused?.ticketId).toBe(ticket.id);

    const forWithReq = await prisma.epicRequest.findMany({ where: { personId: withReq.id, kind: "DEACTIVATE" } });
    expect(forWithReq).toHaveLength(1); // no duplicate

    const created = await prisma.epicRequest.findMany({ where: { personId: withoutReq.id, kind: "DEACTIVATE" } });
    expect(created).toHaveLength(1);
    expect(created[0].status).toBe("SUBMITTED");
    expect(created[0].ticketId).toBe(ticket.id);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run:

```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_offboard_epic \
npx vitest run src/modules/admin/services/itcm.test.ts -t "reconcileDeactivationRequests"
```

Expected: FAIL with "reconcileDeactivationRequests is not a function".

- [ ] **Step 3: Implement the helper**

Append to `src/modules/admin/services/itcm.ts`:

```ts
// ---------------------------------------------------------------------------
// reconcileDeactivationRequests
// ---------------------------------------------------------------------------

/**
 * Links the selected people's deactivation requests to a YNHH ticket when an
 * admin generates a deactivation service request. For each person: reuse an
 * open (PENDING/SUBMITTED) DEACTIVATE request if one exists (the one queued at
 * offboard), attaching it to the ticket and marking it SUBMITTED; otherwise
 * create a SUBMITTED DEACTIVATE request attached to the ticket (supports an
 * ad-hoc deactivation for someone who was not auto-queued).
 *
 * Trusts its caller for permissions: the generate route gates on admin.access.
 */
export async function reconcileDeactivationRequests(
  actorPersonId: string,
  personIds: string[],
  ticketId: string
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    for (const personId of personIds) {
      const open = await tx.epicRequest.findFirst({
        where: { personId, kind: "DEACTIVATE", status: { in: ["PENDING", "SUBMITTED"] } },
        select: { id: true },
      });
      if (open) {
        await tx.epicRequest.update({
          where: { id: open.id },
          data: { status: "SUBMITTED", ticketId },
        });
      } else {
        await tx.epicRequest.create({
          data: { personId, kind: "DEACTIVATE", status: "SUBMITTED", ticketId, requestedById: actorPersonId },
        });
      }
    }
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run:

```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_offboard_epic \
npx vitest run src/modules/admin/services/itcm.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/admin/services/itcm.ts src/modules/admin/services/itcm.test.ts
git commit -m "feat(itcm): reconcileDeactivationRequests links pending deactivations to a ticket"
```

---

## Task 6: Deactivation request types in the PDF generator

**Files:**
- Modify: `src/modules/admin/services/itcm-pdf.ts` (`RequestType`, `SECTION_IX`, `generatePdf`)
- Test: `src/modules/admin/services/itcm-pdf.test.ts`

**Interfaces:**
- Consumes: the existing `generatePdf(args)` signature (unchanged shape).
- Produces: `RequestType` additionally includes `"deactivate_individual"` and `"bulk_deactivate"`. For these, `generatePdf` fills the person's existing `epicId` (individual) or "See spreadsheet" (bulk), checks the termination/deactivation field, and uses the deactivation Section IX text.

- [ ] **Step 1: Identify the termination/deactivation checkbox field (guided investigation)**

The template's checkboxes are generically named (`Check Box51`, etc.). Determine which one is the access-type "Termination"/"Deactivation" box. Run this to list every checkbox with its on-state and page rectangle, then cross-reference visually with the printed form's access-type section (you are an authorizer on this form and can confirm the box):

```bash
node -e '
const { PDFDocument, PDFDict, PDFName, PDFNumber, PDFArray } = require("pdf-lib");
const fs = require("fs");
(async () => {
  const doc = await PDFDocument.load(fs.readFileSync("public/templates/epic-request-template.pdf"));
  doc.getPages().forEach((pg, pi) => {
    const annots = pg.node.Annots(); if (!annots) return;
    for (let i = 0; i < annots.size(); i++) {
      const w = doc.context.lookup(annots.get(i));
      if (!(w instanceof PDFDict)) continue;
      const ft = w.lookupMaybe(PDFName.of("FT"), PDFName);
      const rect = w.lookupMaybe(PDFName.of("Rect"), PDFArray);
      const t = w.lookupMaybe(PDFName.of("T"), undefined);
      if (rect) {
        const r = [0,1,2,3].map(k => rect.lookup(k, PDFNumber).asNumber());
        console.log("page", pi, String(t||"(child)"), "rect", r.map(n=>n.toFixed(0)).join(","));
      }
    }
  });
})();'
```

Record the confirmed field name as the constant in Step 3. If the access-type section has no dedicated termination box (the form may express deactivation only through Section IX wording plus the spreadsheet/email), set `TERMINATION_CHECKBOX = null` and rely on the Section IX text; note this decision in the code comment.

- [ ] **Step 2: Write the failing tests**

In `src/modules/admin/services/itcm-pdf.test.ts`, add a `loadDeactivateIndividual` helper mirroring the existing `loadOutput`, then assertions:

```ts
async function loadDeactivateIndividual() {
  const bytes = await generatePdf({
    requestType: "deactivate_individual",
    authorizerKey: "CC",
    person: { firstName: "Jane", lastName: "Doe", email: "jane.doe@yale.edu", netId: "jd123", epicId: "EPIC123", yaleAffiliation: "Yale College" },
    endDate: "10/15/2026",
    mirrorPerson: null,
    templateBytes,
  });
  return PDFDocument.load(bytes);
}

describe("generatePdf deactivation", () => {
  it("fills the person's existing Epic ID on an individual deactivation", async () => {
    const doc = await loadDeactivateIndividual();
    const form = doc.getForm();
    // Epic ID field used for the account being deactivated (Text17 holds the
    // person's existing Epic ID on non-new requests).
    expect(form.getTextField("Text17").getText()).toContain("EPIC123");
  });

  it("writes the deactivation Section IX narrative", async () => {
    const doc = await loadDeactivateIndividual();
    const form = doc.getForm();
    expect(form.getTextField("Text113").getText().toLowerCase()).toContain("deactivat");
  });
});
```

- [ ] **Step 3: Implement the request types**

In `src/modules/admin/services/itcm-pdf.ts`:

Extend the union:

```ts
export type RequestType =
  | "new_individual"
  | "mod_individual"
  | "renew_individual"
  | "bulk_new"
  | "bulk_mod"
  | "deactivate_individual"
  | "bulk_deactivate";
```

Add `SECTION_IX` entries:

```ts
  deactivate_individual:
    "This individual is leaving the YM HAVEN FREE CLINIC. Please DEACTIVATE their Epic access for the department YM HAVEN FREE CLINIC effective on the listed date.",
  bulk_deactivate:
    "These individuals are leaving the YM HAVEN FREE CLINIC. Please DEACTIVATE their Epic access for the department YM HAVEN FREE CLINIC. Please see the attached spreadsheet for the multiple user information.",
```

Near the top of `generatePdf`, add a termination-field constant (use the value confirmed in Step 1; `null` if none):

```ts
  // The access-type checkbox that marks a request as a termination/deactivation.
  // Confirmed against the YNHH template (see plan Task 6, Step 1).
  const TERMINATION_CHECKBOX: string | null = "Check Box__"; // <-- confirmed field name
  const isDeactivate = requestType === "deactivate_individual" || requestType === "bulk_deactivate";
```

Update the existing branch flags so deactivation is treated as a non-new, non-bulk-spreadsheet-mirror case where appropriate. Specifically:
- Keep `isBulk = requestType.startsWith("bulk")` (this already includes `bulk_deactivate`).
- Keep `isNew` as is (deactivation is not new).
- In Section III, the existing `else if (person)` branch already fills name/email/netId and, because `!isNew`, fills `Text17` with the person's Epic ID. That is correct for individual deactivation, so no change is needed there.
- In Section V, branch deactivation away from the modify/reactivate checkboxes:

```ts
  // Section V: access type.
  if (isNew) {
    checkBox(form, "Check Box49");
    fillText(form, "Text75", today);
  } else if (isDeactivate) {
    if (TERMINATION_CHECKBOX) checkBox(form, TERMINATION_CHECKBOX);
    fillText(form, "Text76", endDate); // effective deactivation date
  } else {
    checkBox(form, "Check Box51");
    checkBox(form, "Check Box53");
    checkBox(form, "Check Box54");
    checkBox(form, "Check Box56");
    fillText(form, "Text76", endDate);
  }
```

- For the mirror/"similar person" block: deactivation needs no mirror. Guard it so deactivation does not print mirror fields:

```ts
  if (isBulk && !isDeactivate) {
    checkBox(form, "Check Box58");
    fillText(form, "Text78", "See spreadsheet");
    fillText(form, "Text79", "See spreadsheet");
  } else if (mirrorPerson && !isDeactivate) {
    checkBox(form, "Check Box58");
    fillText(form, "Text78", mirrorPerson.name);
    fillText(form, "Text79", mirrorPerson.epicId);
  }
```

Leave the Section IX `field.setText(SECTION_IX[requestType])` block as is; it now resolves the deactivation text.

- [ ] **Step 4: Run to verify it passes**

Run:

```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_offboard_epic \
npx vitest run src/modules/admin/services/itcm-pdf.test.ts
```

Expected: PASS, including the pre-existing generatePdf tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/admin/services/itcm-pdf.ts src/modules/admin/services/itcm-pdf.test.ts
git commit -m "feat(itcm): deactivation request types in the YNHH PDF generator"
```

---

## Task 7: Generate route supports deactivation

**Files:**
- Modify: `src/app/api/admin/itcm/generate/route.ts`

**Interfaces:**
- Consumes: `reconcileDeactivationRequests` (Task 5), `listPendingDeactivations` not needed here, the deactivation `RequestType`s (Task 6).
- Produces: the route accepts `requestType` `deactivate_individual` / `bulk_deactivate`, returns a PDF (+ spreadsheet for bulk) and an email body, and links the selected people's deactivation requests to a new ticket instead of creating fresh NEW/MODIFY/RENEW requests.

- [ ] **Step 1: Add the records for the new types**

In `EMAIL_BODIES`, add:

```ts
  deactivate_individual: ({ personName, endDate, authorizerName }) =>
    `Hello,\nCould we please DEACTIVATE Epic access for ${personName}? They are no longer with the YM HAVEN FREE CLINIC. Please deactivate their access effective ${endDate}.\nThe completed PDF request form is attached. Please contact me with any questions.\n\nBest,\n${authorizerName}`,
  bulk_deactivate: ({ endDate, authorizerName, userCount }) =>
    `Hello,\nCould we please DEACTIVATE Epic access for the ${userCount} users in the attached spreadsheet? They are no longer with the YM HAVEN FREE CLINIC. Please deactivate their access effective ${endDate}.\nThe completed PDF request form and the spreadsheet are attached. Please contact me with any questions.\n\nBest,\n${authorizerName}`,
```

In `PDF_FILENAMES`, add:

```ts
  deactivate_individual: (i, d) => `${i} ${d} DEACTIVATE Service Request Form_V5.5.pdf`,
  bulk_deactivate: (i, d) => `${i} ${d} Multiple Users DEACTIVATE Service Request Form_V5.5.pdf`,
```

In `REQUEST_TYPE_LABELS`, add:

```ts
  deactivate_individual: "Deactivate - Individual",
  bulk_deactivate: "Deactivate - Bulk",
```

- [ ] **Step 2: Make endDate default for deactivation and add deactivation to the switches**

Replace the end-date validation so deactivation does not hard-require a manually entered date (it defaults to today). Change:

```ts
  if (!requestType.includes("new") && !endDate?.trim()) {
```

to:

```ts
  const isDeactivate = requestType === "deactivate_individual" || requestType === "bulk_deactivate";
  if (!requestType.includes("new") && !isDeactivate && !endDate?.trim()) {
```

After the `endDate` is read, add a resolved date used everywhere the PDF/email need it:

```ts
  const todayMMDDYYYY = new Date().toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });
  const effectiveEndDate = isDeactivate && !endDate?.trim() ? todayMMDDYYYY : endDate;
```

Use `effectiveEndDate` in the `generatePdf({ ... endDate: effectiveEndDate ... })` call and in `emailBodyArgs.endDate` (replace the `isNew ? oneYearStr : endDate` expression with `isNew ? oneYearStr : effectiveEndDate`).

Add `deactivate_individual` and `bulk_deactivate` cases to BOTH the `pdfFilename` switch and the `emailBody` switch (the route uses validated switches to satisfy CodeQL):

```ts
    case "deactivate_individual": pdfFilename = PDF_FILENAMES.deactivate_individual(authorizerKey, dateStr); break;
    case "bulk_deactivate": pdfFilename = PDF_FILENAMES.bulk_deactivate(authorizerKey, dateStr); break;
```

```ts
    case "deactivate_individual": emailBody = EMAIL_BODIES.deactivate_individual(emailBodyArgs); break;
    case "bulk_deactivate": emailBody = EMAIL_BODIES.bulk_deactivate(emailBodyArgs); break;
```

- [ ] **Step 3: Make the spreadsheet generate for bulk_deactivate**

The current spreadsheet guard is `if (isBulk)`. `isBulk` already covers `bulk_deactivate`, so the spreadsheet generates automatically. The mirror column will be blank for deactivation people (they have no mirror lookup), which is correct. No change needed here beyond confirming `isBulk` includes the new type (it does, via `startsWith("bulk")`).

- [ ] **Step 4: Branch the tracking writes for deactivation**

Replace the tracking block (the `epicKind` computation, the `ynhhTicket.create`, and the `$transaction([...create...])`) so deactivation reconciles existing requests instead of creating NEW/MODIFY/RENEW rows. Import the helper at the top:

```ts
import { findMirrorPerson, getPeopleByIds, reconcileDeactivationRequests } from "@/modules/admin/services/itcm";
```

Then, where the ticket and requests are written, branch:

```ts
  const ticket = await prisma.ynhhTicket.create({
    data: {
      submittedById: actor.id,
      description: `${REQUEST_TYPE_LABELS[requestType]} - ${people.map((p) => p.name).join(", ")}`,
      status: "OPEN",
    },
  });

  if (isDeactivate) {
    // Deactivation requests already exist (queued at offboard) or are created
    // here for an ad-hoc deactivation; link them to this ticket as SUBMITTED.
    await reconcileDeactivationRequests(actor.id, people.map((p) => p.id), ticket.id);
  } else {
    const epicKind =
      requestType === "new_individual" || requestType === "bulk_new"
        ? "NEW"
        : requestType === "mod_individual"
        ? "MODIFY"
        : "RENEW";

    await prisma.$transaction(
      people.map((p) =>
        prisma.epicRequest.create({
          data: {
            personId: p.id,
            kind: epicKind,
            status: "SUBMITTED",
            mirrorEpicId: mirrorByPersonId.get(p.id)?.epicId ?? null,
            requestedById: actor.id,
            ticketId: ticket.id,
          },
        })
      )
    );
  }
```

Note: the `REQUEST_TYPE_LABELS` description uses a hyphen, not an em-dash, per the global constraint.

- [ ] **Step 5: Typecheck and build the route**

Run:

```bash
npx tsc --noEmit
```

Expected: no type errors. (The route has no unit test; type-checking plus the Task 8 manual verification cover it.)

- [ ] **Step 6: Commit**

```bash
git add src/app/api/admin/itcm/generate/route.ts
git commit -m "feat(itcm): generate route handles deactivation (reconcile + PDF + email)"
```

---

## Task 8: ITCM form and page expose the Deactivate flow

**Files:**
- Modify: `src/app/(app)/admin/itcm/epic-requests/page.tsx` (load and pass pending deactivations)
- Modify: `src/modules/admin/components/epic-request-tabs.tsx` (thread the new prop to the form)
- Modify: `src/modules/admin/components/epic-request-form.tsx` (Deactivate type + pending-deactivation person source)

**Interfaces:**
- Consumes: `listPendingDeactivations` (Task 4), the deactivation `RequestType`s (Task 6), the generate route (Task 7).
- Produces: an admin-facing "Deactivate" request type whose person picker lists pending deactivations.

- [ ] **Step 1: Load pending deactivations on the page and pass them down**

In `src/app/(app)/admin/itcm/epic-requests/page.tsx`, add `listPendingDeactivations` to the import from `@/modules/admin/services/itcm`, then add it to the parallel load and pass it to `EpicRequestTabs`:

```ts
  const [departments, history, pendingDeactivations] = await Promise.all([
    listDepartmentsWithMembers(),
    getEpicRequestHistory(),
    listPendingDeactivations(),
  ]);
```

```tsx
      <EpicRequestTabs
        activeTab={activeTab}
        departments={departments}
        history={history}
        pendingDeactivations={pendingDeactivations}
        closeTicketAction={closeTicketAction}
        updateServiceRequestNumberAction={updateServiceRequestNumberAction}
      />
```

- [ ] **Step 2: Thread the prop through the tabs component**

In `src/modules/admin/components/epic-request-tabs.tsx`, add `pendingDeactivations` to the component's props type (type `PendingDeactivation[]` imported from `@/modules/admin/services/itcm`) and pass it into `<EpicRequestForm ... pendingDeactivations={pendingDeactivations} />` in the Generate tab. Match the existing prop-passing style in that file.

- [ ] **Step 3: Add the Deactivate type and person source to the form**

In `src/modules/admin/components/epic-request-form.tsx`:

Extend the `RequestType` union and `EMAIL_SUBJECTS`:

```ts
type RequestType =
  | "new_individual"
  | "mod_individual"
  | "renew_individual"
  | "bulk_new"
  | "bulk_mod"
  | "deactivate_individual"
  | "bulk_deactivate";
```

```ts
  deactivate_individual: (i, d) => `[HAVEN] Deactivate Epic Access for One User ${d} ${i}`,
  bulk_deactivate: (i, d) => `[HAVEN] Deactivate Epic Access for Multiple Users ${d} ${i}`,
```

Add `pendingDeactivations: PendingDeactivation[]` to `Props` (import the type), and add a derived flag `const isDeactivate = requestType.startsWith("deactivate") || requestType === "bulk_deactivate";`. Add "Deactivate" to the request-type `Select` (a third base option `deactivate`), updating the select's value mapping and the `onChange` so choosing Deactivate sets `deactivate_individual` or `bulk_deactivate` based on scope. Mirror the existing `new`/`mod`/`renew` handling: the base derivation and the `raw` assembly should produce `deactivate_individual` / `bulk_deactivate`.

When `isDeactivate`, render the person picker from `pendingDeactivations` instead of the department tree. Add this block at the top of Step 2's render (Select person section), short-circuiting the existing tree when deactivating:

```tsx
{isDeactivate ? (
  <div className="space-y-1">
    {pendingDeactivations.length === 0 && (
      <p className="text-sm text-muted-foreground">No people are awaiting Epic deactivation.</p>
    )}
    {pendingDeactivations.map((p) => (
      <PersonRow
        key={p.id}
        person={{ id: p.id, name: p.name, netId: p.netId, contactEmail: p.contactEmail, epicId: p.epicId, kind: "VOLUNTEER" }}
        selected={selectedPeopleIds.has(p.id)}
        onToggle={() => togglePerson(p.id, { id: p.id, name: p.name, netId: p.netId, contactEmail: p.contactEmail, epicId: p.epicId, kind: "VOLUNTEER" })}
      />
    ))}
  </div>
) : isBulk ? (
  /* ...existing bulk tree... */
) : (
  /* ...existing individual tree... */
)}
```

Keep the existing `handleGenerate` as is: it already posts `requestType`, `authorizerKey`, `personIds`, `endDate`. For deactivation the server defaults the date, so a blank `endDate` is acceptable; relax the client guard so it does not block deactivation:

```ts
    if (!isNew && !isDeactivate && !endDate) {
      setError("Set the access end date before generating a modify/renew request.");
      return;
    }
```

- [ ] **Step 4: Typecheck and build**

Run:

```bash
npx tsc --noEmit && npm run build
```

Expected: no type errors; build succeeds.

- [ ] **Step 5: Manual verification (record result in the commit body)**

Start the app, sign in as an admin, offboard a person who has an Epic ID (via the volunteers offboarding flow or the admin people page), then open Admin to Epic Requests to Generate, choose Deactivate, confirm the person appears in the picker, generate, and confirm a PDF downloads and the tracker shows the request as SUBMITTED under a new ticket.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/admin/itcm/epic-requests/page.tsx" src/modules/admin/components/epic-request-tabs.tsx src/modules/admin/components/epic-request-form.tsx
git commit -m "feat(itcm): Deactivate request type with pending-deactivation person picker"
```

---

## Task 9: Volunteers Epic queue completes DEACTIVATE without an Epic ID

**Files:**
- Modify: `src/app/(app)/volunteers/epic/page.tsx` (the per-row Complete form, around lines 594 to 613)

**Interfaces:**
- Consumes: `completeRequest` (Task 2), which for a `DEACTIVATE` request ignores `epicId`.
- Produces: a `DEACTIVATE` row renders a Complete confirm button (no Epic ID input) with deactivation-appropriate copy.

- [ ] **Step 1: Adjust the Complete form branch**

In `src/app/(app)/volunteers/epic/page.tsx`, the Complete form currently shows an Epic ID input for `NEW`/`MODIFY` and a `ConfirmButton` otherwise. A `DEACTIVATE` row already falls into the `else` branch, but the confirm copy says "Complete this renewal?". Make the confirm label kind-aware:

```tsx
                              ) : (
                                /* RENEW and DEACTIVATE: no epicId needed */
                                <ConfirmButton
                                  label="Complete"
                                  confirmLabel={
                                    row.kind === "DEACTIVATE"
                                      ? "Mark this deactivation complete?"
                                      : "Complete this renewal?"
                                  }
                                />
                              )}
```

If the queue filters rows by kind anywhere using `ALL_KINDS` (it is `["NEW", "MODIFY", "RENEW"]`, used only for the new-request kind dropdown), do NOT add DEACTIVATE there: deactivations are system/admin generated, not created from this dropdown. Confirm the row list itself is not filtered to exclude DEACTIVATE (it lists by status, so DEACTIVATE rows already appear).

- [ ] **Step 2: Typecheck and build**

Run:

```bash
npx tsc --noEmit && npm run build
```

Expected: no type errors; build succeeds.

- [ ] **Step 3: Manual verification**

In the volunteers Epic queue, a pending DEACTIVATE row shows a single "Complete" button (no Epic ID field); completing it sets the request COMPLETED and leaves the person's Epic ID intact.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/volunteers/epic/page.tsx"
git commit -m "feat(epic): complete DEACTIVATE rows without an Epic ID in the volunteers queue"
```

---

## Final verification

- [ ] **Run the full test suite**

```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_offboard_epic npm test
```

Expected: all pass (the 4 cert /tmp ENOENT tests are pre-existing flakes per project memory; ignore those if they appear).

- [ ] **Typecheck and build**

```bash
npx tsc --noEmit && npm run build
```

- [ ] **Confirm migration status is clean before any Neon deploy**

```bash
npx prisma migrate status
```

## Notes for the implementer

- The relation accessor on `Person` for memberships (Task 4) must match the schema. Verify the exact field name before writing the include.
- The exact termination checkbox field (Task 6, Step 1) is confirmed against the real template during implementation; if the form has no such box, fall back to the Section IX wording and the spreadsheet/email, and leave `TERMINATION_CHECKBOX = null`.
- Do not change `createEpicRequest`: it correctly refuses non-active people for grant kinds, and DEACTIVATE requests are created only by `setPersonStatusField` and `reconcileDeactivationRequests`.
```
