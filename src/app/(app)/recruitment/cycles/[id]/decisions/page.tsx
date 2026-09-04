import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { listConflicts, releaseSummary, rejectionSummary } from "@/modules/recruitment/services/decisions";
import { releaseDecisionsAction, sendRejectionsAction } from "./actions";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { cycleTrail } from "@/modules/recruitment/breadcrumbs";
import { PageHeader } from "@/platform/ui/page-header";
import { StatCard } from "@/platform/ui/stat-card";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { Alert } from "@/platform/ui/alert";
import { cardClasses } from "@/platform/ui/card";
import { SectionHeader } from "@/platform/ui/section-header";
import { EmptyState } from "@/platform/ui/empty-state";

/** Reads the one query param the actions redirect back with. Both actions can
 *  land here with an ?error= (a permission or ordering refusal), and until this
 *  page read it those refusals were silently swallowed: the user pressed
 *  Release, nothing happened, and nothing said why. */
function first(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

export default async function DecisionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;
  await requirePermission("recruitment.access");
  await requirePermission("recruitment.review_all");
  const cycle = await getCycle(id);
  if (!cycle) notFound();
  const [conflicts, summary, rejections] = await Promise.all([
    listConflicts(id),
    releaseSummary(id),
    rejectionSummary(id),
  ]);

  const error = first(query.error);
  const released = first(query.sent);
  const rejected = first(query.rejected);

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

      {error && <Alert tone="error">{error}</Alert>}
      {released && (
        <Alert tone="success">
          Sent {released} acceptance {released === "1" ? "email" : "emails"}.
        </Alert>
      )}
      {rejected && (
        <Alert tone="success">
          Sent {rejected} not-selected {rejected === "1" ? "email" : "emails"}.
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Accepted" value={summary.acceptedApplications} />
        <StatCard label="Unnotified" value={summary.unnotified} />
        <StatCard label="Conflicts" value={summary.conflictedApplications} tone={summary.conflictedApplications > 0 ? "critical" : "default"} />
        <StatCard label="Emailed" value={summary.emailed} />
      </div>

      <section>
        <SectionHeader>Conflicts to resolve</SectionHeader>
        {conflicts.length === 0 ? (
          <EmptyState inline className="mt-2">No conflicts.</EmptyState>
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
        <ConfirmButton label="Release decisions" confirmLabel="Send acceptance emails?" />
        <p className="text-xs text-subtle-foreground">
          Emails every accepted, non-conflicted applicant who hasn&apos;t been notified yet.
        </p>
      </form>

      {/* Rejections are their own section and their own button, not part of
          Release. SRR times and checks this send separately -- see the block
          comment in services/decisions.ts. */}
      <section className="space-y-3 border-t border-border-subtle pt-6">
        <SectionHeader>Not selected</SectionHeader>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <StatCard label="Not selected" value={rejections.rejected} />
          <StatCard label="Unnotified" value={rejections.unnotified} />
          <StatCard label="Emailed" value={rejections.emailed} />
        </div>

        <form action={sendRejectionsAction.bind(null, id)} className="space-y-2">
          <ConfirmButton
            label="Send rejection emails"
            confirmLabel={`Email ${rejections.unnotified} not-selected ${rejections.unnotified === 1 ? "applicant" : "applicants"}?`}
            disabled={!rejections.released || rejections.unnotified === 0}
          />
          <p className="text-xs text-subtle-foreground">
            {!rejections.released
              ? "Release decisions first, so accepted applicants hear before anyone is told they were not selected."
              : rejections.unnotified === 0
                ? "Everyone marked Rejected on the applicant roster has already been emailed."
                : "Emails every applicant the roster shows as Rejected and who hasn't been notified yet. Applicants who were accepted, waitlisted, still undecided, or who withdrew are never included."}
          </p>
        </form>
      </section>
    </div>
  );
}
