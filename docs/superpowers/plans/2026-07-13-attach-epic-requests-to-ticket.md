# Attach many Epic requests to one support ticket — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a manager attach any number of Epic access requests (for the requester or arbitrary other active people, in bulk, any kind, any ticket category) to one IT Support ticket, work them through the YNHH pipeline on `/support/epic`, and cancel a wrong one.

**Architecture:** Flip the `TechRequest <-> EpicRequest` link from a 1:1 parent-side unique FK to a 1:N child-side FK (`EpicRequest.techRequestId`), mirroring the existing `EpicRequest.ticketId -> YnhhTicket` relation. Replace the single-shot `promoteToEpic` with a bulk, multi-person `attachEpicRequests`; add `cancelEpicRequest`. Move all YNHH pipeline work (create YNHH ticket, SR#, Complete, Epic emails) off the ticket and onto `/support/epic` (a new Pending tab for un-submitted requests, plus per-request Complete + Email on the Tracker). The ticket keeps a live attached-requests list plus an attach control.

**Tech Stack:** Next.js App Router (server components + server actions), Prisma/PostgreSQL, Vitest, Playwright, Tailwind with the repo's UI primitives.

## Global Constraints

- **DB SAFETY (critical).** This repo's `.env` points every DB URL, including `TEST_DATABASE_URL`, at a shared Neon database. `prisma migrate` and Vitest's `resetDb` will WIPE whatever DB they point at. Never run migrations or tests against Neon. Use a throwaway LOCAL Postgres for this worktree (see Prerequisites).
- **No em-dashes** in code comments, UI copy, or docs. Use commas, colons, or parentheses.
- **No `tailwind-merge`.** Passing `className` to override a primitive's own classes is unreliable in this codebase; compose with wrappers instead of fighting a primitive's internal classes.
- **Lint runs before tests in CI**, so a lint failure hides test results. Keep lint clean each task. `react-hooks/purity` bans `Date.now()` / `Math.random()` in React render; server/service code may use `new Date()`.
- **Permission constant:** the manage permission is `support.manage_requests` (exported as `MANAGE` from `tech-request.ts`).
- **Gate command** (run at the end of every task): `npm run lint && npm run typecheck && npm run test`. There is no `npm run check` script here.
- **Attachable kinds:** `NEW`, `MODIFY`, `RENEW` only. `DEACTIVATE` is handled by the offboarding/Generate paths, not by ticket attach.
- **Terminal ticket statuses:** `RESOLVED`, `CLOSED`, `CANCELLED` (exported as `TERMINAL_STATUSES` from `manage.ts`). Attach/cancel are blocked on these.

## Prerequisites (do once, before Task 1)

- [ ] Install deps in this worktree: `npm install` (creates `node_modules` + generates the Prisma client).
- [ ] Provision a throwaway LOCAL Postgres and create a worktree-local `.env` (this worktree has none). Point BOTH `DATABASE_URL` and `TEST_DATABASE_URL` at the local DB, e.g.:
  ```
  DATABASE_URL="postgresql://localhost:5432/havenhub_epic_dev"
  TEST_DATABASE_URL="postgresql://localhost:5432/havenhub_epic_test"
  ```
  Confirm neither contains a Neon host. Copy any other required non-DB vars from the main checkout's `.env` as needed for `npm run dev`.
- [ ] Apply current migrations to the local DB: `npx prisma migrate deploy`.

---

## Task 1: Schema — flip `TechRequest <-> EpicRequest` to 1:N

**Files:**
- Modify: `prisma/schema.prisma` (model `EpicRequest` ~line 561, model `TechRequest` ~line 645)
- Create: `prisma/migrations/<timestamp>_attach_epic_1n/migration.sql`

**Interfaces:**
- Produces: `EpicRequest.techRequestId: string | null`; `TechRequest.epicRequests: EpicRequest[]`. Removes `TechRequest.epicRequestId`.

- [ ] **Step 1: Edit `EpicRequest`.** Replace the existing back-relation line
  ```prisma
    /// The IT Support ticket that was promoted into this request, if any.
    techRequest   TechRequest?      @relation("techRequestEpic")
  ```
  with an FK-owning field plus its scalar and index. The model becomes (add the two lines shown, keep the rest):
  ```prisma
    ticketId      String?
    techRequestId String?
    completedAt   DateTime?
    // ...existing fields unchanged...
    /// The YNHH ticket opened for this request (optional).
    ticket        YnhhTicket?       @relation(fields: [ticketId], references: [id], onDelete: SetNull)
    /// The IT Support ticket this request is attached to, if any. SetNull: deleting the ticket detaches its requests but keeps them for YNHH/audit history.
    techRequest   TechRequest?      @relation("techRequestEpic", fields: [techRequestId], references: [id], onDelete: SetNull)

    @@index([status])
    @@index([personId, status])
    @@index([techRequestId])
  ```

- [ ] **Step 2: Edit `TechRequest`.** Remove the unique scalar and the singleton relation:
  ```prisma
    epicRequestId String?             @unique
  ```
  and
  ```prisma
    /// The Epic request this ticket was promoted into (EPIC category only). SetNull: keep the ticket if the EpicRequest is removed.
    epicRequest EpicRequest? @relation("techRequestEpic", fields: [epicRequestId], references: [id], onDelete: SetNull)
  ```
  Add, next to the other relations:
  ```prisma
    /// Epic access requests attached to this ticket (0..n). See EpicRequest.techRequestId.
    epicRequests EpicRequest[] @relation("techRequestEpic")
  ```

- [ ] **Step 3: Create the migration SQL (do NOT let migrate auto-drop before backfilling).** Generate a blank migration, then paste the SQL:
  Run: `npx prisma migrate dev --create-only --name attach_epic_1n`
  Open the created `migration.sql` and replace its contents with exactly:
  ```sql
  -- Add child-side FK column
  ALTER TABLE "EpicRequest" ADD COLUMN "techRequestId" TEXT;

  -- Backfill from the old parent-side link (each EpicRequest was referenced by at most one TechRequest via the @unique FK)
  UPDATE "EpicRequest" e
  SET "techRequestId" = t."id"
  FROM "TechRequest" t
  WHERE t."epicRequestId" = e."id";

  -- Index + FK constraint
  CREATE INDEX "EpicRequest_techRequestId_idx" ON "EpicRequest"("techRequestId");
  ALTER TABLE "EpicRequest" ADD CONSTRAINT "EpicRequest_techRequestId_fkey"
    FOREIGN KEY ("techRequestId") REFERENCES "TechRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

  -- Drop the old parent-side link (drops its unique index too)
  ALTER TABLE "TechRequest" DROP COLUMN "epicRequestId";
  ```

- [ ] **Step 4: Apply + regenerate.**
  Run: `npx prisma migrate dev` (applies the migration to the local DB), then `npx prisma generate`.
  Expected: migration applies cleanly; client regenerates with `techRequestId` on `EpicRequest` and no `epicRequestId` on `TechRequest`.

- [ ] **Step 5: Verify the schema compiles against consumers.**
  Run: `npm run typecheck`
  Expected: FAILS, listing the current consumers of the removed field: `src/modules/support/services/epic-link.ts`, `src/modules/support/services/tech-request.ts` (`loadDetail`), `src/app/(app)/support/[id]/page.tsx`, `src/modules/support/components/ticket-detail.tsx`. This failure list is your task map for Tasks 2, 4, and 6. (Do not fix here.)

- [ ] **Step 6: Commit.**
  ```bash
  git add prisma/schema.prisma prisma/migrations
  git commit -m "feat(schema): 1:N TechRequest->EpicRequest via EpicRequest.techRequestId"
  ```

---

## Task 2: Service — replace `promoteToEpic` with `attachEpicRequests`

**Files:**
- Modify: `src/modules/support/services/epic-link.ts` (full rewrite)
- Test: `src/modules/support/services/epic-link.test.ts` (full rewrite)

**Interfaces:**
- Consumes: `MANAGE`, `SupportForbiddenError`, `SupportNotFoundError`, `SupportStateError` from `./tech-request`; `TERMINAL_STATUSES` from `./manage`; `prisma`, `recordAudit`, `can`.
- Produces:
  ```ts
  attachEpicRequests(
    actorPersonId: string,
    techRequestId: string,
    input: { kind: EpicRequestKind; personIds: string[] }
  ): Promise<EpicRequest[]>
  ```
  Throws only `Support*` errors (it inlines validation instead of calling `createEpicRequest`). Audits `support.epic_attach`.

- [ ] **Step 1: Write the failing tests.** Replace the entire contents of `epic-link.test.ts` with:
  ```ts
  /**
   * TDD tests for attachEpicRequests: attaching 1..n Epic requests (any active
   * people, any category, non-terminal ticket) to one IT Support ticket.
   */
  import { beforeEach, describe, expect, it } from "vitest";
  import { prisma } from "@/platform/db";
  import { resetDb } from "@/platform/test/db";
  import {
    createTechRequest,
    SupportForbiddenError,
    SupportNotFoundError,
    SupportStateError,
  } from "./tech-request";
  import { cancelOwnRequest } from "./manage";
  import { attachEpicRequests } from "./epic-link";

  async function createPerson(
    name: string,
    opts: { epicId?: string; status?: "ACTIVE" | "OFFBOARDED" } = {}
  ) {
    return prisma.person.create({
      data: { name, epicId: opts.epicId ?? null, status: opts.status ?? "ACTIVE" },
    });
  }
  async function grantManage(personId: string) {
    const role = await prisma.role.create({
      data: {
        name: `Role-${personId}`,
        isSystem: false,
        grants: { create: [{ permission: "support.manage_requests" }] },
      },
    });
    await prisma.roleAssignment.create({ data: { roleId: role.id, personId, termId: null } });
  }
  async function epicTicket(requesterId: string, category: "EPIC" | "GENERAL_IT" = "EPIC") {
    return createTechRequest(requesterId, { category, subject: "Need Epic", description: "d" });
  }

  beforeEach(resetDb);

  describe("attachEpicRequests", () => {
    it("attaches one NEW request for the requester and moves the ticket to IN_PROGRESS", async () => {
      const owner = await createPerson("Owner");
      const mgr = await createPerson("Manager");
      await grantManage(mgr.id);
      const t = await epicTicket(owner.id);

      const created = await attachEpicRequests(mgr.id, t.id, { kind: "NEW", personIds: [owner.id] });

      expect(created).toHaveLength(1);
      expect(created[0].kind).toBe("NEW");
      expect(created[0].personId).toBe(owner.id);
      expect(created[0].techRequestId).toBe(t.id);
      expect(created[0].status).toBe("PENDING");
      const linked = await prisma.techRequest.findUniqueOrThrow({ where: { id: t.id } });
      expect(linked.status).toBe("IN_PROGRESS");
    });

    it("attaches a bulk NEW request for several other people", async () => {
      const director = await createPerson("Director");
      const a = await createPerson("Vol A");
      const b = await createPerson("Vol B");
      const mgr = await createPerson("Manager");
      await grantManage(mgr.id);
      const t = await epicTicket(director.id);

      const created = await attachEpicRequests(mgr.id, t.id, { kind: "NEW", personIds: [a.id, b.id] });

      expect(created.map((r) => r.personId).sort()).toEqual([a.id, b.id].sort());
      const count = await prisma.epicRequest.count({ where: { techRequestId: t.id } });
      expect(count).toBe(2);
    });

    it("attaches to a non-EPIC category ticket", async () => {
      const owner = await createPerson("Owner");
      const mgr = await createPerson("Manager");
      await grantManage(mgr.id);
      const t = await epicTicket(owner.id, "GENERAL_IT");

      const created = await attachEpicRequests(mgr.id, t.id, { kind: "NEW", personIds: [owner.id] });
      expect(created).toHaveLength(1);
    });

    it("allows a second request once the first is terminal (follow-up)", async () => {
      const owner = await createPerson("Owner");
      const mgr = await createPerson("Manager");
      await grantManage(mgr.id);
      const t = await epicTicket(owner.id);
      const [first] = await attachEpicRequests(mgr.id, t.id, { kind: "NEW", personIds: [owner.id] });
      // Simulate the first reaching a terminal state so the person has no open request.
      await prisma.epicRequest.update({ where: { id: first.id }, data: { status: "CANCELLED" } });

      const [second] = await attachEpicRequests(mgr.id, t.id, { kind: "NEW", personIds: [owner.id] });
      expect(second.id).not.toBe(first.id);
      const total = await prisma.epicRequest.count({ where: { techRequestId: t.id } });
      expect(total).toBe(2);
    });

    it("rejects the whole batch (all-or-nothing) when one person is invalid", async () => {
      const good = await createPerson("Good");
      const bad = await createPerson("Bad", { status: "OFFBOARDED" });
      const mgr = await createPerson("Manager");
      await grantManage(mgr.id);
      const t = await epicTicket(good.id);

      await expect(
        attachEpicRequests(mgr.id, t.id, { kind: "NEW", personIds: [good.id, bad.id] })
      ).rejects.toThrow(SupportStateError);
      const count = await prisma.epicRequest.count();
      expect(count).toBe(0);
    });

    it("rejects a duplicate open request for a person", async () => {
      const owner = await createPerson("Owner");
      const mgr = await createPerson("Manager");
      await grantManage(mgr.id);
      const t = await epicTicket(owner.id);
      await attachEpicRequests(mgr.id, t.id, { kind: "NEW", personIds: [owner.id] });

      await expect(
        attachEpicRequests(mgr.id, t.id, { kind: "NEW", personIds: [owner.id] })
      ).rejects.toThrow(SupportStateError);
    });

    it("rejects a terminal (cancelled) ticket", async () => {
      const owner = await createPerson("Owner");
      const mgr = await createPerson("Manager");
      await grantManage(mgr.id);
      const t = await epicTicket(owner.id);
      await cancelOwnRequest(owner.id, t.id);

      await expect(
        attachEpicRequests(mgr.id, t.id, { kind: "NEW", personIds: [owner.id] })
      ).rejects.toThrow(SupportStateError);
      expect(await prisma.epicRequest.count()).toBe(0);
    });

    it("rejects a non-manager", async () => {
      const owner = await createPerson("Owner");
      const t = await epicTicket(owner.id);
      await expect(
        attachEpicRequests(owner.id, t.id, { kind: "NEW", personIds: [owner.id] })
      ).rejects.toThrow(SupportForbiddenError);
    });

    it("rejects a missing ticket", async () => {
      const mgr = await createPerson("Manager");
      await grantManage(mgr.id);
      await expect(
        attachEpicRequests(mgr.id, "nope", { kind: "NEW", personIds: [mgr.id] })
      ).rejects.toThrow(SupportNotFoundError);
    });

    it("rejects DEACTIVATE and empty personIds", async () => {
      const owner = await createPerson("Owner");
      const mgr = await createPerson("Manager");
      await grantManage(mgr.id);
      const t = await epicTicket(owner.id);
      await expect(
        attachEpicRequests(mgr.id, t.id, { kind: "DEACTIVATE" as never, personIds: [owner.id] })
      ).rejects.toThrow(SupportStateError);
      await expect(
        attachEpicRequests(mgr.id, t.id, { kind: "NEW", personIds: [] })
      ).rejects.toThrow(SupportStateError);
    });
  });
  ```

- [ ] **Step 2: Run tests to verify they fail.**
  Run: `npm run test -- epic-link`
  Expected: FAIL, `attachEpicRequests` is not exported (or import error).

- [ ] **Step 3: Rewrite `epic-link.ts`.** Replace the entire file with:
  ```ts
  /**
   * Epic attach: links one or more EpicRequests to an IT Support ticket
   * (src/modules/support/services/epic.ts owns the downstream pipeline). A
   * manager chooses the kind and the target people at attach time; the requester
   * is no longer the implicit subject, and one ticket may hold many requests.
   *
   * Permission model:
   *   ENFORCED internally (call-site cannot bypass):
   *     attachEpicRequests - support.manage_requests
   */
  import type { EpicRequest, EpicRequestKind } from "@prisma/client";
  import { prisma } from "@/platform/db";
  import { recordAudit } from "@/platform/audit";
  import { can } from "@/platform/rbac/engine";
  import { MANAGE, SupportForbiddenError, SupportNotFoundError, SupportStateError } from "./tech-request";
  import { TERMINAL_STATUSES } from "./manage";

  const ATTACHABLE_KINDS: EpicRequestKind[] = ["NEW", "MODIFY", "RENEW"];

  /**
   * Attaches one Epic request per person to a support ticket.
   *
   * Requires support.manage_requests. kind must be NEW/MODIFY/RENEW. personIds
   * must be non-empty. The ticket must exist and be non-terminal. Works for any
   * ticket category and even when the ticket already has attached requests.
   *
   * Validates every person up front (rules copied from createEpicRequest in
   * epic.ts; keep the two in sync) and creates in one transaction, so a single
   * bad person rejects the whole batch (no partial attach). A brand-new
   * (SUBMITTED) ticket is advanced to IN_PROGRESS; a later-stage ticket is left
   * untouched. Audits "support.epic_attach".
   */
  export async function attachEpicRequests(
    actorPersonId: string,
    techRequestId: string,
    input: { kind: EpicRequestKind; personIds: string[] }
  ): Promise<EpicRequest[]> {
    if (!(await can(actorPersonId, MANAGE))) {
      throw new SupportForbiddenError(`${MANAGE} is required.`);
    }
    if (!ATTACHABLE_KINDS.includes(input.kind)) {
      throw new SupportStateError(
        `Invalid Epic request kind: ${input.kind}. Must be New, Modification, or Renewal.`
      );
    }
    const personIds = [...new Set(input.personIds)].filter(Boolean);
    if (personIds.length === 0) {
      throw new SupportStateError("Select at least one person to attach an Epic request.");
    }

    const t = await prisma.techRequest.findUnique({ where: { id: techRequestId } });
    if (!t) throw new SupportNotFoundError();
    if (TERMINAL_STATUSES.includes(t.status)) {
      throw new SupportStateError(
        `Cannot attach an Epic request to a ${t.status} ticket. Reopen it first.`
      );
    }

    const created = await prisma.$transaction(async (tx) => {
      const people = await tx.person.findMany({
        where: { id: { in: personIds } },
        select: { id: true, name: true, status: true, epicId: true },
      });
      const byId = new Map(people.map((p) => [p.id, p]));
      for (const personId of personIds) {
        const person = byId.get(personId);
        const who = person?.name ?? "This person";
        if (!person) throw new SupportNotFoundError(`Person not found: ${personId}`);
        if (person.status !== "ACTIVE") {
          throw new SupportStateError(`${who} is not an active member; cannot attach an Epic request.`);
        }
        if (input.kind === "NEW" && person.epicId) {
          throw new SupportStateError(`${who} already has an Epic ID; attach a Modify or Renew instead of New.`);
        }
        if ((input.kind === "MODIFY" || input.kind === "RENEW") && !person.epicId) {
          throw new SupportStateError(`${who} has no Epic ID on file; attach a New request instead of ${input.kind}.`);
        }
      }

      const open = await tx.epicRequest.findMany({
        where: { personId: { in: personIds }, status: { in: ["PENDING", "SUBMITTED"] } },
        include: { person: { select: { name: true } } },
      });
      if (open.length > 0) {
        const names = [...new Set(open.map((r) => r.person.name))].join(", ");
        throw new SupportStateError(
          `An open Epic request already exists for: ${names}. Cancel it before attaching another.`
        );
      }

      await tx.epicRequest.createMany({
        data: personIds.map((personId) => ({
          personId,
          kind: input.kind,
          status: "PENDING" as const,
          requestedById: actorPersonId,
          techRequestId,
          notes: `Attached from IT Support #${t.number}: ${t.subject}`,
        })),
      });

      if (t.status === "SUBMITTED") {
        await tx.techRequest.update({ where: { id: techRequestId }, data: { status: "IN_PROGRESS" } });
      }

      // No open request existed for these people before this call, so every
      // PENDING row for them on this ticket is one we just created.
      return tx.epicRequest.findMany({
        where: { techRequestId, personId: { in: personIds }, status: "PENDING" },
        orderBy: { createdAt: "asc" },
      });
    });

    await recordAudit({
      actorPersonId,
      action: "support.epic_attach",
      entityType: "TechRequest",
      entityId: techRequestId,
      after: { personIds, kind: input.kind, count: created.length },
    });

    return created;
  }
  ```

- [ ] **Step 4: Run tests to verify they pass.**
  Run: `npm run test -- epic-link`
  Expected: PASS (all cases).

- [ ] **Step 5: Commit.**
  ```bash
  git add src/modules/support/services/epic-link.ts src/modules/support/services/epic-link.test.ts
  git commit -m "feat(support): attachEpicRequests replaces single-shot promoteToEpic"
  ```

---

## Task 3: Service — `cancelEpicRequest`

**Files:**
- Modify: `src/modules/support/services/epic.ts` (append a function)
- Test: `src/modules/support/services/epic.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `requireManageEpic`, `EpicNotFoundError`, `EpicStateError` (already in `epic.ts`).
- Produces: `cancelEpicRequest(actorPersonId: string, requestId: string): Promise<void>`. Audits `epic.cancel`.

