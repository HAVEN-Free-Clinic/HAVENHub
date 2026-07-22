import { notFound } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { getContractLayoutForEdit } from "@/modules/recruitment/contract/template";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { cycleTrail } from "@/modules/recruitment/breadcrumbs";
import { PageHeader } from "@/platform/ui/page-header";
import { ContractEditor } from "./contract-editor";
import { loadOnboardingPreviewContext } from "./preview-context";

export default async function ContractBuilderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requirePermission("recruitment.access");
  await requirePermission("recruitment.manage_cycles");
  const cycle = await getCycle(id);
  if (!cycle) notFound();
  const { layout, hasOverride } = await getContractLayoutForEdit(id);
  const preview = await loadOnboardingPreviewContext({
    departmentCodes: cycle.departments,
    fixedTrack: cycle.track,
    inPersonTrainingDate: cycle.inPersonTrainingDate,
    trainingLocation: cycle.trainingLocation,
    title: cycle.title,
  });
  return (
    <div className="max-w-3xl space-y-6">
      <SetBreadcrumb
        trail={cycleTrail({
          cycleId: id,
          cycleTitle: cycle.title,
          section: { label: "Form builder", slug: "builder" },
          leaf: "Onboarding contract",
        })}
      />
      <PageHeader title="Onboarding contract" description={cycle.title} />
      <ContractEditor cycleId={id} initialLayout={layout} hasOverride={hasOverride} status={cycle.status} preview={preview} />
    </div>
  );
}
