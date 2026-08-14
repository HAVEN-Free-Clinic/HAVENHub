import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  createAttending,
  updateAttending,
  getAttending,
  listAttendings,
  canManageAttendings,
  capabilitiesForSpecialty,
  capabilitiesFromFormData,
  attendingSchedule,
  coverageForDate,
  AttendingValidationError,
  AttendingForbiddenError,
} from "./attendings";

const ACTOR = "actor-1";

/**
 * The clinic's reference data, as the seed provisions it.
 *
 * Specialties, the schedule's columns, and the questions asked are all
 * CLINIC-WIDE: there is one roster and one schedule, so none of this hangs off
 * a department.
 */
async function seedReference() {
  const rhd = await prisma.attendingSpecialty.create({
    data: { code: "RHD", name: "Reproductive Health", order: 1 },
  });
  const pc = await prisma.attendingSpecialty.create({
    data: { code: "PC", name: "Primary Care", order: 0 },
  });
  const derm = await prisma.attendingSpecialty.create({
    data: { code: "DERM", name: "Dermatology", runsSpecialtyClinic: true, order: 3 },
  });

  const morning = await prisma.clinicSlot.create({
    data: { label: "9am-12pm", startTime: "09:00", endTime: "12:00", order: 0, allowsMultiple: true },
  });
  const midday = await prisma.clinicSlot.create({
    data: { label: "11am-2pm", startTime: "11:00", endTime: "14:00", order: 1 },
  });
  const rhdSlot = await prisma.clinicSlot.create({
    data: { label: "RHD Attending", startTime: "09:00", endTime: "13:00", order: 2 },
  });

  // Scoped: only reproductive health is asked about IUDs.
  const iudIn = await prisma.attendingCapability.create({
    data: { key: "iudIn", label: "IUD In", order: 0, specialtyId: rhd.id },
  });
  // Unscoped: asked of everyone, mirroring "can sign GAC" spanning specialties.
  const gac = await prisma.attendingCapability.create({
    data: { key: "gac", label: "GAC", order: 1 },
  });

  return { rhd, pc, derm, morning, midday, rhdSlot, iudIn, gac };
}

/** Give ACTOR the permission that maintains attendings. */
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
      grants: { create: [{ permission: "schedule.manage_attendings" }] },
    },
  });
  await prisma.roleAssignment.create({ data: { roleId: role.id, personId, termId: null } });
}

/** A person with schedule access but no attending rights. */
async function plainMember(name = "Volunteer") {
  return prisma.person.create({ data: { name } });
}

async function activeTerm(dateKeys: string[]) {
  return prisma.term.create({
    data: {
      code: "SU26",
      name: "Summer 2026",
      status: "ACTIVE",
      startDate: new Date("2026-05-01T12:00:00Z"),
      endDate: new Date("2026-08-31T12:00:00Z"),
      clinicDates: dateKeys.map((k) => new Date(`${k}T12:00:00Z`)),
    },
  });
}

beforeEach(resetDb);

/**
 * Maintaining attendings is ONE unscoped permission, held by Faculty Relations.
 *
 * It used to be "directs a department that manages another department", which
 * meant every clinical team's director could rewrite the roster, and an
 * oversight-only pair became a clinic line by accident.
 */
describe("canManageAttendings", () => {
  it("is true for a permission holder", async () => {
    await grantManageAttendings();
    expect(await canManageAttendings(ACTOR)).toBe(true);
  });

  it("is false for a member without it, however many departments they direct", async () => {
    const term = await prisma.term.create({
      data: { code: "FA26", name: "Fall", startDate: new Date(), endDate: new Date(), status: "ACTIVE" },
    });
    const dept = await prisma.department.create({ data: { code: "SCTS", name: "SCTS Dept" } });
    const managed = await prisma.department.create({ data: { code: "JCTS", name: "JCTS Dept" } });
    await prisma.departmentDelegation.create({
      data: { managerDepartmentId: dept.id, managedDepartmentId: managed.id },
    });
    const director = await plainMember("SCTS Director");
    await prisma.termMembership.create({
      data: { personId: director.id, termId: term.id, departmentId: dept.id, kind: "DIRECTOR", status: "ACTIVE" },
    });

    expect(await canManageAttendings(director.id)).toBe(false);
  });
});

