import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { markEhsComplete, unmarkEhsComplete } from "./completion";
import { createTraining } from "./trainings";

beforeEach(resetDb);
afterEach(resetDb);

describe("ehs completion service", () => {
  it("marks and then unmarks completion", async () => {
    const actor = await prisma.person.create({ data: { name: "Actor", status: "ACTIVE" } });
    const person = await prisma.person.create({ data: { name: "Volunteer", status: "ACTIVE" } });
    const training = await createTraining({ name: "Completion test item" }, actor.id);

    await markEhsComplete(person.id, training.id, actor.id, new Date("2026-03-01"));
    const row = await prisma.ehsCompletion.findUnique({
      where: { personId_trainingId: { personId: person.id, trainingId: training.id } },
    });
    expect(row?.source).toBe("MANUAL");
    expect(row?.markedById).toBe(actor.id);

    await unmarkEhsComplete(person.id, training.id, actor.id);
    const gone = await prisma.ehsCompletion.findUnique({
      where: { personId_trainingId: { personId: person.id, trainingId: training.id } },
    });
    expect(gone).toBeNull();
  });
});
