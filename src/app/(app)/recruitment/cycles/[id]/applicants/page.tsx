import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { listApplicantsForReview, reviewScope, awaitingRoutingCount } from "@/modules/recruitment/services/review";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { cycleTrail } from "@/modules/recruitment/breadcrumbs";
import { PageHeader } from "@/platform/ui/page-header";
import { Table, THead, TR, TD, SortableTH } from "@/platform/ui/table";
import { Badge } from "@/platform/ui/badge";
import { Pagination } from "@/platform/ui/pagination";
import { applicantTypeLabel } from "@/modules/recruitment/engine/visibility";
import { serviceGapsForCycle } from "@/modules/recruitment/services/service-gap";
import { formatScoreSummary, scoreAverage } from "@/modules/recruitment/engine/scoring";
import { applicationStage, applicationStageLabel, isHandledStage } from "@/modules/recruitment/engine/application-stage";
import { can } from "@/platform/rbac/engine";
import { SpeedScoreLauncher } from "@/modules/recruitment/components/speed-score-launcher";
import { speedScoreAction, loadReviewApplicationAction } from "./actions";
import type { SpeedScoreItem } from "@/modules/recruitment/engine/speed-score-queue";
import { rosterDecision, type RosterDecisionStatus } from "@/modules/recruitment/engine/decision-summary";
import { DecisionFilter } from "@/modules/recruitment/components/decision-filter";
import { DepartmentFilter } from "@/modules/recruitment/components/department-filter";
import {
  departmentFilterOptions,
  filterApplicantsByDepartment,
} from "@/modules/recruitment/engine/applicant-department";
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
  department: string | null;
  sort: string | null;
  dir: string | null;
  page: number | null;
}): string {
  const q = new URLSearchParams();
  if (parts.decision) q.set("decision", parts.decision);
  if (parts.department) q.set("department", parts.department);
  if (parts.sort && parts.dir) {
    q.set("sort", parts.sort);
    q.set("dir", parts.dir);
  }
  if (parts.page && parts.page > 1) q.set("page", String(parts.page));
  const s = q.toString();
  return s ? `?${s}` : "";
}