describe("roster", () => {
  it("creates an attending with contact details and a specialty", async () => {
    await grantManageAttendings();
    const { rhd } = await seedReference();

    const created = await createAttending(ACTOR, {
      scheduleName: "Peggy Bia",
      fullName: "Bia, Margaret",
      credentials: "MD",
      specialtyId: rhd.id,
      email: "margaret.bia@yale.edu",
      phone: "2033142234",
    });

    expect(created.scheduleName).toBe("Peggy Bia");
    expect(created.fullName).toBe("Bia, Margaret");
    expect(created.credentials).toBe("MD");
    expect(created.email).toBe("margaret.bia@yale.edu");
    expect(created.isActive).toBe(true);
  });

  it("refuses an actor without the permission", async () => {
    const { rhd } = await seedReference();
    const nobody = await plainMember("Nobody");
    await expect(
      createAttending(nobody.id, { scheduleName: "X", fullName: "X", specialtyId: rhd.id }),
    ).rejects.toBeInstanceOf(AttendingForbiddenError);
  });

  it("rejects a duplicate schedule name", async () => {
    await grantManageAttendings();
    await seedReference();
    await createAttending(ACTOR, { scheduleName: "Peggy Bia", fullName: "Bia, Margaret" });
    await expect(
      createAttending(ACTOR, { scheduleName: "Peggy Bia", fullName: "Someone Else" }),
    ).rejects.toBeInstanceOf(AttendingValidationError);
  });

  it("deactivates rather than deleting, and keeps them in the roster", async () => {
    await grantManageAttendings();
    await seedReference();
    const a = await createAttending(ACTOR, { scheduleName: "Retired", fullName: "Dr. Retired" });

    await updateAttending(ACTOR, a.id, { isActive: false });

    const all = await listAttendings();
    expect(all.map((x) => x.scheduleName)).toContain("Retired");
    expect(all.find((x) => x.id === a.id)?.isActive).toBe(false);
    // Active-only is what the schedule's assignable list uses.
    expect((await listAttendings({ activeOnly: true })).map((x) => x.id)).not.toContain(a.id);
  });
});

/**
 * Which questions an attending is asked follows their SPECIALTY.
 *
 * The six procedure columns used to sit on every attending regardless, so a
 * dermatologist carried an "IUD In" field defaulted to unknown.
 */
describe("capabilities follow the specialty", () => {
  it("asks a scoped question only of that specialty, and unscoped ones of everyone", async () => {
    const { rhd, pc, iudIn, gac } = await seedReference();

    expect((await capabilitiesForSpecialty(rhd.id)).map((c) => c.id).sort()).toEqual(
      [iudIn.id, gac.id].sort(),
    );
    expect((await capabilitiesForSpecialty(pc.id)).map((c) => c.id)).toEqual([gac.id]);
    // No specialty at all still gets the unscoped questions, not all of them.
    expect((await capabilitiesForSpecialty(null)).map((c) => c.id)).toEqual([gac.id]);
  });

  it("stores answers the specialty asks and drops the ones it does not", async () => {
    await grantManageAttendings();
    const { pc, iudIn, gac } = await seedReference();

    const a = await createAttending(ACTOR, {
      scheduleName: "Atlas",
      fullName: "Atlas, Stephen",
      specialtyId: pc.id,
      // iudIn is not asked of primary care: a crafted post must not attach it.
      capabilities: { [iudIn.id]: "yes", [gac.id]: "yes" },
    });

    const loaded = await getAttending(a.id);
    expect(loaded?.capabilityValues[gac.id]).toBe("yes");
    expect(loaded?.capabilityValues[iudIn.id]).toBeUndefined();
  });

  it("validates answers against the specialty being SAVED, not the previous one", async () => {
    await grantManageAttendings();
    const { rhd, pc, iudIn } = await seedReference();
    const a = await createAttending(ACTOR, {
      scheduleName: "Mover",
      fullName: "Dr. Mover",
      specialtyId: rhd.id,
      capabilities: { [iudIn.id]: "yes" },
    });
    expect((await getAttending(a.id))?.capabilityValues[iudIn.id]).toBe("yes");

    // Moving to primary care in the same edit must drop the RHD-only answer.
    await updateAttending(ACTOR, a.id, { specialtyId: pc.id, capabilities: { [iudIn.id]: "yes" } });

    expect((await getAttending(a.id))?.capabilityValues[iudIn.id]).toBeUndefined();
  });

  it("treats a missing answer as absent, so an attending asked nothing still saves", async () => {
    await grantManageAttendings();
    const { derm } = await seedReference();

    const created = await createAttending(ACTOR, {
      scheduleName: "Haynes",
      fullName: "Haynes, Starling",
      specialtyId: derm.id,
      capabilities: capabilitiesFromFormData(new FormData()),
    });

    expect(created.scheduleName).toBe("Haynes");
    expect((await getAttending(created.id))?.capabilityValues).toEqual({});
  });

  it("clears an answer set back to unknown", async () => {
    await grantManageAttendings();
    const { rhd, iudIn } = await seedReference();
    const a = await createAttending(ACTOR, {
      scheduleName: "Rivera",
      fullName: "Rivera, Nina",
      specialtyId: rhd.id,
      capabilities: { [iudIn.id]: "yes" },
    });

    await updateAttending(ACTOR, a.id, { capabilities: { [iudIn.id]: "unknown" } });

    expect((await getAttending(a.id))?.capabilityValues[iudIn.id]).toBeUndefined();
  });

  it("rejects a value that is not yes, no, or unknown", async () => {
    await grantManageAttendings();
    const { rhd, iudIn } = await seedReference();
    await expect(
      createAttending(ACTOR, {
        scheduleName: "Bad",
        fullName: "Dr. Bad",
        specialtyId: rhd.id,
        capabilities: { [iudIn.id]: "maybe" as never },
      }),
    ).rejects.toBeInstanceOf(AttendingValidationError);
  });
});

