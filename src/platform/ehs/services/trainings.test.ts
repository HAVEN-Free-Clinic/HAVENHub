import { describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { createTraining, listTrainings, setTrainingDepartments } from "./trainings";
import { EhsValidationError } from "./errors";

describe("ehs trainings service", () => {
  it("rejects an empty name", async () => {
    await expect(createTraining({ name: "  " }, "actor1")).rejects.toBeInstanceOf(
      EhsValidationError
    );
  });

  it("creates a training with an auto-incremented position", async () => {
    const created = await createTraining({ name: "Test EHS item" }, "actor1");
    expect(created.position).toBeGreaterThanOrEqual(0);
    const rows = await listTrainings();
    expect(rows.some((r) => r.id === created.id)).toBe(true);
  });

  it("replaces department assignment transactionally", async () => {
    const t = await createTraining({ name: "Scoped item", requiredForAll: false }, "actor1");
    const dept = await prisma.department.findFirstOrThrow();
    await setTrainingDepartments(t.id, [dept.id], "actor1");
    const after = await prisma.ehsTrainingDepartment.findMany({ where: { trainingId: t.id } });
    expect(after.map((d: { departmentId: string }) => d.departmentId)).toEqual([dept.id]);
  });
});
