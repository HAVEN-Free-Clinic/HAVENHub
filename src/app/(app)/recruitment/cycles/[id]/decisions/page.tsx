import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { listConflicts, releaseSummary } from "@/modules/recruitment/services/decisions";
import { releaseDecisionsAction } from "./actions";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { cycleTrail } from "@/modules/recruitment/breadcrumbs";
import { PageHeader } from "@/platform/ui/page-header";
import { StatCard } from "@/platform/ui/stat-card";
import { Alert } from "@/platform/ui/alert";
import { SubmitButton } from "@/platform/ui/submit-button";
import { cardClasses } from "@/platform/ui/card";

export default async function DecisionsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ sent?: string; skipped?: string; error?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  await requirePermission("recruitment.review_all");
  const cycle = await getCycle(id);
  if (!cycle) notFound();
  const [conflicts, summary] = await Promise.all([listConflicts(id), releaseSummary(id)]);

  return (
    <div className="max-w-2xl space-y-6">
      <SetBreadcrumb
        trail={cycleTrail({
          cycleId: id,
          cycleTitle: cycle.title,
          section: { label: "Decisions", slug: "decisions" },
        })}
      />
      <PageHeader title="Decisions" description={cycle.title} />
      {sp.error && <Alert tone="error">{sp.error}</Alert>}
      {sp.sent !== undefined && (
        <Alert tone="success">
          Released {sp.sent} acceptance email(s); skipped {sp.skipped} conflicted applicant(s).
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Accepted" value={summary.acceptedApplications} />
        <StatCard label="Unnotified" value={summary.unnotified} />
        <StatCard label="Conflicts" value={summary.conflictedApplications} tone={summary.conflictedApplications > 0 ? "critical" : "default"} />
        <StatCard label="Emailed" value={summary.emailed} />
      </div>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Conflicts to resolve</h2>
        {conflicts.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No conflicts.</p>
        ) : (
          <ul className={`mt-3 divide-y divide-border-subtle ${cardClasses({ pad: false })}`}>
            {conflicts.map((c) => (
              <li key={c.applicationId} className="px-4 py-2.5 text-sm text-foreground-soft">
                <Link
                  className="font-medium text-brand-fg hover:text-brand-hover"
                  href={`/recruitment/cycles/${id}/applicants/${c.applicationId}`}
                >
                  {c.applicantName}
                </Link>{" "}
                accepted by {c.departments.join(" + ")}
              </li>
            ))}
          </ul>
        )}
      </section>

      <form action={releaseDecisionsAction.bind(null, id)} className="space-y-2">
        <SubmitButton pendingLabel="Releasing…">Release decisions</SubmitButton>
        <p className="text-xs text-subtle-foreground">
          Emails every accepted, non-conflicted applicant who hasn&apos;t been notified yet.
        </p>
      </form>
    </div>
  );
}
