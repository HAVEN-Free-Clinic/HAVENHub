import { describe, expect, it } from "vitest";
import { createTraining, listTrainings } from "./trainings";
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
});
