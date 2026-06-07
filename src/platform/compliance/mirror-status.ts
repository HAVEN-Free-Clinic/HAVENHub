/**
 * Compliance status mirror helpers.
 *
 * The clinic's Airtable "HIPAA Compliance Status" field is a singleSelect with
 * exactly two options: "Compliant" and "Not Compliant". Our richer computed
 * status collapses to "Compliant" only when COMPLIANT; every other status
 * (EXPIRING_SOON, EXPIRED, UNKNOWN_DATE, NO_CERTIFICATE) maps to "Not Compliant".
 *
 * computeMirrorStatus is the single source of that mapping, shared by the drain
 * (mirror.ts), the nightly reconcile (reconcile.ts), and the nightly refresh job
 * (refreshComplianceMirror below). Keeping it here avoids three copies of the
 * "newest cert + active term -> status -> two-option string" logic drifting apart.
 */

import { prisma } from "@/platform/db";
import { complianceStatus } from "./rules";
import type { MirroredHipaaStatus } from "@/platform/airtable/mirror-map";

export type { MirroredHipaaStatus };

/**
 * Compute the two-option Airtable status for a person from the current DB state:
 * their newest certificate (any kind) and the active term's end date.
 * Returns "Compliant" iff the computed status is COMPLIANT, else "Not Compliant".
 */
export async function computeMirrorStatus(personId: string): Promise<MirroredHipaaStatus> {
  const [cert, activeTerm] = await Promise.all([
    prisma.hipaaCertificate.findFirst({
      where: { personId },
      orderBy: { uploadedAt: "desc" },
    }),
    prisma.term.findFirst({
      where: { status: "ACTIVE" },
      orderBy: { startDate: "desc" },
    }),
  ]);

  const status = complianceStatus(
    cert ? { completionDate: cert.completionDate } : null,
    activeTerm?.endDate ?? null
  );

  return status === "COMPLIANT" ? "Compliant" : "Not Compliant";
}

/**
 * Nightly recompute. For every person who has ANY certificate OR an ACTIVE
 * membership in the active term, compute the current mirror status; when it
 * differs from the last asserted Person.mirroredHipaaStatus, enqueue a Person
 * outbox row (changedFields ["hipaaStatus"]) so the drain pushes it on the next
 * pass. Gating (mirror enabled, statusFieldId set) stays in the drain: this job
 * only enqueues, so disabling the mirror leaves the queue draining to no-ops.
 *
 * Skips enqueue when a PENDING Person outbox row already exists for that person
 * (the next drain will pick up the freshest computed status anyway).
 *
 * Returns the number of rows enqueued.
 */
export async function refreshComplianceMirror(): Promise<number> {
  const activeTerm = await prisma.term.findFirst({
    where: { status: "ACTIVE" },
    orderBy: { startDate: "desc" },
  });

  // Candidate set: anyone with a cert, plus anyone with an ACTIVE membership in
  // the active term. Union by person id.
  const candidateIds = new Set<string>();

  const withCerts = await prisma.hipaaCertificate.findMany({
    distinct: ["personId"],
    select: { personId: true },
  });
  for (const c of withCerts) candidateIds.add(c.personId);

  if (activeTerm) {
    const members = await prisma.termMembership.findMany({
      where: { termId: activeTerm.id, status: "ACTIVE" },
      distinct: ["personId"],
      select: { personId: true },
    });
    for (const m of members) candidateIds.add(m.personId);
  }

  if (candidateIds.size === 0) return 0;

  const people = await prisma.person.findMany({
    where: { id: { in: Array.from(candidateIds) } },
    select: { id: true, mirroredHipaaStatus: true },
  });

  // People with an already-PENDING Person outbox row are skipped (the drain will
  // recompute the freshest status when it processes the existing row).
  const pendingRows = await prisma.outbox.findMany({
    where: { entityType: "Person", status: "PENDING", entityId: { in: people.map((p) => p.id) } },
    select: { entityId: true },
  });
  const alreadyPending = new Set(pendingRows.map((r) => r.entityId));

  let enqueued = 0;
  for (const person of people) {
    if (alreadyPending.has(person.id)) continue;
    const computed = await computeMirrorStatus(person.id);
    if (computed === person.mirroredHipaaStatus) continue;
    await prisma.outbox.create({
      data: {
        entityType: "Person",
        entityId: person.id,
        operation: "upsert",
        changedFields: ["hipaaStatus"],
        status: "PENDING",
      },
    });
    enqueued++;
  }

  return enqueued;
}
