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
import { Badge } from "@/platform/ui/badge";
import { Button } from "@/platform/ui/button";
import { Card } from "@/platform/ui/card";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { Input } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  builderView,
  canManageAnyScheduleDept,
  setAssignment,
  toggleTag,
  setAvailabilityOverride,
  acknowledgeAvailability,
  setPatientsBooked,
  upsertRhdClinic,
  BuilderForbiddenError,
  BuilderValidationError,
  compareBuilderMembers,
} from "@/modules/schedule/services/builder";
import type { BuilderMemberIntake } from "@/modules/schedule/services/builder";
import { createAttending, AttendingValidationError, AttendingForbiddenError } from "@/modules/schedule/services/attendings";
import {
  listDepartmentRequests,
  approveRequest,
  denyRequest,
  canManageRequestsForDept,
  RequestForbiddenError,
  RequestNotFoundError,
  RequestValidationError,
} from "@/modules/schedule/services/requests";
import { BuilderCell } from "@/modules/schedule/components/builder-cell";
import { BuilderGrid } from "@/modules/schedule/components/builder-grid";
import { CapacityPanel } from "@/modules/schedule/components/capacity-panel";
import { ReadinessPanel } from "@/modules/schedule/components/readiness-panel";
import { PendingRequests } from "@/modules/schedule/components/pending-requests";
import { displayDate } from "@/modules/schedule/engine/display";
import { rolesForDept } from "@/modules/schedule/engine/capacity";
import { isoDateKey } from "@/platform/dates";
import { AlertTriangle } from "lucide-react";

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
    error?: string;
    message?: string;
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

  const errorCode = sp.error ?? null;
  const errorMessage = errorCode
    ? errorCode === "validation" && sp.message
      ? sp.message
      : errorCode
    : null;

  const data = await builderView(session.personId, {
    departmentId: deptParam,
    dateKey: dateParam,
  });

  if (data.departments.length === 0) {
    return (
      <div>
        <div className="rounded-2xl bg-brand px-8 py-6 text-white mb-8">
          <p className="text-xs font-semibold uppercase tracking-widest text-white/60 mb-1">Schedule Builder</p>
          <h1 className="text-2xl font-bold">No departments</h1>
          <p className="text-sm text-white/70 mt-1">You do not direct any departments this term.</p>
        </div>
      </div>
    );
  }

  const { selectedDepartment, clinicDates, selectedDateKey, currentClinicDateKey, members, assignmentsByDate, conflicts } = data;
  const dept = selectedDepartment!;

  const canManageRequests = await canManageRequestsForDept(session.personId, dept.id);
  const requestRows = canManageRequests
    ? await listDepartmentRequests(session.personId, dept.id)
    : [];

  function href(overrides: HrefParams): string {
    return buildHref("/schedule/builder", {
      dept: dept.id,
      date: selectedDateKey,
      view,
      mode,
      gmode,
      ...overrides,
    });
  }

  const assignmentsOnDate: Record<string, { role: "VOLUNTEER" | "SHADOW" | "DIRECTOR"; tags: { triage: boolean; walkin: boolean; cc: boolean; remote: boolean } }> =
    selectedDateKey ? (assignmentsByDate[selectedDateKey] ?? {}) : {};

  const memberByPersonId = new Map(members.map((m) => [m.person.id, m]));

  const assignedDirectors = Object.entries(assignmentsOnDate)
    .filter(([, a]) => a.role === "DIRECTOR")
    .map(([pid]) => pid);

  const assignedVolunteers = Object.entries(assignmentsOnDate)
    .filter(([, a]) => a.role === "VOLUNTEER")
    .map(([pid]) => pid);

  const assignedShadows = Object.entries(assignmentsOnDate)
    .filter(([, a]) => a.role === "SHADOW")
    .map(([pid]) => pid);

  const assignedPersonIds = new Set(Object.keys(assignmentsOnDate));

  const unassignedMembers = selectedDateKey
    ? members.filter((m) => !assignedPersonIds.has(m.person.id))
    : members;

  const isAvailableOnDate = (m: (typeof unassignedMembers)[number]) =>
    selectedDateKey
      ? m.availability.dates.some((d) => isoDateKey(d) === selectedDateKey)
      : false;

  // Directors first, then volunteers, alphabetical within each group.
  const availableMembers = unassignedMembers
    .filter(isAvailableOnDate)
    .sort(compareBuilderMembers);
  const notAvailableMembers = unassignedMembers
    .filter((m) => !isAvailableOnDate(m))
    .sort(compareBuilderMembers);
  const availableCount = availableMembers.length;

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
    const base = buildHref("/schedule/builder", { dept: dept.id, date: selectedDateKey, view, mode, gmode });
    try {
      await setAssignment(actor.personId, { departmentId, dateKey, personId, role });
    } catch (err) {
      if (err instanceof BuilderValidationError || err instanceof BuilderForbiddenError) {
        redirect(buildHref("/schedule/builder", { dept: dept.id, date: selectedDateKey, view, mode, gmode, error: "validation", message: err.message }));
      }
      throw err;
    }
    revalidatePath("/schedule/builder");
    redirect(base);
  }

  async function unassignAction(formData: FormData) {
    "use server";
    const actor = await requireModuleAccess("schedule");
    const departmentId = (formData.get("departmentId") as string) ?? "";
    const dateKey = (formData.get("dateKey") as string) ?? "";
    const personId = (formData.get("personId") as string) ?? "";
    const reason = ((formData.get("reason") as string) ?? "").trim() || undefined;
    const base = buildHref("/schedule/builder", { dept: dept.id, date: selectedDateKey, view, mode, gmode });
    try {
      await setAssignment(actor.personId, { departmentId, dateKey, personId, role: null, reason });
    } catch (err) {
      if (err instanceof BuilderValidationError || err instanceof BuilderForbiddenError) {
        redirect(buildHref("/schedule/builder", { dept: dept.id, date: selectedDateKey, view, mode, gmode, error: "validation", message: err.message }));
      }
      throw err;
    }
    revalidatePath("/schedule/builder");
    redirect(base);
  }

  async function toggleTagAction(formData: FormData) {
    "use server";
    const actor = await requireModuleAccess("schedule");
    const departmentId = (formData.get("departmentId") as string) ?? "";
    const dateKey = (formData.get("dateKey") as string) ?? "";
    const personId = (formData.get("personId") as string) ?? "";
    const tag = (formData.get("tag") as "triage" | "walkin" | "cc" | "remote") ?? "triage";
    const base = buildHref("/schedule/builder", { dept: dept.id, date: selectedDateKey, view, mode, gmode });
    try {
      await toggleTag(actor.personId, { departmentId, dateKey, personId, tag });
    } catch (err) {
      if (err instanceof BuilderValidationError || err instanceof BuilderForbiddenError) {
        redirect(buildHref("/schedule/builder", { dept: dept.id, date: selectedDateKey, view, mode, gmode, error: "validation", message: err.message }));
      }
      throw err;
    }
    revalidatePath("/schedule/builder");
    redirect(base);
  }

  async function saveOverrideAction(formData: FormData) {
    "use server";
    const actor = await requireModuleAccess("schedule");
    const membershipId = (formData.get("membershipId") as string) ?? "";
    const rawDates = formData.getAll("dates") as string[];
    const base = buildHref("/schedule/builder", { dept: dept.id, date: selectedDateKey, view, mode, gmode });
    try {
      await setAvailabilityOverride(actor.personId, { membershipId, dateKeys: rawDates });
    } catch (err) {
      if (err instanceof BuilderValidationError || err instanceof BuilderForbiddenError) {
        redirect(buildHref("/schedule/builder", { dept: dept.id, date: selectedDateKey, view, mode, gmode, error: "validation", message: err.message }));
      }
      throw err;
    }
    revalidatePath("/schedule/builder");
    redirect(base);
  }

  async function clearOverrideAction(formData: FormData) {
    "use server";
    const actor = await requireModuleAccess("schedule");
    const membershipId = (formData.get("membershipId") as string) ?? "";
    const base = buildHref("/schedule/builder", { dept: dept.id, date: selectedDateKey, view, mode, gmode });
    try {
      await setAvailabilityOverride(actor.personId, { membershipId, dateKeys: null });
    } catch (err) {
      if (err instanceof BuilderValidationError || err instanceof BuilderForbiddenError) {
        redirect(buildHref("/schedule/builder", { dept: dept.id, date: selectedDateKey, view, mode, gmode, error: "validation", message: err.message }));
      }
      throw err;
    }
    revalidatePath("/schedule/builder");
    redirect(base);
  }

  async function acknowledgeAction(formData: FormData) {
    "use server";
    const actor = await requireModuleAccess("schedule");
    const membershipId = (formData.get("membershipId") as string) ?? "";
    const base = buildHref("/schedule/builder", { dept: dept.id, date: selectedDateKey, view, mode, gmode });
    try {
      await acknowledgeAvailability(actor.personId, membershipId);
    } catch (err) {
      if (err instanceof BuilderValidationError || err instanceof BuilderForbiddenError) {
        redirect(buildHref("/schedule/builder", { dept: dept.id, date: selectedDateKey, view, mode, gmode, error: "validation", message: err.message }));
      }
      throw err;
    }
    revalidatePath("/schedule/builder");
    redirect(base);
  }

  async function patientsBookedAction(formData: FormData) {
    "use server";
    const actor = await requireModuleAccess("schedule");
    const departmentId = (formData.get("departmentId") as string) ?? "";
    const dateKey = (formData.get("dateKey") as string) ?? "";
    const raw = (formData.get("patientsBooked") as string) ?? "";
    const patientsBooked = raw === "" ? null : Number(raw);
    const base = buildHref("/schedule/builder", { dept: dept.id, date: selectedDateKey, view, mode, gmode });
    try {
      await setPatientsBooked(actor.personId, { departmentId, dateKey, patientsBooked });
    } catch (err) {
      if (err instanceof BuilderValidationError || err instanceof BuilderForbiddenError) {
        redirect(buildHref("/schedule/builder", { dept: dept.id, date: selectedDateKey, view, mode, gmode, error: "validation", message: err.message }));
      }
      throw err;
    }
    revalidatePath("/schedule/builder");
    redirect(base);
  }

  async function rhdClinicAction(formData: FormData) {
    "use server";
    const actor = await requireModuleAccess("schedule");
    const dateKey = (formData.get("dateKey") as string) ?? "";
    const rawAttendingId = (formData.get("attendingId") as string) ?? "";
    const rawDirectorName = (formData.get("directorName") as string) ?? "";
    const rawProceduresBooked = (formData.get("proceduresBooked") as string) ?? "";
    const attendingId = rawAttendingId === "" ? null : rawAttendingId;
    const directorName = rawDirectorName.trim() === "" ? null : rawDirectorName.trim();
    const proceduresBooked = rawProceduresBooked === "" ? null : Number(rawProceduresBooked);
    const base = buildHref("/schedule/builder", { dept: dept.id, date: selectedDateKey, view, mode, gmode });
    try {
      await upsertRhdClinic(actor.personId, { dateKey, attendingId, directorName, proceduresBooked });
    } catch (err) {
      if (err instanceof BuilderValidationError || err instanceof BuilderForbiddenError) {
        redirect(buildHref("/schedule/builder", { dept: dept.id, date: selectedDateKey, view, mode, gmode, error: "validation", message: err.message }));
      }
      throw err;
    }
    revalidatePath("/schedule/builder");
    redirect(base);
  }

  async function addAttendingAction(formData: FormData) {
    "use server";
    const actor = await requireModuleAccess("schedule");
    const scheduleName = ((formData.get("scheduleName") as string) ?? "").trim();
    const fullName = ((formData.get("fullName") as string) ?? "").trim();
    const base = buildHref("/schedule/builder", { dept: dept.id, date: selectedDateKey, view, mode, gmode });
    try {
      await createAttending(actor.personId, { scheduleName, fullName: fullName || scheduleName });
    } catch (err) {
      if (err instanceof AttendingValidationError || err instanceof AttendingForbiddenError) {
        redirect(buildHref("/schedule/builder", { dept: dept.id, date: selectedDateKey, view, mode, gmode, error: "validation", message: err.message }));
      }
      throw err;
    }
    revalidatePath("/schedule/builder");
    redirect(base);
  }

  async function approveRequestAction(formData: FormData) {
    "use server";
    const actor = await requireModuleAccess("schedule");
    const requestId = (formData.get("requestId") as string) ?? "";
    const base = buildHref("/schedule/builder", { dept: dept.id, date: selectedDateKey, view, mode, gmode });
    try {
      await approveRequest(actor.personId, requestId);
    } catch (err) {
      if (err instanceof RequestValidationError || err instanceof RequestForbiddenError || err instanceof RequestNotFoundError) {
        redirect(buildHref("/schedule/builder", { dept: dept.id, date: selectedDateKey, view, mode, gmode, error: "validation", message: err.message }));
      }
      throw err;
    }
    revalidatePath("/schedule/builder");
    redirect(base);
  }

  async function denyRequestAction(formData: FormData) {
    "use server";
    const actor = await requireModuleAccess("schedule");
    const requestId = (formData.get("requestId") as string) ?? "";
    const note = ((formData.get("denyNote") as string) ?? "").trim() || undefined;
    const base = buildHref("/schedule/builder", { dept: dept.id, date: selectedDateKey, view, mode, gmode });
    try {
      await denyRequest(actor.personId, requestId, note);
    } catch (err) {
      if (err instanceof RequestValidationError || err instanceof RequestForbiddenError || err instanceof RequestNotFoundError) {
        redirect(buildHref("/schedule/builder", { dept: dept.id, date: selectedDateKey, view, mode, gmode, error: "validation", message: err.message }));
      }
      throw err;
    }
    revalidatePath("/schedule/builder");
    redirect(base);
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const selectedDisplay = selectedDateKey
    ? new Date(selectedDateKey + "T12:00:00Z").toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      })
    : null;

  function flagBadges(person: { spanishVerified: boolean; licensedRN: boolean }) {
    if (!person.spanishVerified && !person.licensedRN) return null;
    return (
      <>
        {person.spanishVerified && <Badge tone="default">ES</Badge>}
        {person.licensedRN && <Badge tone="default">RN</Badge>}
      </>
    );
  }

  function assignCard(member: (typeof unassignedMembers)[number], available: boolean) {
    const isDirectorKind = member.kind === "DIRECTOR";
    return (
      <div
        key={member.person.id}
        className={`rounded-2xl border px-3 py-3 ${
          available ? "border-border bg-surface" : "border-border bg-muted opacity-75"
        }`}
      >
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <span className="text-sm font-semibold text-foreground">{member.person.name}</span>
          <Badge tone={isDirectorKind ? "brand" : "default"}>
            {isDirectorKind ? "Director" : "Volunteer"}
          </Badge>
          {flagBadges(member.person)}
          {!available && <Badge tone="warning">not free</Badge>}
        </div>
        <div className="flex flex-wrap gap-2">
          {isDirectorKind && (
            <BuilderCell
              action={assignAction}
              hidden={{
                departmentId: dept.id,
                dateKey: selectedDateKey ?? "",
                personId: member.person.id,
                role: "DIRECTOR",
              }}
              label="Assign as director"
              variant="assign"
            />
          )}
          <BuilderCell
            action={assignAction}
            hidden={{
              departmentId: dept.id,
              dateKey: selectedDateKey ?? "",
              personId: member.person.id,
              role: "VOLUNTEER",
            }}
            label="Assign as volunteer"
            variant="assign"
          />
          <BuilderCell
            action={assignAction}
            hidden={{
              departmentId: dept.id,
              dateKey: selectedDateKey ?? "",
              personId: member.person.id,
              role: "SHADOW",
            }}
            label="Assign as shadow"
            variant="assign"
          />
        </div>
        <IntakeNotes intake={member.intake} />
      </div>
    );
  }

  return (
    <div>
      {/* Hero */}
      <div className="rounded-2xl bg-brand px-8 py-6 text-white mb-6">
        <p className="text-xs font-semibold uppercase tracking-widest text-white/60 mb-1">Schedule Builder</p>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">{selectedDisplay ?? "Select a date"}</h1>
            <p className="text-sm text-white/70 mt-0.5 font-semibold uppercase tracking-widest">{dept.code} &middot; {dept.name}</p>
          </div>
          <div className="flex items-center gap-3">
            {mode === "availability" ? (
              <a href={href({ mode: "assign" })} className="px-3 py-1.5 rounded-lg bg-white/10 text-xs font-medium text-white/80 hover:text-white transition-colors">
                &larr; Back to assigning
              </a>
            ) : (
              <>
                {/* View toggle */}
                <div className="flex items-center rounded-lg bg-white/10 overflow-hidden">
                  <a href={href({ view: "saturday" })} className={`px-3 py-1.5 text-xs font-medium transition-colors ${view === "saturday" ? "bg-white text-brand" : "text-white/70 hover:text-white"}`}>Day view</a>
                  <a href={href({ view: "grid" })} className={`px-3 py-1.5 text-xs font-medium transition-colors border-l border-white/20 ${view === "grid" ? "bg-white text-brand" : "text-white/70 hover:text-white"}`}>Grid view</a>
                </div>
                <a href={href({ mode: "availability" })} className="px-3 py-1.5 rounded-lg bg-white/10 text-xs font-medium text-white/80 hover:text-white transition-colors">
                  Edit availability
                </a>
              </>
            )}
            {/* Department selector */}
            <form method="GET" action="/schedule/builder" className="flex items-center gap-2">
              {dateParam && <input type="hidden" name="date" value={dateParam} />}
              {view !== "saturday" && <input type="hidden" name="view" value={view} />}
              {mode !== "assign" && <input type="hidden" name="mode" value={mode} />}
              {gmode !== "assign" && <input type="hidden" name="gmode" value={gmode} />}
              <Select name="dept" aria-label="Department" defaultValue={dept.id} className="text-sm text-foreground bg-surface">
                {data.departments.map((d) => (
                  <option key={d.id} value={d.id}>{d.code} - {d.name}</option>
                ))}
              </Select>
              <Button type="submit" variant="outline" size="sm" className="text-foreground border-border-strong bg-surface">Go</Button>
            </form>
          </div>
        </div>
      </div>

      {/* Error banner */}
      {errorMessage && (
        <Alert tone="error" className="mb-6">
          {errorMessage}
        </Alert>
      )}

      {/* Date strip -- hidden in the Grid view, which already shows every date as a column */}
      {clinicDates.length > 0 && !(view === "grid" && mode !== "availability") && (
        <nav className="flex flex-wrap gap-2 mb-6" aria-label="Clinic dates">
          {clinicDates.map((d) => {
            const key = isoDateKey(d);
            const isSelected = key === selectedDateKey;
            return (
              <a
                key={key}
                href={href({ date: key })}
                aria-current={isSelected ? "page" : undefined}
                className={
                  isSelected
                    ? "rounded-full px-3 py-1 text-sm font-medium bg-brand text-white"
                    : "rounded-full px-3 py-1 text-sm font-medium bg-muted-strong text-foreground-soft hover:bg-muted-strong transition-colors"
                }
              >
                {displayDate(key)}
              </a>
            );
          })}
        </nav>
      )}

      {/* Main content */}
      <div>
        {mode === "availability" ? (
          <AvailabilityView
            members={members}
            clinicDates={clinicDates}
            dept={dept}
            saveOverrideAction={saveOverrideAction}
            clearOverrideAction={clearOverrideAction}
            acknowledgeAction={acknowledgeAction}
          />
        ) : view === "grid" ? (
          <>
            <div className="mb-4 flex items-center gap-3">
              <span className="text-sm font-semibold text-foreground-soft">Assigning as:</span>
              <div className="flex items-center rounded-lg border border-border overflow-hidden">
                <a
                  href={href({ gmode: "assign" })}
                  aria-current={gmode === "assign" ? "true" : undefined}
                  className={`px-3 py-1.5 text-xs font-medium transition-colors ${gmode === "assign" ? "bg-brand text-white" : "text-muted-foreground hover:text-foreground-soft"}`}
                >
                  Volunteer
                </a>
                <a
                  href={href({ gmode: "shadow" })}
                  aria-current={gmode === "shadow" ? "true" : undefined}
                  className={`px-3 py-1.5 text-xs font-medium transition-colors border-l ${gmode === "shadow" ? "border-border bg-amber-400 text-white" : "border-transparent text-muted-foreground hover:text-foreground-soft"}`}
                >
                  Shadow
                </a>
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
              assignAction={assignAction}
              unassignAction={unassignAction}
            />
          </>
        ) : (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_1fr_280px]">

            {/* Column 1: Assigned */}
            <section>
              <div className="flex items-center gap-2 mb-4">
                <h2 className="text-base font-bold text-foreground">Assigned</h2>
                <span className="rounded-full bg-brand text-white text-xs font-semibold px-2.5 py-0.5">
                  {assignedDirectors.length + assignedVolunteers.length + assignedShadows.length}
                </span>
              </div>

              {/* HIPAA banner */}
              {data.banner.length > 0 && (
                <Card size="compact" pad={false} role="status" className="mb-4 px-4 py-3 text-sm text-foreground-soft">
                  <p className="font-semibold mb-1 flex items-center gap-1.5 text-foreground">
                    <AlertTriangle className="h-4 w-4 shrink-0 text-warning" aria-hidden />
                    HIPAA issues on this date
                  </p>
                  <ul className="list-disc list-inside space-y-0.5">
                    {data.banner.flatMap((b) =>
                      b.nonCompliant.map((v) => (
                        <li key={v.id}>{v.name}</li>
                      ))
                    )}
                  </ul>
                </Card>
              )}

              {/* Directors */}
              <div className="mb-5">
                <p className="text-xs font-semibold uppercase tracking-widest text-subtle-foreground mb-2">
                  Directors <span className="text-brand-fg">({assignedDirectors.length})</span>
                </p>
                {assignedDirectors.length === 0 ? (
                  <p className="text-sm text-subtle-foreground italic">None assigned</p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {assignedDirectors.map((pid) => {
                      const m = memberByPersonId.get(pid);
                      const name = m?.person.name ?? pid;
                      return (
                        <Card key={pid} pad={false} className="px-3 py-2 flex items-center justify-between">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-bold text-foreground">{name}</span>
                            {m?.person && flagBadges(m.person)}
                          </span>
                          <form action={unassignAction} className="flex items-center gap-2">
                            <input type="hidden" name="departmentId" value={dept.id} />
                            <input type="hidden" name="dateKey" value={selectedDateKey ?? ""} />
                            <input type="hidden" name="personId" value={pid} />
                            <ConfirmButton label="Remove" confirmLabel="Remove this director?" />
                          </form>
                        </Card>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Volunteers */}
              <div className="mb-5">
                <p className="text-xs font-semibold uppercase tracking-widest text-subtle-foreground mb-2">
                  Volunteers <span className="text-success">({assignedVolunteers.length})</span>
                </p>
                {assignedVolunteers.length === 0 ? (
                  <p className="text-sm text-subtle-foreground italic">None assigned</p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {assignedVolunteers.map((pid) => {
                      const m = memberByPersonId.get(pid);
                      const name = m?.person.name ?? pid;
                      const assignment = assignmentsOnDate[pid]!;
                      const tags = assignment.tags;
                      const personConflicts = conflicts[pid] ?? [];
                      return (
                        <Card key={pid} pad={false} className="px-3 py-2">
                          <div className="flex flex-wrap items-center gap-2 text-sm">
                            <span className="font-medium text-foreground">{name}</span>
                            {m?.person && flagBadges(m.person)}
                            {personConflicts.length > 0 && (
                              <Badge tone="warning" title={personConflicts.join(", ")}>
                                Also in {personConflicts.join(", ")}
                              </Badge>
                            )}
                          </div>
                          <div className="mt-2 flex flex-wrap gap-1">
                            {([...rolesForDept(dept.code), "remote"] as Array<"triage" | "walkin" | "cc" | "remote">).map((tag) => (
                              <BuilderCell
                                key={tag}
                                action={toggleTagAction}
                                hidden={{ departmentId: dept.id, dateKey: selectedDateKey ?? "", personId: pid, tag }}
                                label={tag === "walkin" ? "Walk-in" : tag.charAt(0).toUpperCase() + tag.slice(1)}
                                pressed={tags[tag]}
                                variant="tag"
                              />
                            ))}
                          </div>
                          <form action={unassignAction} className="mt-2 flex flex-wrap items-center gap-2">
                            <input type="hidden" name="departmentId" value={dept.id} />
                            <input type="hidden" name="dateKey" value={selectedDateKey ?? ""} />
                            <input type="hidden" name="personId" value={pid} />
                            <Input name="reason" aria-label="Removal reason" placeholder="Reason (optional)" className="flex-1 min-w-32 py-1 text-xs" />
                            <ConfirmButton label="Remove" confirmLabel="Remove this volunteer?" />
                          </form>
                        </Card>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Shadows */}
              <div>
                <p className="text-xs font-semibold uppercase tracking-widest text-subtle-foreground mb-2">
                  Shadows <span className="text-warning">({assignedShadows.length})</span>
                </p>
                {assignedShadows.length === 0 ? (
                  <p className="text-sm text-subtle-foreground italic">None assigned</p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {assignedShadows.map((pid) => {
                      const m = memberByPersonId.get(pid);
                      const name = m?.person.name ?? pid;
                      return (
                        <Card key={pid} pad={false} className="px-3 py-2 flex items-center justify-between">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium text-foreground-soft">{name}</span>
                            {m?.person && flagBadges(m.person)}
                          </span>
                          <form action={unassignAction} className="flex items-center gap-2">
                            <input type="hidden" name="departmentId" value={dept.id} />
                            <input type="hidden" name="dateKey" value={selectedDateKey ?? ""} />
                            <input type="hidden" name="personId" value={pid} />
                            <ConfirmButton label="Remove" confirmLabel="Remove this shadow?" />
                          </form>
                        </Card>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>

            {/* Column 2: Available to assign */}
            <section>
              <div className="flex items-center gap-2 mb-4">
                <h2 className="text-base font-bold text-foreground">Available to assign</h2>
                <Badge tone="success">{availableCount} available</Badge>
              </div>

              {!selectedDateKey ? (
                <div className="rounded-2xl border border-dashed border-border px-6 py-10 text-center text-sm text-subtle-foreground">
                  Select a date above to start assigning.
                </div>
              ) : (
                <div className="flex flex-col gap-5">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-widest text-success mb-2">
                      Available &middot; said yes ({availableMembers.length})
                    </p>
                    {availableMembers.length === 0 ? (
                      <p className="text-sm text-subtle-foreground italic">No one is marked available for this date.</p>
                    ) : (
                      <div className="flex flex-col gap-2">
                        {availableMembers.map((m) => assignCard(m, true))}
                      </div>
                    )}
                  </div>

                  <div>
                    <p className="text-xs font-semibold uppercase tracking-widest text-subtle-foreground mb-2">
                      Not available ({notAvailableMembers.length})
                    </p>
                    {notAvailableMembers.length === 0 ? (
                      <p className="text-sm text-subtle-foreground italic">Everyone else is already assigned.</p>
                    ) : (
                      <div className="flex flex-col gap-2">
                        {notAvailableMembers.map((m) => assignCard(m, false))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </section>

            {/* Column 3: Sidebar */}
            <div className="flex flex-col gap-4">
              {selectedDateKey && data.hasCapacityConfig && (
                <CapacityPanel
                  metrics={data.capacity}
                  deptCode={dept.code}
                  patientsBookedAction={patientsBookedAction}
                  departmentId={dept.id}
                  dateKey={selectedDateKey!}
                />
              )}
              {data.rhd != null && selectedDateKey && (
                <ReadinessPanel
                  rhd={data.rhd!}
                  clinicAction={rhdClinicAction}
                  addAttendingAction={addAttendingAction}
                  dateKey={selectedDateKey!}
                />
              )}
              {canManageRequests && (
                <PendingRequests
                  rows={requestRows}
                  approveAction={approveRequestAction}
                  denyAction={denyRequestAction}
                />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Training-intake notes
// ---------------------------------------------------------------------------

/**
 * Renders the scheduling preferences a member gave during training intake so
 * directors can use them while building. Returns null when the member left
 * everything blank.
 */
function IntakeNotes({
  intake,
  className = "",
}: {
  intake: BuilderMemberIntake;
  className?: string;
}) {
  const { minShiftsWanted, additionalShiftAvailability, feedback } = intake;
  if (!minShiftsWanted && !additionalShiftAvailability && !feedback) return null;

  const border = "border-border";
  const body = "text-muted-foreground";
  const label = "text-foreground";

  return (
    <div className={`mt-2 space-y-0.5 border-t ${border} pt-2 text-xs ${body} ${className}`}>
      {minShiftsWanted && (
        <p>
          <span className={`font-semibold ${label}`}>Wants</span> {minShiftsWanted}+ shifts this term
        </p>
      )}
      {additionalShiftAvailability && (
        <p>
          <span className={`font-semibold ${label}`}>Availability:</span> {additionalShiftAvailability}
        </p>
      )}
      {feedback && (
        <p>
          <span className={`font-semibold ${label}`}>Note to directors:</span> {feedback}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Availability mode sub-view
// ---------------------------------------------------------------------------

type AvailabilityViewProps = {
  members: Awaited<ReturnType<typeof builderView>>["members"];
  clinicDates: Date[];
  dept: { id: string; code: string; name: string };
  saveOverrideAction: (fd: FormData) => Promise<void>;
  clearOverrideAction: (fd: FormData) => Promise<void>;
  acknowledgeAction: (fd: FormData) => Promise<void>;
};

function AvailabilityView({
  members,
  clinicDates,
  dept: _dept,
  saveOverrideAction,
  clearOverrideAction,
  acknowledgeAction,
}: AvailabilityViewProps) {
  return (
    <div className="flex flex-col gap-4">
      {members.length === 0 && (
        <p className="text-sm text-subtle-foreground">No members in this department.</p>
      )}
      {/* Directors first, then volunteers, alphabetical within each group. */}
      {[...members].sort(compareBuilderMembers).map((member) => {
        const tierLabel =
          member.availability.tier === "DIRECTOR"
            ? "Director override"
            : member.availability.tier === "SELF"
            ? "Self-reported"
            : "Application";

        const tierTone: "brand" | "default" | "warning" =
          member.availability.tier === "DIRECTOR"
            ? "brand"
            : member.availability.tier === "SELF"
            ? "default"
            : "warning";

        const availKeys = new Set(member.availability.dates.map((d) => isoDateKey(d)));

        return (
          <Card key={member.membershipId} pad={false} className="px-4 py-4">
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <span className="text-sm font-bold text-foreground">{member.person.name}</span>
              <Badge tone="default">{member.kind === "DIRECTOR" ? "Director" : "Volunteer"}</Badge>
              <Badge tone={tierTone}>{tierLabel}</Badge>
              {member.acknowledgePending && <Badge tone="warning">Availability updated</Badge>}
            </div>
            {member.legacyNote && (
              <p className="mb-3 text-xs text-subtle-foreground italic">{member.legacyNote}</p>
            )}
            <IntakeNotes intake={member.intake} className="mb-3" />
            <form action={saveOverrideAction} className="mb-2">
              <input type="hidden" name="membershipId" value={member.membershipId} />
              <div className="flex flex-wrap gap-2 mb-3">
                {clinicDates.map((d) => {
                  const key = isoDateKey(d);
                  const checked = availKeys.has(key);
                  return (
                    <label key={key} className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs cursor-pointer transition-colors whitespace-nowrap ${checked ? "border-brand bg-brand/5 text-brand-fg font-semibold" : "border-border text-muted-foreground hover:border-border-strong"}`}>
                      <input
                        type="checkbox"
                        name="dates"
                        value={key}
                        defaultChecked={checked}
                        className="h-3 w-3 rounded accent-brand"
                      />
                      {displayDate(key)}
                    </label>
                  );
                })}
              </div>
              <Button type="submit" variant="outline" size="sm">Save override</Button>
            </form>
            {member.overrideActive && (
              <form action={clearOverrideAction} className="inline mr-2">
                <input type="hidden" name="membershipId" value={member.membershipId} />
                <Button type="submit" variant="ghost" size="sm">Clear override</Button>
              </form>
            )}
            {member.acknowledgePending && (
              <form action={acknowledgeAction} className="inline">
                <input type="hidden" name="membershipId" value={member.membershipId} />
                <ConfirmButton label="Acknowledge" confirmLabel="Mark availability as reviewed?" />
              </form>
            )}
          </Card>
        );
      })}
    </div>
  );
}