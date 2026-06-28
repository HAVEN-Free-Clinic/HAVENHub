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

  it("enqueues mirror with only the fields that actually changed (precise changed-field set)", async () => {
    const person = await createPersonRecord(ACTOR, {
      name: "Mirror Diff",
      netId: "md1",
      phone: "111",
    });
    await prisma.outbox.deleteMany();

    // Only `name` changes; netId and phone are passed unchanged and must not
    // appear in the enqueued changedFields.
    await updatePersonFields(ACTOR, person.id, {
      name: "Mirror Diff Updated",
      netId: "md1",
      phone: "111",
    });

    const outboxRows = await prisma.outbox.findMany({ where: { entityId: person.id } });
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0].changedFields).toEqual(["name"]);
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

  it("persists spanishSpeaking and licensedRN and audits only the changed flag", async () => {
    const person = await createPersonRecord(ACTOR, { name: "Flagged" });
    expect(person.spanishSpeaking).toBe(false);
    expect(person.licensedRN).toBe(false);
    await prisma.auditLog.deleteMany();
    await prisma.outbox.deleteMany();

    const updated = await updatePersonFields(ACTOR, person.id, { spanishSpeaking: true });
    expect(updated.spanishSpeaking).toBe(true);
    expect(updated.licensedRN).toBe(false);

    // Only the changed flag is audited; these flags are not mirrored to Airtable.
    expect(await prisma.auditLog.count()).toBe(1);
    expect(await prisma.outbox.count()).toBe(0);
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

  it("offboarding sets ALL ACTIVE memberships (any term) to REMOVED and records the count in the single audit row", async () => {
    const person = await createPersonRecord(ACTOR, { name: "Member", netId: "mem1" });
    const dept = await prisma.department.create({ data: { code: "ITCM", name: "IT" } });
    const term1 = await prisma.term.create({
      data: { code: "SU26", name: "Summer", startDate: new Date("2026-05-01"), endDate: new Date("2026-09-01"), status: "ACTIVE" },
    });
    const term2 = await prisma.term.create({
      data: { code: "FA26", name: "Fall", startDate: new Date("2026-09-02"), endDate: new Date("2026-12-01"), status: "ACTIVE" },
    });
    // Two ACTIVE memberships across two terms + one already-REMOVED (must not be recounted).
    await prisma.termMembership.create({ data: { personId: person.id, termId: term1.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" } });
    await prisma.termMembership.create({ data: { personId: person.id, termId: term2.id, departmentId: dept.id, kind: "DIRECTOR", status: "ACTIVE" } });
    const alreadyRemoved = await prisma.termMembership.create({
      data: { personId: person.id, termId: term1.id, departmentId: (await prisma.department.create({ data: { code: "SRR", name: "SRR" } })).id, kind: "VOLUNTEER", status: "REMOVED" },
    });
    await prisma.auditLog.deleteMany();

    await setPersonStatusField(ACTOR, person.id, "OFFBOARDED");

    const memberships = await prisma.termMembership.findMany({ where: { personId: person.id } });
    expect(memberships.every((m) => m.status === "REMOVED")).toBe(true);
    // The pre-existing REMOVED row is untouched (still REMOVED).
    expect(memberships.find((m) => m.id === alreadyRemoved.id)?.status).toBe("REMOVED");

    // Still exactly one audit row for the person; it carries the removed count.
    const logs = await prisma.auditLog.findMany({ where: { entityId: person.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe("person.offboard");
    expect((logs[0].after as Record<string, unknown>).removedMemberships).toBe(2);
  });

  it("reactivating never restores or touches memberships and records no removal count", async () => {
    const person = await createPersonRecord(ACTOR, { name: "Reactivate", netId: "rea1" });
    const dept = await prisma.department.create({ data: { code: "ITCM", name: "IT" } });
    const term = await prisma.term.create({
      data: { code: "SU26", name: "Summer", startDate: new Date("2026-05-01"), endDate: new Date("2026-09-01"), status: "ACTIVE" },
    });
    const membership = await prisma.termMembership.create({
      data: { personId: person.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER", status: "REMOVED" },
    });
    await setPersonStatusField(ACTOR, person.id, "OFFBOARDED");
    await prisma.auditLog.deleteMany();

    await setPersonStatusField(ACTOR, person.id, "ACTIVE");

    // Reactivate is status-only: the REMOVED membership stays REMOVED.
    const after = await prisma.termMembership.findUniqueOrThrow({ where: { id: membership.id } });
    expect(after.status).toBe("REMOVED");

    const logs = await prisma.auditLog.findMany({ where: { entityId: person.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe("person.reactivate");
    expect((logs[0].after as Record<string, unknown>).removedMemberships).toBeUndefined();
  });

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
    expect(deact[0].notes?.endsWith("Cancelled: person reactivated")).toBe(true);

    const log = await prisma.auditLog.findFirst({
      where: { entityId: person.id, action: "person.reactivate" },
      orderBy: { createdAt: "desc" },
    });
    const after = log?.after as Record<string, unknown>;
    expect(after.cancelledDeactivationRequestIds).toEqual([deact[0].id]);
  });
});
