import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { listOnboardingRows } from "@/modules/recruitment/services/onboarding";
import { sendLinksAction, promoteAction, withdrawAction } from "./actions";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { cycleTrail } from "@/modules/recruitment/breadcrumbs";
import { PageHeader } from "@/platform/ui/page-header";
import { OnboardingTable } from "@/modules/recruitment/components/onboarding-table";

export default async function OnboardingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requirePermission("recruitment.access");
  await requirePermission("recruitment.review_all");
  const cycle = await getCycle(id);
  if (!cycle) notFound();
  const rows = await listOnboardingRows(id);
  const hasConflicts = rows.some((r) => r.state === "CONFLICT");

  return (
    <div className="max-w-4xl space-y-6">
      <SetBreadcrumb
        trail={cycleTrail({
          cycleId: id,
          cycleTitle: cycle.title,
          section: { label: "Onboarding", slug: "onboarding" },
        })}
      />
      <PageHeader title="Onboarding" description={cycle.title} />

      <OnboardingTable
        rows={rows}
        cycleId={id}
        sendLinks={sendLinksAction.bind(null, id)}
        promote={promoteAction.bind(null, id)}
        withdraw={withdrawAction.bind(null, id)}
      />

      <p className="text-xs text-subtle-foreground">
        Resending refreshes the 21-day expiry on the same link, so an expired or
        undelivered link is recoverable without a fresh acceptance.
      </p>
      {hasConflicts && (
        <p className="text-xs text-subtle-foreground">
          Applicants accepted by more than one department are marked{" "}
          <span className="font-medium text-foreground-soft">Conflict</span> and can&apos;t be onboarded until you resolve
          them on the{" "}
          <Link className="text-brand-fg hover:text-brand-hover" href={`/recruitment/cycles/${id}/decisions`}>
            Decisions
          </Link>{" "}
          page.
        </p>
      )}
    </div>
  );
}
