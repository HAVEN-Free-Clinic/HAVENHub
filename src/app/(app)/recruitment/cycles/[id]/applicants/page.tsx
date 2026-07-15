import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { listApplicantsForReview, reviewScope } from "@/modules/recruitment/services/review";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { cycleTrail } from "@/modules/recruitment/breadcrumbs";
import { PageHeader } from "@/platform/ui/page-header";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { Badge } from "@/platform/ui/badge";
import { Pagination } from "@/platform/ui/pagination";
import { applicantTypeLabel } from "@/modules/recruitment/engine/visibility";
import { scoreAverage } from "@/modules/recruitment/engine/scoring";
import { applicationStage, applicationStageLabel } from "@/modules/recruitment/engine/application-stage";
import { can } from "@/platform/rbac/engine";
import { SpeedScoreLauncher } from "@/modules/recruitment/components/speed-score-launcher";
import { speedScoreAction, loadReviewApplicationAction } from "./actions";
import type { SpeedScoreItem } from "@/modules/recruitment/engine/speed-score-queue";

const PAGE_SIZE = 50;

function decision(depts: string[]): { label: string; tone: "default" | "success" | "critical" } {
  if (depts.length === 0) return { label: "None", tone: "default" };
  const distinct = [...new Set(depts)];
  return distinct.length > 1
    ? { label: `Conflict: ${distinct.join(" + ")}`, tone: "critical" }
    : { label: `Accepted: ${distinct[0]}`, tone: "success" };
}

export default async function ApplicantsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ page?: string }> }) {
  const { id } = await params;
  const { page: pageParam } = await searchParams;
  const [person, cycle] = await Promise.all([requirePersonSession(), getCycle(id)]);
  if (!cycle) notFound();
  const apps = await listApplicantsForReview(id, person.personId);
  const [scope, canScorePerm] = await Promise.all([
    reviewScope(person.personId),
    can(person.personId, "recruitment.score"),
  ]);
  const canScore = scope.all || canScorePerm;
  const speedItems: SpeedScoreItem[] = canScore
    ? apps
        .filter((a) => a.applicant.applicantPersonId !== person.personId) // never queue your own application
        .map((a) => ({
          applicationId: a.id,
          name: `${a.applicant.firstName} ${a.applicant.lastName}`,
          typeLabel: applicantTypeLabel(a.applicantType),
          myScore: a.committeeScores.find((c) => c.scorerId === person.personId)?.score ?? null,
        }))
    : [];
  const pageCount = Math.max(1, Math.ceil(apps.length / PAGE_SIZE));
  const page = Math.min(Math.max(1, Number(pageParam) || 1), pageCount);
  const pageApps = apps.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  return (
    <div className="space-y-6">
      <SetBreadcrumb
        trail={cycleTrail({
          cycleId: id,
          cycleTitle: cycle.title,
          section: { label: "Applicants", slug: "applicants" },
        })}
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeader title="Applicants" description={cycle.title} />
        {canScore && speedItems.length > 0 && (
          <SpeedScoreLauncher
            items={speedItems}
            onScore={speedScoreAction}
            onLoad={loadReviewApplicationAction}
          />
        )}
      </div>
      <Table>
        <THead>
          <tr>
            <TH>Name</TH>
            <TH>Email</TH>
            <TH>Type</TH>
            <TH>Committee avg</TH>
            <TH>Stage</TH>
            <TH>Ranked</TH>
            <TH>Decision</TH>
          </tr>
        </THead>
        <tbody>
          {pageApps.map((a) => {
            const d = decision(a.acceptances.map((x) => x.departmentCode));
            return (
              <TR key={a.id}>
                <TD>
                  <Link
                    className="font-medium text-foreground hover:text-brand-fg"
                    href={`/recruitment/cycles/${id}/applicants/${a.id}`}
                  >
                    {a.applicant.firstName} {a.applicant.lastName}
                  </Link>
                </TD>
                <TD className="text-foreground-soft">{a.applicant.email}</TD>
                <TD className="text-foreground-soft">{applicantTypeLabel(a.applicantType)}</TD>
                <TD className="text-foreground-soft">
                  {(() => {
                    const s = scoreAverage(a.committeeScores.map((c) => c.score));
                    return s.average != null ? `${s.average.toFixed(1)} · ${s.count}` : "-";
                  })()}
                </TD>
                <TD>
                  <Badge>{applicationStageLabel[applicationStage({
                    scoreCount: a.committeeScores.length,
                    routedDepartmentCode: a.routedDepartmentCode,
                    applicationDecision: a.decision,
                    interviews: a.interviews,
                  })]}</Badge>
                </TD>
                <TD className="text-foreground-soft">{a.departmentChoices.join(", ")}</TD>
                <TD>
                  <Badge tone={d.tone}>{d.label}</Badge>
                </TD>
              </TR>
            );
          })}
          {apps.length === 0 && (
            <TR>
              <TD colSpan={7} className="py-10 text-center text-subtle-foreground">
                No applicants in your review scope.
              </TD>
            </TR>
          )}
        </tbody>
      </Table>
      <Pagination
        page={page}
        pageCount={pageCount}
        hrefFor={(p) => `/recruitment/cycles/${id}/applicants?page=${p}`}
      />
    </div>
  );
}
