import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { MODULES } from "@/platform/modules/registry";
import {
  listAttendingSpecialties,
  getAttendingSpecialty,
  referenceCounts,
  createAttendingSpecialty,
  updateAttendingSpecialty,
  deleteAttendingSpecialty,
  AttendingSpecialtyConflictError,
  AttendingSpecialtyForbiddenError,
  AttendingSpecialtyInUseError,
  AttendingSpecialtyNotFoundError,
  AttendingSpecialtyValidationError,
  MANAGE_PERMISSION,
} from "./attending-specialties";

const ACTOR = "actor-1";

/**
 * Give a person schedule.manage_attendings, the permission already guarding the
 * attending roster. Mirrors the grant helper in
 * modules/schedule/services/attendings.test.ts: an unscoped RoleAssignment
 * (termId null), because attendings belong to no department and no term.
 */
async function grantManageAttendings(personId = ACTOR) {
  await prisma.person.upsert({
    where: { id: personId },
    update: {},
    create: { id: personId, name: "FCRL Director" },
  });
  const role = await prisma.role.create({
    data: {
      name: `r-${Date.now()}-${Math.random()}`,
      isSystem: false,
      grants: { create: [{ permission: MANAGE_PERMISSION }] },
    },
  });
  await prisma.roleAssignment.create({ data: { roleId: role.id, personId, termId: null } });
}

/** A signed-in person holding nothing. */
async function plainMember(name = "Volunteer") {
  return prisma.person.create({ data: { name } });
}

/** A term with one clinic date, so a ClinicDay can be attached to a specialty. */
async function termWithClinicDate() {
  return prisma.term.create({
    data: {
      code: "SU26",
      name: "Summer 2026",
      status: "ACTIVE",
      startDate: new Date("2026-05-01T12:00:00Z"),
      endDate: new Date("2026-08-31T12:00:00Z"),
      clinicDates: [new Date("2026-06-06T12:00:00Z")],
    },
  });
}

beforeEach(resetDb);

// ---------------------------------------------------------------------------
// Permission
// ---------------------------------------------------------------------------

describe("permission", () => {
  it("reuses the attending roster's permission rather than minting a new one", () => {
    // The whole point of this service is that specialties are the roster's
    // reference data, so a second permission would have to be granted alongside
    // schedule.manage_attendings forever. Pinning the string here means a rename
    // that misses one side fails a test instead of silently locking the page.
    expect(MANAGE_PERMISSION).toBe("schedule.manage_attendings");
    const schedule = MODULES.find((m) => m.id === "schedule")!;
    expect(schedule.permissions).toContain(MANAGE_PERMISSION);
  });

  it("refuses create, update and delete for an actor without schedule.manage_attendings", async () => {
    // Seeded by a permitted actor so the update/delete targets exist: the point
    // of the assertion is the refusal, not a missing row.
    await grantManageAttendings();
    const derm = await createAttendingSpecialty(ACTOR, { code: "DERM", name: "Dermatology" });

    const nobody = await plainMember("Nobody");

    await expect(
      createAttendingSpecialty(nobody.id, { code: "STER", name: "Steroid Clinic" })
    ).rejects.toBeInstanceOf(AttendingSpecialtyForbiddenError);
    await expect(
      updateAttendingSpecialty(nobody.id, derm.id, {
        name: "Renamed",
        runsSpecialtyClinic: true,
      })
    ).rejects.toBeInstanceOf(AttendingSpecialtyForbiddenError);
    await expect(deleteAttendingSpecialty(nobody.id, derm.id)).rejects.toBeInstanceOf(
      AttendingSpecialtyForbiddenError
    );

    // Refused, not half-done: the row is untouched and nothing new was created.
    expect(await prisma.attendingSpecialty.count()).toBe(1);
    expect((await getAttendingSpecialty(derm.id))?.name).toBe("Dermatology");
  });

  it("refuses before touching the database, so a bad actor cannot probe for row ids", async () => {
    const nobody = await plainMember("Nobody");
    await expect(deleteAttendingSpecialty(nobody.id, "does-not-exist")).rejects.toBeInstanceOf(
      AttendingSpecialtyForbiddenError
    );
  });
});

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

