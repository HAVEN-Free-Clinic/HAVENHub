import Link from "next/link";
import { notFound } from "next/navigation";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { cycleTrail } from "@/modules/recruitment/breadcrumbs";
import { publishCycleAction, closeCycleAction, reopenCycleAction, archiveCycleAction, toggleRenewalsAction, setTrainingCycleAction, updateQuizSettingsAction, setCycleDepartmentsAction, setApplicationWindowAction } from "../../actions";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { PageHeader } from "@/platform/ui/page-header";
import { Badge } from "@/platform/ui/badge";
import { Field, Input } from "@/platform/ui/input";
import { Alert } from "@/platform/ui/alert";
import { buttonClasses } from "@/platform/ui/button";
import { SubmitButton } from "@/platform/ui/submit-button";
import { prisma } from "@/platform/db";
import { Checkbox } from "@/platform/ui/checkbox";
import { Card } from "@/platform/ui/card";
import { FormActions } from "@/platform/ui/form";
import { SectionHeader } from "@/platform/ui/section-header";

const statusTone = { DRAFT: "default", OPEN: "success", CLOSED: "warning", ARCHIVED: "default" } as const;

/** Format a stored instant for a <input type="datetime-local"> default value
 *  (local wall-clock, "YYYY-MM-DDTHH:mm"). Mirrors the interview scheduler so the
 *  format here and the `new Date(raw)` parse in setApplicationWindowAction agree. */
function toLocalInput(d: Date | null): string {
  return d ? new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "";
}

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; deptsaved?: string; deptwarn?: string; windowsaved?: string }>;
};

export default async function CycleOverviewPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const { error, deptsaved, deptwarn, windowsaved } = await searchParams;
  const cycle = await getCycle(id);
  if (!cycle) notFound();

  const activeDepts = await prisma.department.findMany({ where: { isActive: true }, select: { code: true, name: true }, orderBy: { code: "asc" } });
  const apps = await prisma.application.findMany({ where: { cycleId: id }, select: { departmentChoices: true } });
  const counts = new Map<string, number>();
  for (const a of apps) for (const c of a.departmentChoices) counts.set(c, (counts.get(c) ?? 0) + 1);
  const activeCodes = new Set(activeDepts.map((d) => d.code));
  const deptOptions = [
    ...activeDepts.map((d) => ({ code: d.code, name: d.name, known: true })),
    ...cycle.departments.filter((c) => !activeCodes.has(c)).map((c) => ({ code: c, name: null as string | null, known: false })),
  ];
  const selected = new Set(cycle.departments);
  const applyUrl = `/apply/${cycle.publicSlug}`;
  const navLink = buttonClasses("outline", "sm");
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
      {error && <Alert tone="error">{error}</Alert>}

      <div className="flex flex-wrap gap-2">
        <Link href={`/recruitment/cycles/${id}/builder`} className={navLink}>Edit form</Link>
        <Link href={`/recruitment/cycles/${id}/applicants`} className={navLink}>View applicants</Link>
        <Link href={`/recruitment/cycles/${id}/decisions`} className={navLink}>Decisions</Link>
        {cycle.track === "VOLUNTEER" && (
          <Link href={`/recruitment/cycles/${id}/subcommittees`} className={navLink}>Subcommittees</Link>
        )}
        {cycle.track === "DIRECTOR" && (
          <Link href={`/recruitment/cycles/${id}/interviews`} className={navLink}>Interviews</Link>
        )}
        <Link href={`/recruitment/cycles/${id}/onboarding`} className={navLink}>Onboarding</Link>
        <Link href={`/recruitment/cycles/${id}/emails`} className={navLink}>Edit emails</Link>
      </div>

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
              <p className="text-xs text-subtle-foreground">Scheduled to open {cycle.opensAt!.toLocaleString()}. Not accepting applications yet.</p>
            )}
            {afterClose && (
              <p className="text-xs text-subtle-foreground">Application window closed {cycle.closesAt!.toLocaleString()}. No longer accepting applications.</p>
            )}
            {liveByWindow && cycle.closesAt && (
              <p className="text-xs text-subtle-foreground">Accepting applications until {cycle.closesAt.toLocaleString()}.</p>
            )}
          </div>
        ) : (
          <p className="mt-1 text-sm text-muted-foreground">Publish the cycle to activate {applyUrl}</p>
        )}
      </Card>

      <Card className="space-y-3">
        <SectionHeader>Departments</SectionHeader>
        {deptsaved && <Alert tone="success">Departments updated.</Alert>}
        {deptwarn && <Alert tone="warning">Saved. These removed departments still have applicants: {deptwarn}. Existing applications keep their choices, but you can no longer accept into a removed department.</Alert>}
        {cycle.status === "ARCHIVED" ? (
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
            <div className="grid gap-2 sm:grid-cols-2">
              {deptOptions.map((d) => (
                <label key={d.code} className="flex items-center gap-2 text-sm">
                  <Checkbox name="departments" value={d.code} defaultChecked={selected.has(d.code)} />
                  <span className="text-foreground">{d.code}{d.name ? ` - ${d.name}` : ""}</span>
                  <span className="text-xs text-subtle-foreground">{counts.get(d.code) ? `${counts.get(d.code)} applicant${counts.get(d.code) === 1 ? "" : "s"}` : ""}{!d.known ? " · not in department list" : ""}</span>
                </label>
              ))}
              {deptOptions.length === 0 && <p className="text-sm text-subtle-foreground">No departments configured.</p>}
            </div>
            <FormActions>
              <SubmitButton size="sm" variant="outline" pendingLabel="Saving…">Save departments</SubmitButton>
            </FormActions>
          </form>
        )}
      </Card>

      {(cycle.status === "DRAFT" || cycle.status === "OPEN") && (
        <Card className="space-y-3">
          <SectionHeader>Application window</SectionHeader>
          {windowsaved && <Alert tone="success">Application window updated.</Alert>}
          <p className="text-sm text-muted-foreground">
            Optional. While the cycle is open, the public form only accepts applications inside this window. Leave a field blank for no bound, or clear both to accept whenever the cycle is open. Times use the server timezone.
          </p>
          <form action={setApplicationWindowAction.bind(null, id)} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Opens" hint="Blank means open as soon as the cycle is published.">
                <Input type="datetime-local" name="opensAt" defaultValue={toLocalInput(cycle.opensAt)} />
              </Field>
              <Field label="Closes" hint="Blank means stay open until the cycle is closed.">
                <Input type="datetime-local" name="closesAt" defaultValue={toLocalInput(cycle.closesAt)} />
              </Field>
            </div>
            <FormActions>
              <SubmitButton size="sm" variant="outline" pendingLabel="Saving…">Save window</SubmitButton>
            </FormActions>
          </form>
        </Card>
      )}

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

      {(cycle.track === "VOLUNTEER" || cycle.track === "DIRECTOR") && (
        <Card className="space-y-4">
          <SectionHeader>{cycle.track === "DIRECTOR" ? "Director training" : "Training"}</SectionHeader>
          <div className="flex flex-wrap gap-2">
            <Link href={`/recruitment/cycles/${id}/builder/quiz`} className={navLink}>Edit quiz</Link>
            <Link href={`/recruitment/cycles/${id}/training`} className={navLink}>Training roster</Link>
          </div>
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
            <SubmitButton size="sm" variant="outline" pendingLabel="Saving…">Save quiz settings</SubmitButton>
          </form>
        </Card>
      )}
    </div>
  );
}