- [ ] **Step 1: Write the failing tests.** Append to `epic.test.ts` (add `cancelEpicRequest` to the existing `from "./epic"` import):
  ```ts
  describe("cancelEpicRequest", () => {
    async function pendingRequest(personId: string, requestedById: string) {
      return prisma.epicRequest.create({
        data: { personId, kind: "NEW", status: "PENDING", requestedById },
      });
    }

    it("cancels a PENDING request and audits", async () => {
      const person = await createPerson("P");
      const mgr = await createPerson("Manager");
      await grantPermission(mgr.id, "support.manage_requests");
      const req = await pendingRequest(person.id, mgr.id);

      await cancelEpicRequest(mgr.id, req.id);

      const after = await prisma.epicRequest.findUniqueOrThrow({ where: { id: req.id } });
      expect(after.status).toBe("CANCELLED");
      const audit = await prisma.auditLog.findFirst({ where: { action: "epic.cancel", entityId: req.id } });
      expect(audit).not.toBeNull();
    });

    it("refuses to cancel a non-PENDING request", async () => {
      const person = await createPerson("P");
      const mgr = await createPerson("Manager");
      await grantPermission(mgr.id, "support.manage_requests");
      const req = await pendingRequest(person.id, mgr.id);
      await prisma.epicRequest.update({ where: { id: req.id }, data: { status: "SUBMITTED" } });

      await expect(cancelEpicRequest(mgr.id, req.id)).rejects.toThrow(EpicStateError);
    });

    it("rejects a non-manager", async () => {
      const person = await createPerson("P");
      const other = await createPerson("Other");
      const req = await pendingRequest(person.id, other.id);
      await expect(cancelEpicRequest(other.id, req.id)).rejects.toThrow(EpicForbiddenError);
    });

    it("raises not-found for a missing request", async () => {
      const mgr = await createPerson("Manager");
      await grantPermission(mgr.id, "support.manage_requests");
      await expect(cancelEpicRequest(mgr.id, "nope")).rejects.toThrow(EpicNotFoundError);
    });
  });
  ```
  Note: reuse the `createPerson` and `grantPermission` helpers already in `epic.test.ts`. If `grantPermission` is not present there, copy it from Task 2's test. Confirm the audit model accessor is `prisma.auditLog` by checking another test in the repo; adjust if the model name differs.

