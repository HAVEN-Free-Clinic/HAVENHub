import { cache } from "react";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { manageableScheduleDepartmentIds } from "./builder";

/** Publish is not allowed for this term/department (out of scope, or a non-PLANNING term). */
export class PublicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicationError";
  }
}

async function assertPublishable(actorId: string, termId: string, departmentId: string): Promise<void> {
  const term = await prisma.term.findUnique({ where: { id: termId } });
  if (!term) throw new PublicationError("Unknown term.");
  // Publishing only makes sense for a next (PLANNING) term: the live term is always
  // visible to members, and an archived term is read-only.
  if (term.status !== "PLANNING") {
    throw new PublicationError("Only a next (planning) term's schedule can be published.");
  }
  const manageable = await manageableScheduleDepartmentIds(actorId);
  if (!manageable.includes(departmentId)) {
    throw new PublicationError("You do not manage this department.");
  }
}

/** Publish a department's schedule for a next term (create the row; idempotent). Audited. */
export async function publishSchedule(actorId: string, opts: { termId: string; departmentId: string }): Promise<void> {
  await assertPublishable(actorId, opts.termId, opts.departmentId);
  await prisma.schedulePublication.upsert({
    where: { termId_departmentId: { termId: opts.termId, departmentId: opts.departmentId } },
    create: { termId: opts.termId, departmentId: opts.departmentId, publishedById: actorId },
    update: {},
  });
  await recordAudit({
    actorPersonId: actorId,
    action: "schedule.publish",
    entityType: "SchedulePublication",
    entityId: `${opts.termId}|${opts.departmentId}`,
    after: { termId: opts.termId, departmentId: opts.departmentId },
  });
}

/** Unpublish a department's next-term schedule (delete the row). Idempotent. Audited. */
export async function unpublishSchedule(actorId: string, opts: { termId: string; departmentId: string }): Promise<void> {
  await assertPublishable(actorId, opts.termId, opts.departmentId);
  await prisma.schedulePublication.deleteMany({ where: { termId: opts.termId, departmentId: opts.departmentId } });
  await recordAudit({
    actorPersonId: actorId,
    action: "schedule.unpublish",
    entityType: "SchedulePublication",
    entityId: `${opts.termId}|${opts.departmentId}`,
    before: { termId: opts.termId, departmentId: opts.departmentId },
  });
}

/** Department ids with a currently-published schedule for the term. Memoized per request. */
export const publishedDepartmentIds = cache(async (termId: string): Promise<Set<string>> => {
  const rows = await prisma.schedulePublication.findMany({ where: { termId }, select: { departmentId: true } });
  return new Set(rows.map((r) => r.departmentId));
});

/** Whether a specific (term, department) schedule is currently published. */
export async function isPublished(termId: string, departmentId: string): Promise<boolean> {
  return (await prisma.schedulePublication.count({ where: { termId, departmentId } })) > 0;
}
