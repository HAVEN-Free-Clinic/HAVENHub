import type { Prisma } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { personMirrorPayload } from "./mirror-map";
import { computeMirrorStatus } from "@/platform/compliance/mirror-status";
import type { AirtableWriter, MirrorTarget } from "./mirror";

export type AirtableReader = {
  listAll(baseId: string, tableId: string): Promise<Array<{ id: string; fields: Record<string, unknown> }>>;
};

/** Nightly: rewrite Airtable to match Postgres for owned fields; audit drift. */
export async function reconcilePeople(
  io: AirtableReader & AirtableWriter,
  target: MirrorTarget
): Promise<number> {
  if (!target.enabled) return 0;

  const remote = new Map(
    (await io.listAll(target.baseId, target.peopleTableId)).map((r) => [r.id, r.fields])
  );
  const mappings = await prisma.mirrorRecord.findMany({
    where: { entityType: "Person", baseId: target.baseId },
  });

  // Comparison assumes the raw REST API shape: singleSelect fields arrive as
  // plain strings. Do not swap the read path to a surface that returns
  // {id, name, color} objects, or every select field will appear drifted.
  let corrected = 0;
  for (const mapping of mappings) {
    const person = await prisma.person.findUnique({ where: { id: mapping.entityId } });
    const fields = remote.get(mapping.recordId);
    if (!person || !fields) continue; // deletions are handled at cutover, not nightly
    // Include the HIPAA compliance status only when this target asserts it, computed
    // the same way as the drain (newest cert + active term -> two-option string).
    const hipaaStatus = target.statusFieldId ? await computeMirrorStatus(person.id) : null;
    const desired = personMirrorPayload(person, target.fieldMap, {
      statusFieldId: target.statusFieldId,
      hipaaStatus,
    });
    const drifted: Record<string, unknown> = {};
    const before: Record<string, unknown> = {};
    for (const [fieldId, value] of Object.entries(desired)) {
      const current = fields[fieldId] ?? "";
      if (String(current) !== String(value)) {
        drifted[fieldId] = value;
        before[fieldId] = current;
      }
    }
    if (Object.keys(drifted).length === 0) continue;
    await io.patchRecord(target.baseId, target.peopleTableId, mapping.recordId, drifted);
    await recordAudit({
      action: "mirror.drift_corrected",
      entityType: "Person",
      entityId: person.id,
      before: before as Prisma.InputJsonValue,
      after: drifted as Prisma.InputJsonValue,
    });
    corrected++;
  }
  return corrected;
}