- [ ] **Step 2: Run to verify failure.**
  Run: `npm run test -- epic.test`
  Expected: FAIL, `cancelEpicRequest` not exported.

- [ ] **Step 3: Implement.** Append to `epic.ts` (after `sendEpicEmail`):
  ```ts
  /**
   * Cancels a PENDING Epic request (support.manage_requests). Used to discard a
   * wrongly-attached or wrong-kind request so a corrected one can be attached.
   * A SUBMITTED request is already at YNHH and is not cancellable here.
   * Does not touch Person.epicId. Audits "epic.cancel".
   */
  export async function cancelEpicRequest(actorPersonId: string, requestId: string): Promise<void> {
    await requireManageEpic(actorPersonId);
    const req = await prisma.epicRequest.findUnique({ where: { id: requestId } });
    if (!req) throw new EpicNotFoundError(`EpicRequest not found: ${requestId}`);
    if (req.status !== "PENDING") {
      throw new EpicStateError(
        `Cannot cancel a request with status ${req.status}. Only a PENDING request can be cancelled.`
      );
    }
    await prisma.epicRequest.update({ where: { id: requestId }, data: { status: "CANCELLED" } });
    await recordAudit({
      actorPersonId,
      action: "epic.cancel",
      entityType: "EpicRequest",
      entityId: requestId,
      after: { status: "CANCELLED" },
    });
  }
  ```

