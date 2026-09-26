import { z } from "zod";
import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { listCycles, listArchivedCycles } from "@/modules/recruitment/services/cycles";
import {
  reviewScope,
  listApplicantsForReview,
  listReviewableCycles,
  listWaitlisted,
  awaitingRoutingCount,
  recordApplicationView,
  type ReviewApplication,
} from "@/modules/recruitment/services/review";
import { loadReviewApplication } from "@/modules/recruitment/services/speed-score";
import { listInterviewsForReview } from "@/modules/recruitment/services/interviews";
import { committeeScoreSummary } from "@/modules/recruitment/services/committee-scoring";
import { reviewerIdentity } from "@/modules/recruitment/services/own-application";
import { isOwnApplication } from "@/modules/recruitment/engine/own-application";
import { applicantTypeLabel } from "@/modules/recruitment/engine/visibility";
import { scoreAverage } from "@/modules/recruitment/engine/scoring";
import { applicationStage, applicationStageLabel } from "@/modules/recruitment/engine/application-stage";
import { rosterDecision, type RosterDecisionStatus } from "@/modules/recruitment/engine/decision-summary";
import { filterApplicantsByDepartment } from "@/modules/recruitment/engine/applicant-department";
import { interviewStatus } from "@/modules/recruitment/components/interview-cells";
import { DECISION_LABELS } from "@/modules/recruitment/components/status-badge";

/**
 * Read-only tools for the per-user recruitment MCP server: a recruitment staff
 * member asking Claude to analyse a cycle they already work in the Hub.
 *
 * The one rule every tool here follows: return exactly what the Hub shows this
 * person for the same thing, never more. That is enforced by reusing the page's
 * own service calls and the page's own permission checks, not by re-deriving
 * either here. Each tool names the page it mirrors, and where a page gates a
 * piece of a record more tightly than the record itself (committee score
 * comments, decision notes), the tool copies that gate line for line. If a page
 * changes what it shows, the tool mirroring it should change with it.
 *
 * The caller is `ctx.personId`, verified upstream by the OAuth layer. No input
 * schema here names a person, and the registry test asserts that.
 *
 * Deliberately never returned, whatever the caller holds:
 *  - Uploaded files: no contents, no download or inline URLs, no stored names.
 *    A FILE answer becomes a fixed placeholder string; a SIGNATURE answer is
 *    already "Signed" in loadReviewApplication and stays that way.
 *  - Onboarding contracts (date of birth, Epic id, signatures, HIPAA/photo
 *    blobs), invite token hashes, and phone numbers. None of the pages mirrored
 *    here show them.
 *
 * Output is compact JSON, because the consumer is a model doing analysis, not a
 * person reading a chat bubble. Every list is bounded (limit/offset) and reports
 * `total`, so a truncated answer can never be mistaken for a complete one.
 */

export type RecruitmentToolContext = { personId: string };

export type RecruitmentTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  run: (ctx: RecruitmentToolContext, args: Record<string, unknown>) => Promise<string>;
};

/**
 * One refusal per kind of thing, identical whether the thing does not exist or
 * the caller may not see it. A different message for "exists but not yours"
 * would let a caller probe ids to learn which applications are real.
 */
export const NO_RECRUITMENT_ACCESS = "You do not have access to recruitment in the Hub.";
export const CYCLE_REFUSAL = "No recruitment cycle with that id is available to you.";
export const APPLICATION_REFUSAL = "No application with that id is available to you.";
export const INVALID_INPUT = "The arguments to this tool were not valid.";

/** Stands in for a FILE answer. The file itself never leaves the Hub. */
export const FILE_PLACEHOLDER = "[uploaded file: not available through this connector]";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const pagingShape = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(`How many rows to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`),
  offset: z.number().int().min(0).optional().describe("How many rows to skip, for paging. Default 0."),
};

