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
 * or live applicants: those are confidential or carry personal essays, and this
 * repo has already leaked strike data to the wrong audience once (#165).
 * Leaving them out of the palette index is a product decision, not an
 * oversight to "complete" later.
 *
 * HistoricalApplicant is the one apparent exception, and it is not really one.
 * The row it indexes is an IDENTITY -- a name, a NetID, an email -- with no
 * essay, score, or decision on it, and it is gated on exactly the permission
 * that opens /recruitment/history, a page that already lists those same three
 * columns for every imported identity at once. The palette surfaces nothing
 * that gate does not already show; a hit's outcome trail lives on the detail
 * page, behind the same check. Applications and live applicants stay out.
 */

import { cache } from "react";
import { prisma } from "@/platform/db";
import { getEffectivePermissions, hasPermission } from "@/platform/rbac/engine";
import { canAccessModule } from "@/platform/modules/access";
import { getModule } from "@/platform/modules/registry";
import {
  findHistoricalApplicants,
  historicalApplicantLabel,
  historicalApplicantWhere,
  looksLikeEmail,
} from "@/platform/recruitment/historical-applicants";
import type { EntityHit } from "@/platform/search/types";

/**
 * Per-group cap. Keeps every query bounded. Every query below pairs it with an
 * explicit `orderBy`: with more than LIMIT matches an unordered take is the
 * database's choice of rows, which can differ between two keystrokes that match
 * the same set and make the list flicker for no reason the user can see.
 */
const LIMIT = 5;

/** Below this, the palette shows pages only: a 1-char entity query scans too much. */
const MIN_QUERY = 2;

/**
 * Search people, recruitment cycles, imported recruitment history, and support
 * requests for the command palette, scoped to what `personId` is allowed to
 * see. Wrapped in React's
 * `cache()` so repeated calls with the same (personId, query) pair within one
 * request share a single set of queries rather than re-running them.
 */
export const searchEntities = cache(async function searchEntities(
  personId: string,
  query: string
): Promise<EntityHit[]> {
  const q = query.trim();
  if (q.length < MIN_QUERY) return [];

  // Resolve the viewer's effective permissions ONCE, then derive every gate
  // below from that one Set. Nothing below this point may run a query before
  // its gate has been checked here.
  const perms = await getEffectivePermissions(personId);
  // Either support permission widens the ticket search to everyone's requests:
  // both audiences can open any ticket from /support/all, so a search that
  // returned only the auditor's own would be narrower than the list they
  // already have.
  const canSearchAllRequests =
    hasPermission(perms, "support.manage_requests") ||
    hasPermission(perms, "support.view_all_requests");
  const canRecruitmentAccess = hasPermission(perms, "recruitment.access");

  // People: each tier needs the destination page's gate AND the module layout
  // gate that runs above it, because a viewer who fails the layout never
  // reaches the page. Those two are not the same permission:
  //   - /admin/people/[id] sits under admin/layout.tsx (module access =
  //     admin.access), and admin.manage_people does not imply it.
  //   - /volunteers/compliance/[personId] sits under volunteers/layout.tsx,
  //     whose access set is volunteers.view OR volunteers.verify_spanish;
  //     volunteers.manage_compliance is NOT in it.
  // Shipped system roles happen to pair each permission with module access, so
  // a mismatch is latent rather than live, but the Roles UI lets an admin
  // compose a role that grants the fine-grained permission alone and every
  // People result such a viewer got would bounce at the layout. The module
  // half reads through canAccessModule so it can never drift from the
  // registry; only the page half is spelled out here.
  const adminPeople =
    hasPermission(perms, "admin.manage_people") && canAccessModule(getModule("admin")!, perms);
  const compliancePeople =
    hasPermission(perms, "volunteers.manage_compliance") &&
    canAccessModule(getModule("volunteers")!, perms);

  const hits: EntityHit[] = [];

  // A viewer who qualifies for neither tier gets no People results at all --
  // the query below is never reached for them. When both qualify, admin wins.
  if (adminPeople || compliancePeople) {
    const people = await prisma.person.findMany({
      where: { status: "ACTIVE", name: { contains: q, mode: "insensitive" } },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
      take: LIMIT,
    });
    for (const p of people) {
      hits.push({
        id: p.id,
        label: p.name,
        sub: null,
        href: adminPeople ? `/admin/people/${p.id}` : `/volunteers/compliance/${p.id}`,
        group: "People",
      });
    }
  }

  // recruitment.access alone, deliberately narrower than the cycles SUBTREE gate
  // (which also admits scorers and department-scoped reviewers). The page this
  // links to, cycles/[id]/page.tsx, requires recruitment.access outright, so a
  // broader gate here would surface titles that bounce to /no-access on click.
  if (canRecruitmentAccess) {
    const cycles = await prisma.recruitmentCycle.findMany({
      where: { title: { contains: q, mode: "insensitive" } },
      select: { id: true, title: true, status: true },
      orderBy: { createdAt: "desc" },
      take: LIMIT,
    });
    for (const c of cycles) {
      hits.push({ id: c.id, label: c.title, sub: c.status, href: `/recruitment/cycles/${c.id}`, group: "Cycles" });
    }

    // Imported recruitment history. Same gate as Cycles above and for the same
    // reason: both /recruitment/history and its detail page require
    // recruitment.access outright, so a broader gate would surface names that
    // bounce to /no-access on click.
    //
    // This is the group that makes someone who applied in 2022 and never joined
    // findable at all: they have no Person row, so the People query above can
    // never return them however the viewer spells the name.
    //
    // The query, its named-first ordering, and the label fallback all come from
    // the shared platform helper -- the history page runs the identical read, and
    // the nameless-identity traps behind both (#528, #534) are only fixed once
    // if there is only one copy of them.
    const historical = await findHistoricalApplicants(historicalApplicantWhere(q), LIMIT);
    for (const a of historical) {
      const label = historicalApplicantLabel(a);
      // NetID first: it is the strongest identifier and the shortest. The email
      // is the fallback, unless the label is already that same email (which is
      // what a nameless identity renders as) or the column holds one of the ~20
      // non-address values the import carried through.
      const email = looksLikeEmail(a.primaryEmail) && a.primaryEmail !== label ? a.primaryEmail : null;
      hits.push({
        id: a.id,
        label,
        sub: a.netId ?? email,
        href: `/recruitment/history/${a.id}`,
        group: "Recruitment history",
      });
    }
  }

  // Requests: everyone may search their own; a support.manage_requests or
  // support.view_all_requests holder may search everyone's. The scoping is baked
  // into the `where` clause itself, not filtered out of an unscoped result
  // afterward.
  const requestWhere: { subject: { contains: string; mode: "insensitive" }; requesterId?: string } = {
    subject: { contains: q, mode: "insensitive" },
  };
  if (!canSearchAllRequests) requestWhere.requesterId = personId;
  const requests = await prisma.techRequest.findMany({
    where: requestWhere,
    select: { id: true, subject: true, status: true },
    orderBy: { createdAt: "desc" },
    take: LIMIT,
  });
  for (const r of requests) {
    hits.push({ id: r.id, label: r.subject, sub: r.status, href: `/support/${r.id}`, group: "Requests" });
  }

  return hits;
});
