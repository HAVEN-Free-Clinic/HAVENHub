import { notFound } from "next/navigation";
import { DateTime } from "@/platform/dates/display";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { zoneLabel } from "@/platform/dates/zone";
import { formatForDateTimeInput, formatForDateInput } from "@/platform/dates";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { requirePermission, requirePersonSession } from "@/platform/auth/session";
import { can } from "@/platform/rbac/engine";
import { portalUrl } from "@/modules/recruitment/services/portal-url";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { cycleTrail } from "@/modules/recruitment/breadcrumbs";
import { publishCycleAction, closeCycleAction, reopenCycleAction, archiveCycleAction, toggleRenewalsAction, setTrainingCycleAction, updateQuizSettingsAction, setCycleDepartmentsAction, setApplicationWindowAction } from "../../actions";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { PageHeader } from "@/platform/ui/page-header";
import { Badge } from "@/platform/ui/badge";
import { Field, Input } from "@/platform/ui/input";
import { SubmitButton } from "@/platform/ui/submit-button";
import { prisma } from "@/platform/db";
import { MultiCombobox } from "@/platform/ui/multi-combobox";
import { Card } from "@/platform/ui/card";
import { FormActions } from "@/platform/ui/form";
import { SectionHeader } from "@/platform/ui/section-header";

const statusTone = { DRAFT: "default", OPEN: "success", CLOSED: "warning", ARCHIVED: "default" } as const;

type PageProps = {
  params: Promise<{ id: string }>;
};

