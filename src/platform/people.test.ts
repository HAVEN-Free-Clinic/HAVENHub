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

  it("normalizes netId and emails to lowercase", async () => {
    const person = await createPersonRecord(ACTOR, {
      name: "Jack Carney",
      netId: "JDC239",
      contactEmail: "JACK@EXAMPLE.COM",
    });

    expect(person.netId).toBe("jdc239");
    expect(person.contactEmail).toBe("jack@example.com");
  });

  it("throws PersonConflictError on duplicate netId", async () => {
    await createPersonRecord(ACTOR, { name: "First", netId: "dup1" });

    await expect(
      createPersonRecord(ACTOR, { name: "Second", netId: "dup1" })
    ).rejects.toBeInstanceOf(PersonConflictError);
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

  it("writes NO audit on a no-op (every present key unchanged)", async () => {
    const person = await createPersonRecord(ACTOR, {
      name: "Noop Person",
      netId: "noop1",
      contactEmail: "noop@example.com",
    });
    await prisma.auditLog.deleteMany();

    await updatePersonFields(ACTOR, person.id, {
      name: "Noop Person",
      netId: "noop1",
      contactEmail: "noop@example.com",
    });

    expect(await prisma.auditLog.count()).toBe(0);
  });

  it("treats a null as a clear and audits only the changed key", async () => {
    const person = await createPersonRecord(ACTOR, {
      name: "Clearable",
      netId: "clr1",
      contactEmail: "clr@example.com",
    });
    await prisma.auditLog.deleteMany();

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

    const updated = await updatePersonFields(ACTOR, person.id, { name: "Case", netId: "CT1" });

    expect(updated.netId).toBe("ct1");
    expect(await prisma.auditLog.count()).toBe(0);
  });

  it("throws PersonConflictError on a conflicting update", async () => {
    await createPersonRecord(ACTOR, { name: "Taken", netId: "taken1" });
    const person = await createPersonRecord(ACTOR, { name: "Mover", netId: "mover1" });

    await expect(
      updatePersonFields(ACTOR, person.id, { name: "Mover", netId: "taken1" })
    ).rejects.toBeInstanceOf(PersonConflictError);
  });

  it("rejects with PersonNotFoundError when the id does not exist", async () => {
    await expect(
      updatePersonFields(ACTOR, "nonexistent-id", { name: "Ghost" })
    ).rejects.toBeInstanceOf(PersonNotFoundError);
  });

  it("#68: createPersonRecord persists spanishSelfReported / spanishVerified / licensedRN and audits them", async () => {
    const created = await createPersonRecord(ACTOR, {
      name: "Sam Onboard",
      spanishSelfReported: true,
      spanishVerified: false,
      licensedRN: true,
    });

    expect(created.spanishSelfReported).toBe(true);
    expect(created.spanishVerified).toBe(false);
    expect(created.licensedRN).toBe(true);
    // verified=false on create must not stamp the verifier/timestamp.
    expect(created.spanishVerifiedById).toBeNull();
    expect(created.spanishVerifiedAt).toBeNull();

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: "person.create", entityId: created.id },
    });
    const after = audit.after as Record<string, unknown>;
    expect(after.spanishSelfReported).toBe(true);
    expect(after.spanishVerified).toBe(false);
    expect(after.licensedRN).toBe(true);
  });

  it("createPersonRecord stamps verifier+timestamp when spanishVerified is true on create", async () => {
    const created = await createPersonRecord(ACTOR, { name: "Vee Verified", spanishVerified: true });
    expect(created.spanishVerified).toBe(true);
    expect(created.spanishVerifiedById).toBe(ACTOR);
    expect(created.spanishVerifiedAt).not.toBeNull();
  });

  it("updatePersonFields stamps verifier+timestamp when spanishVerified goes false->true", async () => {
    const p = await createPersonRecord(ACTOR, { name: "Up" });
    expect(p.spanishVerifiedAt).toBeNull();

    const u = await updatePersonFields(ACTOR, p.id, { spanishVerified: true });
    expect(u.spanishVerified).toBe(true);
    expect(u.spanishVerifiedById).toBe(ACTOR);
    expect(u.spanishVerifiedAt).not.toBeNull();
  });

  it("updatePersonFields clears verifier+timestamp when spanishVerified goes true->false", async () => {
    const p = await createPersonRecord(ACTOR, { name: "Down", spanishVerified: true });
    expect(p.spanishVerifiedAt).not.toBeNull();

    const u = await updatePersonFields(ACTOR, p.id, { spanishVerified: false });
    expect(u.spanishVerified).toBe(false);
    expect(u.spanishVerifiedAt).toBeNull();
    expect(u.spanishVerifiedById).toBeNull();
  });

  it("updatePersonFields editing only spanishSelfReported leaves the verified fields untouched", async () => {
    const p = await createPersonRecord(ACTOR, { name: "Stable", spanishVerified: true });
    const verifiedAt = p.spanishVerifiedAt;

    const u = await updatePersonFields(ACTOR, p.id, { spanishSelfReported: true });
    expect(u.spanishSelfReported).toBe(true);
    expect(u.spanishVerified).toBe(true);
    expect(u.spanishVerifiedAt).toEqual(verifiedAt);
    expect(u.spanishVerifiedById).toBe(ACTOR);
  });
});

describe("setPersonStatusField", () => {
  beforeEach(resetDb);

  it("audits person.offboard / person.reactivate", async () => {
    const person = await createPersonRecord(ACTOR, { name: "Status", netId: "st1" });
    await prisma.auditLog.deleteMany();

    await setPersonStatusField(ACTOR, person.id, "OFFBOARDED");
    let logs = await prisma.auditLog.findMany({ where: { entityId: person.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe("person.offboard");

    await prisma.auditLog.deleteMany();
    const reactivated = await setPersonStatusField(ACTOR, person.id, "ACTIVE");
    expect(reactivated.status).toBe("ACTIVE");
    logs = await prisma.auditLog.findMany({ where: { entityId: person.id } });
    expect(logs[0].action).toBe("person.reactivate");
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
