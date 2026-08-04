import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { listApplicantsForReview, reviewScope } from "@/modules/recruitment/services/review";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { cycleTrail } from "@/modules/recruitment/breadcrumbs";
import { PageHeader } from "@/platform/ui/page-header";
import { Table, THead, TR, TD, SortableTH } from "@/platform/ui/table";
import { Badge } from "@/platform/ui/badge";
import { Pagination } from "@/platform/ui/pagination";
import { applicantTypeLabel } from "@/modules/recruitment/engine/visibility";
import { formatScoreSummary, scoreAverage } from "@/modules/recruitment/engine/scoring";
import { applicationStage, applicationStageLabel } from "@/modules/recruitment/engine/application-stage";
import { can } from "@/platform/rbac/engine";
import { SpeedScoreLauncher } from "@/modules/recruitment/components/speed-score-launcher";
import { speedScoreAction, loadReviewApplicationAction } from "./actions";
import type { SpeedScoreItem } from "@/modules/recruitment/engine/speed-score-queue";
import { rosterDecision, type RosterDecisionStatus } from "@/modules/recruitment/engine/decision-summary";
import { DecisionFilter } from "@/modules/recruitment/components/decision-filter";
import {
  nextSortDirection,
  parseApplicantSort,
  sortApplicants,
  type ApplicantSortKey,
} from "@/modules/recruitment/engine/applicant-sort";

const PAGE_SIZE = 50;

const DECISION_STATUSES = new Set<RosterDecisionStatus>(["ACCEPTED", "WAITLIST", "REJECTED", "NONE"]);

/** Builds the roster's query string from scratch each time. Every roster link
 *  (sort headers, pagination) carries the full state, so no param is dropped by
 *  navigating. Page 1 and the unsorted default are left implicit. */
function rosterQuery(parts: {
  decision: string | null;
  sort: string | null;
  dir: string | null;
  page: number | null;
}): string {
  const q = new URLSearchParams();
  if (parts.decision) q.set("decision", parts.decision);
  if (parts.sort && parts.dir) {
    q.set("sort", parts.sort);
    q.set("dir", parts.dir);
  }
  if (parts.page && parts.page > 1) q.set("page", String(parts.page));
  const s = q.toString();
  return s ? `?${s}` : "";
}

export default async function ApplicantsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ page?: string; decision?: string; sort?: string; dir?: string }> }) {
  const { id } = await params;
  const { page: pageParam, decision: decisionParam, sort: sortParam, dir: dirParam } = await searchParams;
  const [person, cycle] = await Promise.all([requirePersonSession(), getCycle(id)]);
  if (!cycle) notFound();
  const apps = await listApplicantsForReview(id, person.personId);
  const [scope, canScorePerm, canOpenOverview] = await Promise.all([
    reviewScope(person.personId),
    can(person.personId, "recruitment.score"),
    // This page admits committee scorers and scoped reviewers who lack
    // recruitment.access, but the cycle overview enforces it, so the breadcrumb
    // must not offer them a link that bounces to /no-access.
    can(person.personId, "recruitment.access"),
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
  const decisionFilter = decisionParam && DECISION_STATUSES.has(decisionParam as RosterDecisionStatus)
    ? (decisionParam as RosterDecisionStatus)
    : null;
  const filtered = decisionFilter
    ? apps.filter((a) => rosterDecision({ acceptances: a.acceptances, applicationDecision: a.decision, interviews: a.interviews }).status === decisionFilter)
    : apps;
  const sort = parseApplicantSort(sortParam, dirParam);
  // Sort after filtering and before slicing, so page boundaries stay correct.
  const sorted = sort ? sortApplicants(filtered, sort) : filtered;
  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const page = Math.min(Math.max(1, Number(pageParam) || 1), pageCount);
  const pageApps = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const sortHref = (key: ApplicantSortKey) =>
    // Omitting page returns to page 1, matching how DecisionFilter drops it.
    `/recruitment/cycles/${id}/applicants${rosterQuery({
      decision: decisionFilter,
      sort: key,
      dir: nextSortDirection(sort, key),
      page: null,
    })}`;
  return (
    <div className="space-y-6">
      <SetBreadcrumb
        trail={cycleTrail({
          canOpenOverview,
          cycleId: id,
          cycleTitle: cycle.title,
          section: { label: "Applicants", slug: "applicants" },
        })}
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeader title="Applicants" description={cycle.title} />
        <div className="flex flex-wrap items-center gap-2">
          {canScore && speedItems.length > 0 && (
            <SpeedScoreLauncher
              items={speedItems}
              onScore={speedScoreAction}
              onLoad={loadReviewApplicationAction}
            />
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <DecisionFilter />
        <span className="pb-2 text-sm whitespace-nowrap text-muted-foreground">
          {filtered.length.toLocaleString()} {filtered.length === 1 ? "applicant" : "applicants"}
        </span>
      </div>
      <Table>
        <THead>
          <tr>
            <SortableTH columnKey="name" active={sort} hrefFor={sortHref}>Name</SortableTH>
            <SortableTH columnKey="email" active={sort} hrefFor={sortHref}>Email</SortableTH>
            <SortableTH columnKey="type" active={sort} hrefFor={sortHref}>Type</SortableTH>
            <SortableTH columnKey="score" active={sort} hrefFor={sortHref}>Committee avg</SortableTH>
            <SortableTH columnKey="stage" active={sort} hrefFor={sortHref}>Stage</SortableTH>
            <SortableTH columnKey="ranked" active={sort} hrefFor={sortHref}>Ranked</SortableTH>
            <SortableTH columnKey="decision" active={sort} hrefFor={sortHref}>Decision</SortableTH>
          </tr>
        </THead>
        <tbody>
          {pageApps.map((a) => {
            const d = rosterDecision({ acceptances: a.acceptances, applicationDecision: a.decision, interviews: a.interviews });
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
                  {formatScoreSummary(scoreAverage(a.committeeScores.map((c) => c.score)))}
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
          {filtered.length === 0 && (
            <TR>
              <TD colSpan={7} className="py-10 text-center text-subtle-foreground">
                {apps.length === 0 ? "No applicants in your review scope." : "No applicants match this filter."}
              </TD>
            </TR>
          )}
        </tbody>
      </Table>
      <Pagination
        page={page}
        pageCount={pageCount}
        hrefFor={(p) =>
          `/recruitment/cycles/${id}/applicants${rosterQuery({
            decision: decisionFilter,
            sort: sort?.key ?? null,
            dir: sort?.dir ?? null,
            page: p,
          })}`
        }
      />
    </div>
  );
}