- [ ] **Step 4: Run to verify pass.**
  Run: `npm run test -- epic.test`
  Expected: PASS.

- [ ] **Step 5: Commit.**
  ```bash
  git add src/modules/support/services/epic.ts src/modules/support/services/epic.test.ts
  git commit -m "feat(support): cancelEpicRequest for pending Epic requests"
  ```

---

## Task 4: Reads — generalize `loadDetail`, add `listPendingEpicRequests`

**Files:**
- Modify: `src/modules/support/services/tech-request.ts` (`loadDetail`, ~line 232)
- Modify: `src/modules/support/services/itcm.ts` (append a read + type)

**Interfaces:**
- Produces (tech-request): `TechRequestDetail` now has `epicRequests: (EpicRequest & { ticket: YnhhTicket | null; person: { id; name; epicId } })[]` and no longer has `epicRequestId` / `epicRequest`.
- Produces (itcm): `listPendingEpicRequests(): Promise<PendingEpicRequestRow[]>` and the `PendingEpicRequestRow` type.

- [ ] **Step 1: Edit `loadDetail`.** In `tech-request.ts`, replace the `epicRequest` include with `epicRequests`:
  ```ts
  async function loadDetail(id: string) {
    return prisma.techRequest.findUnique({
      where: { id },
      include: {
        requester: { select: { id: true, name: true, netId: true, contactEmail: true, epicId: true } },
        assignedTo: { select: { id: true, name: true } },
        epicRequests: {
          include: {
            ticket: true,
            person: { select: { id: true, name: true, epicId: true } },
          },
          orderBy: { createdAt: "asc" },
        },
        attachments: true,
      },
    });
  }
  ```
  `TechRequestDetail` is derived from this via `Awaited<ReturnType<typeof loadDetail>>`, so no separate type edit is needed.

- [ ] **Step 2: Add `listPendingEpicRequests` to `itcm.ts`.** Ensure `EpicRequestKind` is imported from `@prisma/client` (add it if absent), then append:
  ```ts
  export type PendingEpicRequestRow = {
    id: string;
    kind: EpicRequestKind;
    createdAt: Date;
    person: { id: string; name: string | null; epicId: string | null };
    techRequest: { id: string; number: number; subject: string } | null;
  };

  /**
   * Un-submitted Epic requests: PENDING and not yet grouped under a YNHH ticket.
   * These are the rows the /support/epic "Pending" tab batches into a YNHH ticket.
   */
  export async function listPendingEpicRequests(): Promise<PendingEpicRequestRow[]> {
    const rows = await prisma.epicRequest.findMany({
      where: { status: "PENDING", ticketId: null },
      orderBy: { createdAt: "asc" },
      include: {
        person: { select: { id: true, name: true, epicId: true } },
        techRequest: { select: { id: true, number: true, subject: true } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      createdAt: r.createdAt,
      person: { id: r.person.id, name: r.person.name, epicId: r.person.epicId },
      techRequest: r.techRequest
        ? { id: r.techRequest.id, number: r.techRequest.number, subject: r.techRequest.subject }
        : null,
    }));
  }
  ```

