/**
 * Schedule Builder page.
 *
 * Gate: requireModuleAccess("schedule").
 * Scope: per-department; actor must manage at least one department.
 *
 * URL params:
 *   ?dept=<departmentId>   -- selected department
 *   ?date=<YYYY-MM-DD>     -- selected clinic date
 *   ?view=saturday|grid    -- view toggle (grid is a placeholder for Task 8)
 *   ?mode=assign|shadow|availability -- mode toggle
 */

import { requireModuleAccess } from "@/platform/auth/session";
import { PageHeader } from "@/platform/ui/page-header";
import { Badge } from "@/platform/ui/badge";
import { Button } from "@/platform/ui/button";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { Input } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  builderView,
  setAssignment,
  toggleTag,
  setAvailabilityOverride,
  acknowledgeAvailability,
  BuilderForbiddenError,
  BuilderValidationError,
} from "@/modules/schedule/services/builder";
import { BuilderCell } from "@/modules/schedule/components/builder-cell";
import { displayDate } from "@/modules/schedule/engine/display";
import { isoDateKey } from "@/platform/dates";

// ---------------------------------------------------------------------------
// Page props
// ---------------------------------------------------------------------------

type PageProps = {
  searchParams: Promise<{
    dept?: string;
    date?: string;
    view?: string;
    mode?: string;
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
};

function buildHref(base: string, p: HrefParams): string {
  const params = new URLSearchParams();
  if (p.dept) params.set("dept", p.dept);
  if (p.date) params.set("date", p.date);
  if (p.view) params.set("view", p.view);
  if (p.mode) params.set("mode", p.mode);
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function BuilderPage({ searchParams }: PageProps) {
  const session = await requireModuleAccess("schedule");
  const sp = await searchParams;

  // Resolve params.
  const deptParam = sp.dept ?? undefined;
  const dateParam = sp.date ?? undefined;
  const view = sp.view === "grid" ? "grid" : "saturday";
  const mode =
    sp.mode === "shadow"
      ? "shadow"
      : sp.mode === "availability"
        ? "availability"
        : "assign";

  // Error banner state.
  const errorCode = sp.error ?? null;
  const errorMessage = errorCode
    ? errorCode === "validation" && sp.message
      ? decodeURIComponent(sp.message)
      : decodeURIComponent(errorCode)
    : null;

  // Load view.
  const data = await builderView(session.personId, {
    departmentId: deptParam,
    dateKey: dateParam,
  });

  // ---------------------------------------------------------------------------
  // Empty state: actor manages no departments
  // ---------------------------------------------------------------------------

  if (data.departments.length === 0) {
    return (
      <div>
        <PageHeader title="Schedule Builder" description="Assign volunteers and manage clinic days" />
        <p className="mt-8 text-sm text-slate-400">You do not direct any departments.</p>
      </div>
    );
  }

  const { selectedDepartment, clinicDates, selectedDateKey, members, assignmentsByDate, conflicts } = data;
  const dept = selectedDepartment!;

  // Shorthand for building hrefs that preserve all current params.
  function href(overrides: HrefParams): string {
    return buildHref("/schedule/builder", {
      dept: dept.id,
      date: selectedDateKey,
      view,
      mode,
      ...overrides,
    });
  }

  // Assignments on the selected date.
  const assignmentsOnDate: Record<string, { role: "VOLUNTEER" | "SHADOW" | "DIRECTOR"; tags: { triage: boolean; walkin: boolean; cc: boolean; remote: boolean } }> =
    selectedDateKey ? (assignmentsByDate[selectedDateKey] ?? {}) : {};

  // Member index by personId for O(1) lookup.
  const memberByPersonId = new Map(members.map((m) => [m.person.id, m]));

  // Partition assigned members.
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

  // Unassigned members (not currently assigned on selectedDate).
  const unassignedMembers = selectedDateKey
    ? members.filter((m) => !assignedPersonIds.has(m.person.id))
    : members;

  // Sort unassigned: available first.
  const sortedUnassigned = [...unassignedMembers].sort((a, b) => {
    const aAvail = selectedDateKey
      ? a.availability.dates.some((d) => isoDateKey(d) === selectedDateKey)
      : false;
    const bAvail = selectedDateKey
      ? b.availability.dates.some((d) => isoDateKey(d) === selectedDateKey)
      : false;
    if (aAvail && !bAvail) return -1;
    if (!aAvail && bAvail) return 1;
    return a.person.name.localeCompare(b.person.name);
  });

  // ---------------------------------------------------------------------------
  // Server actions
  // ---------------------------------------------------------------------------

  // Redirect URL that preserves params, with optional error info.
  function successRedirect(): never {
    const u = new URL("http://x/schedule/builder");
    u.searchParams.set("dept", dept.id);
    if (selectedDateKey) u.searchParams.set("date", selectedDateKey);
    u.searchParams.set("view", view);
    u.searchParams.set("mode", mode);
    redirect(`/schedule/builder?${u.searchParams.toString()}`);
  }

  function errorRedirect(msg: string): never {
    const u = new URL("http://x/schedule/builder");
    u.searchParams.set("dept", dept.id);
    if (selectedDateKey) u.searchParams.set("date", selectedDateKey);
    u.searchParams.set("view", view);
    u.searchParams.set("mode", mode);
    u.searchParams.set("error", "validation");
    u.searchParams.set("message", encodeURIComponent(msg));
    redirect(`/schedule/builder?${u.searchParams.toString()}`);
  }

  async function assignAction(formData: FormData) {
    "use server";
    const actor = await requireModuleAccess("schedule");
    const departmentId = (formData.get("departmentId") as string) ?? "";
    const dateKey = (formData.get("dateKey") as string) ?? "";
    const personId = (formData.get("personId") as string) ?? "";
    const role = (formData.get("role") as "VOLUNTEER" | "SHADOW" | "DIRECTOR") ?? "VOLUNTEER";
    try {
      await setAssignment(actor.personId, { departmentId, dateKey, personId, role });
    } catch (err) {
      if (err instanceof BuilderValidationError || err instanceof BuilderForbiddenError) {
        errorRedirect(err.message);
      }
      throw err;
    }
    revalidatePath("/schedule/builder");
    successRedirect();
  }

  async function unassignAction(formData: FormData) {
    "use server";
    const actor = await requireModuleAccess("schedule");
    const departmentId = (formData.get("departmentId") as string) ?? "";
    const dateKey = (formData.get("dateKey") as string) ?? "";
    const personId = (formData.get("personId") as string) ?? "";
    const reason = ((formData.get("reason") as string) ?? "").trim() || undefined;
    try {
      await setAssignment(actor.personId, { departmentId, dateKey, personId, role: null, reason });
    } catch (err) {
      if (err instanceof BuilderValidationError || err instanceof BuilderForbiddenError) {
        errorRedirect(err.message);
      }
      throw err;
    }
    revalidatePath("/schedule/builder");
    successRedirect();
  }

  async function toggleTagAction(formData: FormData) {
    "use server";
    const actor = await requireModuleAccess("schedule");
    const departmentId = (formData.get("departmentId") as string) ?? "";
    const dateKey = (formData.get("dateKey") as string) ?? "";
    const personId = (formData.get("personId") as string) ?? "";
    const tag = (formData.get("tag") as "triage" | "walkin" | "cc" | "remote") ?? "triage";
    try {
      await toggleTag(actor.personId, { departmentId, dateKey, personId, tag });
    } catch (err) {
      if (err instanceof BuilderValidationError || err instanceof BuilderForbiddenError) {
        errorRedirect(err.message);
      }
      throw err;
    }
    revalidatePath("/schedule/builder");
    successRedirect();
  }

  async function saveOverrideAction(formData: FormData) {
    "use server";
    const actor = await requireModuleAccess("schedule");
    const membershipId = (formData.get("membershipId") as string) ?? "";
    const rawDates = formData.getAll("dates") as string[];
    try {
      await setAvailabilityOverride(actor.personId, { membershipId, dateKeys: rawDates });
    } catch (err) {
      if (err instanceof BuilderValidationError || err instanceof BuilderForbiddenError) {
        errorRedirect(err.message);
      }
      throw err;
    }
    revalidatePath("/schedule/builder");
    successRedirect();
  }

  async function clearOverrideAction(formData: FormData) {
    "use server";
    const actor = await requireModuleAccess("schedule");
    const membershipId = (formData.get("membershipId") as string) ?? "";
    try {
      await setAvailabilityOverride(actor.personId, { membershipId, dateKeys: null });
    } catch (err) {
      if (err instanceof BuilderValidationError || err instanceof BuilderForbiddenError) {
        errorRedirect(err.message);
      }
      throw err;
    }
    revalidatePath("/schedule/builder");
    successRedirect();
  }

  async function acknowledgeAction(formData: FormData) {
    "use server";
    const actor = await requireModuleAccess("schedule");
    const membershipId = (formData.get("membershipId") as string) ?? "";
    try {
      await acknowledgeAvailability(actor.personId, membershipId);
    } catch (err) {
      if (err instanceof BuilderValidationError || err instanceof BuilderForbiddenError) {
        errorRedirect(err.message);
      }
      throw err;
    }
    revalidatePath("/schedule/builder");
    successRedirect();
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div>
      <PageHeader
        title="Schedule Builder"
        description={`${dept.code} - ${dept.name}`}
      />

      {/* Error banner */}
      {errorMessage && (
        <p
          role="alert"
          className="mt-4 rounded-md border border-critical/20 bg-red-50 px-3 py-2 text-sm text-critical"
        >
          {errorMessage}
        </p>
      )}

      {/* Department selector */}
      <form method="GET" action="/schedule/builder" className="mt-6 flex items-end gap-2">
        {dateParam && <input type="hidden" name="date" value={dateParam} />}
        {view !== "saturday" && <input type="hidden" name="view" value={view} />}
        {mode !== "assign" && <input type="hidden" name="mode" value={mode} />}
        <div className="w-56">
          <label className="block text-xs font-medium text-slate-500 mb-1">Department</label>
          <Select name="dept" defaultValue={dept.id}>
            {data.departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.code} - {d.name}
              </option>
            ))}
          </Select>
        </div>
        <Button type="submit" variant="outline" size="sm">
          Go
        </Button>
      </form>

      {/* Date tab strip */}
      {clinicDates.length > 0 && (
        <nav className="mt-5 flex flex-wrap gap-2" aria-label="Clinic dates">
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
                    : "rounded-full px-3 py-1 text-sm font-medium bg-slate-100 text-slate-600 hover:bg-slate-200 transition-colors"
                }
              >
                {displayDate(key)}
              </a>
            );
          })}
        </nav>
      )}

      {/* View toggle */}
      <div className="mt-5 flex items-center gap-2">
        <span className="text-xs font-medium text-slate-500">View:</span>
        <a
          href={href({ view: "saturday" })}
          aria-current={view === "saturday" ? "true" : undefined}
          className={
            view === "saturday"
              ? "rounded-md px-3 py-1 text-sm font-medium bg-slate-200 text-slate-800"
              : "rounded-md px-3 py-1 text-sm font-medium text-slate-500 hover:bg-slate-100 transition-colors"
          }
        >
          Saturday
        </a>
        <a
          href={href({ view: "grid" })}
          aria-current={view === "grid" ? "true" : undefined}
          className={
            view === "grid"
              ? "rounded-md px-3 py-1 text-sm font-medium bg-slate-200 text-slate-800"
              : "rounded-md px-3 py-1 text-sm font-medium text-slate-500 hover:bg-slate-100 transition-colors"
          }
        >
          Grid
        </a>
      </div>

      {/* Mode toggle */}
      <div className="mt-3 flex items-center gap-2">
        <span className="text-xs font-medium text-slate-500">Mode:</span>
        {(["assign", "shadow", "availability"] as const).map((m) => (
          <a
            key={m}
            href={href({ mode: m })}
            aria-current={mode === m ? "true" : undefined}
            className={
              mode === m
                ? "rounded-md px-3 py-1 text-sm font-medium bg-brand text-white"
                : "rounded-md px-3 py-1 text-sm font-medium text-slate-500 hover:bg-slate-100 transition-colors"
            }
          >
            {m === "assign" ? "Assign" : m === "shadow" ? "Shadow" : "Availability"}
          </a>
        ))}
      </div>

      {/* Main content area */}
      <div className="mt-8">
        {view === "grid" ? (
          /* Grid placeholder for Task 8 */
          <p className="text-sm text-slate-400">Grid view coming in the next step.</p>
        ) : mode === "availability" ? (
          /* Availability mode */
          <AvailabilityView
            members={members}
            clinicDates={clinicDates}
            dept={dept}
            saveOverrideAction={saveOverrideAction}
            clearOverrideAction={clearOverrideAction}
            acknowledgeAction={acknowledgeAction}
          />
        ) : (
          /* Saturday view: assign or shadow mode */
          <div className="grid grid-cols-1 gap-8 md:grid-cols-2">
            {/* Column 1: Assigned */}
            <section>
              <h2 className="mb-4 text-base font-semibold">Assigned</h2>

              {/* Directors */}
              <div className="mb-6">
                <h3 className="mb-2 text-sm font-medium text-slate-600">Directors</h3>
                {assignedDirectors.length === 0 ? (
                  <p className="text-sm text-slate-400">None assigned.</p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {assignedDirectors.map((pid) => {
                      const m = memberByPersonId.get(pid);
                      const name = m?.person.name ?? pid;
                      return (
                        <div key={pid} className="flex flex-wrap items-center gap-2 text-sm">
                          <span className="font-medium">{name}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Volunteers */}
              <div className="mb-6">
                <h3 className="mb-2 text-sm font-medium text-slate-600">Volunteers</h3>
                {assignedVolunteers.length === 0 ? (
                  <p className="text-sm text-slate-400">None assigned.</p>
                ) : (
                  <div className="flex flex-col gap-3">
                    {assignedVolunteers.map((pid) => {
                      const m = memberByPersonId.get(pid);
                      const name = m?.person.name ?? pid;
                      const assignment = assignmentsOnDate[pid]!;
                      const tags = assignment.tags;
                      const personConflicts = conflicts[pid] ?? [];
                      return (
                        <div key={pid} className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                          <div className="flex flex-wrap items-center gap-2 text-sm">
                            <span className="font-medium">{name}</span>
                            {personConflicts.length > 0 && (
                              <Badge
                                tone="warning"
                                title={personConflicts.join(", ")}
                              >
                                Also in {personConflicts.join(", ")}
                              </Badge>
                            )}
                          </div>
                          {/* Tag toggles */}
                          <div className="mt-2 flex flex-wrap gap-1">
                            {(["triage", "walkin", "cc", "remote"] as const).map((tag) => (
                              <BuilderCell
                                key={tag}
                                action={toggleTagAction}
                                hidden={{
                                  departmentId: dept.id,
                                  dateKey: selectedDateKey ?? "",
                                  personId: pid,
                                  tag,
                                }}
                                label={tag === "walkin" ? "Walk-in" : tag.charAt(0).toUpperCase() + tag.slice(1)}
                                pressed={tags[tag]}
                                variant="tag"
                              />
                            ))}
                          </div>
                          {/* Unassign */}
                          <form action={unassignAction} className="mt-2 flex flex-wrap items-center gap-2">
                            <input type="hidden" name="departmentId" value={dept.id} />
                            <input type="hidden" name="dateKey" value={selectedDateKey ?? ""} />
                            <input type="hidden" name="personId" value={pid} />
                            <Input name="reason" placeholder="Reason (optional)" className="flex-1 min-w-32 py-1 text-xs" />
                            <ConfirmButton label="Remove" confirmLabel="Remove this volunteer?" />
                          </form>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Shadows */}
              <div>
                <h3 className="mb-2 text-sm font-medium text-slate-600">Shadows</h3>
                {assignedShadows.length === 0 ? (
                  <p className="text-sm text-slate-400">None assigned.</p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {assignedShadows.map((pid) => {
                      const m = memberByPersonId.get(pid);
                      const name = m?.person.name ?? pid;
                      return (
                        <div key={pid} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
                          <span className="text-sm font-medium">{name}</span>
                          <form action={unassignAction} className="ml-auto flex flex-wrap items-center gap-2">
                            <input type="hidden" name="departmentId" value={dept.id} />
                            <input type="hidden" name="dateKey" value={selectedDateKey ?? ""} />
                            <input type="hidden" name="personId" value={pid} />
                            <ConfirmButton label="Remove" confirmLabel="Remove this shadow?" />
                          </form>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>

            {/* Column 2: Available to assign */}
            <section>
              <h2 className="mb-4 text-base font-semibold">Available to assign</h2>
              {sortedUnassigned.length === 0 ? (
                <p className="text-sm text-slate-400">All members are already assigned.</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {sortedUnassigned.map((member) => {
                    const isAvail = selectedDateKey
                      ? member.availability.dates.some((d) => isoDateKey(d) === selectedDateKey)
                      : false;
                    const isDirectorKind = member.kind === "DIRECTOR";
                    return (
                      <div key={member.person.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
                        <span className="text-sm font-medium">{member.person.name}</span>
                        <Badge tone={isDirectorKind ? "brand" : "default"}>
                          {isDirectorKind ? "Director" : "Volunteer"}
                        </Badge>
                        {isAvail && <Badge tone="success">Available</Badge>}
                        <div className="ml-auto flex flex-wrap gap-2">
                          {/* Assign as volunteer (or shadow in shadow mode) */}
                          <BuilderCell
                            action={assignAction}
                            hidden={{
                              departmentId: dept.id,
                              dateKey: selectedDateKey ?? "",
                              personId: member.person.id,
                              role: mode === "shadow" ? "SHADOW" : "VOLUNTEER",
                            }}
                            label={mode === "shadow" ? "Assign as shadow" : "Assign"}
                            variant="assign"
                          />
                          {/* Assign as director -- only in assign mode for director-kind members */}
                          {mode === "assign" && isDirectorKind && (
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
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Availability mode sub-view (server component)
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
    <div className="flex flex-col gap-6">
      {members.length === 0 && (
        <p className="text-sm text-slate-400">No members in this department.</p>
      )}
      {members.map((member) => {
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
          <div key={member.membershipId} className="rounded-lg border border-slate-200 bg-white px-4 py-3">
            {/* Header */}
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <span className="text-sm font-medium">{member.person.name}</span>
              <Badge tone="default">{member.kind === "DIRECTOR" ? "Director" : "Volunteer"}</Badge>
              <Badge tone={tierTone}>{tierLabel}</Badge>
              {member.acknowledgePending && (
                <Badge tone="warning">Availability updated</Badge>
              )}
            </div>

            {/* Legacy note */}
            {member.legacyNote && (
              <p className="mb-3 text-xs text-slate-400 italic">{member.legacyNote}</p>
            )}

            {/* Override form (date checkboxes) */}
            <form action={saveOverrideAction} className="mb-2">
              <input type="hidden" name="membershipId" value={member.membershipId} />
              <div className="flex flex-wrap gap-3 mb-3">
                {clinicDates.map((d) => {
                  const key = isoDateKey(d);
                  return (
                    <label key={key} className="flex items-center gap-1.5 text-xs text-slate-700">
                      <input
                        type="checkbox"
                        name="dates"
                        value={key}
                        defaultChecked={availKeys.has(key)}
                        className="h-3.5 w-3.5 rounded border-slate-300 text-brand focus:ring-brand"
                      />
                      {displayDate(key)}
                    </label>
                  );
                })}
              </div>
              <Button type="submit" variant="outline" size="sm">
                Save override
              </Button>
            </form>

            {/* Clear override (only when override is active) */}
            {member.overrideActive && (
              <form action={clearOverrideAction} className="inline mr-2">
                <input type="hidden" name="membershipId" value={member.membershipId} />
                <Button type="submit" variant="ghost" size="sm">
                  Clear override
                </Button>
              </form>
            )}

            {/* Acknowledge availability */}
            {member.acknowledgePending && (
              <form action={acknowledgeAction} className="inline">
                <input type="hidden" name="membershipId" value={member.membershipId} />
                <ConfirmButton
                  label="Acknowledge"
                  confirmLabel="Mark availability as reviewed?"
                />
              </form>
            )}
          </div>
        );
      })}
    </div>
  );
}
