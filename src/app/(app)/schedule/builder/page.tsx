/**
 * Schedule Builder page.
 *
 * Gate: requireModuleAccess("schedule").
 * Scope: per-department; actor must manage at least one department.
 *
 * URL params:
 *   ?dept=<departmentId>   -- selected department
 *   ?date=<YYYY-MM-DD>     -- selected clinic date
 *   ?view=grid             -- show the Grid view; default (absent) is the Day view
 *   ?gmode=shadow          -- Grid view only: empty-cell click assigns SHADOW;
 *                             default (absent) assigns VOLUNTEER
 *   ?mode=availability      -- show the availability-override editor (over either view)
 */

import { requireModuleAccess } from "@/platform/auth/session";
import { Alert } from "@/platform/ui/alert";
import { Button } from "@/platform/ui/button";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { cx } from "@/platform/ui/cx";
import { PageHeader } from "@/platform/ui/page-header";
import { SectionHeader } from "@/platform/ui/section-header";
import { formatCalendarDate } from "@/platform/dates";
import { redirect } from "next/navigation";
import { runAction } from "@/platform/actions";
import {
  // Aliased: this file also declares a local `builderView` holding the
  // resolved BuilderView ("day" | "grid" | "availability") from
  // resolveBuilderView -- the service export keeps its real name.
  builderView as loadBuilderView,
  canManageAnyScheduleDept,
  setAssignment,
  toggleTag,
  setAvailabilityOverride,
  acknowledgeAvailability,
  setPatientsBooked,
  parseBookedCount,
  BuilderForbiddenError,
  BuilderValidationError,
} from "@/modules/schedule/services/builder";
import {
  listDepartmentRequests,
  approveRequest,
  denyRequest,
  canManageRequestsForDept,
  RequestForbiddenError,
  RequestNotFoundError,
  RequestValidationError,
} from "@/modules/schedule/services/requests";
import { publishSchedule, unpublishSchedule, isPublished, PublicationError } from "@/modules/schedule/services/publication";
import { captureEvent } from "@/platform/posthog/capture";
import { activeTermGroup } from "@/platform/posthog/groups";
import { getWorkingTerm } from "@/platform/terms/working-term";
import { getActiveTerm } from "@/platform/terms/active-term";
import { buildTermOptions } from "@/platform/terms/term-options";
import { prisma } from "@/platform/db";
import { BuilderGrid } from "@/modules/schedule/components/builder-grid";
import { BuilderDayView } from "@/modules/schedule/components/builder-day-view";
import { BuilderAvailabilityView } from "@/modules/schedule/components/builder-availability-view";
import { BuilderToolbar, resolveBuilderView } from "@/modules/schedule/components/builder-toolbar";
import { ClinicDateStrip } from "@/modules/schedule/components/clinic-date-strip";
import { CapacityPanel } from "@/modules/schedule/components/capacity-panel";
import { ReadinessPanel } from "@/modules/schedule/components/readiness-panel";
import { PendingRequests } from "@/modules/schedule/components/pending-requests";
import { displayTodayKey } from "@/platform/dates/today";
import Link from "next/link";

// ---------------------------------------------------------------------------
// Booked-count parsing
// ---------------------------------------------------------------------------

/**
 * Parse a booked-count form field: empty -> null; otherwise require a
 * non-negative integer. Rejects NaN, negatives, and fractional input so a blank
 * or malformed value never persists as NaN or a negative count. Throws
 * BuilderValidationError (a domain error runAction turns into an inline error
 * redirect); call it inside an action's `work` closure so the throw is caught.
 */
// Moved to services/builder.ts so the attending grid validates the same way.
// Re-exported name kept in scope via the import above.

// ---------------------------------------------------------------------------
// Page props
// ---------------------------------------------------------------------------

type PageProps = {
  searchParams: Promise<{
    dept?: string;
    date?: string;
    view?: string;
    mode?: string;
    gmode?: string;
    term?: string;
  }>;
};

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

type HrefParams = {
  dept?: string | null;
  date?: string | null;
  view?: string | null;
  mode?: string | null;
  gmode?: string | null;
  term?: string | null;
  error?: string;
  message?: string;
};

