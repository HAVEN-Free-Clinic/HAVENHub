import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { getMyEhsStatus } from "./my-ehs";
import { createTraining, setTrainingDepartments } from "./trainings";
import { WORKDAY_LEARNING_URL, HEALTH_ON_TRACK_URL } from "@/platform/external-links";

beforeEach(resetDb);
afterEach(resetDb);

async function buildMember() {
  const actor = await prisma.person.create({ data: { name: "Admin", status: "ACTIVE" } });
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
  const person = await prisma.person.create({ data: { name: "Volunteer", status: "ACTIVE" } });
  await prisma.termMembership.create({
    data: { personId: person.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" },
  });
  return { actor, term, dept, person };
}

describe("getMyEhsStatus", () => {
  it("carries each item's description and its own completion link", async () => {
    const { actor, dept, person, term } = await buildMember();
    const hepb = await createTraining(
      {
        name: "HepB Immunity Assessment",
        description: "Part of the Bloodborne Pathogens (BBP) requirement.",
        completionUrl: HEALTH_ON_TRACK_URL,
      },
      actor.id
    );
    await setTrainingDepartments(hepb.id, [dept.id], actor.id);

    const items = await getMyEhsStatus(person.id, term.id);
    const item = items.find((i) => i.id === hepb.id);

    expect(item).toBeDefined();
    expect(item!.description).toBe("Part of the Bloodborne Pathogens (BBP) requirement.");
    // The whole point: this one is done in HealthOnTrack, not Workday.
    expect(item!.completionUrl).toBe(HEALTH_ON_TRACK_URL);
  });

  it("keeps a Workday course pointed at Workday", async () => {
    const { actor, dept, person, term } = await buildMember();
    const course = await createTraining(
      { name: "Chemical - Hazard Communication", completionUrl: WORKDAY_LEARNING_URL },
      actor.id
    );
    await setTrainingDepartments(course.id, [dept.id], actor.id);

    const items = await getMyEhsStatus(person.id, term.id);

    expect(items.find((i) => i.id === course.id)!.completionUrl).toBe(WORKDAY_LEARNING_URL);
  });

  it("leaves a coordinator-recorded item with no link, so it gets no misleading CTA", async () => {
    const { actor, dept, person, term } = await buildMember();
    const flag = await createTraining({ name: "Added to EHS?" }, actor.id);
    await setTrainingDepartments(flag.id, [dept.id], actor.id);

    const items = await getMyEhsStatus(person.id, term.id);

    expect(items.find((i) => i.id === flag.id)!.completionUrl).toBeNull();
  });
});
