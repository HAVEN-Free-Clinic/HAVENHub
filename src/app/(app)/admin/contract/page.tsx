import { requirePermission } from "@/platform/auth/session";
import { getSetting } from "@/platform/settings/service";
import { parseContractLayout } from "@/modules/recruitment/contract/layout";
import { DEFAULT_CONTRACT_LAYOUT } from "@/modules/recruitment/contract/system-fields";
import { PageHeader } from "@/platform/ui/page-header";
import { ContractEditor } from "@/app/(app)/recruitment/cycles/[id]/builder/contract/contract-editor";

export default async function AdminContractPage() {
  await requirePermission("admin.manage_settings");
  const raw = await getSetting<unknown>("onboarding.contractTemplate");
  let layout = DEFAULT_CONTRACT_LAYOUT;
  try {
    layout = parseContractLayout(raw);
  } catch {
    // unset or invalid -> fall back to the built-in default
  }
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Onboarding contract" description="Master template inherited by new cycles" />
      <ContractEditor mode="global" cycleId="" initialLayout={layout} hasOverride={false} />
    </div>
  );
}
