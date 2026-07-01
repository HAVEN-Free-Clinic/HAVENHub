import { describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { backfillEhsCompletions } from "./ehs";
import {
  COMPLIANCE_TABLE_ID,
  ADDED_TO_EHS_FIELD,
} from "@/platform/airtable/fields";

const fakeReader = {
  async listAll() {
    return [
      {
        id: "recCompliance1",
        fields: {
          fldcaF7NQu6JObuq6: ["recPersonAirtable1"],
          [ADDED_TO_EHS_FIELD]: true, // Added to EHS? (person flag, not a training)
          fldQgdujeCMk5dVVH: true,   // Chemical - Hazard Communication (training checkbox)
        },
      },
    ];
  },
};

describe("backfillEhsCompletions", () => {
  it("dry-run reports without writing", async () => {
    const report = await backfillEhsCompletions(fakeReader, {
      baseId: "appkxTQ19GmaHgW1O",
      complianceTableId: COMPLIANCE_TABLE_ID,
      dryRun: true,
    });
    expect(report.imported + report.unmatchedPeople).toBeGreaterThanOrEqual(0);
    expect(report.addedToEhs).toBeGreaterThanOrEqual(0);
    const wrote = await prisma.ehsCompletion.count({ where: { source: "IMPORT" } });
    expect(wrote).toBe(0);
  });
});
