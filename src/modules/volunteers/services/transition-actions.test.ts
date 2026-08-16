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
import {
  bulkFlag,
  bulkExecuteOffboard,
  TransitionBatchTooLargeError,
  MAX_BULK_FLAG,
} from "./transition-actions";
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

  // audit 14, bulk-flag-uncapped. personIds comes straight off a FormData POST
  // behind volunteers.view, and each id costs ~6 sequential queries, so an
  // uncapped batch is unbounded database work any signed-in member can ask for
  // (and half-applies if it outruns the function's wall clock). The cap is its
  // own number, well above a full roster, NOT the offboard cap of 25 -- the UI
  // tells the user to flag everyone and offboard in batches.
  it("refuses a batch larger than MAX_BULK_FLAG without touching the database", async () => {
    const actor = await createPerson("Exec", "exec01");
    await grantPermission(actor.id, "volunteers.manage_offboarding");
    const ids = Array.from({ length: MAX_BULK_FLAG + 1 }, (_, i) => `person-${i}`);

    await expect(bulkFlag(actor.id, ids)).rejects.toBeInstanceOf(TransitionBatchTooLargeError);
    // Refused before the loop, so nothing was flagged and no summary row landed.
    expect(await prisma.offboardFlag.count()).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: "offboard.bulk_flag" } })).toBe(0);
  });

  // The other half of the cap: it must NOT be the offboard cap. transition-tab
  // tells a director whose selection exceeds 25 to "flag them all now and
  // offboard in batches", so a batch of 26 has to go through.
  it("accepts a batch larger than the offboard cap", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const actor = await createPerson("Exec", "exec01");
    await grantPermission(actor.id, "volunteers.manage_offboarding");
    const target = await createPerson("Target", "tgt01");
    await createMembership(target.id, term.id, dept.id);
    // The same person repeated: re-flagging takes the existing-row fast path, so
    // this exercises the length check without creating 26 fixtures.
    const ids = Array.from({ length: MAX_BULK_OFFBOARD + 1 }, () => target.id);

    expect(MAX_BULK_FLAG).toBeGreaterThan(MAX_BULK_OFFBOARD);
    const result = await bulkFlag(actor.id, ids);

    expect(result.skipped).toEqual([]);
    expect(await prisma.offboardFlag.count()).toBe(1);
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
