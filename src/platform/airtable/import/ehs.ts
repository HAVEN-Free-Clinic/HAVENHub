/**
 * Backfill EHS completions from Airtable's "Compliance" table.
 *
 * One-directional: data flows FROM Airtable into Postgres. Nothing is written
 * back to Airtable.
 */

import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import type { AirtableReader } from "./importer";
import {
  COMPLIANCE_NAMES_LINK_FIELD,
  EHS_CHECKBOX_FIELDS,
  ADDED_TO_EHS_FIELD,
} from "@/platform/airtable/fields";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type EhsBackfillReport = {
  imported: number;
  skippedExisting: number;
  unmatchedPeople: number;
  unknownTrainings: string[];
  addedToEhs: number;
};

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function backfillEhsCompletions(
  reader: AirtableReader,
  options: { baseId: string; complianceTableId: string; dryRun: boolean }
): Promise<EhsBackfillReport> {
  const report: EhsBackfillReport = {
    imported: 0,
    skippedExisting: 0,
    unmatchedPeople: 0,
    unknownTrainings: [],
    addedToEhs: 0,
  };

  // Resolve training names -> ids once. Cast result to a structural subset
  // because the stale Prisma client in this worktree may not have ehsTraining
  // typed yet; CI regenerates the client against the migrated schema.
  const trainings = (await prisma.ehsTraining.findMany({
    select: { id: true, name: true },
  })) as Array<{ id: string; name: string }>;

  const idByName = new Map(trainings.map((t) => [t.name, t.id]));
  for (const f of EHS_CHECKBOX_FIELDS) {
    if (!idByName.has(f.trainingName)) report.unknownTrainings.push(f.trainingName);
  }

  const records = await reader.listAll(options.baseId, options.complianceTableId);

  for (const record of records) {
    const link = record.fields[COMPLIANCE_NAMES_LINK_FIELD];
    const linkedId = Array.isArray(link) && link.length > 0 ? String(link[0]) : null;
    if (!linkedId) {
      report.unmatchedPeople++;
      continue;
    }

    const person = await prisma.person.findUnique({
      where: { airtableRecordId: linkedId },
      select: { id: true, addedToEhs: true },
    });
    if (!person) {
      report.unmatchedPeople++;
      continue;
    }

    // Sync the "Added to EHS?" flag when Airtable says true and the local record is false.
    if (record.fields[ADDED_TO_EHS_FIELD] === true && !person.addedToEhs) {
      if (!options.dryRun) {
        await prisma.person.update({ where: { id: person.id }, data: { addedToEhs: true } });
        await recordAudit({
          actorPersonId: null,
          action: "ehs.added_to_ehs_import",
          entityType: "Person",
          entityId: person.id,
          after: { addedToEhs: true },
        });
      }
      report.addedToEhs++;
    }

    for (const field of EHS_CHECKBOX_FIELDS) {
      if (record.fields[field.fieldId] !== true) continue;
      const trainingId = idByName.get(field.trainingName);
      if (!trainingId) continue;

      // Cast for the same stale-client reason as the training query above.
      const existing = (await prisma.ehsCompletion.findUnique({
        where: { personId_trainingId: { personId: person.id, trainingId } },
        select: { id: true },
      })) as { id: string } | null;

      if (existing) {
        report.skippedExisting++;
        continue;
      }
      if (options.dryRun) {
        report.imported++;
        continue;
      }

      const created = (await prisma.ehsCompletion.create({
        data: {
          personId: person.id,
          trainingId,
          source: "IMPORT",
          completedAt: null,
          markedById: null,
        },
      })) as { id: string };

      await recordAudit({
        actorPersonId: null,
        action: "ehs.completion_import",
        entityType: "EhsCompletion",
        entityId: created.id,
        after: { personId: person.id, trainingId, source: "IMPORT" },
      });
      report.imported++;
    }
  }

  return report;
}
