import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { can } from "@/platform/rbac/engine";
import { prisma } from "@/platform/db";
import { cycleNavItems } from "@/modules/recruitment/cycle-nav";
import { CycleNavTabs } from "@/modules/recruitment/components/cycle-nav-tabs";
import { reviewScope } from "@/modules/recruitment/services/review";
import { Alert } from "@/platform/ui/alert";
import { TextLink } from "@/platform/ui/text-link";

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
  // Deliberately not getCycle(id): every sub-page below this layout already
  // calls it, and its include (term, all sections, all fields, plus
  // resolveAvailabilityOptions) is the module's heaviest query. This layout
  // only needs track, so it selects just that instead of paying for the full
  // load a second time on every render.
  const [cycle, canAccess, canManage, canReviewAll, scope] = await Promise.all([
    prisma.recruitmentCycle.findUnique({ where: { id }, select: { track: true, isTest: true, testSourceCycleId: true } }),
    can(session.personId, "recruitment.access"),
    can(session.personId, "recruitment.manage_cycles"),
    can(session.personId, "recruitment.review_all"),
    // Request-cached; the subtree gate above already resolved it.
    reviewScope(session.personId),
  ]);
  if (!cycle) notFound();

  // On every page of a test run, so whoever opens its form builder, emails or
  // contract learns before trying to edit that those follow the real cycle.
  const testSource = cycle.isTest && cycle.testSourceCycleId
    ? await prisma.recruitmentCycle.findUnique({ where: { id: cycle.testSourceCycleId }, select: { id: true, title: true } })
    : null;

  const items = cycleNavItems({
    cycleId: id, track: cycle.track, canAccess, canManage, canReviewAll,
    hasReviewScope: scope.departmentCodes.length > 0,
  });

  return (
    <div className="space-y-6">
      <CycleNavTabs items={items} />
      {cycle.isTest && (
        <Alert tone="warning">
          {testSource ? (
            <>
              Test run of <TextLink href={`/recruitment/cycles/${testSource.id}`}>{testSource.title}</TextLink>. Its
              form, emails, onboarding contract and settings follow that cycle and update the moment it changes,
              so make those edits there.
            </>
          ) : (
            <>Test run of a cycle that has since been deleted. It keeps the last version it had.</>
          )}
        </Alert>
      )}
      {children}
    </div>
  );
}
