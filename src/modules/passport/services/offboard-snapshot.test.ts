import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { setPersonStatusField } from "@/platform/people";
import { getCredential } from "./credential";
import { computeServiceRecord } from "./service-record";

const ACTOR = "actor-person-id";

async function seedActiveMember() {
  const person = await prisma.person.create({ data: { name: "Ada Lovelace" } });
  const dept = await prisma.department.upsert({
    where: { code: "ITCM" },
    update: {},
    create: { code: "ITCM", name: "Internal Medicine" },
  });
  const term = await prisma.term.create({
    data: {
      code: "SU26",
      name: "Summer 2026",
      startDate: new Date("2026-05-01T12:00:00Z"),
      endDate: new Date("2026-08-31T12:00:00Z"),
      status: "ACTIVE",
    },
  });
  await prisma.termMembership.create({
    data: { personId: person.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER" },
  });
  return person;
}

describe("offboarding snapshots the service record first", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("captures the current term before the membership is flipped to REMOVED", async () => {
    const person = await seedActiveMember();

    await setPersonStatusField(ACTOR, person.id, "OFFBOARDED");

    // The membership really was removed ...
    const memberships = await prisma.termMembership.findMany({ where: { personId: person.id } });
    expect(memberships.every((m) => m.status === "REMOVED")).toBe(true);

    // ... and a live recomputation would now show nothing ...
    const live = await computeServiceRecord(person.id);
    expect(live.terms).toHaveLength(0);

    // ... but the snapshot taken during offboarding still has the final term.
    const credential = await getCredential(person.id);
    expect(credential!.record.terms).toHaveLength(1);
    expect(credential!.record.terms[0].termCode).toBe("SU26");
  });

  it("does not issue a credential when the status change is not an offboard", async () => {
    const person = await seedActiveMember();

    await setPersonStatusField(ACTOR, person.id, "ACTIVE");

    expect(await getCredential(person.id)).toBeNull();
  });
});
