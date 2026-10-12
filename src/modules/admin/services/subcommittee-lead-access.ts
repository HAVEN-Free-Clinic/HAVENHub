/**
 * Who may manage one subcommittee's members from My Info: a LEAD of that
 * subcommittee, or anyone holding recruitment.manage_cycles (who can already
 * do it from Recruitment). Being a lead is the grant, so co-chairs need no role
 * and no recruitment access, and their reach stops at the subcommittees they
 * lead.
 */
import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";

export async function canManageSubcommittee(
  personId: string,
  subcommitteeId: string,
): Promise<boolean> {
  if (await can(personId, "recruitment.manage_cycles")) return true;
  const membership = await prisma.subcommitteeMembership.findUnique({
    where: { subcommitteeId_personId: { subcommitteeId, personId } },
    select: { role: true },
  });
  return membership?.role === "LEAD";
}

/**
 * Whether a membership row belongs to this subcommittee. The role and remove
 * actions take a membershipId from the form, so without this a lead could post
 * the id of someone on a different subcommittee and change it.
 */
export async function membershipBelongsTo(
  membershipId: string,
  subcommitteeId: string,
): Promise<boolean> {
  const membership = await prisma.subcommitteeMembership.findUnique({
    where: { id: membershipId },
    select: { subcommitteeId: true },
  });
  return membership?.subcommitteeId === subcommitteeId;
}