- [ ] **Step 3: Typecheck (expect only UI consumers to remain broken).**
  Run: `npm run typecheck`
  Expected: FAIL now only in `src/app/(app)/support/[id]/page.tsx` and `src/modules/support/components/ticket-detail.tsx` (they still reference `detail.epicRequestId` / `detail.epicRequest` and pass removed action props). Those are fixed in Task 6. `epic-link.ts` and `tech-request.ts` should no longer error.

- [ ] **Step 4: Commit.**
  ```bash
  git add src/modules/support/services/tech-request.ts src/modules/support/services/itcm.ts
  git commit -m "feat(support): loadDetail returns epicRequests[]; add listPendingEpicRequests"
  ```

---

## Task 5: `EpicPersonPicker` client component

Self-contained multi-person picker for the attach form. Standalone by design: we do NOT refactor the mature `EpicRequestForm` generator in this pass (avoids regressing the PDF/email flow); convergence is a later cleanup.

**Files:**
- Create: `src/modules/support/components/epic-person-picker.tsx`

**Interfaces:**
- Consumes: `DepartmentWithMembers`, `MemberLite` types from `@/modules/support/services/itcm`.
- Produces: `EpicPersonPicker` — renders hidden `<input name="personIds">` per selected id, so a parent `<form action=...>` submits them via `formData.getAll("personIds")`.

- [ ] **Step 1: Create the component.**
  ```tsx
  "use client";

  /**
   * EpicPersonPicker: pick one or more active people to attach an Epic request to.
   * A department Select scopes a checkbox list; selections persist across
   * department switches and render as removable chips. Selected ids are emitted
   * as hidden inputs named "personIds" for the enclosing server-action form.
   *
   * `quickAdd` (optional) pre-lists the ticket requester as a one-click add.
   */
  import { useMemo, useState } from "react";
  import type { DepartmentWithMembers, MemberLite } from "@/modules/support/services/itcm";
  import { Select } from "@/platform/ui/select";
  import { Field } from "@/platform/ui/input";
  import { Checkbox } from "@/platform/ui/checkbox";
  import { Button } from "@/platform/ui/button";

  type QuickAdd = { id: string; name: string | null };

  export function EpicPersonPicker({
    departments,
    quickAdd,
  }: {
    departments: DepartmentWithMembers[];
    quickAdd?: QuickAdd;
  }) {
    const [deptId, setDeptId] = useState<string>("");
    const [selected, setSelected] = useState<Map<string, string>>(() =>
      quickAdd ? new Map([[quickAdd.id, quickAdd.name ?? "Requester"]]) : new Map()
    );

    const dept = useMemo(
      () => departments.find((d) => d.department.id === deptId),
      [departments, deptId]
    );
    const members: MemberLite[] = useMemo(
      () => (dept ? [...dept.directors, ...dept.volunteers] : []),
      [dept]
    );

    function toggle(id: string, name: string | null) {
      setSelected((prev) => {
        const next = new Map(prev);
        if (next.has(id)) next.delete(id);
        else next.set(id, name ?? "Unknown");
        return next;
      });
    }

    return (
      <div className="space-y-3">
        {quickAdd && !selected.has(quickAdd.id) && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => toggle(quickAdd.id, quickAdd.name)}
          >
            + Add requester ({quickAdd.name ?? "requester"})
          </Button>
        )}

        <Field label="Department">
          <Select value={deptId} onChange={(e) => setDeptId(e.target.value)}>
            <option value="">Select a department…</option>
            {departments.map((d) => (
              <option key={d.department.id} value={d.department.id}>
                {d.department.name}
              </option>
            ))}
          </Select>
        </Field>

        {members.length > 0 && (
          <div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
            {members.map((m) => (
              <label key={m.id} className="flex items-center gap-2 text-sm">
                <Checkbox checked={selected.has(m.id)} onChange={() => toggle(m.id, m.name)} />
                <span>{m.name}</span>
                {m.epicId && <span className="text-subtle-foreground text-xs">{m.epicId}</span>}
              </label>
            ))}
          </div>
        )}

        {selected.size > 0 && (
          <div className="flex flex-wrap gap-2">
            {[...selected.entries()].map(([id, name]) => (
              <span
                key={id}
                className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs"
              >
                {name}
                <button
                  type="button"
                  aria-label={`Remove ${name}`}
                  onClick={() => toggle(id, name)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        {[...selected.keys()].map((id) => (
          <input key={id} type="hidden" name="personIds" value={id} />
        ))}
      </div>
    );
  }
  ```
  Before implementing, confirm the exact props of the `Checkbox` primitive at `src/platform/ui/checkbox.tsx` (it is used with `checked`/`onChange` in `epic-request-form.tsx`; match that usage). Confirm `MemberLite` exposes `id`, `name`, `epicId` by reading its definition in `itcm.ts`; adjust the chip/label fields if a property name differs.

- [ ] **Step 2: Typecheck.**
  Run: `npm run typecheck`
  Expected: no new errors from this file (the ticket page errors from Task 4 still remain until Task 6).

- [ ] **Step 3: Commit.**
  ```bash
  git add src/modules/support/components/epic-person-picker.tsx
  git commit -m "feat(support): EpicPersonPicker multi-person selector"
  ```

---

## Task 6: Ticket detail — attached list + attach/cancel, remove inline pipeline

**Files:**
- Modify: `src/modules/support/components/ticket-detail.tsx` (props block ~123-135 and 152-157; Epic section ~289-410)
- Modify: `src/app/(app)/support/[id]/page.tsx` (imports; Epic actions ~198-305; render props ~379-384; add departments load)

**Interfaces:**
- Consumes: `attachEpicRequests`, `cancelEpicRequest`, `listDepartmentsWithMembers`, `detail.epicRequests`.
- Produces (TicketDetail props): replace `promoteAction`/`completeEpicAction`/`createEpicTicketAction`/`setEpicSrAction`/`sendEpicEmailAction` with `attachEpicAction`, `cancelEpicAction`, and `departments: DepartmentWithMembers[]`.

