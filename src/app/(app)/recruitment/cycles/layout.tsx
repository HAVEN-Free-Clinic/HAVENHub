import type { ReactNode } from "react";
import { requireRecruitmentStaff } from "./access";

/**
 * Recruitment-staff gate for the whole cycle-management subtree
 * (`/recruitment/cycles/**`). Admits module-access staff, committee scorers
 * (recruitment.score) and department directors; each staff-only page re-gates
 * itself on recruitment.access, and the applicants surface self-authorizes by
 * review scope.
 */
export default async function RecruitmentCyclesLayout({ children }: { children: ReactNode }) {
  await requireRecruitmentStaff();
  return <>{children}</>;
}
