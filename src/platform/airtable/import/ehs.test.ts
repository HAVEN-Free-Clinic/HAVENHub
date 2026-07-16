import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { backfillEhsCompletions } from "./ehs";
import {
  COMPLIANCE_TABLE_ID,
  COMPLIANCE_NAMES_LINK_FIELD,
  ADDED_TO_EHS_FIELD,
} from "@/platform/airtable/fields";

beforeEach(resetDb);

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

  it("imports completions for every linked person on a row, not just the first (audit #59)", async () => {
    const p1 = await prisma.person.create({ data: { name: "Ann", airtableRecordId: "recA" } });
    const p2 = await prisma.person.create({ data: { name: "Ben", airtableRecordId: "recB" } });
    await prisma.ehsTraining.create({ data: { name: "Chemical - Hazard Communication" } });

    const reader = {
      async listAll() {
        return [
          {
            id: "recCompliance2",
            fields: {
              [COMPLIANCE_NAMES_LINK_FIELD]: ["recA", "recB"],
              fldQgdujeCMk5dVVH: true, // Chemical - Hazard Communication checkbox
            },
          },
        ];
      },
    };

    await backfillEhsCompletions(reader, {
      baseId: "appkxTQ19GmaHgW1O",
      complianceTableId: COMPLIANCE_TABLE_ID,
      dryRun: false,
    });

    // Previously only recA (link[0]) was imported; recB got nothing.
    expect(await prisma.ehsCompletion.count({ where: { personId: p1.id } })).toBe(1);
    expect(await prisma.ehsCompletion.count({ where: { personId: p2.id } })).toBe(1);
  });
});
