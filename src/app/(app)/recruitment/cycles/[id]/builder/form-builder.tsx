"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Eye } from "lucide-react";
import { SectionCard, type BuilderSection } from "./section-card";
import { SortableList } from "./sortable-list";
import { ApplyPreview } from "./apply-preview";
import type { ApplicantScope } from "@prisma/client";
import { addSectionAction, reorderSectionsAction } from "./actions";
import { Alert } from "@/platform/ui/alert";
import { Button } from "@/platform/ui/button";
import { Card } from "@/platform/ui/card";
import type { DepartmentNameRow } from "@/modules/recruitment/templates/department-options";
import type { CycleStatus } from "@prisma/client";
import { CYCLE_STATUS_LABELS } from "@/modules/recruitment/components/status-badge";

export function FormBuilder({
  cycleId, cycleTitle, editable, status, departments, departmentNames, subcommittees, sections, acceptsRenewals,
}: {
  cycleId: string;
  cycleTitle: string;
  editable: boolean;
  status: CycleStatus;
  departments: string[];
  // Passed straight through to ApplyPreview (not to SectionCard) so the "Preview
  // form" modal can resolve department names and generated section titles the
  // same way the live apply wizard does. See the fetch site in page.tsx for why
  // this stays separate from `sections`'s own stored titles.
  departmentNames: DepartmentNameRow[];
  subcommittees: { id: string; name: string }[];
  sections: BuilderSection[];
  acceptsRenewals: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  // Covers every action on the form as a whole. `addSection` used to drop the
  // `{ ok: false, error }` it gets back, so a refused add looked like a no-op.
  const [error, setError] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const refresh = () => router.refresh();
  // The full cycle-wide field list, used as the pool of candidate "controlling"
  // fields for each question's "Show only when" condition -- a gate can live in
  // a different section than the question it controls.
  const allFields = sections.flatMap((s) => s.fields);

  function addSection() {
    setError(null);
    startTransition(async () => {
      const r = await addSectionAction(cycleId, { title: "New section", appliesTo: "BOTH" as ApplicantScope, departmentCode: null });
      if (r.ok) refresh();
      else setError(r.error);
    });
  }

  async function reorder(orderedSectionIds: string[]) {
    setError(null);
    const r = await reorderSectionsAction(cycleId, orderedSectionIds);
    if (r.ok) { router.refresh(); return true; }
    setError(r.error);
    return false;
  }

  return (
    <div className="space-y-4">
      {status !== "DRAFT" && (
        <Alert tone="warning">
          This cycle is {CYCLE_STATUS_LABELS[status].toLowerCase()}. Applicants may have already
          submitted. Changes take effect for new submissions
          immediately; existing answers are kept as-is and may no longer match the updated form.
        </Alert>
      )}
      {error && <Alert tone="error">{error}</Alert>}

      <Card pad={false} className="overflow-hidden">
        <div className="h-2 bg-brand" aria-hidden />
        <div className="flex items-start justify-between gap-3 p-5">
          <div>
            <h2 className="text-lg font-semibold text-foreground">{cycleTitle}</h2>
            <p className="text-sm text-muted-foreground">Application form</p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => setPreviewOpen(true)}>
            <Eye className="h-4 w-4" aria-hidden /> Preview form
          </Button>
        </div>
      </Card>

      <SortableList
        items={sections}
        onReorder={reorder}
        disabled={!editable}
        renderItem={(section, handle) => (
          <div className="py-2">
            <SectionCard
              cycleId={cycleId}
              section={section}
              allFields={allFields}
              departments={departments}
              subcommittees={subcommittees}
              editable={editable}
              handle={handle}
              onChanged={refresh}
            />
          </div>
        )}
      />

      <Button type="button" variant="outline" onClick={addSection} disabled={!editable}>
        <Plus className="h-4 w-4" aria-hidden /> Add section
      </Button>

      <ApplyPreview
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        sections={sections}
        departments={departments}
        departmentNames={departmentNames}
        subcommittees={subcommittees}
        acceptsRenewals={acceptsRenewals}
        cycleTitle={cycleTitle}
      />
    </div>
  );
}
