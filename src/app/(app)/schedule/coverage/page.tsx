import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/platform/db";
import { requireModuleAccess } from "@/platform/auth/session";
import {
  attendingSchedule,
  canViewAttendingCoverage,
  canManageAttendings,
} from "@/modules/schedule/services/attendings";
import { AttendingCoverageView } from "@/modules/schedule/components/attending-coverage-view";
import { getWorkingTerm } from "@/platform/terms/working-term";
import { getActiveTerm } from "@/platform/terms/active-term";
import { buildTermOptions } from "@/platform/terms/term-options";
import { displayTodayKey } from "@/platform/dates/today";
import { buildPageMetadata } from "@/platform/branding/metadata";
import { PageHeader } from "@/platform/ui/page-header";
import { Card } from "@/platform/ui/card";
import { buttonClasses } from "@/platform/ui/button";
import { TermSwitcher } from "@/platform/ui/term-switcher";

// buildPageMetadata is async, so it goes through generateMetadata, not a static
// `metadata` export.
export function generateMetadata() {
  return buildPageMetadata({
    title: "Attending coverage",
    description: "Who is covering every column of the clinic schedule, for the whole term.",
  });
}

/**
 * The clinic-wide attending coverage, read only.
 *
 * Separate page from the builder on purpose. Faculty Relations BUILDS this
 * schedule; the executive directors and everyone else holding clinic-wide
 * schedule rights need to READ it -- on a clinic morning, at speed, without any
 * chance of changing it by misclicking. So this page has no controls, and a
 * wider gate than the builder's.
 */
const BASE = "/schedule/coverage";

type PageProps = {
  searchParams: Promise<{ term?: string }>;
};

export default async function CoveragePage({ searchParams }: PageProps) {
  const session = await requireModuleAccess("schedule");
  const sp = await searchParams;

  // Matches the nav gate in schedule/layout.tsx exactly, so the tab is never a
  // link to a page that bounces, and the URL is never a way around the tab.
  if (!(await canViewAttendingCoverage(session.personId))) redirect("/no-access");

  const [workingTerm, liveTerm, canBuild] = await Promise.all([
    getWorkingTerm(sp.term),
    getActiveTerm(),
    canManageAttendings(session.personId),
  ]);

  if (!workingTerm) {
    return (
      <div className="space-y-8">
        <PageHeader title="Attending coverage" description="No active term" />
        <p className="text-sm text-muted-foreground">
          There is no term to show coverage for yet.
        </p>
      </div>
    );
  }

  const [schedule, todayKey, switcherTerms] = await Promise.all([
    attendingSchedule(workingTerm.id),
    displayTodayKey(),
    prisma.term.findMany({
      orderBy: { startDate: "desc" },
      take: 8, // live + next + a bounded set of recent archived
      select: { id: true, code: true, status: true },
    }),
  ]);

  // The clinic date being worked toward. Skips the Saturdays the term does not
  // run -- the rows span the whole term, so "the next row" is often a break
  // week. Null when every clinic date has passed, rather than pinning the last.
  const highlightDateKey =
    schedule.rows.find((r) => !r.isClosed && r.dateKey >= todayKey)?.dateKey ?? null;

  const hrefForTerm = (termId: string | null) =>
    termId && termId !== liveTerm?.id ? `${BASE}?term=${termId}` : BASE;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Attending coverage"
        description={`Who is covering each column of the clinic schedule · ${workingTerm.name}`}
      />

      <div className="flex flex-wrap items-end justify-between gap-4 rounded-2xl border border-border bg-muted px-4 py-3">
        <TermSwitcher
          options={buildTermOptions(switcherTerms, { includeArchived: true })}
          selectedId={workingTerm.id}
          liveTermId={liveTerm?.id ?? null}
          hrefForTerm={hrefForTerm}
        />
        {/* Only for the people who maintain it. Everyone else reading this page
            has no builder to go to, and a link to /no-access is worse than
            no link. */}
        {canBuild && (
          <Link href="/schedule/attendings" className={buttonClasses("outline", "sm")}>
            Edit the schedule
          </Link>
        )}
      </div>

      {schedule.rows.length === 0 ? (
        <Card pad={false} className="px-6 py-10 text-center text-sm text-muted-foreground">
          {schedule.emptyReason === "no-clinic-dates"
            ? `${workingTerm.name} has no clinic dates yet.`
            : "No schedule columns are defined yet, so there is no coverage to show."}
        </Card>
      ) : (
        <AttendingCoverageView
          rows={schedule.rows}
          slots={schedule.slots}
          specialties={schedule.specialties}
          highlightDateKey={highlightDateKey}
        />
      )}
    </div>
  );
}