- [ ] **Step 1: Rewrite the page's Epic actions + imports.** In `page.tsx`:
  - Replace the import block for epic services. Remove:
    ```ts
    import { promoteToEpic } from "@/modules/support/services/epic-link";
    import {
      completeRequest,
      createTicket,
      setTicketServiceRequestNumber,
      sendEpicEmail,
      EpicForbiddenError,
      EpicNotFoundError,
      EpicStateError,
    } from "@/modules/support/services/epic";
    import type { EpicTemplateKey } from "@/platform/email/templates/epic";
    ```
    Add:
    ```ts
    import { attachEpicRequests } from "@/modules/support/services/epic-link";
    import { cancelEpicRequest, EpicForbiddenError, EpicNotFoundError, EpicStateError } from "@/modules/support/services/epic";
    import { listDepartmentsWithMembers } from "@/modules/support/services/itcm";
    import type { EpicRequestKind } from "@prisma/client";
    ```
  - Delete the `EPIC_EMAIL_TEMPLATES` const.
  - Delete `promoteAction`, `completeEpicAction`, `createEpicTicketAction`, `setEpicSrAction`, `sendEpicEmailAction`.
  - Add, after `cancelOwnAction`:
    ```ts
    async function attachEpicAction(formData: FormData) {
      "use server";
      const actorSession = await requireModuleAccess("support");
      const kind = (formData.get("epicKind") as string) as EpicRequestKind;
      const personIds = formData.getAll("personIds").map(String).filter(Boolean);
      try {
        await attachEpicRequests(actorSession.personId, id, { kind, personIds });
      } catch (err) {
        if (
          err instanceof SupportStateError ||
          err instanceof SupportForbiddenError ||
          err instanceof SupportNotFoundError
        ) {
          redirect(`/support/${id}?epicError=${encodeURIComponent(err.message)}`);
        }
        throw err;
      }
      redirect(`/support/${id}`);
    }

    async function cancelEpicAction(formData: FormData) {
      "use server";
      const actorSession = await requireModuleAccess("support");
      const epicRequestId = String(formData.get("epicRequestId") ?? "");
      // Only allow cancelling a request that belongs to this ticket.
      if (!detail.epicRequests.some((r) => r.id === epicRequestId)) {
        redirect(`/support/${id}?epicError=${encodeURIComponent("Unknown Epic request.")}`);
      }
      try {
        await cancelEpicRequest(actorSession.personId, epicRequestId);
      } catch (err) {
        if (
          err instanceof EpicForbiddenError ||
          err instanceof EpicNotFoundError ||
          err instanceof EpicStateError
        ) {
          redirect(`/support/${id}?epicError=${encodeURIComponent(err.message)}`);
        }
        throw err;
      }
      redirect(`/support/${id}`);
    }
    ```
  - Load departments for the picker (only when managing) near the other loads:
    ```ts
    const departments = canManage ? await listDepartmentsWithMembers() : [];
    ```
  - In the `<TicketDetail ... />` JSX, remove the five old epic action props and add:
    ```tsx
    attachEpicAction={attachEpicAction}
    cancelEpicAction={cancelEpicAction}
    departments={departments}
    ```

- [ ] **Step 2: Update `TicketDetail` props + Epic section.** In `ticket-detail.tsx`:
  - Add the import for the picker and the department type at the top:
    ```ts
    import { EpicPersonPicker } from "./epic-person-picker";
    import type { DepartmentWithMembers } from "@/modules/support/services/itcm";
    ```
  - In `TicketDetailProps`, replace the five epic action prop declarations (`promoteAction` through `sendEpicEmailAction`) with:
    ```ts
    /** Server action wired to attachEpicRequests. Reads "epicKind" + repeated "personIds". */
    attachEpicAction?: (formData: FormData) => Promise<void>;
    /** Server action wired to cancelEpicRequest. Reads hidden "epicRequestId". */
    cancelEpicAction?: (formData: FormData) => Promise<void>;
    /** Active departments+members for the attach picker. Only needed when canManage. */
    departments?: DepartmentWithMembers[];
    ```
    Keep `epicError`. Update the destructure in the function signature the same way (replace the five names with `attachEpicAction`, `cancelEpicAction`, `departments = []`).
  - Replace the entire Epic section (the `{canManage && detail.category === "EPIC" && ( ... )}` block, lines ~289-410) with:
    ```tsx
    {canManage && (
      <section>
        <SectionHeader className="mb-2">Epic access</SectionHeader>
        <Card className="space-y-4">
          {epicError && <Alert tone="error">{epicError}</Alert>}

          {detail.epicRequests.length > 0 ? (
            <ul className="space-y-2">
              {detail.epicRequests.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-2 border-b border-border pb-2 last:border-0">
                  <Badge>{EPIC_KIND_LABELS[r.kind]}</Badge>
                  <span className="text-sm font-medium text-foreground">{r.person.name}</span>
                  <Badge tone={EPIC_STATUS_TONE[r.status]}>{EPIC_STATUS_LABELS[r.status]}</Badge>
                  {r.ticket && (
                    <span className="text-xs text-foreground-soft">
                      YNHH SR#: {r.ticket.serviceRequestNumber ?? "(not set)"}
                    </span>
                  )}
                  {isOpen && r.status === "PENDING" && cancelEpicAction && (
                    <form action={cancelEpicAction} className="ml-auto">
                      <input type="hidden" name="epicRequestId" value={r.id} />
                      <SubmitButton size="sm" variant="ghost" pendingLabel="Cancelling…">
                        Cancel
                      </SubmitButton>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No Epic requests attached yet.</p>
          )}

          {isOpen && attachEpicAction && (
            <form action={attachEpicAction} className="space-y-3 border-t border-border pt-4">
              <Field label="Request type">
                <Select name="epicKind" defaultValue="NEW" className="w-48">
                  {PROMOTABLE_EPIC_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {EPIC_KIND_LABELS[k]}
                    </option>
                  ))}
                </Select>
              </Field>
              <EpicPersonPicker
                departments={departments}
                quickAdd={{ id: detail.requester.id, name: detail.requester.name }}
              />
              <SubmitButton variant="primary" size="sm" pendingLabel="Attaching…">
                Attach Epic request(s)
              </SubmitButton>
              <p className="text-xs text-subtle-foreground">
                Attached requests are worked on the Epic Requests page (submit to YNHH, set SR#, complete, email).
              </p>
            </form>
          )}
        </Card>
      </section>
    )}
    ```
  - Remove now-unused imports/consts if the linter flags them (e.g. `Input` if no longer used elsewhere in the file, `ConfirmButton`). Keep `EPIC_KIND_LABELS`, `PROMOTABLE_EPIC_KINDS`, `EPIC_STATUS_LABELS`, `EPIC_STATUS_TONE`.

- [ ] **Step 3: Typecheck + lint.**
  Run: `npm run typecheck && npm run lint`
  Expected: PASS. If lint flags an unused import (`Input`, `ConfirmButton`, `EpicTemplateKey`, etc.), delete it.

- [ ] **Step 4: Manual smoke (real app).** Start `npm run dev`, sign in as a manager, open a ticket, and verify: the Epic access section shows on any category; attaching the requester creates a PENDING row; attaching a second person works; Cancel removes a PENDING row; a resolved ticket hides the attach form. (Full e2e is Task 9.)

