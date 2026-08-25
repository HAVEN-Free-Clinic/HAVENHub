import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { createTraining, listTrainings, setTrainingDepartments, updateTraining } from "./trainings";
import { EhsValidationError } from "./errors";

beforeEach(resetDb);
afterEach(resetDb);

describe("ehs trainings service", () => {
  it("rejects an empty name", async () => {
    await expect(createTraining({ name: "  " }, "any-actor-id")).rejects.toBeInstanceOf(
      EhsValidationError
    );
  });

  it("rejects a duplicate name with a friendly domain error", async () => {
    const actor = await prisma.person.create({ data: { name: "Actor", status: "ACTIVE" } });
    await createTraining({ name: "Duplicate item" }, actor.id);
    await expect(
      createTraining({ name: "Duplicate item" }, actor.id)
    ).rejects.toBeInstanceOf(EhsValidationError);
  });

  it("creates a training with an auto-incremented position", async () => {
    const actor = await prisma.person.create({ data: { name: "Actor", status: "ACTIVE" } });
    const created = await createTraining({ name: "Test EHS item" }, actor.id);
    expect(created.position).toBeGreaterThanOrEqual(0);
    const rows = await listTrainings();
    expect(rows.some((r) => r.id === created.id)).toBe(true);
  });

  it("stores a completion link and clears it back to the Workday default", async () => {
    const actor = await prisma.person.create({ data: { name: "Actor", status: "ACTIVE" } });
    const url = "https://healthontrack.yale.edu/s/chs-health-requirement/CHS_Health_Requirement__c/";
    const created = await createTraining({ name: "TB Baseline", completionUrl: url }, actor.id);
    expect((created as { completionUrl: string | null }).completionUrl).toBe(url);

    // An empty field means "no link of its own", not a stored empty string, so the
    // member-facing panel falls back to Workday rather than rendering href="".
    const cleared = await updateTraining(created.id, { name: "TB Baseline", completionUrl: "" }, actor.id);
    expect((cleared as { completionUrl: string | null }).completionUrl).toBeNull();
  });

  it("rejects a completion link that is not an http(s) URL", async () => {
    const actor = await prisma.person.create({ data: { name: "Actor", status: "ACTIVE" } });
    await expect(
      createTraining({ name: "Bad link", completionUrl: "healthontrack.yale.edu" }, actor.id)
    ).rejects.toBeInstanceOf(EhsValidationError);
    await expect(
      createTraining({ name: "Worse link", completionUrl: "javascript:alert(1)" }, actor.id)
    ).rejects.toBeInstanceOf(EhsValidationError);
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
