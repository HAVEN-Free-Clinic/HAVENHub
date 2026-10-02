"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/platform/auth/session";
import {
  bulkAddMembers,
  parseIdentifiers,
  removeMember,
  setMemberRole,
  type BulkAddResult,
} from "@/modules/admin/services/subcommittee-members";

/**
 * Adds a pasted list of NetIDs / emails. Returns the outcome instead of
 * redirecting so the unmatched entries can be shown back next to the box,
 * still there to correct. Module scope, with the id bound by the page, for the
 * reason outreach/campaigns/[id]/actions.ts documents.
 */
export async function addMembersAction(
  subcommitteeId: string,
  _prev: BulkAddResult | null,
  formData: FormData,
): Promise<BulkAddResult | null> {
  const session = await requirePermission("recruitment.manage_cycles");
  const identifiers = parseIdentifiers(String(formData.get("identifiers") ?? ""));
  const role = formData.get("role") === "LEAD" ? "LEAD" : "MEMBER";
  const result = await bulkAddMembers(session.personId, subcommitteeId, identifiers, role);
  revalidatePath(`/recruitment/subcommittees/${subcommitteeId}`);
  return result;
}

export async function setRoleAction(subcommitteeId: string, formData: FormData): Promise<void> {
  const session = await requirePermission("recruitment.manage_cycles");
  const membershipId = String(formData.get("membershipId") ?? "");
  const role = formData.get("role") === "LEAD" ? "LEAD" : "MEMBER";
  if (membershipId) await setMemberRole(session.personId, membershipId, role);
  revalidatePath(`/recruitment/subcommittees/${subcommitteeId}`);
  redirect(`/recruitment/subcommittees/${subcommitteeId}#members`);
}

export async function removeMemberAction(subcommitteeId: string, formData: FormData): Promise<void> {
  const session = await requirePermission("recruitment.manage_cycles");
  const membershipId = String(formData.get("membershipId") ?? "");
  if (membershipId) await removeMember(session.personId, membershipId);
  revalidatePath(`/recruitment/subcommittees/${subcommitteeId}`);
  redirect(`/recruitment/subcommittees/${subcommitteeId}#members`);
}