- [ ] **Step 5: Commit.**
  ```bash
  git add src/app/\(app\)/support/\[id\]/page.tsx src/modules/support/components/ticket-detail.tsx
  git commit -m "feat(support): ticket shows attached Epic requests + attach/cancel; drop inline pipeline"
  ```

---

## Task 7: `/support/epic` — Pending tab

**Files:**
- Modify: `src/app/(app)/support/epic/page.tsx` (load pending; add action; pass props; activeTab)
- Modify: `src/modules/support/components/epic-request-tabs.tsx` (Tab type + nav + PendingTab)

**Interfaces:**
- Consumes: `listPendingEpicRequests`, `PendingEpicRequestRow`, `createTicket`.
- Produces: `createTicketFromPendingAction(formData)` reads repeated `requestIds` + optional `description`.

- [ ] **Step 1: Page — load, action, props.** In `support/epic/page.tsx`:
  - Import `listPendingEpicRequests` from `itcm` and `createTicket` + `EpicForbiddenError`/`EpicStateError` from `epic`.
  - Add to the `Promise.all` load: `listPendingEpicRequests()`, capturing `pending`.
  - Extend `activeTab`: `tab === "pending" ? "pending" : ...` (add `"pending"` as a valid value).
  - Add the action:
    ```ts
    async function createTicketFromPendingAction(formData: FormData) {
      "use server";
      const session = await requirePermission("support.manage_requests");
      const requestIds = formData.getAll("requestIds").map(String).filter(Boolean);
      const description = ((formData.get("description") as string) ?? "").trim() || null;
      try {
        await createTicket(session.personId, { requestIds, description });
      } catch (err) {
        if (err instanceof EpicForbiddenError || err instanceof EpicStateError) {
          redirect(`/support/epic?tab=pending&error=${encodeURIComponent(err.message)}`);
        }
        throw err;
      }
      revalidatePath("/support/epic");
      redirect("/support/epic?tab=pending");
    }
    ```
  - Pass `pending={pending}` and `createTicketFromPendingAction={createTicketFromPendingAction}` to `<EpicRequestTabs>`.

- [ ] **Step 2: Tabs — type, nav, PendingTab.** In `epic-request-tabs.tsx`:
  - Change `type Tab = "generate" | "tracker" | "history";` to add `"pending"`, add it to the nav array and `labels` (`pending: "Pending"`), placing it between generate and tracker.
  - Add to `Props`: `pending: PendingEpicRequestRow[];` and `createTicketFromPendingAction: (formData: FormData) => Promise<void>;` (import `PendingEpicRequestRow` from `itcm`).
  - Add the component:
    ```tsx
    function PendingTab({
      pending,
      action,
    }: {
      pending: PendingEpicRequestRow[];
      action: (formData: FormData) => Promise<void>;
    }) {
      if (pending.length === 0) {
        return <p className="text-sm text-muted-foreground">No pending Epic requests. Attach some from a support ticket.</p>;
      }
      return (
        <form action={action} className="space-y-4">
          <Card className="space-y-3">
            <SectionHeader level="title">Pending Epic requests</SectionHeader>
            <p className="text-xs text-subtle-foreground">
              Select requests and open one YNHH ticket for them. They then appear under Tracker.
            </p>
            <ul className="space-y-1">
              {pending.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <Checkbox name="requestIds" value={r.id} />
                  <Badge>{r.kind}</Badge>
                  <span className="font-medium">{r.person.name}</span>
                  {r.techRequest && (
                    <a href={`/support/${r.techRequest.id}`} className="text-xs text-brand-fg underline underline-offset-2">
                      #{r.techRequest.number}
                    </a>
                  )}
                </li>
              ))}
            </ul>
            <Field label="YNHH ticket description (optional)">
              <Input name="description" placeholder="Optional" className="w-72" />
            </Field>
            <FormActions>
              <SubmitButton variant="primary" pendingLabel="Creating…">Create YNHH ticket</SubmitButton>
            </FormActions>
          </Card>
        </form>
      );
    }
    ```
    Confirm the `Checkbox` primitive forwards `name`/`value` to a real checkbox input (so `formData.getAll("requestIds")` collects the checked ids). If it does not, use a plain `<input type="checkbox" name="requestIds" value={r.id} />`.
  - In the tab body switch, render `PendingTab` when `activeTab === "pending"`.

- [ ] **Step 3: Typecheck + lint.**
  Run: `npm run typecheck && npm run lint`
  Expected: PASS.

- [ ] **Step 4: Manual smoke.** After attaching from a ticket (Task 6), open `/support/epic?tab=pending`, select the request(s), Create YNHH ticket, and confirm they move to Tracker.

- [ ] **Step 5: Commit.**
  ```bash
  git add src/app/\(app\)/support/epic/page.tsx src/modules/support/components/epic-request-tabs.tsx
  git commit -m "feat(support): Pending tab batches attached Epic requests into a YNHH ticket"
  ```

---

## Task 8: `/support/epic` Tracker — per-request Complete + Email

Adds the two steps that previously existed only inline on the ticket, so `/support/epic` is the full pipeline home (also fixes Generate-flow requests, which never had in-app Complete/Email).

**Files:**
- Modify: `src/app/(app)/support/epic/page.tsx` (two actions + props)
- Modify: `src/modules/support/components/epic-request-tabs.tsx` (Tracker row controls)

**Interfaces:**
- Consumes: `completeRequest`, `sendEpicEmail` from `epic`; `EpicTemplateKey`.
- Produces: `completeEpicRequestAction(formData)` (reads `requestId`, optional `epicId`), `sendEpicEmailFromTrackerAction(formData)` (reads `requestId`, `template`).

- [ ] **Step 1: Page — actions + props.** In `support/epic/page.tsx`:
  - Import `completeRequest`, `sendEpicEmail`, `EpicNotFoundError` from `epic`, and `EpicTemplateKey` from `@/platform/email/templates/epic`. Add:
    ```ts
    const EPIC_EMAIL_TEMPLATES: EpicTemplateKey[] = ["epic-onboarding", "epic-activation", "epic-password-reset"];

    async function completeEpicRequestAction(formData: FormData) {
      "use server";
      const session = await requirePermission("support.manage_requests");
      const requestId = String(formData.get("requestId") ?? "");
      const epicId = (String(formData.get("epicId") ?? "")).trim() || undefined;
      try {
        await completeRequest(session.personId, requestId, epicId);
      } catch (err) {
        if (err instanceof EpicForbiddenError || err instanceof EpicNotFoundError || err instanceof EpicStateError) {
          redirect(`/support/epic?tab=tracker&error=${encodeURIComponent(err.message)}`);
        }
        throw err;
      }
      revalidatePath("/support/epic");
      redirect("/support/epic?tab=tracker");
    }

    async function sendEpicEmailFromTrackerAction(formData: FormData) {
      "use server";
      const session = await requirePermission("support.manage_requests");
      const requestId = String(formData.get("requestId") ?? "");
      const template = String(formData.get("template") ?? "");
      if (!(EPIC_EMAIL_TEMPLATES as string[]).includes(template)) {
        redirect(`/support/epic?tab=tracker&error=${encodeURIComponent("Invalid email template.")}`);
      }
      try {
        await sendEpicEmail(session.personId, requestId, template as EpicTemplateKey);
      } catch (err) {
        if (err instanceof EpicForbiddenError || err instanceof EpicNotFoundError || err instanceof EpicStateError) {
          redirect(`/support/epic?tab=tracker&error=${encodeURIComponent(err.message)}`);
        }
        throw err;
      }
      revalidatePath("/support/epic");
      redirect("/support/epic?tab=tracker");
    }
    ```
  - Pass both actions to `<EpicRequestTabs>`.

