import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { can } from "@/platform/rbac/engine";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { cycleNavItems } from "@/modules/recruitment/cycle-nav";
import { CycleNavTabs } from "@/modules/recruitment/components/cycle-nav-tabs";

type LayoutProps = {
  children: ReactNode;
  params: Promise<{ id: string }>;
};

/**
 * Persistent workspace nav for a single cycle (Overview, Form, Applicants,
 * ...). The subtree gate (requireRecruitmentStaff, cycles/layout.tsx) already
 * ran for the whole /recruitment/cycles/** tree and deliberately admits
 * committee scorers who hold none of recruitment.access, .manage_cycles, or
 * .review_all -- so this layout does not re-gate access, it only resolves
 * those three booleans for cycleNavItems to decide which tabs a given viewer
 * can actually open.
 *
 * canAccess matters as much as the other two: nearly every cycle sub-page
 * requires recruitment.access first and then its finer permission, so
 * omitting canAccess here would show a committee scorer tabs that dead-end on
 * /no-access. See cycle-nav.ts for the per-tab gating detail.
 */
export default async function CycleWorkspaceLayout({ children, params }: LayoutProps) {
  const { id } = await params;
  const session = await requirePersonSession();
  const [cycle, canAccess, canManage, canReviewAll] = await Promise.all([
    getCycle(id),
    can(session.personId, "recruitment.access"),
    can(session.personId, "recruitment.manage_cycles"),
    can(session.personId, "recruitment.review_all"),
  ]);
  if (!cycle) notFound();

  const items = cycleNavItems({ cycleId: id, track: cycle.track, canAccess, canManage, canReviewAll });

  return (
    <div className="space-y-6">
      <CycleNavTabs items={items} />
      {children}
    </div>
  );
}