export default async function CycleOverviewPage({ params }: PageProps) {
  const { id } = await params;
  await requirePermission("recruitment.access");
  const cycle = await getCycle(id);
  if (!cycle) notFound();

  // The /recruitment layout admits any recruitment.access holder (reviewers), but the
  // cycle-lifecycle controls below are all gated on recruitment.manage_cycles server-side.
  // Hide them from reviewers so they do not see controls that would only error on submit.
  const session = await requirePersonSession();
  const canManage = await can(session.personId, "recruitment.manage_cycles");
  const zone = await getDisplayTimeZone();

  const activeDepts = await prisma.department.findMany({ where: { isActive: true }, select: { code: true, name: true }, orderBy: { code: "asc" } });
  const apps = await prisma.application.findMany({ where: { cycleId: id }, select: { departmentChoices: true } });
  const counts = new Map<string, number>();
  for (const a of apps) for (const c of a.departmentChoices) counts.set(c, (counts.get(c) ?? 0) + 1);
  const activeCodes = new Set(activeDepts.map((d) => d.code));
  const deptOptions = [
    ...activeDepts.map((d) => ({ code: d.code, name: d.name, known: true })),
    ...cycle.departments.filter((c) => !activeCodes.has(c)).map((c) => ({ code: c, name: null as string | null, known: false })),
  ];
  // Annotate each option so staff see the consequence of removing a department
  // (applicant counts, and codes no longer in the active department list) both in
  // the dropdown and on the selected chip.
  const deptSelectOptions = deptOptions.map((d) => {
    const c = counts.get(d.code) ?? 0;
    const parts: string[] = [];
    if (c > 0) parts.push(`${c} applicant${c === 1 ? "" : "s"}`);
    if (!d.known) parts.push("not in department list");
    return {
      value: d.code,
      label: d.name ? `${d.code} - ${d.name}` : d.code,
      note: parts.length ? parts.join(" · ") : undefined,
    };
  });
  const applyUrl = await portalUrl(cycle.publicSlug);
  // The opensAt/closesAt window is a soft gate *inside* the OPEN status: the public
  // form only accepts applications while now is in [opensAt, closesAt]. Reflect that
  // here so the admin view matches what an applicant actually sees (issue #106).
  const now = new Date();
  const beforeOpen = cycle.status === "OPEN" && cycle.opensAt !== null && cycle.opensAt > now;
  const afterClose = cycle.status === "OPEN" && cycle.closesAt !== null && cycle.closesAt < now;
  const liveByWindow = cycle.status === "OPEN" && !beforeOpen && !afterClose;
  return (
    <div className="max-w-2xl space-y-6">
      <SetBreadcrumb trail={cycleTrail({ cycleId: id, cycleTitle: cycle.title })} />
      <PageHeader
        title={cycle.title}
        action={<Badge tone={statusTone[cycle.status as keyof typeof statusTone] ?? "default"}>{cycle.status}</Badge>}
      />

      <Card>
        <SectionHeader>Public link</SectionHeader>
        {cycle.status === "OPEN" ? (
          <div className="mt-1 space-y-1">
            {liveByWindow ? (
              <a className="inline-block text-sm font-medium text-brand-fg hover:text-brand-hover" href={applyUrl}>
                {applyUrl}
              </a>
            ) : (
              <p className="text-sm text-muted-foreground">{applyUrl}</p>
            )}
            {beforeOpen && (
              <p className="text-xs text-subtle-foreground">Scheduled to open <DateTime value={cycle.opensAt} />. Not accepting applications yet.</p>
            )}
            {afterClose && (
              <p className="text-xs text-subtle-foreground">Application window closed <DateTime value={cycle.closesAt} />. No longer accepting applications.</p>
            )}
            {liveByWindow && cycle.closesAt && (
              <p className="text-xs text-subtle-foreground">Accepting applications until <DateTime value={cycle.closesAt} />.</p>
            )}
          </div>
        ) : (
          <p className="mt-1 text-sm text-muted-foreground">Publish the cycle to activate {applyUrl}</p>
        )}
      </Card>

      <Card className="space-y-3">
        <SectionHeader>Departments</SectionHeader>
        {cycle.status === "ARCHIVED" || !canManage ? (
          <div className="flex flex-wrap gap-2">
            {cycle.departments.length === 0 ? (
              <p className="text-sm text-subtle-foreground">No departments.</p>
            ) : (
              cycle.departments.map((c) => (
                <span key={c} className="rounded-lg border border-border px-2 py-1 text-sm text-foreground">{c}</span>
              ))
            )}
          </div>
        ) : (
          <form action={setCycleDepartmentsAction.bind(null, id)} className="space-y-3">
            {deptSelectOptions.length === 0 ? (
              <p className="text-sm text-subtle-foreground">No departments configured.</p>
            ) : (
              <MultiCombobox
                name="departments"
                options={deptSelectOptions}
                defaultValue={cycle.departments}
                ariaLabel="Departments"
                placeholder="Search departments…"
              />
            )}
            <FormActions>
              <SubmitButton size="sm" variant="outline" pendingLabel="Saving…">Save departments</SubmitButton>
            </FormActions>
          </form>
        )}
      </Card>

      {canManage && (cycle.status === "DRAFT" || cycle.status === "OPEN") && (
        <Card className="space-y-3">
          <SectionHeader>Application window</SectionHeader>
          <p className="text-sm text-muted-foreground">
            Optional. While the cycle is open, the public form only accepts applications inside this window. Leave a field blank for no bound, or clear both to accept whenever the cycle is open. Times are in {zoneLabel(zone)}.
          </p>
          <form action={setApplicationWindowAction.bind(null, id)} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Opens" hint="Blank means open as soon as the cycle is published.">
                <Input type="datetime-local" name="opensAt" defaultValue={formatForDateTimeInput(cycle.opensAt, zone)} />
              </Field>
              <Field label="Closes" hint="Blank means stay open until the cycle is closed.">
                <Input type="datetime-local" name="closesAt" defaultValue={formatForDateTimeInput(cycle.closesAt, zone)} />
              </Field>
            </div>
            <FormActions>
              <SubmitButton size="sm" variant="outline" pendingLabel="Saving…">Save window</SubmitButton>
            </FormActions>
          </form>
        </Card>
      )}

      {canManage && (
      <div className="flex flex-wrap items-center gap-3">
        {cycle.status === "DRAFT" && (
          <form action={publishCycleAction.bind(null, id)}>
            <SubmitButton size="sm" pendingLabel="Publishing…">Publish</SubmitButton>
          </form>
        )}
        {cycle.status === "OPEN" && (
          <form action={closeCycleAction.bind(null, id)}>
            <SubmitButton size="sm" variant="outline" pendingLabel="Closing…">Close</SubmitButton>
          </form>
        )}
        {cycle.status === "CLOSED" && (
          <>
            <form action={reopenCycleAction.bind(null, id)}>
              <SubmitButton size="sm" variant="outline" pendingLabel="Reopening…">Reopen</SubmitButton>
            </form>
            <form action={archiveCycleAction.bind(null, id)}>
              <ConfirmButton label="Archive" confirmLabel="Archive this cycle?" size="sm" />
            </form>
          </>
        )}
        {cycle.status === "ARCHIVED" && (
          <p className="text-sm text-subtle-foreground">Archived. Removed from the active cycle list.</p>
        )}
        {(cycle.status === "DRAFT" || cycle.status === "OPEN") && (
          <form action={toggleRenewalsAction.bind(null, id, !cycle.acceptsRenewals)}>
            <SubmitButton size="sm" variant="ghost">
              {cycle.acceptsRenewals ? "Disable" : "Enable"} renewal branch
            </SubmitButton>
          </form>
        )}
      </div>
      )}

      {(cycle.track === "VOLUNTEER" || cycle.track === "DIRECTOR") && (
        <Card className="space-y-4">
          <SectionHeader>{cycle.track === "DIRECTOR" ? "Director training" : "Training"}</SectionHeader>
          {canManage && (
            <>
              <form action={setTrainingCycleAction.bind(null, id, !cycle.isTermTraining)}>
                <SubmitButton size="sm" variant="ghost">
                  {cycle.isTermTraining ? "Stop using as this term's training" : "Use as this term's training"}
                </SubmitButton>
              </form>
              <form action={updateQuizSettingsAction.bind(null, id)} className="flex flex-wrap items-end gap-3">
                <div className="w-28">
                  <Field label="Pass %">
                    <Input name="quizPassPercent" type="number" min={0} max={100} defaultValue={cycle.quizPassPercent} />
                  </Field>
                </div>
                <div className="w-28">
                  <Field label="Max attempts">
                    <Input name="quizMaxAttempts" type="number" min={1} defaultValue={cycle.quizMaxAttempts} />
                  </Field>
                </div>
                <div className="w-44">
                  <Field label="In-person training date">
                    <Input
                      name="inPersonTrainingDate"
                      type="date"
                      defaultValue={cycle.inPersonTrainingDate ? formatForDateInput(cycle.inPersonTrainingDate, zone) : ""}
                    />
                  </Field>
                </div>
                <div className="w-56">
                  <Field label="Training location / time">
                    <Input
                      name="trainingLocation"
                      type="text"
                      defaultValue={cycle.trainingLocation ?? ""}
                      placeholder="on Zoom at 10:00 AM"
                    />
                  </Field>
                </div>
                <SubmitButton size="sm" variant="outline" pendingLabel="Saving…">Save quiz settings</SubmitButton>
              </form>
            </>
          )}
        </Card>
      )}
    </div>
  );
}
