import type { ReactNode } from "react";
import { requireModuleAccess } from "@/platform/auth/session";

/**
 * Recruitment-staff gate for the whole cycle-management subtree
 * (`/recruitment/cycles/**`). The recruitment root layout was relaxed to a bare
 * session check so panelists can reach `/recruitment/interviews/**`, so the
 * `recruitment.access` requirement lives here, where every page is a staff
 * surface. The cycles index (`/recruitment`) enforces the same gate on its own
 * page since it sits above this layout.
 */
export default async function RecruitmentCyclesLayout({ children }: { children: ReactNode }) {
  await requireModuleAccess("recruitment");
  return <>{children}</>;
}
