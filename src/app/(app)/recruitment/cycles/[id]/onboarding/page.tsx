import { notFound } from "next/navigation";
import { PageBody } from "@/platform/ui/page-body";
import { requirePermission } from "@/platform/auth/session";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { listOnboardingRows } from "@/modules/recruitment/services/onboarding";
import { sendLinksAction, promoteAction, withdrawAction } from "./actions";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { cycleTrail } from "@/modules/recruitment/breadcrumbs";
import { PageHeader } from "@/platform/ui/page-header";
import { TextLink } from "@/platform/ui/text-link";
import { OnboardingTable } from "@/modules/recruitment/components/onboarding-table";

export default async function OnboardingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requirePermission("recruitment.access");
  await requirePermission("recruitment.review_all");
  const cycle = await getCycle(id);
  if (!cycle) notFound();
  const rows = await listOnboardingRows(id);
  const hasConflicts = rows.some((r) => r.state === "CONFLICT");

  // full: this tab's body is OnboardingTable -- checkbox, name, department,
  // status, plus a per-row action -- and 56rem squeezed it while the tab beside
  // it ran full width.
  return (
    <PageBody width="full">
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
          <TextLink href={`/recruitment/cycles/${id}/decisions`}>Decisions</TextLink>{" "}
          page.
        </p>
      )}
    </PageBody>
  );
}
