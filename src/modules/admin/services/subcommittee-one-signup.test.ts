import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  bulkAddMembers,
  joinSubcommittee,
  SubcommitteeSignupError,
} from "./subcommittee-members";

beforeEach(resetDb);
afterEach(resetDb);

/** A current volunteer (so canSelfSignup passes) and two open subcommittees. */
async function setup() {
  const term = await prisma.term.create({
    data: {
      code: "FA26",
      name: "Fall 2026",
      startDate: new Date("2026-09-01T00:00:00.000Z"),
      endDate: new Date("2026-12-31T00:00:00.000Z"),
      status: "ACTIVE",
    },
  });
  const dept = await prisma.department.create({ data: { code: "PCAR", name: "Primary Care" } });
  const volunteer = await prisma.person.create({
    data: { name: "Volunteer", netId: "vol001", status: "ACTIVE" },
  });
  await prisma.termMembership.create({
    data: { personId: volunteer.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" },
  });
  const admin = await prisma.person.create({ data: { name: "Admin", status: "ACTIVE" } });
  const crec = await prisma.subcommittee.create({ data: { name: "CREC", signupOpen: true } });
  const cqa = await prisma.subcommittee.create({ data: { name: "CQA", signupOpen: true } });
  return { volunteer, admin, crec, cqa };
}

const membershipsOf = (personId: string) =>
  prisma.subcommitteeMembership.count({ where: { personId } });

describe("one subcommittee per volunteer", () => {
  it("refuses a second self sign-up and names the one they are on", async () => {
    const { volunteer, crec, cqa } = await setup();
    await joinSubcommittee(volunteer.id, crec.id);

    await expect(joinSubcommittee(volunteer.id, cqa.id)).rejects.toThrow(SubcommitteeSignupError);
    await expect(joinSubcommittee(volunteer.id, cqa.id)).rejects.toThrow(/CREC/);
    expect(await membershipsOf(volunteer.id)).toBe(1);
  });

  it("does not count being a lead", async () => {
    const { volunteer, crec, cqa } = await setup();
    await prisma.subcommitteeMembership.create({
      data: { subcommitteeId: crec.id, personId: volunteer.id, role: "LEAD", source: "STAFF" },
    });

    await joinSubcommittee(volunteer.id, cqa.id);
    expect(await membershipsOf(volunteer.id)).toBe(2);
  });

  it("still lets staff add someone to a second subcommittee", async () => {
    const { volunteer, admin, crec, cqa } = await setup();
    await joinSubcommittee(volunteer.id, crec.id);

    await bulkAddMembers(admin.id, cqa.id, ["vol001"], "MEMBER");
    expect(await membershipsOf(volunteer.id)).toBe(2);
  });

  it("ignores a membership on a subcommittee that is no longer offered", async () => {
    const { volunteer, crec, cqa } = await setup();
    await joinSubcommittee(volunteer.id, crec.id);
    await prisma.subcommittee.update({ where: { id: crec.id }, data: { isActive: false } });

    await joinSubcommittee(volunteer.id, cqa.id);
    expect(await membershipsOf(volunteer.id)).toBe(2);
  });
});