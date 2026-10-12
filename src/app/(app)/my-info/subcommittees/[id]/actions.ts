"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireModuleAccess } from "@/platform/auth/session";
import {
  bulkAddMembers,
  parseIdentifiers,
  removeMember,
  setMemberRole,
  type BulkAddResult,
} from "@/modules/admin/services/subcommittee-members";
import {
  canManageSubcommittee,
  membershipBelongsTo,
} from "@/modules/admin/services/subcommittee-lead-access";

/** Every action re-checks: a lead of THIS subcommittee, or a recruitment manager. */
async function requireLead(subcommitteeId: string) {
  const person = await requireModuleAccess("my-info");
  if (!(await canManageSubcommittee(person.personId, subcommitteeId))) {
    throw new Error("You do not lead this subcommittee.");
  }
  return person;
}

function refresh(subcommitteeId: string) {
  revalidatePath(`/my-info/subcommittees/${subcommitteeId}`);
  revalidatePath("/my-info/subcommittees");
  revalidatePath(`/recruitment/subcommittees/${subcommitteeId}`);
}

export async function leadAddMembersAction(
  subcommitteeId: string,
  _prev: BulkAddResult | null,
  formData: FormData,
): Promise<BulkAddResult | null> {
  const person = await requireLead(subcommitteeId);
  const identifiers = parseIdentifiers(String(formData.get("identifiers") ?? ""));
  const role = formData.get("role") === "LEAD" ? "LEAD" : "MEMBER";
  const result = await bulkAddMembers(person.personId, subcommitteeId, identifiers, role);
  refresh(subcommitteeId);
  return result;
}

export async function leadSetRoleAction(subcommitteeId: string, formData: FormData): Promise<void> {
  const person = await requireLead(subcommitteeId);
  const membershipId = String(formData.get("membershipId") ?? "");
  const role = formData.get("role") === "LEAD" ? "LEAD" : "MEMBER";
  if (membershipId && (await membershipBelongsTo(membershipId, subcommitteeId))) {
    await setMemberRole(person.personId, membershipId, role);
  }
  refresh(subcommitteeId);
  redirect(`/my-info/subcommittees/${subcommitteeId}#members`);
}

export async function leadRemoveMemberAction(subcommitteeId: string, formData: FormData): Promise<void> {
  const person = await requireLead(subcommitteeId);
  const membershipId = String(formData.get("membershipId") ?? "");
  if (membershipId && (await membershipBelongsTo(membershipId, subcommitteeId))) {
    await removeMember(person.personId, membershipId);
  }
  refresh(subcommitteeId);
  redirect(`/my-info/subcommittees/${subcommitteeId}#members`);
}