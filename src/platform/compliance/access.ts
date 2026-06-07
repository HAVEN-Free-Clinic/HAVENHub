/**
 * Certificate access control.
 *
 * canViewCertificate determines whether a given viewer may access another
 * person's HIPAA certificate. Rules (first match wins):
 *   1. Self: viewer === owner
 *   2. viewer has volunteers.manage_compliance permission
 *   3. viewer has volunteers.view AND is an ACTIVE DIRECTOR in the active term
 *      in any department where the owner also has an ACTIVE membership
 *   4. Otherwise false
 */

import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";

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

  // Rule 3: volunteers.view + ACTIVE DIRECTOR in same dept as owner
  if (!(await can(viewerPersonId, "volunteers.view"))) return false;

  // Find the active term
  const activeTerm = await prisma.term.findFirst({
    where: { status: "ACTIVE" },
    orderBy: { startDate: "desc" },
  });
  if (!activeTerm) return false;

  // Get departments where the viewer is an ACTIVE DIRECTOR in the active term
  const directorDepts = await prisma.termMembership.findMany({
    where: {
      personId: viewerPersonId,
      termId: activeTerm.id,
      kind: "DIRECTOR",
      status: "ACTIVE",
    },
    select: { departmentId: true },
  });
  if (directorDepts.length === 0) return false;

  const directorDeptIds = directorDepts.map((m) => m.departmentId);

  // Check whether the owner has an ACTIVE membership in any of those departments
  const ownerMembership = await prisma.termMembership.findFirst({
    where: {
      personId: ownerPersonId,
      termId: activeTerm.id,
      status: "ACTIVE",
      departmentId: { in: directorDeptIds },
    },
  });

  return ownerMembership !== null;
}
