import Link from "next/link";
import { notFound } from "next/navigation";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { cycleTrail } from "@/modules/recruitment/breadcrumbs";
import { publishCycleAction, closeCycleAction, toggleRenewalsAction, setTrainingCycleAction, updateQuizSettingsAction } from "../../actions";
import { PageHeader } from "@/platform/ui/page-header";
import { Badge } from "@/platform/ui/badge";
import { Field, Input } from "@/platform/ui/input";
import { Alert } from "@/platform/ui/alert";
import { buttonClasses } from "@/platform/ui/button";
import { SubmitButton } from "@/platform/ui/submit-button";

const statusTone = { DRAFT: "default", OPEN: "success", CLOSED: "warning" } as const;

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
};

export default async function CycleOverviewPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const { error } = await searchParams;
  const cycle = await getCycle(id);
  if (!cycle) notFound();
  const applyUrl = `/apply/${cycle.publicSlug}`;
  const navLink = buttonClasses("outline", "sm");
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
        {cycle.track === "DIRECTOR" && (
          <Link href={`/recruitment/cycles/${id}/interviews`} className={navLink}>Interviews</Link>
        )}
        <Link href={`/recruitment/cycles/${id}/onboarding`} className={navLink}>Onboarding</Link>
      </div>

      <div className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
        <p className="text-xs font-medium uppercase tracking-wider text-subtle-foreground">Public link</p>
        {cycle.status === "OPEN" ? (
          <a className="mt-1 inline-block text-sm font-medium text-brand-fg hover:text-brand-hover" href={applyUrl}>
            {applyUrl}
          </a>
        ) : (
          <p className="mt-1 text-sm text-muted-foreground">Publish the cycle to activate {applyUrl}</p>
        )}
      </div>

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
        {(cycle.status === "DRAFT" || cycle.status === "OPEN") && (
          <form action={toggleRenewalsAction.bind(null, id, !cycle.acceptsRenewals)}>
            <SubmitButton size="sm" variant="ghost">
              {cycle.acceptsRenewals ? "Disable" : "Enable"} renewal branch
            </SubmitButton>
          </form>
        )}
      </div>

      {(cycle.track === "VOLUNTEER" || cycle.track === "DIRECTOR") && (
        <div className="space-y-4 rounded-2xl border border-border bg-surface p-5 shadow-sm">
          <p className="text-xs font-medium uppercase tracking-wider text-subtle-foreground">
            {cycle.track === "DIRECTOR" ? "Director training" : "Training"}
          </p>
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
        </div>
      )}
    </div>
  );
}
