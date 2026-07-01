import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { createTraining, listTrainings, setTrainingDepartments } from "./trainings";
import { EhsValidationError } from "./errors";

beforeEach(resetDb);
afterEach(resetDb);

describe("ehs trainings service", () => {
  it("rejects an empty name", async () => {
    await expect(createTraining({ name: "  " }, "any-actor-id")).rejects.toBeInstanceOf(
      EhsValidationError
    );
  });

  it("creates a training with an auto-incremented position", async () => {
    const actor = await prisma.person.create({ data: { name: "Actor", status: "ACTIVE" } });
    const created = await createTraining({ name: "Test EHS item" }, actor.id);
    expect(created.position).toBeGreaterThanOrEqual(0);
    const rows = await listTrainings();
    expect(rows.some((r) => r.id === created.id)).toBe(true);
  });

  it("replaces department assignment transactionally", async () => {
    const actor = await prisma.person.create({ data: { name: "Actor", status: "ACTIVE" } });
    const dept = await prisma.department.create({ data: { code: "SCTP", name: "Street Care" } });
    const training = await createTraining({ name: "Scoped item", requiredForAll: false }, actor.id);
    await setTrainingDepartments(training.id, [dept.id], actor.id);

    const db = prisma as unknown as {
      ehsTrainingDepartment: {
        findMany: (args: { where: { trainingId: string } }) => Promise<{ departmentId: string }[]>;
      };
    };
    const after = await db.ehsTrainingDepartment.findMany({ where: { trainingId: training.id } });
    expect(after.map((d) => d.departmentId)).toEqual([dept.id]);
  });
});
