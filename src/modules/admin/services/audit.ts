/**
 * Audit service: query-only. No mutations here; audit writes go through
 * platform/audit.ts (recordAudit).
 *
 * Permission checks are NOT this service's concern -- pages gate via
 * requirePermission. The service trusts its callers and stays testable.
 */

import type { AuditLog } from "@prisma/client";
import { prisma } from "@/platform/db";

export type AuditRow = AuditLog & {
  /** Resolved from Person table; null when actor is "system" or person was deleted. */
  actorName: string | null;
};

export type AuditQuery = {
  action?: string;
  entityType?: string;
  page?: number;
  pageSize?: number;
};

export async function queryAudit(q: AuditQuery): Promise<{
  rows: AuditRow[];
  total: number;
  page: number;
  pageCount: number;
}> {
  const page = Math.max(1, q.page ?? 1);
  const pageSize = q.pageSize ?? 50;
  const skip = (page - 1) * pageSize;

  const where: {
    action?: { contains: string; mode: "insensitive" };
    entityType?: string;
  } = {};

  if (q.action?.trim()) {
    where.action = { contains: q.action.trim(), mode: "insensitive" };
  }

  if (q.entityType?.trim()) {
    where.entityType = q.entityType.trim();
  }

  const [rawRows, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: pageSize,
    }),
    prisma.auditLog.count({ where }),
  ]);

  // Resolve actor names in a single query: collect distinct non-null actorPersonIds
  // from this page's rows and look them up in Person.
  const actorIds = Array.from(
    new Set(rawRows.map((r) => r.actorPersonId).filter((id): id is string => id !== null))
  );

  const personMap = new Map<string, string>();
  if (actorIds.length > 0) {
    const persons = await prisma.person.findMany({
      where: { id: { in: actorIds } },
      select: { id: true, name: true },
    });
    for (const p of persons) {
      if (p.name) personMap.set(p.id, p.name);
    }
  }

  const rows: AuditRow[] = rawRows.map((r) => ({
    ...r,
    actorName: r.actorPersonId ? (personMap.get(r.actorPersonId) ?? null) : null,
  }));

  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return { rows, total, page, pageCount };
}

/**
 * Returns the sorted list of distinct entityType values present in the audit
 * log. Used to populate the entityType filter select on the audit page.
 */
export async function distinctEntityTypes(): Promise<string[]> {
  const results = await prisma.auditLog.findMany({
    select: { entityType: true },
    distinct: ["entityType"],
    orderBy: { entityType: "asc" },
  });
  return results.map((r) => r.entityType);
}
