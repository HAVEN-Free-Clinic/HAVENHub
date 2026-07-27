/**
 * Permission-scoped entity search for the command palette (Cmd+K).
 *
 * SECURITY: every group below is gated BEFORE its Prisma query runs. A
 * post-filter -- run the query against every row, then Array.prototype.filter
 * the result down to what the viewer may see -- is a bug even when the
 * returned array looks correct, because the unauthorized rows were already
 * pulled out of the database. Support-request scoping in particular lives in
 * the Prisma `where` clause, never in a filter applied after the query.
 *
 * This module deliberately never queries incidents, strikes, applications,
 * or applicants: those are confidential or carry personal essays, and this
 * repo has already leaked strike data to the wrong audience once (#165).
 * Leaving them out of the palette index is a product decision, not an
 * oversight to "complete" later.
 */

import { cache } from "react";
import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { reviewScope } from "@/modules/recruitment/services/review";

export type EntityHit = {
  id: string;
  label: string;
  sub: string | null;
  href: string;
  group: "People" | "Cycles" | "Requests";
};

/** Per-group cap. Keeps every query bounded. */
const LIMIT = 5;

/** Below this, the palette shows pages only: a 1-char entity query scans too much. */
const MIN_QUERY = 2;

/**
 * Search people, recruitment cycles, and support requests for the command
 * palette, scoped to what `personId` is allowed to see. Wrapped in React's
 * `cache()` so repeated calls with the same (personId, query) pair within one
 * request share a single set of queries rather than re-running them.
 */
export const searchEntities = cache(async function searchEntities(
  personId: string,
  query: string
): Promise<EntityHit[]> {
  const q = query.trim();
  if (q.length < MIN_QUERY) return [];

  // Resolve every permission ONCE, in parallel, before any group's query
  // runs. Nothing below this point may run a query before its gate has been
  // checked here.
  const [
    canManagePeople,
    canManageCompliance,
    canManageRequests,
    canRecruitmentAccess,
    canRecruitmentScore,
    scope,
  ] = await Promise.all([
    can(personId, "admin.manage_people"),
    can(personId, "volunteers.manage_compliance"),
    can(personId, "support.manage_requests"),
    can(personId, "recruitment.access"),
    can(personId, "recruitment.score"),
    reviewScope(personId),
  ]);

  const hits: EntityHit[] = [];

  // People: gated on admin.manage_people or volunteers.manage_compliance. A
  // viewer with neither gets no People results at all -- the query below is
  // never reached for them. When a viewer holds both, the admin link wins.
  if (canManagePeople || canManageCompliance) {
    const people = await prisma.person.findMany({
      where: { status: "ACTIVE", name: { contains: q, mode: "insensitive" } },
      take: LIMIT,
    });
    for (const p of people) {
      hits.push({
        id: p.id,
        label: p.name,
        sub: null,
        href: canManagePeople ? `/admin/people/${p.id}` : `/volunteers/compliance/${p.id}`,
        group: "People",
      });
    }
  }

  // Cycles: gated on a global recruitment capability (access or score) or a
  // reviewer scope that actually covers something (all cycles, or at least
  // one department).
  if (canRecruitmentAccess || canRecruitmentScore || scope.all || scope.departmentCodes.length > 0) {
    const cycles = await prisma.recruitmentCycle.findMany({
      where: { title: { contains: q, mode: "insensitive" } },
      take: LIMIT,
    });
    for (const c of cycles) {
      hits.push({ id: c.id, label: c.title, sub: c.status, href: `/recruitment/cycles/${c.id}`, group: "Cycles" });
    }
  }

  // Requests: everyone may search their own; only a support.manage_requests
  // holder may search everyone's. The scoping is baked into the `where`
  // clause itself, not filtered out of an unscoped result afterward.
  const requestWhere: { subject: { contains: string; mode: "insensitive" }; requesterId?: string } = {
    subject: { contains: q, mode: "insensitive" },
  };
  if (!canManageRequests) requestWhere.requesterId = personId;
  const requests = await prisma.techRequest.findMany({ where: requestWhere, take: LIMIT });
  for (const r of requests) {
    hits.push({ id: r.id, label: r.subject, sub: r.status, href: `/support/${r.id}`, group: "Requests" });
  }

  return hits;
});
