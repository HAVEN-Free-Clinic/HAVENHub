import Link from "next/link";
import type { Track } from "@prisma/client";
import { requirePermission } from "@/platform/auth/session";
import { getGlobalContractLayout } from "@/modules/recruitment/contract/template";
import { PageHeader } from "@/platform/ui/page-header";
import { ContractEditor } from "@/app/(app)/recruitment/cycles/[id]/builder/contract/contract-editor";
import { loadOnboardingPreviewContext } from "@/app/(app)/recruitment/cycles/[id]/builder/contract/preview-context";

const TRACKS: { value: Track; label: string }[] = [
  { value: "VOLUNTEER", label: "Volunteer" },
  { value: "DIRECTOR", label: "Director" },
];

export default async function AdminContractPage({
  searchParams,
}: {
  searchParams: Promise<{ track?: string }>;
}) {
  await requirePermission("admin.manage_settings");
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
      <div className="flex gap-2" role="tablist" aria-label="Contract track">
        {TRACKS.map((t) => {
          const active = t.value === track;
          return (
            <Link
              key={t.value}
              href={`/admin/contract?track=${t.value}`}
              role="tab"
              aria-selected={active}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                active
                  ? "bg-brand/10 text-brand-fg"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              {t.label}
            </Link>
          );
        })}
      </div>
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
