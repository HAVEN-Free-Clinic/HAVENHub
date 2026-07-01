/**
 * Certificate access control.
 *
 * canViewCertificate determines whether a given viewer may access another
 * person's HIPAA certificate. Rules (first match wins):
 *   1. Self: viewer === owner
 *   2. viewer has volunteers.manage_compliance permission
 *   3. viewer has volunteers.view AND manages (via active directorship or a
 *      one-hop department delegation) a department where the owner also has an
 *      ACTIVE membership in the active term
 *   4. Otherwise false
 *
 * The "manages" set comes from manageableDepartmentIds, so delegation (e.g. a
 * PCAR director overseeing SCTP/JCTP) is honored. Delegation is one-way.
 */

import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { manageableDepartmentIds } from "@/platform/departments";
import { getActiveTerm } from "@/platform/terms/active-term";

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

  // Rule 2: manage_compliance is a master key
  if (await can(viewerPersonId, "volunteers.manage_compliance")) return true;

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
