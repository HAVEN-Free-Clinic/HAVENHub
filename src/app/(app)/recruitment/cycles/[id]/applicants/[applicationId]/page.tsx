import Link from "next/link";
import { notFound } from "next/navigation";
import { getApplication } from "@/modules/recruitment/services/submissions";
import { getApplicantHistory } from "@/modules/recruitment/services/history";
import { visibleSections, applicantTypeLabel } from "@/modules/recruitment/engine/visibility";
import { requirePersonSession } from "@/platform/auth/session";
import { reviewScope, listAcceptances, canViewApplication } from "@/modules/recruitment/services/review";
import { can } from "@/platform/rbac/engine";
import { scheduleInterviewAction, committeeScoreAction, routeAction, decideRoutedAction, reopenDecisionAction, rescindAcceptanceAction, reopenWithdrawnAction } from "../actions";
import { listApplicationInterviews } from "@/modules/recruitment/services/interviews";
import { DateTime } from "@/platform/dates/display";
import { committeeScoreSummary } from "@/modules/recruitment/services/committee-scoring";
import { formatScoreSummary } from "@/modules/recruitment/engine/scoring";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { cycleTrail } from "@/modules/recruitment/breadcrumbs";
import { PageHeader } from "@/platform/ui/page-header";
import { Field, Input } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { Badge } from "@/platform/ui/badge";
import { SubmitButton } from "@/platform/ui/submit-button";
import { Card } from "@/platform/ui/card";
import { SectionHeader } from "@/platform/ui/section-header";
import { Alert } from "@/platform/ui/alert";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { prisma } from "@/platform/db";
import { RescindAcceptanceNotice } from "@/modules/recruitment/components/rescind-acceptance-notice";
import { ApplicantHistory } from "@/modules/recruitment/components/applicant-history";

const decisionLabel = { PENDING: "Pending", ACCEPT: "Accepted", REJECT: "Rejected", WAITLIST: "Waitlisted" } as const;

