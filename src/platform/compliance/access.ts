/**
 * Certificate access control, and the clinic-wide compliance read boundary.
 *
 * canViewCertificate determines whether a given viewer may access another
 * person's HIPAA certificate. Rules (first match wins):
 *   1. Self: viewer === owner
 *   2. viewer holds the clinic-wide compliance read (canViewAllCompliance)
 *   3. viewer has volunteers.view AND manages (via active directorship or a
 *      one-hop department delegation) a department where the owner also has an
 *      ACTIVE membership in the active term
 *   4. Otherwise false
 *
 * The "manages" set comes from manageableDepartmentIds, so delegation (e.g. a
 * PCAR director overseeing SCTP/JCTP) is honored. Delegation is one-way.
 */

import { prisma } from "@/platform/db";
import { can, getEffectivePermissions, hasPermission } from "@/platform/rbac/engine";
import { manageableDepartmentIds } from "@/platform/departments";
import { getActiveTerm } from "@/platform/terms/active-term";

/**
 * The clinic-wide compliance READ: every member's status, dates, clearance and
 * HIPAA certificate, across every department, with no viewer scoping.
 *
 * Two permissions satisfy it, and this function is the only place that fact is
 * written down:
 *
 *   - volunteers.view_compliance -- read and nothing else.
 *   - volunteers.manage_compliance -- the same read PLUS verifying certificates,
 *     entering completion dates, and managing EHS trainings.
 *
 * Manage implies view HERE, in code, rather than through an engine feature the
 * RBAC engine does not have (getEffectivePermissions is a flat set; only "*"
 * expands). That matters for two reasons. Every existing manage_compliance
 * holder keeps their read the moment this ships, with no dependency on the
 * backfill migration having run. And an admin who composes a role granting only
 * manage_compliance from the Roles screen gets a coherent role rather than one
 * that can verify a certificate it cannot open.
 *
 * Use this for every read surface. Do NOT use it to gate a write: verifying,
 * date entry and EHS management check manage_compliance directly, which is the
 * entire point of the split. And do not use it to decide who is NOTIFIED to
 * review certificates -- that is a work assignment, not a read, and paging
 * someone for work they are not permitted to do is a bug (see
 * platform/compliance/review-notifications.ts).
 */
export async function canViewAllCompliance(viewerPersonId: string): Promise<boolean> {
  return hasViewAllCompliance(await getEffectivePermissions(viewerPersonId));
}

/** canViewAllCompliance for a caller that already resolved the permission set
 *  (the search index, nav filtering). Same rule, no second query. */
export function hasViewAllCompliance(perms: Set<string>): boolean {
  return (
    hasPermission(perms, "volunteers.view_compliance") ||
    hasPermission(perms, "volunteers.manage_compliance")
  );
}

/**
 * Returns true when the viewer is allowed to download or inspect the HIPAA
 * certificate belonging to ownerPersonId.
 */
export async function canViewCertificate(
  viewerPersonId: string,
  ownerPersonId: string
): Promise<boolean> {
  // Rule 1: self
  if (viewerPersonId === ownerPersonId) return true;

  // Rule 2: the clinic-wide compliance read is a master key. view_compliance
  // reaches certificates exactly as manage_compliance always has -- a role that
  // sees every member's compliance status but cannot open the document behind it
  // would show a status it could not check.
  if (await canViewAllCompliance(viewerPersonId)) return true;

  // Rule 3: volunteers.view + manages a dept the owner is an ACTIVE member of
  if (!(await can(viewerPersonId, "volunteers.view"))) return false;

  // Find the active term
  const activeTerm = await getActiveTerm();
  if (!activeTerm) return false;

  // Departments the viewer manages (own directorships + one-hop delegations).
  const manageableDeptIds = await manageableDepartmentIds(viewerPersonId);
  if (manageableDeptIds.length === 0) return false;

  // Check whether the owner has an ACTIVE membership in any of those departments
  const ownerMembership = await prisma.termMembership.findFirst({
    where: {
      personId: ownerPersonId,
      termId: activeTerm.id,
      status: "ACTIVE",
      departmentId: { in: manageableDeptIds },
    },
  });

  return ownerMembership !== null;
}
