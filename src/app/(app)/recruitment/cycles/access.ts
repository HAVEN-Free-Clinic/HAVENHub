import { redirect } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { can } from "@/platform/rbac/engine";
import { reviewScope } from "@/modules/recruitment/services/review";

/**
 * Recruitment staff-surface gate. Admits anyone with ANY recruitment
 * capability: module access, committee scoring, or a review scope (SRR /
 * review_all or an active-term department director). Sub-permissions are still
 * enforced per-page and per-action; this only decides who may enter the subtree.
 */
export async function requireRecruitmentStaff() {
  const person = await requirePersonSession();
  const [access, score, scope] = await Promise.all([
    can(person.personId, "recruitment.access"),
    can(person.personId, "recruitment.score"),
    reviewScope(person.personId),
  ]);
  if (access || score || scope.all || scope.departmentCodes.length > 0) return person;
  redirect("/no-access");
}
