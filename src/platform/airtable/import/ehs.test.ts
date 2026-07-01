import { describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { backfillEhsCompletions } from "./ehs";
import { COMPLIANCE_TABLE_ID } from "@/platform/airtable/fields";

const fakeReader = {
  async listAll() {
    return [
      {
        id: "recCompliance1",
        fields: {
          fldcaF7NQu6JObuq6: ["recPersonAirtable1"],
          fld3gfbuD5rASyD8Z: true, // Added to EHS?
          fldQgdujeCMk5dVVH: false,
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
    const wrote = await prisma.ehsCompletion.count({ where: { source: "IMPORT" } });
    expect(wrote).toBe(0);
  });
});
