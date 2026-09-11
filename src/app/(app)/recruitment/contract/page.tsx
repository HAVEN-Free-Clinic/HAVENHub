import type { Track } from "@prisma/client";
import { requirePermission } from "@/platform/auth/session";
import { getGlobalContractLayout } from "@/modules/recruitment/contract/template";
import { PageHeader } from "@/platform/ui/page-header";
import { ContractEditor } from "@/app/(app)/recruitment/cycles/[id]/builder/contract/contract-editor";
import { loadOnboardingPreviewContext } from "@/app/(app)/recruitment/cycles/[id]/builder/contract/preview-context";
import { TabRow } from "@/platform/ui/tab-row";

const TRACKS: { value: Track; label: string }[] = [
  { value: "VOLUNTEER", label: "Volunteer" },
  { value: "DIRECTOR", label: "Director" },
];

export default async function AdminContractPage({
  searchParams,
}: {
  searchParams: Promise<{ track?: string }>;
}) {
  await requirePermission("recruitment.manage_cycles");
  const sp = await searchParams;
  // The master template is stored per track so a template saved for one track can
  // never override the other's built-in default (#3). Default to the volunteer tab.
  const track: Track = sp.track === "DIRECTOR" ? "DIRECTOR" : "VOLUNTEER";

  const { layout, hasOverride } = await getGlobalContractLayout(track);
  const preview = await loadOnboardingPreviewContext({
    departmentCodes: "all",
    fixedTrack: track,
    inPersonTrainingDate: null,
    trainingLocation: null,
    title: "master template",
  });

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Onboarding contract" description="Master template inherited by new cycles, per track" />
      {/* These were the only role="tab"/role="tablist" nodes in the app, and
          there is no role="tabpanel" anywhere -- so the ARIA promised arrow-key
          movement between tabs and an in-place panel swap, and delivered
          neither: they are plain links that navigate. role="tab" also
          suppresses the link role, so a screen reader announced "tab, selected,
          1 of 2" for something that is a link to another URL. TabRow marks the
          current one with aria-current="page", which is what a row of links
          actually is. */}
      <TabRow
        variant="segmented"
        label="Contract track"
        isActive={(item) => item.href.endsWith(`track=${track}`)}
        items={TRACKS.map((t) => ({
          label: t.label,
          href: `/recruitment/contract?track=${t.value}`,
        }))}
      />
      <p className="text-sm text-muted-foreground">
        {hasOverride
          ? `Editing the custom ${track === "DIRECTOR" ? "director" : "volunteer"} master template. Reset to fall back to the built-in default.`
          : `Showing the built-in ${track === "DIRECTOR" ? "director" : "volunteer"} default. Saving stores a custom master template for ${track === "DIRECTOR" ? "director" : "volunteer"} cycles only.`}
      </p>
      {/* key on track so switching tabs re-seeds the editor's internal state. */}
      <ContractEditor
        key={track}
        mode="global"
        globalTrack={track}
        cycleId=""
        initialLayout={layout}
        hasOverride={hasOverride}
        preview={preview}
      />
    </div>
  );
}
