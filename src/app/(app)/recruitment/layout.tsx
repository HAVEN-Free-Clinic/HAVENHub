import type { ReactNode } from "react";
import { requirePersonSession } from "@/platform/auth/session";
import { getEffectivePermissions } from "@/platform/rbac/engine";
import { getModule } from "@/platform/modules/registry";
import { canAccessModule, filterNavItems } from "@/platform/modules/access";
import { isInterviewPanelist } from "@/modules/recruitment/services/interviews";
import { recruitmentNavItems } from "@/modules/recruitment/nav";
import { ModuleNav } from "@/platform/ui/module-nav";

export default async function RecruitmentLayout({ children }: { children: ReactNode }) {
  // The recruitment area is open to a bare session so interview panelists (who
  // are not recruitment staff and hold no recruitment.access) can reach
  // /recruitment/interviews/**. recruitment.access is enforced on the staff
  // surfaces themselves: the cycles subtree layout (/recruitment/cycles/**) and
  // the cycles index page (/recruitment).
  //
  // The nav is assembled per viewer: staff get the module's (permission-filtered)
  // staff tabs; anyone on an interview panel additionally gets a "My interviews"
  // tab. Panel membership is dynamic, not a permission, so it cannot flow through
  // the registry's permission-based filterNavItems and is resolved here.
  const person = await requirePersonSession();
  const mod = getModule("recruitment")!;
  const [perms, isPanelist] = await Promise.all([
    getEffectivePermissions(person.personId),
    isInterviewPanelist(person.personId),
  ]);
  const staffNav = canAccessModule(mod, perms) ? filterNavItems(mod.nav, perms) : [];
  const items = recruitmentNavItems({ staffNav, isPanelist });
  return (
    <>
      {items.length > 0 && <ModuleNav items={items} />}
      <div className="mt-8">{children}</div>
    </>
  );
}