describe("createAttendingSpecialty", () => {
  it("uppercases the code, defaults the flags, and audits", async () => {
    await grantManageAttendings();
    const s = await createAttendingSpecialty(ACTOR, { code: "ster", name: "  Steroid Clinic  " });

    expect(s.code).toBe("STER");
    expect(s.name).toBe("Steroid Clinic");
    expect(s.runsSpecialtyClinic).toBe(false);
    expect(s.order).toBe(0);

    const audit = await prisma.auditLog.findFirst({
      where: { action: "attending_specialty.create", entityId: s.id },
    });
    expect(audit).toMatchObject({ entityType: "AttendingSpecialty", actorPersonId: ACTOR });
    expect(audit?.after).toMatchObject({ code: "STER", name: "Steroid Clinic", order: 0 });
  });

  it("stores runsSpecialtyClinic and order when given", async () => {
    await grantManageAttendings();
    const s = await createAttendingSpecialty(ACTOR, {
      code: "STER",
      name: "Steroid Clinic",
      runsSpecialtyClinic: true,
      order: 7,
    });
    expect(s.runsSpecialtyClinic).toBe(true);
    expect(s.order).toBe(7);
  });

  it("rejects a duplicate code, case-insensitively, naming the code", async () => {
    await grantManageAttendings();
    await createAttendingSpecialty(ACTOR, { code: "DERM", name: "Dermatology" });

    const err = await createAttendingSpecialty(ACTOR, {
      code: "derm",
      name: "Something Else",
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AttendingSpecialtyConflictError);
    expect((err as AttendingSpecialtyConflictError).field).toBe("code");
    // A readable message, not a raw Prisma P2002 leaking to the boundary.
    expect((err as Error).message).toContain("DERM");
    expect((err as Error).message).not.toContain("P2002");
    expect(await prisma.attendingSpecialty.count()).toBe(1);
  });

  it("rejects a duplicate name, case-insensitively, naming the name", async () => {
    await grantManageAttendings();
    await createAttendingSpecialty(ACTOR, { code: "DERM", name: "Dermatology" });

    const err = await createAttendingSpecialty(ACTOR, {
      code: "SKIN",
      name: "dermatology",
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AttendingSpecialtyConflictError);
    expect((err as AttendingSpecialtyConflictError).field).toBe("name");
  });

  it("rejects a bad code, an empty name, and a non-integer order", async () => {
    await grantManageAttendings();
    await expect(
      createAttendingSpecialty(ACTOR, { code: "a b!", name: "X" })
    ).rejects.toBeInstanceOf(AttendingSpecialtyValidationError);
    await expect(
      createAttendingSpecialty(ACTOR, { code: "OKAY", name: "   " })
    ).rejects.toBeInstanceOf(AttendingSpecialtyValidationError);
    // Number("abc") is NaN, which a ?? fallback in the form layer does not catch.
    await expect(
      createAttendingSpecialty(ACTOR, { code: "OKAY", name: "Fine", order: Number("abc") })
    ).rejects.toBeInstanceOf(AttendingSpecialtyValidationError);
  });
});

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

describe("updateAttendingSpecialty", () => {
  // `code` is deliberately NOT updatable: platform/attendings/import/roster.ts
  // keys its alias table on these exact codes, so a rename silently stops the
  // roster importer recognising the specialty.
  it("changes name, flag and order but leaves the code alone, and audits before/after", async () => {
    await grantManageAttendings();
    const s = await createAttendingSpecialty(ACTOR, { code: "STER", name: "Steroid" });

    const u = await updateAttendingSpecialty(ACTOR, s.id, {
      name: "Steroid Clinic",
      runsSpecialtyClinic: true,
      order: 9,
    });

    expect(u.code).toBe("STER");
    expect(u.name).toBe("Steroid Clinic");
    expect(u.runsSpecialtyClinic).toBe(true);
    expect(u.order).toBe(9);

    const audit = await prisma.auditLog.findFirst({
      where: { action: "attending_specialty.update", entityId: s.id },
    });
    expect(audit?.before).toMatchObject({ code: "STER", name: "Steroid", runsSpecialtyClinic: false });
    expect(audit?.after).toMatchObject({ code: "STER", name: "Steroid Clinic", runsSpecialtyClinic: true });
  });

  it("keeps its own code and name (an unchanged save is not a self-conflict)", async () => {
    await grantManageAttendings();
    const s = await createAttendingSpecialty(ACTOR, { code: "DERM", name: "Dermatology", order: 3 });
    const u = await updateAttendingSpecialty(ACTOR, s.id, {
      name: "Dermatology",
      runsSpecialtyClinic: true,
    });
    expect(u.runsSpecialtyClinic).toBe(true);
    // order omitted: preserved, not reset to 0.
    expect(u.order).toBe(3);
  });

  it("rejects taking another specialty's name", async () => {
    await grantManageAttendings();
    await createAttendingSpecialty(ACTOR, { code: "DERM", name: "Dermatology" });
    const neuro = await createAttendingSpecialty(ACTOR, { code: "NEURO", name: "Neurology" });

    await expect(
      updateAttendingSpecialty(ACTOR, neuro.id, {
        name: "Dermatology",
        runsSpecialtyClinic: true,
      })
    ).rejects.toBeInstanceOf(AttendingSpecialtyConflictError);
  });

  it("throws AttendingSpecialtyNotFoundError for a missing id", async () => {
    await grantManageAttendings();
    await expect(
      updateAttendingSpecialty(ACTOR, "nope", { name: "X", runsSpecialtyClinic: false })
    ).rejects.toBeInstanceOf(AttendingSpecialtyNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

describe("deleteAttendingSpecialty", () => {
  it("deletes an unreferenced specialty and audits the removed row", async () => {
    await grantManageAttendings();
    const s = await createAttendingSpecialty(ACTOR, { code: "STER", name: "Steroid Clinic" });

    await deleteAttendingSpecialty(ACTOR, s.id);

    expect(await getAttendingSpecialty(s.id)).toBeNull();
    const audit = await prisma.auditLog.findFirst({
      where: { action: "attending_specialty.delete", entityId: s.id },
    });
    expect(audit?.before).toMatchObject({ code: "STER", name: "Steroid Clinic" });
  });

  it("refuses when an attending still works in it, and does not blank the attending", async () => {
    await grantManageAttendings();
    const s = await createAttendingSpecialty(ACTOR, { code: "RHD", name: "Reproductive Health" });
    const attending = await prisma.attending.create({
      data: { scheduleName: "Peggy Bia", fullName: "Bia, Margaret", specialtyId: s.id },
    });

    const err = await deleteAttendingSpecialty(ACTOR, s.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AttendingSpecialtyInUseError);
    expect((err as Error).message).toContain("1 attending");
    expect((err as AttendingSpecialtyInUseError).counts).toMatchObject({ attendings: 1 });

    // Never cascade: Attending.specialtyId is onDelete SetNull, so a delete that
    // slipped through would have silently detached this attending instead of failing.
    expect(await getAttendingSpecialty(s.id)).not.toBeNull();
    const after = await prisma.attending.findUnique({ where: { id: attending.id } });
    expect(after?.specialtyId).toBe(s.id);
  });

  it("refuses when a capability question is scoped to it, and does not unscope the question", async () => {
    await grantManageAttendings();
    const s = await createAttendingSpecialty(ACTOR, { code: "RHD", name: "Reproductive Health" });
    const cap = await prisma.attendingCapability.create({
      data: { key: "iudIn", label: "IUD In", order: 0, specialtyId: s.id },
    });

    const err = await deleteAttendingSpecialty(ACTOR, s.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AttendingSpecialtyInUseError);
    expect((err as Error).message).toContain("1 capability question");

    // The dangerous one: SetNull here would turn a specialty-scoped question
    // into an unscoped one asked of the entire roster.
    const after = await prisma.attendingCapability.findUnique({ where: { id: cap.id } });
    expect(after?.specialtyId).toBe(s.id);
  });

  it("refuses when a clinic day names it as that date's specialty clinic", async () => {
    await grantManageAttendings();
    const s = await createAttendingSpecialty(ACTOR, {
      code: "DERM",
      name: "Dermatology",
      runsSpecialtyClinic: true,
    });
    const term = await termWithClinicDate();
    const day = await prisma.clinicDay.create({
      data: { termId: term.id, clinicDate: new Date("2026-06-06T12:00:00Z"), specialtyId: s.id },
    });

    const err = await deleteAttendingSpecialty(ACTOR, s.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AttendingSpecialtyInUseError);
    expect((err as Error).message).toContain("1 clinic day");

    const after = await prisma.clinicDay.findUnique({ where: { id: day.id } });
    expect(after?.specialtyId).toBe(s.id);
  });

  // Un-ticking the flag reaches the same data loss as deleting the row, just
  // more quietly: the day's Specialty Clinic select only offers specialties that
  // run one, so the stored id stops matching any option, the control falls back
  // to "None", and the next save of that day for any unrelated reason clears it.
  it("refuses to stop running a specialty clinic while a clinic day names it", async () => {
    await grantManageAttendings();
    const s = await createAttendingSpecialty(ACTOR, {
      code: "DERM",
      name: "Dermatology",
      runsSpecialtyClinic: true,
    });
    const term = await termWithClinicDate();
    const day = await prisma.clinicDay.create({
      data: { termId: term.id, clinicDate: new Date("2026-06-06T12:00:00Z"), specialtyId: s.id },
    });

    const err = await updateAttendingSpecialty(ACTOR, s.id, {
      name: "Dermatology",
      runsSpecialtyClinic: false,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AttendingSpecialtyInUseError);
    expect((err as Error).message).toContain("1 clinic day");

    // The flag and the day's assignment both survive the refusal.
    const unchanged = await prisma.attendingSpecialty.findUniqueOrThrow({ where: { id: s.id } });
    expect(unchanged.runsSpecialtyClinic).toBe(true);
    const after = await prisma.clinicDay.findUnique({ where: { id: day.id } });
    expect(after?.specialtyId).toBe(s.id);
  });

  it("allows turning the flag off once no clinic day names it", async () => {
    await grantManageAttendings();
    const s = await createAttendingSpecialty(ACTOR, {
      code: "DERM",
      name: "Dermatology",
      runsSpecialtyClinic: true,
    });

    const u = await updateAttendingSpecialty(ACTOR, s.id, {
      name: "Dermatology",
      runsSpecialtyClinic: false,
    });
    expect(u.runsSpecialtyClinic).toBe(false);
  });

  it("names every referencing kind at once, so one fix does not reveal the next", async () => {
    await grantManageAttendings();
    const s = await createAttendingSpecialty(ACTOR, { code: "RHD", name: "Reproductive Health" });
    await prisma.attending.create({
      data: { scheduleName: "A", fullName: "A", specialtyId: s.id },
    });
    await prisma.attendingCapability.create({
      data: { key: "iudIn", label: "IUD In", order: 0, specialtyId: s.id },
    });
    const term = await termWithClinicDate();
    await prisma.clinicDay.create({
      data: { termId: term.id, clinicDate: new Date("2026-06-06T12:00:00Z"), specialtyId: s.id },
    });

    const err = await deleteAttendingSpecialty(ACTOR, s.id).catch((e: unknown) => e);
    const message = (err as Error).message;
    expect(message).toContain("1 attending");
    expect(message).toContain("1 capability question");
    expect(message).toContain("1 clinic day");
    expect((err as AttendingSpecialtyInUseError).counts).toEqual({
      attendings: 1,
      capabilities: 1,
      clinicDays: 1,
    });

    // A refusal records nothing: the row survived, so there is no delete to audit.
    expect(await prisma.auditLog.count({ where: { action: "attending_specialty.delete" } })).toBe(0);
  });

  it("throws AttendingSpecialtyNotFoundError for a missing id", async () => {
    await grantManageAttendings();
    await expect(deleteAttendingSpecialty(ACTOR, "nope")).rejects.toBeInstanceOf(
      AttendingSpecialtyNotFoundError
    );
  });
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

describe("listAttendingSpecialties", () => {
  it("returns display order with the reference counts the list page renders", async () => {
    await grantManageAttendings();
    const derm = await createAttendingSpecialty(ACTOR, {
      code: "DERM",
      name: "Dermatology",
      order: 2,
    });
    await createAttendingSpecialty(ACTOR, { code: "PC", name: "Primary Care", order: 0 });
    await prisma.attending.create({
      data: { scheduleName: "Derm Doc", fullName: "Doc, Derm", specialtyId: derm.id },
    });

    const list = await listAttendingSpecialties();
    expect(list.map((s) => s.code)).toEqual(["PC", "DERM"]);
    expect(list[1]._count).toMatchObject({ attendings: 1, capabilities: 0, clinicDays: 0 });
  });

  it("orders ties by code so a shared order value is still stable", async () => {
    await grantManageAttendings();
    await createAttendingSpecialty(ACTOR, { code: "ZZZ", name: "Z", order: 1 });
    await createAttendingSpecialty(ACTOR, { code: "AAA", name: "A", order: 1 });
    const list = await listAttendingSpecialties();
    expect(list.map((s) => s.code)).toEqual(["AAA", "ZZZ"]);
  });
});

describe("referenceCounts", () => {
  it("counts zero for a fresh specialty", async () => {
    await grantManageAttendings();
    const s = await createAttendingSpecialty(ACTOR, { code: "STER", name: "Steroid Clinic" });
    expect(await referenceCounts(s.id)).toEqual({ attendings: 0, capabilities: 0, clinicDays: 0 });
  });
});