function page<T>(rows: T[], args: { limit?: number; offset?: number }) {
  const limit = args.limit ?? DEFAULT_LIMIT;
  const offset = args.offset ?? 0;
  return { total: rows.length, offset, limit, rows: rows.slice(offset, offset + limit) };
}

/** Validates inside run() too: the route's schema check is not the only caller. */
function parseArgs<S extends z.ZodTypeAny>(schema: S, args: Record<string, unknown>): z.infer<S> | null {
  const parsed = schema.safeParse(args ?? {});
  return parsed.success ? parsed.data : null;
}

/** Mean to one decimal place, the precision every score surface in the Hub prints. */
function round1(n: number | null): number | null {
  return n == null ? null : Math.round(n * 10) / 10;
}

type Caller = {
  scope: Awaited<ReturnType<typeof reviewScope>>;
  hasAccess: boolean;
  canScorePerm: boolean;
  isStaff: boolean;
};

/**
 * The gate every /recruitment/cycles/** page sits behind (requireRecruitmentStaff
 * in cycles/access.ts): module access, committee scoring, or a review scope
 * (review_all or a directed department). Resolved once per call so each tool
 * reads the same booleans the page would.
 */
async function resolveCaller(personId: string): Promise<Caller> {
  const [scope, hasAccess, canScorePerm] = await Promise.all([
    reviewScope(personId),
    can(personId, "recruitment.access"),
    can(personId, "recruitment.score"),
  ]);
  const isStaff = hasAccess || canScorePerm || scope.all || scope.departmentCodes.length > 0;
  return { scope, hasAccess, canScorePerm, isStaff };
}

type CycleRow = {
  id: string;
  title: string;
  track: string;
  status: string;
  termName?: string | null;
  opensAt?: string | null;
  closesAt?: string | null;
  decisionsReleasedAt?: string | null;
};

/**
 * The cycles the /recruitment index lists for this caller. A recruitment.access
 * holder sees every cycle (active and archived) and can open each one's
 * overview, which shows the window and release date, so they get those fields.
 * Anyone else gets listReviewableCycles, which the page renders as title,
 * track and status only.
 */
async function visibleCycles(personId: string, caller: Caller): Promise<CycleRow[]> {
  if (caller.hasAccess) {
    const [active, archived] = await Promise.all([listCycles(), listArchivedCycles()]);
    const all = [...active, ...archived];
    const terms = await prisma.term.findMany({
      where: { id: { in: [...new Set(all.map((c) => c.termId))] } },
      select: { id: true, name: true },
    });
    const termName = new Map(terms.map((t) => [t.id, t.name]));
    return all.map((c) => ({
      id: c.id,
      title: c.title,
      track: c.track,
      status: c.status,
      termName: termName.get(c.termId) ?? null,
      opensAt: c.opensAt?.toISOString() ?? null,
      closesAt: c.closesAt?.toISOString() ?? null,
      decisionsReleasedAt: c.decisionsReleasedAt?.toISOString() ?? null,
    }));
  }
  const cycles = await listReviewableCycles(personId);
  return cycles.map((c) => ({ id: c.id, title: c.title, track: c.track, status: c.status }));
}

/**
 * The applicant roster for a cycle, or null when the caller may not see the
 * cycle at all. "See the cycle" is: it is in their list_cycles answer, or the
 * scoped roster hands them at least one application in it. Stricter than the
 * applicants page, which renders an empty roster for any staff member who
 * guesses a cycle id; here a guessed id is indistinguishable from a bad one.
 */
async function rosterFor(
  personId: string,
  cycleId: string,
): Promise<{ caller: Caller; cycle: { id: string; title: string; track: string; status: string }; apps: ReviewApplication[] } | null> {
  const caller = await resolveCaller(personId);
  if (!caller.isStaff) return null;
  const cycle = await prisma.recruitmentCycle.findUnique({
    where: { id: cycleId },
    select: { id: true, title: true, track: true, status: true },
  });
  if (!cycle) return null;
  const apps = await listApplicantsForReview(cycleId, personId);
  if (apps.length === 0) {
    const listed = caller.hasAccess || (await listReviewableCycles(personId)).some((c) => c.id === cycleId);
    if (!listed) return null;
  }
  return { caller, cycle, apps };
}