describe("capabilitiesFromFormData", () => {
  it("reads only capability fields, keyed by id", () => {
    const fd = new FormData();
    fd.set("scheduleName", "Rivera");
    fd.set("capability:cap-1", "yes");
    fd.set("capability:cap-2", "unknown");
    expect(capabilitiesFromFormData(fd)).toEqual({ "cap-1": "yes", "cap-2": "unknown" });
  });
});

describe("attendingSchedule", () => {
  it("returns one row per clinic date with an entry per column", async () => {
    await seedReference();
    await activeTerm(["2026-05-30", "2026-06-06"]);

    const schedule = await attendingSchedule();

    expect(schedule.rows.map((r) => r.dateKey)).toEqual(["2026-05-30", "2026-06-06"]);
    // Columns come from the clinic's slots, so an unscheduled date still has a
    // cell to fill for every one of them.
    expect(schedule.rows[0].slots).toHaveLength(3);
    expect(schedule.slots.map((s) => s.label)).toEqual(["9am-12pm", "11am-2pm", "RHD Attending"]);
  });

  // The defect the whole remodel exists to fix: the 9am-12pm column really is
  // covered by two attendings, which the old one-per-slot key could not express.
  it("carries two attendings in one slot on one date", async () => {
    await grantManageAttendings();
    const { morning } = await seedReference();
    const term = await activeTerm(["2026-05-30"]);
    const peggy = await createAttending(ACTOR, { scheduleName: "Peggy Bia", fullName: "Bia, Margaret" });
    const frank = await createAttending(ACTOR, { scheduleName: "Frank Bia", fullName: "Bia, Frank" });

    await prisma.clinicDay.create({
      data: {
        termId: term.id,
        clinicDate: new Date("2026-05-30T12:00:00Z"),
        attendings: {
          create: [
            { slotId: morning.id, attendingId: peggy.id, order: 0 },
            { slotId: morning.id, attendingId: frank.id, order: 1 },
          ],
        },
      },
    });

    const cell = (await attendingSchedule()).rows[0].slots.find((s) => s.slotId === morning.id);
    expect(cell?.attendings.map((a) => a.scheduleName)).toEqual(["Peggy Bia", "Frank Bia"]);
  });

  it("carries the on-call attending, who covers the week AFTER this date", async () => {
    await grantManageAttendings();
    await seedReference();
    const term = await activeTerm(["2026-05-30"]);
    const peng = await createAttending(ACTOR, { scheduleName: "Jack Peng", fullName: "Peng, Bo" });

    await prisma.clinicDay.create({
      data: {
        termId: term.id,
        clinicDate: new Date("2026-05-30T12:00:00Z"),
        onCallAttendingId: peng.id,
      },
    });

    const row = (await attendingSchedule()).rows[0];
    expect(row.onCallAttendingId).toBe(peng.id);
    expect(row.onCallName).toBe("Jack Peng");
  });

  it("marks a closed date rather than showing it as an unstaffed gap", async () => {
    await seedReference();
    const term = await activeTerm(["2026-07-04"]);
    await prisma.clinicDay.create({
      data: {
        termId: term.id,
        clinicDate: new Date("2026-07-04T12:00:00Z"),
        isClosed: true,
        closedNote: "HAVEN FREE CLINIC CLOSED",
      },
    });

    const row = (await attendingSchedule()).rows[0];
    expect(row.isClosed).toBe(true);
    expect(row.closedNote).toBe("HAVEN FREE CLINIC CLOSED");
  });

  it("reads a deactivated attending as unset while keeping the raw id", async () => {
    await grantManageAttendings();
    const { rhdSlot } = await seedReference();
    const term = await activeTerm(["2026-05-30"]);
    const gone = await createAttending(ACTOR, { scheduleName: "Dr. Gone", fullName: "Dr. Gone" });
    await updateAttending(ACTOR, gone.id, { isActive: false });

    await prisma.clinicDay.create({
      data: {
        termId: term.id,
        clinicDate: new Date("2026-05-30T12:00:00Z"),
        attendings: { create: [{ slotId: rhdSlot.id, attendingId: gone.id }] },
      },
    });

    const cell = (await attendingSchedule()).rows[0].slots.find((s) => s.slotId === rhdSlot.id);
    // The editor still round-trips the value, so saving the row cannot silently
    // clear an assignment the select could not represent.
    expect(cell?.attendings[0]?.id).toBe(gone.id);
    expect(cell?.attendings[0]?.isActive).toBe(false);
  });

  it("distinguishes no active term, no clinic dates, and no columns", async () => {
    // No term at all.
    expect((await attendingSchedule()).emptyReason).toBe("no-active-term");

    await seedReference();
    const term = await activeTerm([]);
    expect((await attendingSchedule()).emptyReason).toBe("no-clinic-dates");

    await prisma.term.update({
      where: { id: term.id },
      data: { clinicDates: [new Date("2026-05-30T12:00:00Z")] },
    });
    await prisma.clinicSlot.deleteMany({});
    expect((await attendingSchedule()).emptyReason).toBe("no-slots");
  });
});

