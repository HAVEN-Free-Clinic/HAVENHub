import { describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { markEhsComplete, unmarkEhsComplete } from "./completion";
import { createTraining } from "./trainings";

describe("ehs completion service", () => {
  it("marks and then unmarks completion", async () => {
    const person = await prisma.person.findFirstOrThrow();
    const training = await createTraining({ name: "Completion test item" }, "actor1");

    await markEhsComplete(person.id, training.id, "actor1", new Date("2026-03-01"));
    const row = await prisma.ehsCompletion.findUnique({
      where: { personId_trainingId: { personId: person.id, trainingId: training.id } },
    });
    expect(row?.source).toBe("MANUAL");
    expect(row?.markedById).toBe("actor1");

    await unmarkEhsComplete(person.id, training.id, "actor1");
    const gone = await prisma.ehsCompletion.findUnique({
      where: { personId_trainingId: { personId: person.id, trainingId: training.id } },
    });
    expect(gone).toBeNull();
  });
});
