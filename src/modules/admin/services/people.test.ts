import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  searchPeople,
  getPerson,
  createPerson,
  updatePerson,
  setPersonStatus,
  PersonConflictError,
  PersonNotFoundError,
} from "./people";

const ACTOR = "actor-person-id";

async function seedPerson(overrides: {
  name: string;
  netId?: string | null;
  contactEmail?: string | null;
  status?: "ACTIVE" | "OFFBOARDED";
}) {
  return prisma.person.create({
    data: {
      name: overrides.name,
      netId: overrides.netId ?? null,
      contactEmail: overrides.contactEmail ?? null,
      status: overrides.status ?? "ACTIVE",
    },
  });
}

describe("searchPeople", () => {
  beforeEach(resetDb);

  it("matches by name (case-insensitive contains)", async () => {
    await seedPerson({ name: "Jack Carney", netId: "jdc239", contactEmail: "jack@example.com" });
    await seedPerson({ name: "Alice Smith", netId: "as111", contactEmail: "alice@example.com" });

    const result = await searchPeople({ search: "jack" });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].name).toBe("Jack Carney");
  });

  it("matches by netId (case-insensitive contains)", async () => {
    await seedPerson({ name: "Jack Carney", netId: "jdc239", contactEmail: "jack@example.com" });
    await seedPerson({ name: "Alice Smith", netId: "as111", contactEmail: "alice@example.com" });

    const result = await searchPeople({ search: "JDC" });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].netId).toBe("jdc239");
  });

  it("matches by contactEmail (case-insensitive contains)", async () => {
    await seedPerson({ name: "Bob Jones", netId: "bj999", contactEmail: "bob.jones@example.com" });
    await seedPerson({ name: "Carol White", netId: "cw222", contactEmail: "carol@other.org" });

    const result = await searchPeople({ search: "other.org" });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].name).toBe("Carol White");
  });

  it("paginates with default pageSize 25, ordered by name, with total and pageCount", async () => {
    // Create 30 people to test pagination
    for (let i = 0; i < 30; i++) {
      await prisma.person.create({
        data: { name: `Person ${String(i).padStart(2, "0")}`, netId: `nid${i}` },
      });
    }

    const result = await searchPeople({ page: 1 });
    expect(result.rows).toHaveLength(25);
    expect(result.total).toBe(30);
    expect(result.page).toBe(1);
    expect(result.pageCount).toBe(2);

    // Rows are ordered by name ascending
    const names = result.rows.map((r) => r.name);
    expect(names).toEqual([...names].sort());
  });

  it("filters by status when provided", async () => {
    await seedPerson({ name: "Active Person", netId: "ap1", status: "ACTIVE" });
    await seedPerson({ name: "Offboarded Person", netId: "op1", status: "OFFBOARDED" });

    const active = await searchPeople({ status: "ACTIVE" });
    expect(active.rows.every((r) => r.status === "ACTIVE")).toBe(true);

    const offboarded = await searchPeople({ status: "OFFBOARDED" });
    expect(offboarded.rows.every((r) => r.status === "OFFBOARDED")).toBe(true);
  });

  it("returns all when no search or status filter", async () => {
    await seedPerson({ name: "Alpha", netId: "a1" });
    await seedPerson({ name: "Beta", netId: "b2", status: "OFFBOARDED" });

    const result = await searchPeople({});
    expect(result.total).toBe(2);
  });

  it("returns all rows when search is whitespace-only", async () => {
    await seedPerson({ name: "Alpha", netId: "ws1" });
    await seedPerson({ name: "Beta", netId: "ws2" });

    const result = await searchPeople({ search: "   " });
    expect(result.total).toBe(2);
  });
});