describe("coverageForDate", () => {
  it("groups the day's attendings by column, in schedule order", async () => {
    await grantManageAttendings();
    const { morning, rhdSlot } = await seedReference();
    const term = await activeTerm(["2026-05-30"]);
    const peggy = await createAttending(ACTOR, { scheduleName: "Peggy Bia", fullName: "Bia, Margaret" });
    const frank = await createAttending(ACTOR, { scheduleName: "Frank Bia", fullName: "Bia, Frank" });
    const finch = await createAttending(ACTOR, { scheduleName: "Finch", fullName: "Finch, Danielle" });

    const clinicDate = new Date("2026-05-30T12:00:00Z");
    await prisma.clinicDay.create({
      data: {
        termId: term.id,
        clinicDate,
        attendings: {
          create: [
            { slotId: morning.id, attendingId: peggy.id, order: 0 },
            { slotId: morning.id, attendingId: frank.id, order: 1 },
            { slotId: rhdSlot.id, attendingId: finch.id },
          ],
        },
      },
    });

    expect(await coverageForDate(term.id, clinicDate)).toEqual([
      { slotLabel: "9am-12pm", startTime: "09:00", endTime: "12:00", attendings: ["Peggy Bia", "Frank Bia"] },
      { slotLabel: "RHD Attending", startTime: "09:00", endTime: "13:00", attendings: ["Finch"] },
    ]);
  });

  it("reports nothing for a closed date", async () => {
    await grantManageAttendings();
    const { morning } = await seedReference();
    const term = await activeTerm(["2026-07-04"]);
    const a = await createAttending(ACTOR, { scheduleName: "Someone", fullName: "Someone" });
    const clinicDate = new Date("2026-07-04T12:00:00Z");
    await prisma.clinicDay.create({
      data: {
        termId: term.id,
        clinicDate,
        isClosed: true,
        attendings: { create: [{ slotId: morning.id, attendingId: a.id }] },
      },
    });

    expect(await coverageForDate(term.id, clinicDate)).toEqual([]);
  });
});
