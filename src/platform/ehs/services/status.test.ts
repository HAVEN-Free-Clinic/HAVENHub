import { describe, expect, it } from "vitest";
import { getEhsDashboard } from "./status";

describe("getEhsDashboard", () => {
  it("returns active trainings and one row per active-term roster member", async () => {
    const dash = await getEhsDashboard();
    expect(Array.isArray(dash.trainings)).toBe(true);
    expect(Array.isArray(dash.rows)).toBe(true);
    for (const row of dash.rows) {
      expect(typeof row.addedToEhs).toBe("boolean");
      expect(row.cells.length).toBe(dash.trainings.length);
      for (const cell of row.cells) {
        expect(["COMPLETE", "MISSING"]).toContain(cell.state);
      }
    }
  });
});
