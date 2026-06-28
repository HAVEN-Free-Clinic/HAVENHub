import type { ReactNode } from "react";
import { requirePersonSession } from "@/platform/auth/session";
import { can } from "@/platform/rbac/engine";
import { getModule } from "@/platform/modules/registry";
import { ModuleNav } from "@/platform/ui/module-nav";

export default async function RecruitmentLayout({ children }: { children: ReactNode }) {
  // Relaxed from a recruitment.access gate to a bare session check so interview
  // panelists (who are not recruitment staff) can reach /recruitment/interviews/**.
  // The recruitment.access requirement now lives on the staff surfaces themselves:
  // the cycles subtree layout (/recruitment/cycles/**) and the cycles index page
  // (/recruitment). The "Cycles" nav only makes sense for staff, so non-staff
  // (panelists viewing their assignments) never see it.
  const person = await requirePersonSession();
  const mod = getModule("recruitment")!;
  const showNav = await can(person.personId, "recruitment.access");
  return (
    <>
      {showNav && <ModuleNav items={mod.nav} />}
      <div className="mt-8">{children}</div>
    </>
  );
}
