import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { recordSelfWithdrawal, buildSelfWithdrawalNote } from "./self-withdrawal";

beforeEach(resetDb);

/** A person who globally holds volunteers.manage_offboarding. */
async function createOffboardingManager(name: string, contactEmail: string) {
  const person = await prisma.person.create({ data: { name, contactEmail } });
  const role = await prisma.role.create({
    data: {
      name: `Offboarding ${name}`,
      grants: { create: [{ permission: "volunteers.manage_offboarding" }] },
    },
  });
  await prisma.roleAssignment.create({ data: { roleId: role.id, personId: person.id, termId: null } });
  return person;
}

async function createActiveTerm() {
  return prisma.term.create({
    data: {
      code: "SU26",
      name: "Summer 2026",
      startDate: new Date("2026-05-01"),
      endDate: new Date("2026-08-31"),
      status: "ACTIVE",
    },
  });
}

async function createDepartment(code: string) {
  return prisma.department.upsert({
    where: { code },
    update: {},
    create: { code, name: `${code} Department` },
  });
}

describe("buildSelfWithdrawalNote", () => {
  it("names the departments", () => {
    expect(buildSelfWithdrawalNote("MED, PCAR", null)).toBe(
      "Not volunteering this term (MED, PCAR)",
    );
  });

  it("appends a quoted reason when one was given", () => {
    expect(buildSelfWithdrawalNote("MED", "Graduating in May.")).toBe(
      'Not volunteering this term (MED) - "Graduating in May."',
    );
  });

  it("omits the parenthetical when there are no departments", () => {
    expect(buildSelfWithdrawalNote("", null)).toBe("Not volunteering this term");
  });
});

describe("recordSelfWithdrawal", () => {
  it("flags the member and notifies every offboarding manager", async () => {
    const term = await createActiveTerm();
    const m1 = await createOffboardingManager("Olive Ops", "olive@x.org");
    const m2 = await createOffboardingManager("Omar Ops", "omar@x.org");
    const member = await prisma.person.create({ data: { name: "Jane Doe" } });

    const count = await recordSelfWithdrawal(
      prisma,
      { id: member.id, name: member.name! },
      { departmentCodes: ["MED", "PCAR"], reason: "Graduating in May." },
    );

    expect(count).toBe(2);

    const flag = await prisma.offboardFlag.findUnique({
      where: { personId_termId: { personId: member.id, termId: term.id } },
    });
    expect(flag).not.toBeNull();
    expect(flag!.flaggedById).toBe(member.id);
    expect(flag!.note).toBe('Not volunteering this term (MED, PCAR) - "Graduating in May."');

    const notes = await prisma.notification.findMany({
      where: { type: "volunteers.self_withdrawal" },
    });
    expect(notes.map((n) => n.personId).sort()).toEqual([m1.id, m2.id].sort());
    for (const note of notes) {
      expect(note.body).toContain("Jane Doe");
      expect(note.link).toMatch(/\/volunteers\/offboarding$/);
    }
  });

  it("audits the flag it raises", async () => {
    const term = await createActiveTerm();
    await createOffboardingManager("Olive Ops", "olive@x.org");
    const member = await prisma.person.create({ data: { name: "Jane Doe" } });

    await recordSelfWithdrawal(
      prisma,
      { id: member.id, name: member.name! },
      { departmentCodes: ["MED"], reason: null },
    );

    const audit = await prisma.auditLog.findFirst({
      where: { action: "offboard.flag", actorPersonId: member.id },
    });
    expect(audit).not.toBeNull();
    const after = audit!.after as Record<string, unknown>;
    expect(after.termId).toBe(term.id);
    expect(after.self).toBe(true);
  });

  it("does NOT flag a member who keeps another active membership, but still notifies", async () => {
    const term = await createActiveTerm();
    const dept = await createDepartment("SRR");
    await createOffboardingManager("Olive Ops", "olive@x.org");
    const member = await prisma.person.create({ data: { name: "Dana Director" } });
    // A directorship they keep: offboarding them would strip it.
    await prisma.termMembership.create({
      data: { personId: member.id, termId: term.id, departmentId: dept.id, kind: "DIRECTOR", status: "ACTIVE" },
    });

    const count = await recordSelfWithdrawal(
      prisma,
      { id: member.id, name: member.name! },
      { departmentCodes: ["MED"], reason: null },
    );

    expect(count).toBe(1);
    const flag = await prisma.offboardFlag.findUnique({
      where: { personId_termId: { personId: member.id, termId: term.id } },
    });
    expect(flag).toBeNull();

    const note = await prisma.notification.findFirst({ where: { type: "volunteers.self_withdrawal" } });
    expect(note!.body).toContain("still");
  });

  it("keeps an existing flag and its note rather than overwriting it", async () => {
    const term = await createActiveTerm();
    const director = await createOffboardingManager("Olive Ops", "olive@x.org");
    const member = await prisma.person.create({ data: { name: "Jane Doe" } });
    await prisma.offboardFlag.create({
      data: { personId: member.id, termId: term.id, flaggedById: director.id, note: "Raised by their director." },
    });

    await recordSelfWithdrawal(
      prisma,
      { id: member.id, name: member.name! },
      { departmentCodes: ["MED"], reason: null },
    );

    const flag = await prisma.offboardFlag.findUnique({
      where: { personId_termId: { personId: member.id, termId: term.id } },
    });
    expect(flag!.flaggedById).toBe(director.id);
    expect(flag!.note).toBe("Raised by their director.");
  });

  it("returns 0 and writes nothing when there is no active term", async () => {
    await createOffboardingManager("Olive Ops", "olive@x.org");
    const member = await prisma.person.create({ data: { name: "Jane Doe" } });

    const count = await recordSelfWithdrawal(
      prisma,
      { id: member.id, name: member.name! },
      { departmentCodes: ["MED"], reason: null },
    );

    expect(count).toBe(0);
    expect(await prisma.offboardFlag.findMany()).toEqual([]);
    expect(await prisma.notification.findMany({ where: { type: "volunteers.self_withdrawal" } })).toEqual([]);
  });

  it("flags the member but returns 0 when nobody can process an offboard", async () => {
    const term = await createActiveTerm();
    const member = await prisma.person.create({ data: { name: "Jane Doe" } });

    const count = await recordSelfWithdrawal(
      prisma,
      { id: member.id, name: member.name! },
      { departmentCodes: ["MED"], reason: null },
    );

    expect(count).toBe(0);
    const flag = await prisma.offboardFlag.findUnique({
      where: { personId_termId: { personId: member.id, termId: term.id } },
    });
    expect(flag).not.toBeNull();
  });

  it("does not notify the member even when they are themselves an offboarding manager", async () => {
    await createActiveTerm();
    const other = await createOffboardingManager("Olive Ops", "olive@x.org");
    const selfManager = await createOffboardingManager("Sam Self", "sam@x.org");

    const count = await recordSelfWithdrawal(
      prisma,
      { id: selfManager.id, name: selfManager.name! },
      { departmentCodes: ["MED"], reason: null },
    );

    expect(count).toBe(1);
    const notes = await prisma.notification.findMany({ where: { type: "volunteers.self_withdrawal" } });
    expect(notes.map((n) => n.personId)).toEqual([other.id]);
  });
});