/** The same derivation the applicants page's Stage column uses. */
function stageOf(a: ReviewApplication) {
  return applicationStage({
    scoreCount: a.committeeScores.length,
    routedDepartmentCode: a.routedDepartmentCode,
    returnedToRoutingAt: a.returnedToRoutingAt,
    applicationDecision: a.decision,
    interviews: a.interviews,
  });
}

function decisionOf(a: ReviewApplication) {
  return rosterDecision({
    acceptances: a.acceptances,
    applicationDecision: a.decision,
    interviews: a.interviews,
    dualAppointments: a.dualAppointments,
  });
}

function countBy<T>(rows: T[], key: (row: T) => string | string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const k = key(row);
    for (const one of Array.isArray(k) ? k : [k]) out[one] = (out[one] ?? 0) + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// list_cycles
// ---------------------------------------------------------------------------

/**
 * Mirrors the /recruitment index page (src/app/(app)/recruitment/page.tsx).
 * Returns { cycles: CycleRow[] }, where the window/term/release fields are
 * present only for a recruitment.access holder (see visibleCycles).
 */
export const listCyclesTool: RecruitmentTool = {
  name: "list_cycles",
  title: "List recruitment cycles",
  description:
    "Recruitment cycles you can see in the Hub, with id, title, track (VOLUNTEER or DIRECTOR) and status. Recruitment staff also get the term, application window and decisions-released date. Call this first to get a cycle_id for the other tools.",
  inputSchema: z.object({}),
  run: async (ctx) => {
    const caller = await resolveCaller(ctx.personId);
    if (!caller.isStaff) return NO_RECRUITMENT_ACCESS;
    const cycles = await visibleCycles(ctx.personId, caller);
    return JSON.stringify({ total: cycles.length, cycles });
  },
};

// ---------------------------------------------------------------------------
// cycle_summary
// ---------------------------------------------------------------------------

const cycleSummarySchema = z.object({
  cycle_id: z.string().min(1).describe("A cycle id from list_cycles."),
});

/**
 * Aggregates over exactly the rows the applicants page would list for this
 * caller (listApplicantsForReview). Scores follow that page's Committee avg
 * column: every visible row counts, except the caller's own application, which
 * the service already returns with no scores and which is counted separately
 * here so it is never read as "unscored".
 *
 * Returns { cycle, totalSubmitted, byStage, byDecision, byApplicantType,
 * byRoutedDepartment, byFirstChoiceDepartment, invited, scoring,
 * awaitingRoutingOutsideScope? }.
 */
export const cycleSummaryTool: RecruitmentTool = {
  name: "cycle_summary",
  title: "Recruitment cycle summary",
  description:
    "Counts over the submitted applications you can see in one cycle: by stage, by decision, by applicant type, by routed department and by first-choice department, plus committee-scoring coverage. Scoped exactly like your Applicants page in the Hub. byDecision is each applicant's OVERALL outcome, the Applicants page's Decision column: an acceptance anywhere outranks a waitlist, so an applicant waitlisted by one department but accepted by another counts as accepted here, not waitlisted. list_waitlist counts every open waitlist entry instead, so its total can be higher.",
  inputSchema: cycleSummarySchema,
  run: async (ctx, args) => {
    const input = parseArgs(cycleSummarySchema, args);
    if (!input) return INVALID_INPUT;
    const roster = await rosterFor(ctx.personId, input.cycle_id);
    if (!roster) return CYCLE_REFUSAL;
    const { cycle, apps } = roster;

    const scorable = apps.filter((a) => !a.isOwnApplication);
    const scored = scorable.filter((a) => a.committeeScores.length > 0);
    const totalScores = scorable.reduce((n, a) => n + a.committeeScores.length, 0);
    const averages = scored.map((a) => scoreAverage(a.committeeScores.map((c) => c.score)).average as number);

    // The applicants page tells a scoped director how many unrouted submissions
    // exist when their own list is empty, so an empty list is not read as
    // "nobody applied". Same condition, same number.
    const awaitingRouting = apps.length === 0 ? await awaitingRoutingCount(cycle.id, ctx.personId) : 0;

    return JSON.stringify({
      cycle,
      totalSubmitted: apps.length,
      byStage: countBy(apps, (a) => applicationStageLabel[stageOf(a)]),
      byDecision: countBy(apps, (a) => decisionOf(a).status),
      byApplicantType: countBy(apps, (a) => applicantTypeLabel(a.applicantType)),
      byRoutedDepartment: countBy(apps, (a) => a.routedDepartmentCode ?? "(not routed)"),
      byFirstChoiceDepartment: countBy(apps, (a) => a.departmentChoices[0] ?? "(none)"),
      invited: apps.filter((a) => a.invited).length,
      scoring: {
        withAtLeastOneScore: scored.length,
        withNoScore: scorable.length - scored.length,
        totalScores,
        meanScoresPerApplication: scorable.length ? round1(totalScores / scorable.length) : null,
        meanOfApplicationAverages: averages.length ? round1(averages.reduce((s, x) => s + x, 0) / averages.length) : null,
        ownApplicationExcluded: apps.length - scorable.length,
      },
      ...(awaitingRouting > 0 ? { awaitingRoutingOutsideScope: awaitingRouting } : {}),
    });
  },
};

// ---------------------------------------------------------------------------
// list_applicants
// ---------------------------------------------------------------------------

const DECISION_FILTERS = ["ACCEPTED", "WAITLIST", "REJECTED", "NONE"] as const satisfies readonly RosterDecisionStatus[];

const listApplicantsSchema = z.object({
  cycle_id: z.string().min(1).describe("A cycle id from list_cycles."),
  ...pagingShape,
  department_code: z
    .string()
    .optional()
    .describe("Only rows answering for this department: the routed department once routed, else any ranked choice (the Hub's Department filter)."),
  decision: z.enum(DECISION_FILTERS).optional().describe("Only rows with this roster decision (the Hub's Decision filter)."),
  applicant_type: z.enum(["NEW", "RENEWAL", "TRANSFER"]).optional().describe("Only rows of this applicant type."),
});

/**
 * One row per application, mirroring the columns and badges of the applicants
 * page (src/app/(app)/recruitment/cycles/[id]/applicants/page.tsx): name (+
 * Invited and Dual badges), email, type, committee avg, stage (+ Dual fallback
 * badge), ranked choices (+ Routed badge), decision. Nothing the page does not
 * render: no netId, no phone, no answers, no per-interview detail (that is
 * list_interviews, behind the interviews page's own gate).
 *
 * Returns { cycle, total, offset, limit, rows }.
 */
export const listApplicantsTool: RecruitmentTool = {
  name: "list_applicants",
  title: "List applicants in a cycle",
  description:
    "The applicant roster for one cycle, as your Applicants page in the Hub shows it: name, email, type, committee average and score count, stage, ranked departments, routed department, decision, and invited/dual badges. Paged; `total` is the full filtered count. Use get_application for one applicant's answers.",
  inputSchema: listApplicantsSchema,
  run: async (ctx, args) => {
    const input = parseArgs(listApplicantsSchema, args);
    if (!input) return INVALID_INPUT;
    const roster = await rosterFor(ctx.personId, input.cycle_id);
    if (!roster) return CYCLE_REFUSAL;
    const { cycle, apps } = roster;

    let filtered = filterApplicantsByDepartment(apps, input.department_code ?? null);
    if (input.decision) filtered = filtered.filter((a) => decisionOf(a).status === input.decision);
    if (input.applicant_type) filtered = filtered.filter((a) => a.applicantType === input.applicant_type);

    const paged = page(filtered, input);
    const rows = paged.rows.map((a) => {
      const d = decisionOf(a);
      const dual = a.dualAppointments.find((x) => x.status === "PENDING" || x.status === "APPROVED");
      const summary = scoreAverage(a.committeeScores.map((c) => c.score));
      return {
        applicationId: a.id,
        name: `${a.applicant.firstName} ${a.applicant.lastName}`,
        email: a.applicant.email,
        applicantType: applicantTypeLabel(a.applicantType),
        invited: a.invited,
        // The page prints "Hidden: your application" in place of a score.
        committee: a.isOwnApplication
          ? { hidden: "your own application" }
          : { average: round1(summary.average), count: summary.count },
        stage: applicationStageLabel[stageOf(a)],
        dualFallback: Boolean(a.dualFallbackAt && a.routedDepartmentCode),
        departmentChoices: a.departmentChoices,
        routedDepartmentCode: a.routedDepartmentCode,
        decision: d.status === "NONE" ? null : d.label,
        decisionStatus: d.status,
        acceptedDepartments: d.departments,
        dualAppointment: dual ? { departmentCode: dual.departmentCode, status: dual.status } : null,
      };
    });
    return JSON.stringify({ cycle, total: paged.total, offset: paged.offset, limit: paged.limit, rows });
  },
};

// ---------------------------------------------------------------------------
// get_application
// ---------------------------------------------------------------------------

const getApplicationSchema = z.object({
  application_id: z.string().min(1).describe("An applicationId from list_applicants."),
});

/**
 * One application, mirroring the applicant detail page
 * (src/app/(app)/recruitment/cycles/[id]/applicants/[applicationId]/page.tsx).
 *
 * Answers come from loadReviewApplication, the speed-score loader, which
 * resolves option labels, drops never-asked and empty fields, renders a
 * signature as "Signed", and re-checks canViewApplication. Its FILE rows are
 * rewritten to FILE_PLACEHOLDER with the file object dropped, so no href or
 * file name reaches the output.
 *
 * Decision, scores and routing follow the detail page's own conditions, quoted
 * inline below. Returns { applicationId, cycleId, cycleTitle, track, status,
 * name, email, applicantType, departmentChoices, routedDepartmentCode,
 * acceptedDepartments, decision, interviews, sections, history,
 * committeeScores }.
 *
 * Refuses DRAFT applications even though the detail page will render one for a
 * cycle manager who has its URL: nothing in the Hub links to a draft, and an
 * unsubmitted form is not something a reviewer is meant to be reading.
 */
export const getApplicationTool: RecruitmentTool = {
  name: "get_application",
  title: "Get one application",
  description:
    "One applicant's full application as your Hub detail page shows it: answers by section (uploaded files are not available; signatures show as 'Signed'), past applications, routing, decision, and the committee scores you are allowed to see. Opening it is recorded in the Hub's access log, the same as opening the page.",
  inputSchema: getApplicationSchema,
  run: async (ctx, args) => {
    const input = parseArgs(getApplicationSchema, args);
    if (!input) return INVALID_INPUT;
    const personId = ctx.personId;
    const caller = await resolveCaller(personId);
    // The cycles-subtree gate runs before the detail page does.
    if (!caller.isStaff) return APPLICATION_REFUSAL;

    const loaded = await loadReviewApplication(input.application_id, personId);
    // "not found" and "can't view" come back as different strings; collapse them.
    if ("error" in loaded) return APPLICATION_REFUSAL;

    const app = await prisma.application.findUnique({
      where: { id: input.application_id },
      include: {
        cycle: { select: { id: true, title: true, track: true } },
        applicant: { select: { netId: true, emailLower: true, applicantPersonId: true } },
        acceptances: { select: { departmentCode: true } },
        interviews: { select: { id: true, departmentCode: true, decision: true } },
        dualAppointments: { select: { departmentCode: true, status: true } },
      },
    });
    if (!app || app.status === "DRAFT") return APPLICATION_REFUSAL;

    // Past every access check, so this logs a permitted view, exactly where the
    // detail page calls it. Ten-minute dedupe lives in the service.
    await recordApplicationView(personId, app.id);

    const { scope, canScorePerm } = caller;
    const canScore = scope.all || canScorePerm;
    // "Director of the routed department (or SRR) may record the volunteer decision."
    const canDecideRouted = app.routedDepartmentCode
      ? scope.all || scope.departmentCodes.includes(app.routedDepartmentCode)
      : false;
    const own = isOwnApplication(app.applicant, await reviewerIdentity(personId));

    // Committee score card. The page renders it only for (canScore ||
    // canDecideRouted); names every score and comment only for (scope.all ||
    // canDecideRouted); otherwise shows the average and the caller's own score.
    let committeeScores: unknown = null;
    if (canScore || canDecideRouted) {
      if (own) {
        committeeScores = { hidden: "your own application" };
      } else {
        const summary = await committeeScoreSummary(app.id);
        const showEveryScore = scope.all || canDecideRouted;
        const mine = summary.scores.find((s) => s.scorerId === personId);
        committeeScores = {
          average: round1(summary.average),
          count: summary.count,
          ...(showEveryScore
            ? { scores: summary.scores.map((s) => ({ scorer: s.scorer.name, score: s.score, comments: s.comments })) }
            : { myScore: mine ? { score: mine.score, comments: mine.comments } : null }),
        };
      }
    }

    // Decision card (volunteer track). Notes appear only where the page prints
    // them: an unrouted decided application (to every viewer), a returned one
    // (who returned it and why), or a routed one for its deciding director / SRR.
    // A routed application seen by anyone else reads "Waiting on the department
    // to decide" on the page, so only the roster-level label is given.
    const roster = rosterDecision({
      acceptances: app.acceptances,
      applicationDecision: app.decision,
      interviews: app.interviews,
      dualAppointments: app.dualAppointments,
    });
    let decisionDetail: Record<string, unknown> | null = null;
    if (app.cycle.track === "VOLUNTEER") {
      if (!app.routedDepartmentCode) {
        if (app.decision !== "PENDING") {
          decisionDetail = { decision: DECISION_LABELS[app.decision], withoutRouting: true, notes: app.decisionNotes };
        } else if (app.returnedToRoutingAt) {
          decisionDetail = {
            returnedForRerouting: {
              fromDepartment: app.returnedFromDepartmentCode,
              at: app.returnedToRoutingAt.toISOString(),
              reason: app.returnedReason,
            },
          };
        }
      } else if (canDecideRouted) {
        decisionDetail = {
          decision: DECISION_LABELS[app.decision],
          decidedAt: app.decidedAt?.toISOString() ?? null,
          notes: app.decision !== "PENDING" && app.decidedAt ? app.decisionNotes : null,
          dualFallbackFrom: app.dualFallbackAt ? (app.dualFallbackFromDepartmentCode ?? "recruitment lead") : null,
        };
      }
    }

    const view = loaded.view;
    return JSON.stringify({
      applicationId: app.id,
      cycleId: app.cycle.id,
      cycleTitle: app.cycle.title,
      track: app.cycle.track,
      status: app.status,
      withdrawnAt: app.status === "WITHDRAWN" ? (app.withdrawnAt?.toISOString() ?? null) : undefined,
      name: view.name,
      email: view.email,
      applicantType: view.typeLabel,
      departmentChoices: view.departmentChoices,
      routedDepartmentCode: app.routedDepartmentCode,
      acceptedDepartments: roster.departments,
      decision: roster.status === "NONE" ? null : roster.label,
      decisionDetail,
      // Director track: the page lists each interview by department and links out.
      interviews: app.cycle.track === "DIRECTOR" ? app.interviews.map((i) => ({ interviewId: i.id, departmentCode: i.departmentCode })) : undefined,
      sections: view.sections.map((s) => ({
        title: s.title,
        fields: s.fields.map((f) => ({
          label: f.label,
          kind: f.kind,
          value: f.kind === "file" ? FILE_PLACEHOLDER : f.displayValue,
        })),
      })),
      history: {
        summary: view.history.summary,
        rows: view.history.rows.map((r) => ({ title: r.title, meta: r.meta, badge: r.badge })),
      },
      committeeScores,
    });
  },
};

// ---------------------------------------------------------------------------
// list_interviews
// ---------------------------------------------------------------------------

const listInterviewsSchema = z.object({
  cycle_id: z.string().min(1).describe("A cycle id from list_cycles."),
  ...pagingShape,
});

/**
 * Mirrors the cycle interviews page (src/app/(app)/recruitment/cycles/[id]/interviews/page.tsx),
 * which requires recruitment.access and lists listInterviewsForReview's rows:
 * candidate, department, status, time, panel size, evaluation progress.
 *
 * Evaluations (evaluator, score, comments) are added because the interview
 * detail page shows them to anyone past its canView gate, and every row this
 * service returns passes that gate: listInterviewsForReview returns all rows
 * only for review_all/manage_cycles (both "isStaff" on the detail page) and
 * otherwise only the caller's own departments' rows (also "isStaff").
 *
 * Not returned: the Zoom link, internal notes and the note to the applicant.
 * The detail page shows those only to a deciding director (canManage) or a
 * panelist, and this tool does not reproduce that per-row split.
 *
 * Returns { cycle, total, offset, limit, rows }.
 */
export const listInterviewsTool: RecruitmentTool = {
  name: "list_interviews",
  title: "List interviews in a cycle",
  description:
    "Director-track interviews in one cycle that your Hub Interviews page shows you: candidate, department, status (Offered, Scheduled, a decision, or Withdrawn), scheduled time, panel size, and each panelist's evaluation score and comments. Paged; `total` is the full count.",
  inputSchema: listInterviewsSchema,
  run: async (ctx, args) => {
    const input = parseArgs(listInterviewsSchema, args);
    if (!input) return INVALID_INPUT;
    // The page's own gate is requirePermission("recruitment.access").
    if (!(await can(ctx.personId, "recruitment.access"))) return CYCLE_REFUSAL;
    const cycle = await prisma.recruitmentCycle.findUnique({
      where: { id: input.cycle_id },
      select: { id: true, title: true, track: true, status: true },
    });
    if (!cycle) return CYCLE_REFUSAL;

    const interviews = await listInterviewsForReview(cycle.id, ctx.personId);
    const paged = page(interviews, input);
    const evaluatorIds = [...new Set(paged.rows.flatMap((iv) => iv.evaluations.map((e) => e.evaluatorId)))];
    const evaluators = evaluatorIds.length
      ? await prisma.person.findMany({ where: { id: { in: evaluatorIds } }, select: { id: true, name: true } })
      : [];
    const evaluatorName = new Map(evaluators.map((p) => [p.id, p.name]));

    const rows = paged.rows.map((iv) => {
      const avg = scoreAverage(iv.evaluations.map((e) => e.score));
      return {
        interviewId: iv.id,
        applicationId: iv.applicationId,
        candidate: `${iv.application.applicant.firstName} ${iv.application.applicant.lastName}`,
        departmentCode: iv.departmentCode,
        status: interviewStatus(iv).label,
        scheduledAt: iv.scheduledAt?.toISOString() ?? null,
        panelists: iv.panelists.length,
        evaluationsDone: Math.min(iv.evaluations.length, iv.panelists.length),
        evaluationAverage: round1(avg.average),
        evaluations: iv.evaluations.map((e) => ({
          evaluator: evaluatorName.get(e.evaluatorId) ?? null,
          score: e.score,
          comments: e.comments,
        })),
      };
    });
    return JSON.stringify({ cycle, total: paged.total, offset: paged.offset, limit: paged.limit, rows });
  },
};

// ---------------------------------------------------------------------------
// list_waitlist
// ---------------------------------------------------------------------------

const listWaitlistSchema = z.object({
  cycle_id: z.string().min(1).describe("A cycle id from list_cycles."),
  ...pagingShape,
});

/**
 * Mirrors the waitlist page (src/app/(app)/recruitment/cycles/[id]/waitlist/page.tsx):
 * recruitment.access, then listWaitlisted's scoped entries as name, email and
 * department. One entry per waitlisted decision, so a director-track applicant
 * waitlisted by two departments appears twice, as on the page.
 *
 * An applicant can also sit on one department's waitlist while ACCEPTED by
 * another (routed to VADC and waitlisted there, accepted into PNLC through a
 * dual appointment -- a real Fall 2026 case). The Waitlist page lists them,
 * and so does this tool; cycle_summary's byDecision counts them as accepted,
 * because the Applicants page's Decision column does. A consumer comparing the
 * two numbers found the gap and guessed at double counting, so each row now
 * carries acceptedElsewhere, and the response reports distinct applications
 * alongside entries, rather than leaving the reconciliation to inference.
 *
 * Returns { cycle, total, applications, acceptedElsewhere, offset, limit, rows }.
 */
export const listWaitlistTool: RecruitmentTool = {
  name: "list_waitlist",
  title: "List a cycle's waitlist",
  description:
    "Open waitlist entries in one cycle, scoped as your Hub Waitlist page shows them: name, email, and the department that waitlisted them. One row per waitlisting decision: `total` counts entries, `applications` counts distinct applicants. An applicant can be on one department's waitlist while accepted by another; those rows carry acceptedElsewhere (the accepting departments) and `acceptedElsewhere` counts them. That is why this total can exceed cycle_summary's WAITLIST count, which reports each applicant's overall outcome. Paged.",
  inputSchema: listWaitlistSchema,
  run: async (ctx, args) => {
    const input = parseArgs(listWaitlistSchema, args);
    if (!input) return INVALID_INPUT;
    if (!(await can(ctx.personId, "recruitment.access"))) return CYCLE_REFUSAL;
    const cycle = await prisma.recruitmentCycle.findUnique({
      where: { id: input.cycle_id },
      select: { id: true, title: true, track: true, status: true },
    });
    if (!cycle) return CYCLE_REFUSAL;
    const entries = await listWaitlisted(cycle.id, ctx.personId);
    // Acceptances for every waitlisted application, in one query. Accepted
    // departments are already on the Applicants page for anyone who can see
    // this cycle's waitlist (recruitment.access sees the whole roster).
    const applicationIds = [...new Set(entries.map((e) => e.applicationId))];
    const acceptances = await prisma.acceptance.findMany({
      where: { applicationId: { in: applicationIds } },
      select: { applicationId: true, departmentCode: true },
    });
    const acceptedIn = new Map<string, string[]>();
    for (const a of acceptances) acceptedIn.set(a.applicationId, [...(acceptedIn.get(a.applicationId) ?? []), a.departmentCode]);

    const paged = page(entries, input);
    const rows = paged.rows.map((e) => ({
      applicationId: e.applicationId,
      name: e.applicantName,
      email: e.applicantEmail,
      departmentCode: e.departmentCode,
      interviewId: e.interviewId,
      acceptedElsewhere: acceptedIn.get(e.applicationId) ?? null,
    }));
    return JSON.stringify({
      cycle,
      total: paged.total,
      applications: applicationIds.length,
      acceptedElsewhere: applicationIds.filter((id) => acceptedIn.has(id)).length,
      offset: paged.offset,
      limit: paged.limit,
      rows,
    });
  },
};

export const RECRUITMENT_TOOLS: RecruitmentTool[] = [
  listCyclesTool,
  cycleSummaryTool,
  listApplicantsTool,
  getApplicationTool,
  listInterviewsTool,
  listWaitlistTool,
];
