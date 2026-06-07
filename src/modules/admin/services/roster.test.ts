/**
 * Roster service tests (TDD: written before the implementation).
 *
 * Tests cover:
 * - termRoster: grouping by department, sorting (dept by code, people by name within each list)
 * - addMembership: creates fresh; revives a REMOVED row (no unique violation); writes audit
 * - removeMembership: soft-deletes ACTIVE; writes audit; typed error for missing id;
 *   already-REMOVED is a no-op (no audit written)
 * - copyRosterFromTerm: copies only requested kinds; skips existing ACTIVE rows;
 *   revives REMOVED rows in the target; refuses ARCHIVED target (typed error);
 *   writes exactly one audit row with correct counts
 */

import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  termRoster,
  addMembership,
  removeMembership,
  copyRosterFromTerm,
  MembershipNotFoundError,
  RosterCopyError,
} from "./roster";
import { TermNotFoundError } from "./terms";

const ACTOR = "actor-person-id";

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedTerm(code: string, status: "PLANNING" | "ACTIVE" | "ARCHIVED") {
  return prisma.term.create({
    data: {
      code,
      name: `Term ${code}`,
      startDate: new Date("2026-01-01T12:00:00Z"),
      endDate: new Date("2026-04-30T12:00:00Z"),
      status,
    },
  });
}

async function seedDepartment(code: string) {
  return prisma.department.create({
    data: { code, name: `Dept ${code}` },
  });
}

async function seedPerson(name: string) {
  return prisma.person.create({ data: { name } });
}

async function seedMembership(opts: {
  personId: string;
  termId: string;
  departmentId: string;
  kind: "DIRECTOR" | "VOLUNTEER";
  status?: "ACTIVE" | "REMOVED";
}) {
  return prisma.termMembership.create({
    data: {
      personId: opts.personId,
      termId: opts.termId,
      departmentId: opts.departmentId,
      kind: opts.kind,
      status: opts.status ?? "ACTIVE",
    },
  });
}

// ---------------------------------------------------------------------------
// termRoster
// ---------------------------------------------------------------------------