describe("getPerson", () => {
  beforeEach(resetDb);

  it("returns null for a non-existent id", async () => {
    const result = await getPerson("nonexistent-id");
    expect(result).toBeNull();
  });

  it("returns the person with their memberships including term and department", async () => {
    const person = await seedPerson({ name: "Test User", netId: "tu1" });
    const term = await prisma.term.create({
      data: {
        code: "SU26",
        name: "Summer 2026",
        startDate: new Date("2026-05-30"),
        endDate: new Date("2026-09-26"),
        status: "ACTIVE",
      },
    });
    const dept = await prisma.department.create({ data: { code: "ITCM", name: "IT" } });
    await prisma.termMembership.create({
      data: { personId: person.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER" },
    });

    const result = await getPerson(person.id);
    expect(result).not.toBeNull();
    expect(result!.memberships).toHaveLength(1);
    expect(result!.memberships[0].term.code).toBe("SU26");
    expect(result!.memberships[0].department.code).toBe("ITCM");
  });
});

describe("createPerson", () => {
  beforeEach(resetDb);

  it("creates a person and normalizes netId and emails to lowercase", async () => {
    const person = await createPerson(ACTOR, {
      name: "Jack Carney",
      netId: "JDC239",
      contactEmail: "JACK@EXAMPLE.COM",
    });

    expect(person.netId).toBe("jdc239");
    expect(person.contactEmail).toBe("jack@example.com");
  });

  it("writes an audit entry with action person.create and an after snapshot", async () => {
    const person = await createPerson(ACTOR, { name: "Audit Subject", netId: "as1" });

    const logs = await prisma.auditLog.findMany({ where: { entityId: person.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe("person.create");
    expect(logs[0].actorPersonId).toBe(ACTOR);
    expect(logs[0].after).toBeTruthy();
    expect((logs[0].after as Record<string, unknown>).name).toBe("Audit Subject");
  });

  it("throws PersonConflictError with a field name on duplicate netId", async () => {
    await createPerson(ACTOR, { name: "First", netId: "uniq1", contactEmail: "first@example.com" });

    await expect(
      createPerson(ACTOR, { name: "Second", netId: "uniq1" })
    ).rejects.toBeInstanceOf(PersonConflictError);
  });

  it("throws PersonConflictError with a field name on duplicate contactEmail", async () => {
    await createPerson(ACTOR, {
      name: "First",
      netId: "q1",
      contactEmail: "shared@example.com",
    });

    let caught: PersonConflictError | null = null;
    try {
      await createPerson(ACTOR, { name: "Second", netId: "q2", contactEmail: "shared@example.com" });
    } catch (e) {
      if (e instanceof PersonConflictError) caught = e;
    }

    expect(caught).not.toBeNull();
    expect(caught!.field).toBeTruthy();
  });

  it("normalizes lower()-expression-index violation field name to plain column name", async () => {
    // Insert a row with uppercase netId directly, bypassing app normalization.
    // The @unique constraint on netId stores 'CASEVAR9' and the LOWER() expression
    // index covers lower('CASEVAR9') = 'casevar9'. When createPerson receives
    // 'casevar9' (already lowercase), the standard @unique does NOT fire
    // ('CASEVAR9' != 'casevar9') but the LOWER() expression index does.
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Person" (id, name, "netId", status, "createdAt", "updatedAt") VALUES (gen_random_uuid(), 'Raw Insert', 'CASEVAR9', 'ACTIVE', now(), now())`
    );

    let caught: PersonConflictError | null = null;
    try {
      await createPerson(ACTOR, { name: "Conflict Person", netId: "casevar9" });
    } catch (e) {
      if (e instanceof PersonConflictError) caught = e;
    }

    expect(caught).not.toBeNull();
    // Field should be "netId", NOT "lower(netId)"
    expect(caught!.field).toBe("netId");
  });
});

describe("updatePerson", () => {
  beforeEach(resetDb);

  it("audits only the changed fields (before/after of changed keys)", async () => {
    const person = await createPerson(ACTOR, {
      name: "Original Name",
      netId: "on1",
      contactEmail: "orig@example.com",
    });
    await prisma.auditLog.deleteMany(); // clear create audit

    await updatePerson(ACTOR, person.id, {
      name: "Updated Name",
      netId: "on1", // unchanged
      contactEmail: "orig@example.com", // unchanged
    });

    const logs = await prisma.auditLog.findMany({ where: { action: "person.update" } });
    expect(logs).toHaveLength(1);
    const log = logs[0];
    expect((log.before as Record<string, unknown>).name).toBe("Original Name");
    expect((log.after as Record<string, unknown>).name).toBe("Updated Name");
    // unchanged fields should NOT appear in the audit
    expect((log.before as Record<string, unknown>).netId).toBeUndefined();
    expect((log.after as Record<string, unknown>).netId).toBeUndefined();
  });

  it("writes NO audit when no fields change (no-op update)", async () => {
    const person = await createPerson(ACTOR, {
      name: "Noop Person",
      netId: "noop1",
      contactEmail: "noop@example.com",
    });
    await prisma.auditLog.deleteMany();

    await updatePerson(ACTOR, person.id, {
      name: "Noop Person",
      netId: "noop1",
      contactEmail: "noop@example.com",
    });

    const auditCount = await prisma.auditLog.count();
    expect(auditCount).toBe(0);
  });

  it("normalizes netId and emails to lowercase on update", async () => {
    const person = await createPerson(ACTOR, { name: "Case Test", netId: "ct1" });

    const updated = await updatePerson(ACTOR, person.id, {
      name: "Case Test",
      netId: "CT1",
      contactEmail: "UPPER@EXAMPLE.COM",
    });

    expect(updated.netId).toBe("ct1");
    expect(updated.contactEmail).toBe("upper@example.com");
  });

  it("rejects with PersonNotFoundError when id does not exist", async () => {
    await expect(
      updatePerson(ACTOR, "nonexistent-id", { name: "Ghost" })
    ).rejects.toBeInstanceOf(PersonNotFoundError);
  });
});

describe("setPersonStatus", () => {
  beforeEach(resetDb);

  it("audits with action person.offboard when setting to OFFBOARDED", async () => {
    const person = await createPerson(ACTOR, { name: "To Offboard", netId: "to1" });
    await prisma.auditLog.deleteMany();

    await setPersonStatus(ACTOR, person.id, "OFFBOARDED");

    const logs = await prisma.auditLog.findMany({ where: { entityId: person.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe("person.offboard");
  });

  it("audits with action person.reactivate when setting to ACTIVE", async () => {
    const person = await createPerson(ACTOR, { name: "To Reactivate", netId: "tr1" });
    await setPersonStatus(ACTOR, person.id, "OFFBOARDED");
    await prisma.auditLog.deleteMany();

    await setPersonStatus(ACTOR, person.id, "ACTIVE");

    const logs = await prisma.auditLog.findMany({ where: { entityId: person.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe("person.reactivate");
  });

  it("returns the updated person with the new status", async () => {
    const person = await createPerson(ACTOR, { name: "Status Return", netId: "sr1" });

    const result = await setPersonStatus(ACTOR, person.id, "OFFBOARDED");
    expect(result.status).toBe("OFFBOARDED");
  });

  it("rejects with PersonNotFoundError when id does not exist", async () => {
    await expect(
      setPersonStatus(ACTOR, "nonexistent-id", "OFFBOARDED")
    ).rejects.toBeInstanceOf(PersonNotFoundError);
  });
});

describe("PersonConflictError", () => {
  it("is an instance of Error and carries the field name", () => {
    const err = new PersonConflictError("netId");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(PersonConflictError);
    expect(err.field).toBe("netId");
    expect(err.message).toContain("netId");
  });
});

describe("PersonNotFoundError", () => {
  it("is an instance of Error and carries the id", () => {
    const err = new PersonNotFoundError("abc-123");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(PersonNotFoundError);
    expect(err.id).toBe("abc-123");
    expect(err.message).toContain("abc-123");
    expect(err.name).toBe("PersonNotFoundError");
  });
});
