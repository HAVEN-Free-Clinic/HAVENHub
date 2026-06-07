import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  createPersonRecord,
  updatePersonFields,
  setPersonStatusField,
  PersonConflictError,
  PersonNotFoundError,
} from "./people";

const ACTOR = "actor-person-id";

describe("createPersonRecord", () => {
  beforeEach(resetDb);

  it("normalizes netId and emails to lowercase and enqueues a mirror row in the same tx", async () => {
    const person = await createPersonRecord(ACTOR, {
      name: "Jack Carney",
      netId: "JDC239",
      contactEmail: "JACK@EXAMPLE.COM",
    });

    expect(person.netId).toBe("jdc239");
    expect(person.contactEmail).toBe("jack@example.com");

    const outboxRows = await prisma.outbox.findMany({ where: { entityId: person.id } });
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0].entityType).toBe("Person");
  });

  it("rolls back the outbox row and throws PersonConflictError on duplicate netId", async () => {
    await createPersonRecord(ACTOR, { name: "First", netId: "dup1" });
    const countBefore = await prisma.outbox.count();

    await expect(
      createPersonRecord(ACTOR, { name: "Second", netId: "dup1" })
    ).rejects.toBeInstanceOf(PersonConflictError);

    const countAfter = await prisma.outbox.count();
    expect(countAfter).toBe(countBefore); // no outbox row leaked
  });

  it("maps a lower()-expression-index violation to the plain column name", async () => {
    // Insert a row with uppercase netId directly, bypassing app normalization.
    // The LOWER() expression index covers lower('CASEVAR9') = 'casevar9', so a
    // create with an already-lowercase 'casevar9' trips the expression index
    // (not the plain @unique). The target arrives as "lower(netId)".
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Person" (id, name, "netId", status, "createdAt", "updatedAt") VALUES (gen_random_uuid(), 'Raw Insert', 'CASEVAR9', 'ACTIVE', now(), now())`
    );

    let caught: PersonConflictError | null = null;
    try {
      await createPersonRecord(ACTOR, { name: "Conflict Person", netId: "casevar9" });
    } catch (e) {
      if (e instanceof PersonConflictError) caught = e;
    }

    expect(caught).not.toBeNull();
    expect(caught!.field).toBe("netId"); // not "lower(netId)"
  });
});

describe("updatePersonFields", () => {
  beforeEach(resetDb);

  it("writes NO audit and NO outbox row on a no-op (every present key unchanged)", async () => {
    const person = await createPersonRecord(ACTOR, {
      name: "Noop Person",
      netId: "noop1",
      contactEmail: "noop@example.com",
    });
    await prisma.auditLog.deleteMany();
    await prisma.outbox.deleteMany();

    await updatePersonFields(ACTOR, person.id, {
      name: "Noop Person",
      netId: "noop1",
      contactEmail: "noop@example.com",
    });

    expect(await prisma.auditLog.count()).toBe(0);
    expect(await prisma.outbox.count()).toBe(0);
  });

  it("treats a null as a clear and audits only the changed key", async () => {
    const person = await createPersonRecord(ACTOR, {
      name: "Clearable",
      netId: "clr1",
      contactEmail: "clr@example.com",
    });
    await prisma.auditLog.deleteMany();
    await prisma.outbox.deleteMany();

    const updated = await updatePersonFields(ACTOR, person.id, {
      name: "Clearable",
      contactEmail: null,
    });
    expect(updated.contactEmail).toBeNull();

    const logs = await prisma.auditLog.findMany({ where: { action: "person.update" } });
    expect(logs).toHaveLength(1);
    expect((logs[0].before as Record<string, unknown>).contactEmail).toBe("clr@example.com");
    expect((logs[0].after as Record<string, unknown>).contactEmail).toBeNull();
    // name was present but unchanged -> not in the diff
    expect((logs[0].before as Record<string, unknown>).name).toBeUndefined();
  });

  it("treats a case-only difference as no change after normalization (no-op)", async () => {
    const person = await createPersonRecord(ACTOR, { name: "Case", netId: "ct1" });
    await prisma.auditLog.deleteMany();
    await prisma.outbox.deleteMany();

    const updated = await updatePersonFields(ACTOR, person.id, { name: "Case", netId: "CT1" });

    expect(updated.netId).toBe("ct1");
    expect(await prisma.auditLog.count()).toBe(0);
    expect(await prisma.outbox.count()).toBe(0);
  });

  it("enqueues mirror with only changed mirrored fields, skipping non-mirrored ones", async () => {
    const person = await createPersonRecord(ACTOR, { name: "Mirror Diff", netId: "md1" });
    await prisma.outbox.deleteMany();

    // name is mirrored; yaleEmail is not in ALL_PEOPLE_FIELDS.
    await updatePersonFields(ACTOR, person.id, {
      name: "Mirror Diff Updated",
      yaleEmail: "md1@yale.edu",
    });

    const outboxRows = await prisma.outbox.findMany({ where: { entityId: person.id } });
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0].changedFields).toContain("name");
    expect(outboxRows[0].changedFields).not.toContain("yaleEmail");
  });

  it("rolls back the tx (no outbox leak) and throws PersonConflictError on a conflicting update", async () => {
    await createPersonRecord(ACTOR, { name: "Taken", netId: "taken1" });
    const person = await createPersonRecord(ACTOR, { name: "Mover", netId: "mover1" });
    await prisma.outbox.deleteMany();
    const countBefore = await prisma.outbox.count();

    await expect(
      updatePersonFields(ACTOR, person.id, { name: "Mover", netId: "taken1" })
    ).rejects.toBeInstanceOf(PersonConflictError);

    expect(await prisma.outbox.count()).toBe(countBefore); // no leak
  });

  it("rejects with PersonNotFoundError when the id does not exist", async () => {
    await expect(
      updatePersonFields(ACTOR, "nonexistent-id", { name: "Ghost" })
    ).rejects.toBeInstanceOf(PersonNotFoundError);
  });
});

describe("setPersonStatusField", () => {
  beforeEach(resetDb);

  it("audits person.offboard / person.reactivate and never enqueues a mirror", async () => {
    const person = await createPersonRecord(ACTOR, { name: "Status", netId: "st1" });
    await prisma.auditLog.deleteMany();
    await prisma.outbox.deleteMany();

    await setPersonStatusField(ACTOR, person.id, "OFFBOARDED");
    let logs = await prisma.auditLog.findMany({ where: { entityId: person.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe("person.offboard");

    await prisma.auditLog.deleteMany();
    const reactivated = await setPersonStatusField(ACTOR, person.id, "ACTIVE");
    expect(reactivated.status).toBe("ACTIVE");
    logs = await prisma.auditLog.findMany({ where: { entityId: person.id } });
    expect(logs[0].action).toBe("person.reactivate");

    expect(await prisma.outbox.count()).toBe(0);
  });

  it("rejects with PersonNotFoundError when the id does not exist", async () => {
    await expect(
      setPersonStatusField(ACTOR, "nonexistent-id", "OFFBOARDED")
    ).rejects.toBeInstanceOf(PersonNotFoundError);
  });
});