export default async function ApplicationDetailPage({ params }: { params: Promise<{ id: string; applicationId: string }> }) {
  const { id, applicationId } = await params;
  const app = await getApplication(applicationId);
  if (!app) notFound();
  const person = await requirePersonSession();
  if (app.cycleId !== id) notFound();
  const [scope, managesCycles, canScorePerm, canOpenOverview, acceptances, history] = await Promise.all([
    reviewScope(person.personId),
    can(person.personId, "recruitment.manage_cycles"),
    can(person.personId, "recruitment.score"),
    // This page admits committee scorers and scoped reviewers who lack
    // recruitment.access, but the cycle overview enforces it, so the breadcrumb
    // must not offer them a link that bounces to /no-access.
    can(person.personId, "recruitment.access"),
    listAcceptances(applicationId),
    getApplicantHistory({
      netId: app.applicant.netId,
      emails: [app.applicant.email],
      excludeApplicationId: applicationId,
    }),
  ]);
  const seeAll = scope.all || managesCycles;
  // Committee scoring applies to both tracks; only routing is volunteer-only.
  const canScore = scope.all || canScorePerm;
  // Shared with the file-download route: mirror listApplicantsForReview exactly so
  // access to the detail page and its files can never drift (routing drives a
  // director's queue on volunteer cycles; ranking on director-track cycles).
  const canView = canViewApplication(app, { scope, managesCycles, canScore: canScorePerm });
  if (!canView) notFound();
  const eligible = seeAll
    ? app.cycle.departments
    : app.cycle.departments.filter((d) => scope.departmentCodes.includes(d) && app.departmentChoices.includes(d));
  const accepted = new Set(acceptances.map((a) => a.departmentCode));
  const choices = eligible.filter((d) => !accepted.has(d));
  const rankIds = [...new Set([...app.subcommitteeRanking, app.assignedSubcommitteeId].filter((x): x is string => Boolean(x)))];
  const subRows = rankIds.length
    ? await prisma.subcommittee.findMany({ where: { id: { in: rankIds } }, select: { id: true, name: true } })
    : [];
  const subName = new Map(subRows.map((s) => [s.id, s.name]));
  const existingInterviews = app.cycle.track === "DIRECTOR"
    ? await listApplicationInterviews(applicationId) : [];
  // Director of the routed department (or SRR) may record the volunteer decision.
  const canDecideRouted = app.routedDepartmentCode
    ? (scope.all || scope.departmentCodes.includes(app.routedDepartmentCode)) : false;
  const emailedAcceptance = app.routedDepartmentCode
    ? acceptances.find((a) => a.departmentCode === app.routedDepartmentCode && a.emailedAt != null)
    : undefined;
  const interviewedDepts = new Set(existingInterviews.map((i) => i.departmentCode));
  const scheduleChoices = choices.filter((d) => !interviewedDepts.has(d));
  const answers = (app.answers ?? {}) as Record<string, unknown>;
  const sections = visibleSections(app.cycle.sections, {
    applicantType: app.applicantType,
    selectedDepartmentCodes: app.departmentChoices,
  });
  // The routed-decision director is told to "decide from the committee score", so
  // they must be able to see it even without recruitment.score (they get the
  // read-only average below; only scorers get the entry form).
  const scoreSummary = canScore || canDecideRouted ? await committeeScoreSummary(applicationId) : null;
  const myScore = scoreSummary?.scores.find((s) => s.scorerId === person.personId) ?? null;
  const canRoute = scope.all && app.cycle.track === "VOLUNTEER"; // recruitment.review_all; routing is volunteer-only
  const routedOffChoice = app.routedDepartmentCode != null && !app.departmentChoices.includes(app.routedDepartmentCode);
  return (
    <div className="max-w-2xl space-y-6">
      <SetBreadcrumb
        trail={cycleTrail({
          canOpenOverview,
          cycleId: id,
          cycleTitle: app.cycle.title,
          section: { label: "Applicants", slug: "applicants" },
          leaf: `${app.applicant.firstName} ${app.applicant.lastName}`,
        })}
      />
      <PageHeader
        title={`${app.applicant.firstName} ${app.applicant.lastName}`}
        description={`${app.applicant.email} · ${applicantTypeLabel(app.applicantType)}${
          app.renewalDepartment ? ` · renewing in ${app.renewalDepartment}` : ""
        }${
          app.applicantType === "TRANSFER" && app.transferFromDepartments.length > 0
            ? ` · returning member, previously ${app.transferFromDepartments.join(", ")}`
            : ""
        }`}
      />

      <ApplicantHistory history={history} title="Past applications" pendingApplication />

      {app.status === "WITHDRAWN" && (
        <div className="space-y-3">
          <Alert tone="warning">
            This applicant withdrew themselves
            {app.withdrawnAt && <> on <DateTime value={app.withdrawnAt} /></>}. They are out of the
            review queue. Any acceptance or onboarding contract is untouched and still needs to be resolved
            separately.
          </Alert>
          {managesCycles && (
            <form action={reopenWithdrawnAction.bind(null, id, applicationId)}>
              <ConfirmButton label="Reopen" confirmLabel="Reopen this application?" size="sm" />
            </form>
          )}
        </div>
      )}

      {sections.map((section) => {
        // The ranking is hoisted into its own column at submission (submissions.ts
        // deletes the answer key), so a rank field here only ever rendered
        // "(none)". The Subcommittee card below is the authoritative view; drop a
        // section that held nothing else rather than leaving an empty card.
        const fields = section.fields.filter((f) => f.type !== "SUBCOMMITTEE_RANK");
        if (fields.length === 0) return null;
        return (
        <Card key={section.id}>
          <SectionHeader>{section.title}</SectionHeader>
          <dl className="mt-3 grid gap-3 sm:grid-cols-2">
            {fields.map((f) => {
              const val = answers[f.key];
              const isFileLike = (f.type === "FILE" || f.type === "SIGNATURE") && val && typeof val === "object";
              const fileVal = isFileLike ? (val as { storedName?: string; fileName?: string }) : null;
              const display = fileVal
                ? fileVal.fileName ?? "(file)"
                : Array.isArray(val) ? val.join(", ") : val === undefined || val === "" ? "(none)" : String(val);
              const fileHref = `/api/recruitment/applications/${applicationId}/files/${encodeURIComponent(f.key)}?inline=1`;
              return (
                // min-w-0 keeps a long unbroken answer from widening its grid
                // column; break-words/overflow-wrap inherit to the dt, dd and link.
                <div key={f.id} className="min-w-0 break-words [overflow-wrap:anywhere]">
                  <dt className="text-xs text-subtle-foreground">{f.label}</dt>
                  <dd className="mt-0.5 text-sm text-foreground">
                    {f.type === "SIGNATURE" && fileVal?.storedName ? (
                      // eslint-disable-next-line @next/next/no-img-element -- authenticated same-origin file route, not a remote asset
                      <img src={fileHref} alt={`${f.label} signature`} className="h-20 max-w-full rounded border border-border-subtle bg-white" />
                    ) : fileVal?.storedName ? (
                      <a href={fileHref} target="_blank" rel="noopener noreferrer" className="font-medium text-brand-fg hover:underline">
                        {display}
                      </a>
                    ) : (
                      display
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
        </Card>
        );
      })}

      {(app.subcommitteeRanking.length > 0 || app.assignedSubcommitteeId) && (
        <Card>
          <SectionHeader>Subcommittee</SectionHeader>
          <dl className="mt-3 grid gap-3 sm:grid-cols-2">
            <div className="min-w-0 break-words [overflow-wrap:anywhere]">
              <dt className="text-xs text-subtle-foreground">Ranked preferences</dt>
              <dd className="mt-0.5 text-sm text-foreground">
                {app.subcommitteeRanking.length === 0
                  ? "(none)"
                  : app.subcommitteeRanking.map((sid, i) => `${i + 1}. ${subName.get(sid) ?? "(removed)"}`).join("  ·  ")}
              </dd>
            </div>
            <div className="min-w-0 break-words [overflow-wrap:anywhere]">
              <dt className="text-xs text-subtle-foreground">Assigned</dt>
              <dd className="mt-0.5 text-sm text-foreground">
                {app.assignedSubcommitteeId ? (subName.get(app.assignedSubcommitteeId) ?? "(removed)") : "Not assigned"}
              </dd>
            </div>
          </dl>
          <p className="mt-2 text-xs text-subtle-foreground">Assign from the cycle&apos;s Subcommittees view.</p>
        </Card>
      )}

      {scoreSummary && (canScore || canDecideRouted) && (
        <Card>
          <SectionHeader>Committee score</SectionHeader>
          <p className="mt-1 text-xs text-subtle-foreground">
            {formatScoreSummary(scoreSummary)}
          </p>
          {canScore && (
            <>
              <form action={committeeScoreAction.bind(null, id, applicationId)} className="mt-3 flex flex-wrap items-end gap-3">
                <div className="w-28">
                  <Field label="Your score">
                    <Select name="score" required defaultValue={myScore ? String(myScore.score) : ""}>
                      <option value="" disabled>Select…</option>
                      {[1, 2, 3, 4, 5].map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </Select>
                  </Field>
                </div>
                <div className="min-w-[12rem] flex-1">
                  <Field label="Comments" hint="Optional.">
                    <Input name="comments" defaultValue={myScore?.comments ?? ""} />
                  </Field>
                </div>
                <SubmitButton size="sm" pendingLabel="Saving…">{myScore ? "Update score" : "Submit score"}</SubmitButton>
              </form>
            </>
          )}
        </Card>
      )}

      {canRoute && (
        <Card>
          <SectionHeader>Routing</SectionHeader>
          {app.routedDepartmentCode ? (
            <p className="mt-3 text-sm text-foreground-soft">
              Routed to <strong className="text-foreground">{app.routedDepartmentCode}</strong>
              {routedOffChoice && <Badge tone="warning" className="ml-2">off-choice</Badge>}
            </p>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">Not routed yet. Applicant ranked: {app.departmentChoices.join(", ") || "(none)"}.</p>
          )}
          <form action={routeAction.bind(null, id, applicationId)} className="mt-4 flex flex-wrap items-end gap-3 border-t border-border-subtle pt-4">
            <div className="w-40">
              <Field label={app.routedDepartmentCode ? "Re-route to" : "Route to"}>
                <Select name="departmentCode" required defaultValue={app.routedDepartmentCode ?? ""}>
                  <option value="" disabled>Select…</option>
                  {app.cycle.departments.map((d) => (
                    <option key={d} value={d}>
                      {d}{app.departmentChoices.includes(d) ? " (ranked)" : ""}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <SubmitButton size="sm" pendingLabel="Routing…">Route</SubmitButton>
          </form>
        </Card>
      )}

      {app.cycle.track === "DIRECTOR" ? (
        <Card>
          <SectionHeader>Interview</SectionHeader>
          {existingInterviews.length > 0 && (
            <ul className="mt-3 space-y-1 text-sm">
              {existingInterviews.map((iv) => (
                <li key={iv.id}>
                  <Link className="font-medium text-brand-fg hover:text-brand-hover" href={`/recruitment/interviews/${iv.id}`}>
                    Interview for {iv.departmentCode}
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {scheduleChoices.length > 0 ? (
            <form action={scheduleInterviewAction.bind(null, id, applicationId)} className="mt-4 flex flex-wrap items-end gap-3 border-t border-border-subtle pt-4">
              <div className="w-40">
                <Field label="Department">
                  <Select name="departmentCode" required>
                    {scheduleChoices.map((d) => (<option key={d} value={d}>{d}</option>))}
                  </Select>
                </Field>
              </div>
              <SubmitButton size="sm" pendingLabel="Scheduling…">Schedule interview</SubmitButton>
            </form>
          ) : existingInterviews.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">No eligible department to interview for in your scope.</p>
          ) : null}
        </Card>
      ) : (
        <Card>
          <SectionHeader>Department decision</SectionHeader>
          {!app.routedDepartmentCode ? (
            app.decision !== "PENDING" ? (
              <div className="mt-3 space-y-2">
                <p className="text-sm text-foreground-soft">
                  This applicant was <strong className="text-foreground">{decisionLabel[app.decision as keyof typeof decisionLabel]}</strong> without routing.
                  {app.decisionNotes ? ` ${app.decisionNotes}` : ""}
                </p>
                {scope.all && (
                  <form action={reopenDecisionAction.bind(null, id, applicationId)}>
                    <SubmitButton size="sm" variant="outline" pendingLabel="Reopening…">Reopen</SubmitButton>
                  </form>
                )}
              </div>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">Awaiting committee routing.</p>
            )
          ) : canDecideRouted ? (
            <>
              <p className="mt-3 text-sm text-foreground-soft">
                Routed to <strong className="text-foreground">{app.routedDepartmentCode}</strong>. Decide directly from the committee score (no interview).
              </p>
              {emailedAcceptance && (
                <RescindAcceptanceNotice
                  departmentCode={app.routedDepartmentCode}
                  canRescind={scope.all}
                  action={rescindAcceptanceAction.bind(null, id, applicationId, emailedAcceptance.id)}
                />
              )}
              <form action={decideRoutedAction.bind(null, id, applicationId)} className="mt-4 flex flex-wrap items-end gap-3 border-t border-border-subtle pt-4">
                <div className="w-40">
                  <Field label="Outcome">
                    <Select name="outcome" required defaultValue={app.decision === "PENDING" ? "ACCEPT" : app.decision}>
                      <option value="ACCEPT">Accept</option>
                      <option value="REJECT">Reject</option>
                      <option value="WAITLIST">Waitlist</option>
                    </Select>
                  </Field>
                </div>
                <div className="min-w-[12rem] flex-1">
                  <Field label="Notes" hint="Optional.">
                    <Input name="notes" />
                  </Field>
                </div>
                <SubmitButton size="sm" pendingLabel="Recording…">Record decision</SubmitButton>
              </form>
              {app.decision !== "PENDING" && app.decidedAt && (
                <p className="mt-2 text-xs text-subtle-foreground">
                  {decisionLabel[app.decision as keyof typeof decisionLabel]} · recorded <DateTime value={app.decidedAt} />
                  {app.decisionNotes ? ` · ${app.decisionNotes}` : ""}
                </p>
              )}
            </>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">Routed to {app.routedDepartmentCode}. Waiting on the department to decide.</p>
          )}
        </Card>
      )}
    </div>
  );
}