export default async function ApplicantsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ page?: string; decision?: string; department?: string; sort?: string; dir?: string }> }) {
  const { id } = await params;
  const { page: pageParam, decision: decisionParam, department: departmentParam, sort: sortParam, dir: dirParam } = await searchParams;
  const [person, cycle] = await Promise.all([requirePersonSession(), getCycle(id)]);
  if (!cycle) notFound();
  const apps = await listApplicantsForReview(id, person.personId);
  // Only meaningful when the scoped list came back empty; see awaitingRoutingCount.
  const unrouted = apps.length === 0 ? await awaitingRoutingCount(id, person.personId) : 0;
  const [scope, canScorePerm, canOpenOverview] = await Promise.all([
    reviewScope(person.personId),
    can(person.personId, "recruitment.score"),
    // This page admits committee scorers and scoped reviewers who lack
    // recruitment.access, but the cycle overview enforces it, so the breadcrumb
    // must not offer them a link that bounces to /no-access.
    can(person.personId, "recruitment.access"),
  ]);
  const canScore = scope.all || canScorePerm;
  // Who is coming back after sitting terms out. Batched for the whole roster
  // (see serviceGapsForCycle) rather than per row: the Type column says
  // "Renewal" for a continuous returner and a lapsed one alike, and which of the
  // two an applicant is changes how the row reads.
  const serviceGaps = await serviceGapsForCycle(
    apps.map((a) => a.applicant.applicantPersonId).filter((p): p is string => Boolean(p)),
    cycle.termId,
  );
  // Derived once, used by the speed-score queue and the Stage column alike, so
  // the two can never disagree about where an application sits.
  const stageOf = (a: (typeof apps)[number]) =>
    applicationStage({
      scoreCount: a.committeeScores.length,
      routedDepartmentCode: a.routedDepartmentCode,
      returnedToRoutingAt: a.returnedToRoutingAt,
      applicationDecision: a.decision,
      interviews: a.interviews,
    });
  const speedItems: SpeedScoreItem[] = canScore
    ? apps
        .filter((a) => a.applicant.applicantPersonId !== person.personId) // never queue your own application
        // Already with a department, in interviews, or decided: a committee score
        // changes nothing for them. Renewals and first-choice auto-route
        // departments are routed AT SUBMISSION and documented as skipping
        // committee scoring (submissions.ts), so without this they filled the
        // queue with work that must never be done -- on a renewal-heavy cycle,
        // most of it.
        .filter((a) => !isHandledStage(stageOf(a)))
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
  // Options come off the unfiltered roster so the Department menu holds still
  // while the Decision filter moves, and so a hand-edited ?department= that no
  // row answers for falls back to no filter rather than an empty table.
  const departmentOptions = departmentFilterOptions(apps);
  const departmentFilter = departmentParam && departmentOptions.includes(departmentParam)
    ? departmentParam
    : null;
  const byDecision = decisionFilter
    ? apps.filter((a) => rosterDecision({ acceptances: a.acceptances, applicationDecision: a.decision, interviews: a.interviews }).status === decisionFilter)
    : apps;
  const filtered = filterApplicantsByDepartment(byDecision, departmentFilter);
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
      department: departmentFilter,
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
        <div className="flex flex-wrap items-end gap-3">
          <DecisionFilter />
          <DepartmentFilter options={departmentOptions} />
        </div>
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
            const gap = a.applicant.applicantPersonId ? serviceGaps.get(a.applicant.applicantPersonId) : undefined;
            return (
              <TR key={a.id}>
                <TD>
                  <span className="inline-flex flex-wrap items-center gap-1.5">
                    <Link
                      className="font-medium text-foreground hover:text-brand-fg"
                      href={`/recruitment/cycles/${id}/applicants/${a.id}`}
                    >
                      {a.applicant.firstName} {a.applicant.lastName}
                    </Link>
                    {/* Recruited by invite link rather than through the open
                        form, which usually means the application arrived after
                        the deadline. Reviewers are otherwise given no way to
                        tell, and it changes how the application reads. */}
                    {a.invited && (
                      <Badge tone="brand" title="Applied through an invitation link">
                        Invited
                      </Badge>
                    )}
                  </span>
                </TD>
                <TD className="text-foreground-soft">{a.applicant.email}</TD>
                <TD className="text-foreground-soft">
                  <span className="inline-flex flex-wrap items-center gap-1.5">
                    {applicantTypeLabel(a.applicantType)}
                    {/* "Renewal" alone hides the difference between someone who
                        worked last Saturday and someone back after a year off.
                        The detail page names the terms; this is the triage cue. */}
                    {gap && gap.missedTerms.length > 0 && (
                      <Badge
                        tone="warning"
                        title={`Last on the roster in ${gap.lastTerm.name}; not a member for ${gap.missedTerms
                          .map((t) => t.name)
                          .join(", ")}`}
                      >
                        {gap.missedTerms.length === 1
                          ? "1 term off"
                          : `${gap.missedTerms.length} terms off`}
                      </Badge>
                    )}
                  </span>
                </TD>
                <TD className="text-foreground-soft">
                  {formatScoreSummary(scoreAverage(a.committeeScores.map((c) => c.score)))}
                </TD>
                <TD>
                  <Badge>{applicationStageLabel[stageOf(a)]}</Badge>
                </TD>
                <TD className="text-foreground-soft">
                  <span className="inline-flex flex-wrap items-center gap-1.5">
                    {a.departmentChoices.join(", ")}
                    {/* Once routed, the routed department -- not the ranked ones
                        -- is what this row answers for, and routing off the
                        ranked choices is legal. Without this the Department
                        filter looks broken: a row routed to PCAR that ranked
                        SCTP shows up under PCAR with "SCTP" in this cell. */}
                    {a.routedDepartmentCode && (
                      <Badge tone="brand" title={`Routed to ${a.routedDepartmentCode}`}>
                        Routed: {a.routedDepartmentCode}
                      </Badge>
                    )}
                  </span>
                </TD>
                <TD>
                  <Badge tone={d.tone}>{d.label}</Badge>
                </TD>
              </TR>
            );
          })}
          {filtered.length === 0 && (
            <TR>
              <TD colSpan={7} className="py-10 text-center text-subtle-foreground">
                {apps.length > 0
                  ? "No applicants match these filters."
                  : unrouted > 0
                    ? `No applicants in your review scope yet. ${unrouted} submitted ${unrouted === 1 ? "application is" : "applications are"} waiting to be routed to a department, and will appear here once ${unrouted === 1 ? "it reaches" : "they reach"} yours.`
                    : "No applicants in your review scope."}
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
            department: departmentFilter,
            sort: sort?.key ?? null,
            dir: sort?.dir ?? null,
            page: p,
          })}`
        }
      />
    </div>
  );
}