- [ ] **Step 2: Tabs — Tracker row controls.** In `epic-request-tabs.tsx`:
  - Add to `Props` and thread through `EpicRequestTabs` -> `TrackerTable`:
    ```ts
    completeEpicRequestAction: (formData: FormData) => Promise<void>;
    sendEpicEmailFromTrackerAction: (formData: FormData) => Promise<void>;
    ```
  - The Tracker already renders each non-incident request row (`requests.map`). Replace that inner row with per-request controls. For each `r` in `requests`, when `r.status === "PENDING" || r.status === "SUBMITTED"` render a Complete form; always render the three email buttons for `PENDING`/`SUBMITTED`/`COMPLETED`:
    ```tsx
    <div key={r.id} className="flex flex-wrap items-center gap-2 text-xs text-foreground-soft">
      <Badge>{r.kind}</Badge>
      <span>{r.person.name}</span>
      {r.person.epicId && <span className="text-subtle-foreground">{r.person.epicId}</span>}
      <Badge>{r.status}</Badge>

      {(r.status === "PENDING" || r.status === "SUBMITTED") && (
        <form action={completeEpicRequestAction} className="flex items-center gap-1">
          <input type="hidden" name="requestId" value={r.id} />
          {r.kind === "NEW" || r.kind === "MODIFY" ? (
            <>
              <Input name="epicId" aria-label="Epic ID" placeholder="Epic ID" className="w-32" required />
              <SubmitButton size="sm" variant="outline" pendingLabel="Completing…">Complete</SubmitButton>
            </>
          ) : (
            <SubmitButton size="sm" variant="outline" pendingLabel="Completing…">Complete</SubmitButton>
          )}
        </form>
      )}

      {(r.status === "PENDING" || r.status === "SUBMITTED" || r.status === "COMPLETED") && (
        <div className="flex flex-wrap gap-1">
          {(["epic-onboarding", "epic-activation", "epic-password-reset"] as const).map((tpl) => (
            <form key={tpl} action={sendEpicEmailFromTrackerAction}>
              <input type="hidden" name="requestId" value={r.id} />
              <input type="hidden" name="template" value={tpl} />
              <SubmitButton size="sm" variant="ghost" pendingLabel="Sending…">
                {tpl === "epic-onboarding" ? "Onboarding" : tpl === "epic-activation" ? "Activation" : "Password reset"}
              </SubmitButton>
            </form>
          ))}
        </div>
      )}
    </div>
    ```
    Note: `getEpicRequestHistory`'s `requests[]` already includes `id`, `kind`, `status`, `person.name`, `person.epicId`, so no read change is needed. Confirm `SubmitButton` and `Input` are already imported in this file (they are used elsewhere in it).

- [ ] **Step 3: Typecheck + lint.**
  Run: `npm run typecheck && npm run lint`
  Expected: PASS.

- [ ] **Step 4: Manual smoke.** On `/support/epic?tab=tracker`, for an open YNHH ticket's request: enter an Epic ID and Complete (verify the person's `epicId` is written and the request shows COMPLETED), and send an onboarding email (verify an `EmailLog` row is queued).

- [ ] **Step 5: Commit.**
  ```bash
  git add src/app/\(app\)/support/epic/page.tsx src/modules/support/components/epic-request-tabs.tsx
  git commit -m "feat(support): Tracker gains per-request Complete + Epic email"
  ```

---

## Task 9: End-to-end test + full gate

**Files:**
- Create: `e2e/support-epic-attach.spec.ts` (or the repo's e2e dir; match existing support specs' location and fixtures)

**Interfaces:**
- Consumes: existing Playwright auth + seed fixtures used by other support specs.

- [ ] **Step 1: Find the pattern.** Read an existing support e2e spec (e.g. search `e2e` for `support`) to copy its auth fixture, manager sign-in helper, and seed conventions. Do not invent a new harness.

- [ ] **Step 2: Write the spec.** Cover the happy path end to end: as a manager, open a ticket, attach a bulk NEW request for two people, assert both PENDING rows appear on the ticket; go to `/support/epic?tab=pending`, select both, Create YNHH ticket; on `tab=tracker` complete one (enter an Epic ID) and assert it shows COMPLETED. Mirror the selectors and helpers from the spec found in Step 1. Keep it in one worker/serial per the repo's e2e conventions.

- [ ] **Step 3: Run the e2e.**
  Run: `npm run e2e -- support-epic-attach`
  Expected: PASS. If the harness needs a running app/db, follow the repo's e2e setup (same as other support specs).

- [ ] **Step 4: Full gate.**
  Run: `npm run lint && npm run typecheck && npm run test`
  Expected: all PASS.

- [ ] **Step 5: Commit.**
  ```bash
  git add e2e
  git commit -m "test(e2e): attach bulk Epic requests to a ticket, batch to YNHH, complete"
  ```

---

## Self-review notes (author)

- **Spec coverage:** §1 -> Task 1; §2 attach -> Task 2, cancel -> Task 3; §3 ticket UI -> Task 6 (+ picker Task 5, `loadDetail` Task 4); §4 Pending queue -> Task 7 (+ `listPendingEpicRequests` Task 4); §4a Complete+Email on Tracker -> Task 8; testing -> Tasks 2/3 unit + Task 9 e2e.
- **Type consistency:** `attachEpicRequests(actor, ticketId, { kind, personIds })` used identically in Task 2 (def), Task 6 (page action). `cancelEpicRequest(actor, requestId)` in Task 3 (def) + Task 6 (page action). `listPendingEpicRequests` / `PendingEpicRequestRow` defined Task 4, consumed Task 7. `detail.epicRequests` shape defined Task 4, consumed Task 6.
- **Known deviations from spec:** the member picker is a standalone `EpicPersonPicker` (Task 5), not an extraction shared with the Generate form, to avoid regressing the mature generator; convergence is deferred. `TechRequest.epicSubtype` is left in place as an intake hint and is simply no longer written at attach time.
- **Verify-before-claim reminders baked in:** every task ends with the gate command and, for UI, a real-app smoke check, not just typecheck.