describe("termRoster", () => {
  beforeEach(resetDb);

  it("returns only ACTIVE memberships grouped by department", async () => {
    const term = await seedTerm("SU26", "ACTIVE");
    const deptA = await seedDepartment("AAAA");
    const person1 = await seedPerson("Alice");
    const person2 = await seedPerson("Bob");

    await seedMembership({ personId: person1.id, termId: term.id, departmentId: deptA.id, kind: "VOLUNTEER", status: "ACTIVE" });
    await seedMembership({ personId: person2.id, termId: term.id, departmentId: deptA.id, kind: "DIRECTOR", status: "REMOVED" });

    const roster = await termRoster(term.id);
    expect(roster).toHaveLength(1);
    expect(roster[0].volunteers).toHaveLength(1);
    expect(roster[0].directors).toHaveLength(0);
    expect(roster[0].volunteers[0].name).toBe("Alice");
  });

  it("groups into directors and volunteers within each department", async () => {
    const term = await seedTerm("SU26", "ACTIVE");
    const dept = await seedDepartment("DEPT");
    const director = await seedPerson("Director Dan");
    const volunteer = await seedPerson("Volunteer Vera");

    await seedMembership({ personId: director.id, termId: term.id, departmentId: dept.id, kind: "DIRECTOR" });
    await seedMembership({ personId: volunteer.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER" });

    const roster = await termRoster(term.id);
    expect(roster).toHaveLength(1);
    expect(roster[0].directors).toHaveLength(1);
    expect(roster[0].volunteers).toHaveLength(1);
    expect(roster[0].directors[0].name).toBe("Director Dan");
    expect(roster[0].volunteers[0].name).toBe("Volunteer Vera");
  });

  it("sorts departments by code ascending", async () => {
    const term = await seedTerm("SU26", "ACTIVE");
    const deptZ = await seedDepartment("ZZZZ");
    const deptA = await seedDepartment("AAAA");
    const personZ = await seedPerson("Zara");
    const personA = await seedPerson("Aaron");

    await seedMembership({ personId: personZ.id, termId: term.id, departmentId: deptZ.id, kind: "VOLUNTEER" });
    await seedMembership({ personId: personA.id, termId: term.id, departmentId: deptA.id, kind: "VOLUNTEER" });

    const roster = await termRoster(term.id);
    expect(roster).toHaveLength(2);
    expect(roster[0].department.code).toBe("AAAA");
    expect(roster[1].department.code).toBe("ZZZZ");
  });

  it("sorts people by name ascending within each kind list", async () => {
    const term = await seedTerm("SU26", "ACTIVE");
    const dept = await seedDepartment("DEPT");
    const charlie = await seedPerson("Charlie");
    const anna = await seedPerson("Anna");
    const zoe = await seedPerson("Zoe");

    await seedMembership({ personId: charlie.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER" });
    await seedMembership({ personId: anna.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER" });
    await seedMembership({ personId: zoe.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER" });

    const roster = await termRoster(term.id);
    const names = roster[0].volunteers.map((p) => p.name);
    expect(names).toEqual(["Anna", "Charlie", "Zoe"]);
  });

  it("returns an empty array when there are no ACTIVE memberships", async () => {
    const term = await seedTerm("SU26", "ACTIVE");
    const roster = await termRoster(term.id);
    expect(roster).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// addMembership
// ---------------------------------------------------------------------------

describe("addMembership", () => {
  beforeEach(resetDb);

  it("creates a fresh ACTIVE membership and writes an audit row", async () => {
    const term = await seedTerm("SU26", "ACTIVE");
    const dept = await seedDepartment("DEPT");
    const person = await seedPerson("Alice");

    await addMembership(ACTOR, {
      personId: person.id,
      termId: term.id,
      departmentId: dept.id,
      kind: "VOLUNTEER",
    });

    const memberships = await prisma.termMembership.findMany({
      where: { personId: person.id, termId: term.id },
    });
    expect(memberships).toHaveLength(1);
    expect(memberships[0].status).toBe("ACTIVE");

    const logs = await prisma.auditLog.findMany({ where: { action: "roster.add" } });
    expect(logs).toHaveLength(1);
    expect(logs[0].actorPersonId).toBe(ACTOR);
  });

  it("revives a REMOVED membership instead of throwing a unique violation", async () => {
    const term = await seedTerm("SU26", "ACTIVE");
    const dept = await seedDepartment("DEPT");
    const person = await seedPerson("Alice");

    // Seed a REMOVED membership on the same compound key
    await seedMembership({ personId: person.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER", status: "REMOVED" });

    // addMembership should revive it, not throw
    await expect(
      addMembership(ACTOR, {
        personId: person.id,
        termId: term.id,
        departmentId: dept.id,
        kind: "VOLUNTEER",
      })
    ).resolves.not.toThrow();

    const membership = await prisma.termMembership.findFirst({
      where: { personId: person.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER" },
    });
    expect(membership).not.toBeNull();
    expect(membership!.status).toBe("ACTIVE");
  });

  it("revived membership writes an audit row", async () => {
    const term = await seedTerm("SU26", "ACTIVE");
    const dept = await seedDepartment("DEPT");
    const person = await seedPerson("Alice");

    await seedMembership({ personId: person.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER", status: "REMOVED" });
    const auditCountBefore = await prisma.auditLog.count();

    await addMembership(ACTOR, {
      personId: person.id,
      termId: term.id,
      departmentId: dept.id,
      kind: "VOLUNTEER",
    });

    const auditCountAfter = await prisma.auditLog.count();
    expect(auditCountAfter).toBe(auditCountBefore + 1);

    const log = await prisma.auditLog.findFirst({ where: { action: "roster.add" } });
    expect(log).not.toBeNull();
    const after = log!.after as Record<string, unknown>;
    expect(after.personId).toBe(person.id);
    expect(after.termId).toBe(term.id);
    expect(after.departmentId).toBe(dept.id);
    expect(after.kind).toBe("VOLUNTEER");
  });
});

// ---------------------------------------------------------------------------
// removeMembership
// ---------------------------------------------------------------------------

describe("removeMembership", () => {
  beforeEach(resetDb);

  it("soft-deletes an ACTIVE membership (sets status to REMOVED)", async () => {
    const term = await seedTerm("SU26", "ACTIVE");
    const dept = await seedDepartment("DEPT");
    const person = await seedPerson("Alice");
    const membership = await seedMembership({ personId: person.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER" });

    await removeMembership(ACTOR, membership.id);

    const reloaded = await prisma.termMembership.findUnique({ where: { id: membership.id } });
    expect(reloaded!.status).toBe("REMOVED");
  });

  it("writes an audit row with action roster.remove", async () => {
    const term = await seedTerm("SU26", "ACTIVE");
    const dept = await seedDepartment("DEPT");
    const person = await seedPerson("Alice");
    const membership = await seedMembership({ personId: person.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER" });

    await removeMembership(ACTOR, membership.id);

    const logs = await prisma.auditLog.findMany({ where: { action: "roster.remove" } });
    expect(logs).toHaveLength(1);
    expect(logs[0].actorPersonId).toBe(ACTOR);
    expect(logs[0].entityId).toBe(membership.id);
  });

  it("throws MembershipNotFoundError when the membershipId does not exist", async () => {
    await expect(removeMembership(ACTOR, "nonexistent-id")).rejects.toBeInstanceOf(MembershipNotFoundError);
  });

  it("is a no-op (no status change, no audit) when membership is already REMOVED", async () => {
    const term = await seedTerm("SU26", "ACTIVE");
    const dept = await seedDepartment("DEPT");
    const person = await seedPerson("Alice");
    const membership = await seedMembership({ personId: person.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER", status: "REMOVED" });

    const auditCountBefore = await prisma.auditLog.count();

    await removeMembership(ACTOR, membership.id);

    const reloaded = await prisma.termMembership.findUnique({ where: { id: membership.id } });
    expect(reloaded!.status).toBe("REMOVED");

    const auditCountAfter = await prisma.auditLog.count();
    expect(auditCountAfter).toBe(auditCountBefore);
  });
});

// ---------------------------------------------------------------------------
// copyRosterFromTerm
// ---------------------------------------------------------------------------

describe("copyRosterFromTerm", () => {
  beforeEach(resetDb);

  it("copies ACTIVE memberships of the requested kinds from source to target", async () => {
    const source = await seedTerm("SU26", "ACTIVE");
    const target = await seedTerm("FA26", "PLANNING");
    const dept = await seedDepartment("DEPT");
    const director = await seedPerson("Director Dan");
    const volunteer = await seedPerson("Volunteer Vera");

    await seedMembership({ personId: director.id, termId: source.id, departmentId: dept.id, kind: "DIRECTOR" });
    await seedMembership({ personId: volunteer.id, termId: source.id, departmentId: dept.id, kind: "VOLUNTEER" });

    const result = await copyRosterFromTerm(ACTOR, source.id, target.id, ["DIRECTOR"]);

    // Only directors should be copied
    expect(result.copied).toBe(1);
    expect(result.skipped).toBe(0);

    const targetMemberships = await prisma.termMembership.findMany({
      where: { termId: target.id, status: "ACTIVE" },
    });
    expect(targetMemberships).toHaveLength(1);
    expect(targetMemberships[0].kind).toBe("DIRECTOR");
    expect(targetMemberships[0].personId).toBe(director.id);
  });

  it("copies both kinds when both are requested", async () => {
    const source = await seedTerm("SU26", "ACTIVE");
    const target = await seedTerm("FA26", "PLANNING");
    const dept = await seedDepartment("DEPT");
    const director = await seedPerson("Director Dan");
    const volunteer = await seedPerson("Volunteer Vera");

    await seedMembership({ personId: director.id, termId: source.id, departmentId: dept.id, kind: "DIRECTOR" });
    await seedMembership({ personId: volunteer.id, termId: source.id, departmentId: dept.id, kind: "VOLUNTEER" });

    const result = await copyRosterFromTerm(ACTOR, source.id, target.id, ["DIRECTOR", "VOLUNTEER"]);

    expect(result.copied).toBe(2);
    expect(result.skipped).toBe(0);
  });

  it("skips persons already ACTIVE in the target for the same dept+kind", async () => {
    const source = await seedTerm("SU26", "ACTIVE");
    const target = await seedTerm("FA26", "PLANNING");
    const dept = await seedDepartment("DEPT");
    const person = await seedPerson("Alice");

    await seedMembership({ personId: person.id, termId: source.id, departmentId: dept.id, kind: "VOLUNTEER" });
    // Already exists as ACTIVE in target
    await seedMembership({ personId: person.id, termId: target.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" });

    const result = await copyRosterFromTerm(ACTOR, source.id, target.id, ["VOLUNTEER"]);

    expect(result.copied).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("revives a REMOVED membership in the target (counts as copied)", async () => {
    const source = await seedTerm("SU26", "ACTIVE");
    const target = await seedTerm("FA26", "PLANNING");
    const dept = await seedDepartment("DEPT");
    const person = await seedPerson("Alice");

    await seedMembership({ personId: person.id, termId: source.id, departmentId: dept.id, kind: "VOLUNTEER" });
    // REMOVED in target - should be revived
    await seedMembership({ personId: person.id, termId: target.id, departmentId: dept.id, kind: "VOLUNTEER", status: "REMOVED" });

    const result = await copyRosterFromTerm(ACTOR, source.id, target.id, ["VOLUNTEER"]);

    expect(result.copied).toBe(1);
    expect(result.skipped).toBe(0);

    const revived = await prisma.termMembership.findFirst({
      where: { personId: person.id, termId: target.id, departmentId: dept.id, kind: "VOLUNTEER" },
    });
    expect(revived!.status).toBe("ACTIVE");
  });

  it("does not copy REMOVED memberships from the source", async () => {
    const source = await seedTerm("SU26", "ACTIVE");
    const target = await seedTerm("FA26", "PLANNING");
    const dept = await seedDepartment("DEPT");
    const person = await seedPerson("Alice");

    // REMOVED in source - should not be copied
    await seedMembership({ personId: person.id, termId: source.id, departmentId: dept.id, kind: "VOLUNTEER", status: "REMOVED" });

    const result = await copyRosterFromTerm(ACTOR, source.id, target.id, ["VOLUNTEER"]);

    expect(result.copied).toBe(0);
    expect(result.skipped).toBe(0);

    const targetMemberships = await prisma.termMembership.findMany({ where: { termId: target.id } });
    expect(targetMemberships).toHaveLength(0);
  });

  it("throws TermNotFoundError when the target term does not exist", async () => {
    const source = await seedTerm("SU26", "ACTIVE");

    await expect(
      copyRosterFromTerm(ACTOR, source.id, "nonexistent-target-id", ["VOLUNTEER"])
    ).rejects.toBeInstanceOf(TermNotFoundError);
  });

  it("throws RosterCopyError when the target term is ARCHIVED", async () => {
    const source = await seedTerm("SU26", "ACTIVE");
    const target = await seedTerm("FA26", "ARCHIVED");

    await expect(
      copyRosterFromTerm(ACTOR, source.id, target.id, ["VOLUNTEER"])
    ).rejects.toBeInstanceOf(RosterCopyError);
  });

  it("writes exactly one audit row roster.copy with fromTermId, toTermId, kinds, copied, skipped", async () => {
    const source = await seedTerm("SU26", "ACTIVE");
    const target = await seedTerm("FA26", "PLANNING");
    const dept = await seedDepartment("DEPT");
    const person = await seedPerson("Alice");
    const skipped = await seedPerson("Bob");

    await seedMembership({ personId: person.id, termId: source.id, departmentId: dept.id, kind: "VOLUNTEER" });
    // Bob is already in target - will be skipped
    await seedMembership({ personId: skipped.id, termId: source.id, departmentId: dept.id, kind: "DIRECTOR" });
    await seedMembership({ personId: skipped.id, termId: target.id, departmentId: dept.id, kind: "DIRECTOR", status: "ACTIVE" });

    const result = await copyRosterFromTerm(ACTOR, source.id, target.id, ["VOLUNTEER", "DIRECTOR"]);

    expect(result.copied).toBe(1);
    expect(result.skipped).toBe(1);

    const logs = await prisma.auditLog.findMany({ where: { action: "roster.copy" } });
    expect(logs).toHaveLength(1);

    const after = logs[0].after as Record<string, unknown>;
    expect(after.fromTermId).toBe(source.id);
    expect(after.toTermId).toBe(target.id);
    expect(after.kinds).toEqual(expect.arrayContaining(["VOLUNTEER", "DIRECTOR"]));
    expect(after.copied).toBe(1);
    expect(after.skipped).toBe(1);
  });

  it("writes no audit row when copying from a term with no matching ACTIVE memberships", async () => {
    const source = await seedTerm("SU26", "ACTIVE");
    const target = await seedTerm("FA26", "PLANNING");
    const auditCountBefore = await prisma.auditLog.count();

    // No memberships in source
    const result = await copyRosterFromTerm(ACTOR, source.id, target.id, ["VOLUNTEER"]);

    expect(result.copied).toBe(0);
    expect(result.skipped).toBe(0);

    // Still writes one audit row with counts (0/0) to record the operation
    const auditCountAfter = await prisma.auditLog.count();
    expect(auditCountAfter).toBe(auditCountBefore + 1);
  });
});

// ---------------------------------------------------------------------------
// Typed error constructors
// ---------------------------------------------------------------------------

describe("MembershipNotFoundError", () => {
  it("is an instance of Error and carries the id", () => {
    const err = new MembershipNotFoundError("abc-123");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(MembershipNotFoundError);
    expect(err.id).toBe("abc-123");
    expect(err.message).toContain("abc-123");
    expect(err.name).toBe("MembershipNotFoundError");
  });
});

describe("RosterCopyError", () => {
  it("is an instance of Error and carries the message", () => {
    const err = new RosterCopyError("target term is archived");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(RosterCopyError);
    expect(err.message).toContain("target term is archived");
    expect(err.name).toBe("RosterCopyError");
  });
});
