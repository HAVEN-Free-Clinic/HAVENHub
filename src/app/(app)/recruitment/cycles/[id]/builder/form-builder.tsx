// src/app/(app)/recruitment/cycles/[id]/builder/form-builder.tsx
"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { SectionCard, type BuilderSection } from "./section-card";
import { SortableList } from "./sortable-list";
import type { ApplicantScope } from "@prisma/client";
import { addSectionAction, reorderSectionsAction } from "./actions";
import { Alert } from "@/platform/ui/alert";
import { Button } from "@/platform/ui/button";

export function FormBuilder({
  cycleId, cycleTitle, editable, status, departments, sections,
}: {
  cycleId: string;
  cycleTitle: string;
  editable: boolean;
  status: string;
  departments: string[];
  sections: BuilderSection[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const refresh = () => router.refresh();

  function addSection() {
    startTransition(async () => {
      const r = await addSectionAction(cycleId, { title: "New section", appliesTo: "BOTH" as ApplicantScope, departmentCode: null });
      if (r.ok) refresh();
    });
  }

  function reorder(orderedSectionIds: string[]) {
    startTransition(async () => {
      const r = await reorderSectionsAction(cycleId, orderedSectionIds);
      if (r.ok) refresh();
    });
  }

  return (
    <div className="space-y-4">
      {!editable && (
        <Alert tone="warning">
          This cycle is {status}. You can edit labels, help text, and descriptions; structural changes (types, required, adding, deleting, reordering scope) are locked to protect submitted answers.
        </Alert>
      )}

      <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
        <div className="h-2 bg-brand" aria-hidden />
        <div className="p-5">
          <h1 className="text-lg font-semibold text-foreground">{cycleTitle}</h1>
          <p className="text-sm text-muted-foreground">Application form</p>
        </div>
      </div>

      <SortableList
        items={sections}
        onReorder={reorder}
        disabled={!editable}
        renderItem={(section, handle) => (
          <div className="py-2">
            <SectionCard
              cycleId={cycleId}
              section={section}
              departments={departments}
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
    </div>
  );
}