function buildHref(base: string, p: HrefParams): string {
  const params = new URLSearchParams();
  if (p.dept) params.set("dept", p.dept);
  if (p.date) params.set("date", p.date);
  if (p.view) params.set("view", p.view);
  if (p.mode) params.set("mode", p.mode);
  if (p.gmode) params.set("gmode", p.gmode);
  if (p.term) params.set("term", p.term);
  if (p.error) params.set("error", p.error);
  if (p.message) params.set("message", p.message);
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function BuilderPage({ searchParams }: PageProps) {
  const session = await requireModuleAccess("schedule");
  // The Builder is a management tool: only people who manage a schedule
  // department (directorship, delegation, or schedule.edit_all) can do anything
  // here. Plain schedule.view holders are sent to /no-access rather than shown
  // an empty, do-nothing builder. Mutations are still scope-checked server-side.
  if (!(await canManageAnyScheduleDept(session.personId))) redirect("/no-access");
  const sp = await searchParams;

  const deptParam = sp.dept ?? undefined;
  const dateParam = sp.date ?? undefined;
  const view = sp.view === "grid" ? "grid" : "saturday";
  const mode = sp.mode === "availability" ? "availability" : "assign";
  const gmode = sp.gmode === "shadow" ? "shadow" : "assign";
  const builderView = resolveBuilderView(sp.view, sp.mode);

  const [workingTermOrNull, liveTerm] = await Promise.all([getWorkingTerm(sp.term), getActiveTerm()]);
  if (!workingTermOrNull) {
    // No active term (and no valid ?term): nothing to build.
    return (
      <div>
        <div className="mb-8">
          <PageHeader title="Schedule Builder" description="No active term" />
        </div>
        <p className="text-sm text-muted-foreground">There is no term to build a schedule for yet.</p>
      </div>
    );
  }
  // Reassigned (rather than used narrowed) so the non-null type carries into the
  // "use server" action closures below -- TS does not retain control-flow
  // narrowing of an outer const across a nested function boundary (mirrors the
  // `const dept = selectedDepartment!;` pattern a few lines down).
  const workingTerm = workingTermOrNull;
  const editable = workingTerm.status !== "ARCHIVED";
  const termParam = workingTerm.id === liveTerm?.id ? undefined : workingTerm.id; // omit ?term for the live term

  const data = await loadBuilderView(session.personId, {
    departmentId: deptParam,
    dateKey: dateParam,
    termId: workingTerm.id,
  });

  if (data.departments.length === 0) {
    return (
      <div>
        <div className="mb-8">
          <PageHeader title="Schedule Builder" description="No departments" />
        </div>
        <p className="text-sm text-muted-foreground">You do not direct any departments this term.</p>
      </div>
    );
  }

  const { selectedDepartment, clinicDates, selectedDateKey, currentClinicDateKey, members, assignmentsByDate } = data;
  const dept = selectedDepartment!;

  const switcherTerms = await prisma.term.findMany({
    orderBy: { startDate: "desc" },
    take: 8, // the 8 most recent terms: live + next + a bounded set of recent archived
    select: { id: true, code: true, status: true },
  });
  const termOptions = buildTermOptions(switcherTerms, { includeArchived: true });

  const canManageRequests = editable && (await canManageRequestsForDept(session.personId, dept.id));
  const requestRows = canManageRequests
    ? await listDepartmentRequests(session.personId, dept.id, workingTerm.id)
    : [];
  // PendingRequests needs this to mark stale (past-date) rows; resolved once
  // here rather than inside that component, since displayTodayKey is async
  // and settings-backed (Prisma) and the panel just renders props. Cheap
  // (request-cached) to resolve unconditionally, which keeps the type a
  // plain string for the prop below rather than string | null.
  const requestsTodayKey = await displayTodayKey();

  const showPublishControl = workingTerm.status === "PLANNING";
  const deptPublished = showPublishControl ? await isPublished(workingTerm.id, dept.id) : false;

  function href(overrides: HrefParams): string {
    return buildHref("/schedule/builder", {
      dept: dept.id,
      date: selectedDateKey,
      view,
      mode,
      gmode,
      term: termParam,
      ...overrides,
    });
  }

  // ---------------------------------------------------------------------------
  // Server actions
  // ---------------------------------------------------------------------------

  async function assignAction(formData: FormData) {
    "use server";
    const actor = await requireModuleAccess("schedule");
    const departmentId = (formData.get("departmentId") as string) ?? "";
    const dateKey = (formData.get("dateKey") as string) ?? "";
    const personId = (formData.get("personId") as string) ?? "";
    const role = (formData.get("role") as "VOLUNTEER" | "SHADOW" | "DIRECTOR") ?? "VOLUNTEER";
    const base = buildHref("/schedule/builder", { dept: dept.id, date: selectedDateKey, view, mode, gmode, term: termParam });
    await runAction({
      work: () => setAssignment(actor.personId, { termId: workingTerm.id, departmentId, dateKey, personId, role }),
      domainErrors: [BuilderValidationError, BuilderForbiddenError],
      errorRedirect: (message) => buildHref("/schedule/builder", { dept: dept.id, date: selectedDateKey, view, mode, gmode, term: termParam, error: "validation", message }),
      revalidate: "/schedule/builder",
      successRedirect: base,
    });
  }

  async function unassignAction(formData: FormData) {
    "use server";
    const actor = await requireModuleAccess("schedule");
    const departmentId = (formData.get("departmentId") as string) ?? "";
    const dateKey = (formData.get("dateKey") as string) ?? "";
    const personId = (formData.get("personId") as string) ?? "";
    const reason = ((formData.get("reason") as string) ?? "").trim() || undefined;
    const base = buildHref("/schedule/builder", { dept: dept.id, date: selectedDateKey, view, mode, gmode, term: termParam });
    await runAction({
      work: () => setAssignment(actor.personId, { termId: workingTerm.id, departmentId, dateKey, personId, role: null, reason }),
      domainErrors: [BuilderValidationError, BuilderForbiddenError],
      errorRedirect: (message) => buildHref("/schedule/builder", { dept: dept.id, date: selectedDateKey, view, mode, gmode, term: termParam, error: "validation", message }),
      revalidate: "/schedule/builder",
      successRedirect: base,
    });
  }

  async function toggleTagAction(formData: FormData) {
    "use server";
    const actor = await requireModuleAccess("schedule");
    const departmentId = (formData.get("departmentId") as string) ?? "";
    const dateKey = (formData.get("dateKey") as string) ?? "";
    const personId = (formData.get("personId") as string) ?? "";
    const tag = (formData.get("tag") as "triage" | "walkin" | "cc" | "remote") ?? "triage";
    const base = buildHref("/schedule/builder", { dept: dept.id, date: selectedDateKey, view, mode, gmode, term: termParam });
    await runAction({
      work: () => toggleTag(actor.personId, { termId: workingTerm.id, departmentId, dateKey, personId, tag }),
      domainErrors: [BuilderValidationError, BuilderForbiddenError],
      errorRedirect: (message) => buildHref("/schedule/builder", { dept: dept.id, date: selectedDateKey, view, mode, gmode, term: termParam, error: "validation", message }),
      revalidate: "/schedule/builder",
      successRedirect: base,
    });
  }

  async function saveOverrideAction(formData: FormData) {
    "use server";
    const actor = await requireModuleAccess("schedule");
    const membershipId = (formData.get("membershipId") as string) ?? "";
    const rawDates = formData.getAll("dates") as string[];
    const base = buildHref("/schedule/builder", { dept: dept.id, date: selectedDateKey, view, mode, gmode, term: termParam });
    await runAction({
      work: () => setAvailabilityOverride(actor.personId, { membershipId, dateKeys: rawDates }),
      domainErrors: [BuilderValidationError, BuilderForbiddenError],
      errorRedirect: (message) => buildHref("/schedule/builder", { dept: dept.id, date: selectedDateKey, view, mode, gmode, term: termParam, error: "validation", message }),
      revalidate: "/schedule/builder",
      successRedirect: base,
    });
  }

  async function clearOverrideAction(formData: FormData) {
    "use server";
    const actor = await requireModuleAccess("schedule");
    const membershipId = (formData.get("membershipId") as string) ?? "";
    const base = buildHref("/schedule/builder", { dept: dept.id, date: selectedDateKey, view, mode, gmode, term: termParam });
    await runAction({
      work: () => setAvailabilityOverride(actor.personId, { membershipId, dateKeys: null }),
      domainErrors: [BuilderValidationError, BuilderForbiddenError],
      errorRedirect: (message) => buildHref("/schedule/builder", { dept: dept.id, date: selectedDateKey, view, mode, gmode, term: termParam, error: "validation", message }),
      revalidate: "/schedule/builder",
      successRedirect: base,
    });
  }

  async function acknowledgeAction(formData: FormData) {
    "use server";
    const actor = await requireModuleAccess("schedule");
    const membershipId = (formData.get("membershipId") as string) ?? "";
    const base = buildHref("/schedule/builder", { dept: dept.id, date: selectedDateKey, view, mode, gmode, term: termParam });
    await runAction({
      work: () => acknowledgeAvailability(actor.personId, membershipId),
      domainErrors: [BuilderValidationError, BuilderForbiddenError],
      errorRedirect: (message) => buildHref("/schedule/builder", { dept: dept.id, date: selectedDateKey, view, mode, gmode, term: termParam, error: "validation", message }),
      revalidate: "/schedule/builder",
      successRedirect: base,
    });
  }

  async function patientsBookedAction(formData: FormData) {
    "use server";
    const actor = await requireModuleAccess("schedule");
    const departmentId = (formData.get("departmentId") as string) ?? "";
    const dateKey = (formData.get("dateKey") as string) ?? "";
    const raw = (formData.get("patientsBooked") as string) ?? "";
    const base = buildHref("/schedule/builder", { dept: dept.id, date: selectedDateKey, view, mode, gmode, term: termParam });
    await runAction({
      work: () =>
        setPatientsBooked(actor.personId, {
          termId: workingTerm.id,
          departmentId,
          dateKey,
          patientsBooked: parseBookedCount(raw, "Patients booked"),
        }),
      domainErrors: [BuilderValidationError, BuilderForbiddenError],
      errorRedirect: (message) => buildHref("/schedule/builder", { dept: dept.id, date: selectedDateKey, view, mode, gmode, term: termParam, error: "validation", message }),
      revalidate: "/schedule/builder",
      successRedirect: base,
    });
  }

  // The attending assignment and the quick-add roster form used to live here.
  // Both moved to /schedule/attendings, which now schedules attendings for every
  // service line rather than reproductive health alone. The readiness panel below
  // still SHOWS who is covering, because coverage is what it computes, but it is
  // no longer a second place to set it: two forms writing the same RhdClinic row
  // is exactly how the two drift apart.

  async function approveRequestAction(formData: FormData) {
    "use server";
    const actor = await requireModuleAccess("schedule");
    const requestId = (formData.get("requestId") as string) ?? "";
    const base = buildHref("/schedule/builder", { dept: dept.id, date: selectedDateKey, view, mode, gmode, term: termParam });
    await runAction({
      work: async () => {
        await approveRequest(actor.personId, requestId);
        await captureEvent({
          event: "shift_request_approved",
          distinctId: actor.personId,
          properties: { request_id: requestId, department_id: dept.id },
          groups: await activeTermGroup(),
        });
      },
      domainErrors: [RequestValidationError, RequestForbiddenError, RequestNotFoundError],
      errorRedirect: (message) => buildHref("/schedule/builder", { dept: dept.id, date: selectedDateKey, view, mode, gmode, term: termParam, error: "validation", message }),
      revalidate: "/schedule/builder",
      successRedirect: base,
    });
  }

  async function denyRequestAction(formData: FormData) {
    "use server";
    const actor = await requireModuleAccess("schedule");
    const requestId = (formData.get("requestId") as string) ?? "";
    const note = ((formData.get("denyNote") as string) ?? "").trim() || undefined;
    const base = buildHref("/schedule/builder", { dept: dept.id, date: selectedDateKey, view, mode, gmode, term: termParam });
    await runAction({
      work: async () => {
        await denyRequest(actor.personId, requestId, note);
        await captureEvent({
          event: "shift_request_denied",
          distinctId: actor.personId,
          properties: { request_id: requestId, department_id: dept.id },
          groups: await activeTermGroup(),
        });
      },
      domainErrors: [RequestValidationError, RequestForbiddenError, RequestNotFoundError],
      errorRedirect: (message) => buildHref("/schedule/builder", { dept: dept.id, date: selectedDateKey, view, mode, gmode, term: termParam, error: "validation", message }),
      revalidate: "/schedule/builder",
      successRedirect: base,
    });
  }

  async function publishAction(_formData: FormData) {
    "use server";
    const actor = await requireModuleAccess("schedule");
    const base = buildHref("/schedule/builder", { dept: dept.id, date: selectedDateKey, view, mode, gmode, term: termParam });
    await runAction({
      work: () => publishSchedule(actor.personId, { termId: workingTerm.id, departmentId: dept.id }),
      domainErrors: [PublicationError],
      errorRedirect: (message) => buildHref("/schedule/builder", { dept: dept.id, date: selectedDateKey, view, mode, gmode, term: termParam, error: "validation", message }),
      revalidate: "/schedule/builder",
      successRedirect: base,
    });
  }

  async function unpublishAction(_formData: FormData) {
    "use server";
    const actor = await requireModuleAccess("schedule");
    const base = buildHref("/schedule/builder", { dept: dept.id, date: selectedDateKey, view, mode, gmode, term: termParam });
    await runAction({
      work: () => unpublishSchedule(actor.personId, { termId: workingTerm.id, departmentId: dept.id }),
      domainErrors: [PublicationError],
      errorRedirect: (message) => buildHref("/schedule/builder", { dept: dept.id, date: selectedDateKey, view, mode, gmode, term: termParam, error: "validation", message }),
      revalidate: "/schedule/builder",
      successRedirect: base,
    });
  }

  /**
   * Grid-view fallback for an archived (read-only) term. BuilderGrid renders
   * every cell as a clickable form regardless of term status, so the archived
   * banner alone would not stop a click from posting -- this swaps in a no-op
   * in place of assignAction/unassignAction, keeping the grid itself visible
   * (per spec) while making every cell inert. setAssignment would reject the
   * write anyway (loadEditableTerm), so this is a UX nicety, not the
   * enforcement boundary.
   */
  async function readOnlyGridAction(_formData: FormData) {
    "use server";
  }

  // Day view shows one date at a time; without this, only the brand-filled pill
  // among ~18 in the date strip says which date is being edited, and the Day-view
  // cell aria-labels carry no date either.
  const selectedDisplay = selectedDateKey
    ? formatCalendarDate(new Date(selectedDateKey + "T12:00:00Z"), {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
      })
    : null;

  return (
    <div>
      <div className="mb-8">
        <PageHeader
          title="Schedule Builder"
          description={`${dept.name} · ${workingTerm.name}${
            showPublishControl ? (deptPublished ? " · Published" : " · Not published") : ""
          }`}
          action={
            showPublishControl ? (
              deptPublished ? (
                <form action={unpublishAction}>
                  <ConfirmButton
                    label="Unpublish"
                    confirmLabel={`Unpublish ${dept.code}'s ${workingTerm.name} schedule?`}
                  />
                </form>
              ) : (
                <form action={publishAction}>
                  <Button type="submit" variant="primary" size="sm">
                    {`Publish ${dept.code}'s ${workingTerm.name} schedule`}
                  </Button>
                </form>
              )
            ) : undefined
          }
        />
      </div>

      <BuilderToolbar
        departments={data.departments}
        selectedDeptId={dept.id}
        hrefParams={{ dept: dept.id, date: dateParam, term: termParam, gmode: gmode === "assign" ? null : gmode }}
        view={builderView}
        termOptions={termOptions}
        workingTermId={workingTerm.id}
        liveTermId={liveTerm?.id ?? null}
        hrefForTerm={(termId) => buildHref("/schedule/builder", { dept: dept.id, view, mode, gmode, term: termId ?? undefined })}
      />

      {/* Archived read-only banner */}
      {!editable && (
        <div className="mb-4 rounded-xl border border-border bg-muted px-4 py-3 text-sm text-foreground-soft">
          Viewing <span className="font-semibold text-foreground">{workingTerm.name}</span>, archived and read-only.
        </div>
      )}

      {/* Date strip -- hidden in Grid view (dates are already columns there) and in
          edit-availability mode (availability is edited per member across all dates, so the
          per-date picker is just noise). */}
      {clinicDates.length > 0 && builderView === "day" && (
        <div className="mb-6">
          <ClinicDateStrip
            dates={clinicDates}
            selectedKey={selectedDateKey}
            hrefFor={(key) => href({ date: key })}
            ariaLabel="Clinic dates"
          />
        </div>
      )}

      {/* Main content */}
      <div>
        {mode === "availability" ? (
          <BuilderAvailabilityView
            members={members}
            clinicDates={clinicDates}
            editable={editable}
            saveOverrideAction={saveOverrideAction}
            clearOverrideAction={clearOverrideAction}
            acknowledgeAction={acknowledgeAction}
          />
        ) : view === "grid" ? (
          <>
            <div className="mb-4 flex flex-col gap-3">
              {gmode === "shadow" && (
                <Alert tone="warning">
                  Clicking an empty cell assigns a <strong>Shadow</strong>, not a volunteer.
                </Alert>
              )}
              <div className="flex items-center gap-3">
                <span className="text-xs font-semibold uppercase tracking-wider text-subtle-foreground">Clicks assign</span>
                <nav aria-label="Clicks assign" className="inline-flex overflow-hidden rounded-lg border border-border bg-surface">
                  <Link
                    href={href({ gmode: "assign" })}
                    aria-current={gmode === "assign" ? "page" : undefined}
                    className={cx(
                      "inline-flex items-center min-h-11 px-3 py-1.5 text-sm font-medium transition-colors",
                      gmode === "assign" ? "bg-brand text-white" : "text-muted-foreground hover:text-foreground-soft",
                    )}
                  >
                    Volunteer
                  </Link>
                  <Link
                    href={href({ gmode: "shadow" })}
                    aria-current={gmode === "shadow" ? "page" : undefined}
                    className={cx(
                      "inline-flex items-center min-h-11 px-3 py-1.5 text-sm font-medium transition-colors",
                      gmode === "shadow"
                        ? "border-l-2 border-warning bg-warning/5 text-warning-foreground"
                        : "border-l border-border text-muted-foreground hover:text-foreground-soft",
                    )}
                  >
                    Shadow
                  </Link>
                </nav>
              </div>
            </div>
            <BuilderGrid
              members={members}
              clinicDates={clinicDates}
              assignmentsByDate={assignmentsByDate}
              highlightDateKey={currentClinicDateKey}
              deptId={dept.id}
              deptCode={dept.code}
              mode={gmode}
              assignAction={editable ? assignAction : readOnlyGridAction}
              unassignAction={editable ? unassignAction : readOnlyGridAction}
            />
          </>
        ) : (
          <>
            {selectedDisplay && <SectionHeader as="h2" level="title" className="mb-4">{selectedDisplay}</SectionHeader>}
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_1fr_280px]">
              <BuilderDayView
                data={data}
                dept={dept}
                selectedDateKey={selectedDateKey}
                editable={editable}
                assignAction={assignAction}
                unassignAction={unassignAction}
                toggleTagAction={toggleTagAction}
              />

              {/* Column 3: Sidebar */}
              <div className="flex flex-col gap-4">
                {editable && selectedDateKey && data.hasCapacityConfig && (
                  // Key on the selected date so a date-strip soft nav (search-params-only,
                  // which Next reconciles rather than remounts) actually REMOUNTS the panel
                  // and re-reads its uncontrolled defaultValue inputs. Without this the
                  // Patients-booked field kept the prior date's typed value and Save wrote
                  // it onto the new date's clinic (#9).
                  <CapacityPanel
                    key={selectedDateKey}
                    metrics={data.capacity}
                    deptCode={dept.code}
                    patientsBookedAction={patientsBookedAction}
                    departmentId={dept.id}
                    dateKey={selectedDateKey!}
                  />
                )}
                {editable && data.rhd != null && selectedDateKey && (
                  // Same remount-on-date fix (#9): the Attending <select> and Procedures
                  // input otherwise kept the prior date's selection, silently overwriting
                  // the new date's real attending on Save.
                  <ReadinessPanel rhd={data.rhd!} />
                )}
                {canManageRequests && (
                  <PendingRequests
                    rows={requestRows}
                    approveAction={approveRequestAction}
                    denyAction={denyRequestAction}
                    todayKey={requestsTodayKey}
                  />
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}