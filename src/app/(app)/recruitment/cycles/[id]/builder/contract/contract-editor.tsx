"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Eye, Plus } from "lucide-react";
import type { FieldType } from "@prisma/client";
import { applyBlockOp } from "@/modules/recruitment/contract/block-ops";
import type { BlockPatch } from "@/modules/recruitment/contract/block-ops";
import type { ContractBlock, ContractLayout } from "@/modules/recruitment/contract/layout";
import type { Track } from "@prisma/client";
import { saveContractAction, resetContractAction } from "./actions";
import { saveGlobalContractAction, resetGlobalContractAction } from "@/app/(app)/admin/contract/actions";
import { SortableList } from "../sortable-list";
import { TypePicker } from "../type-picker";
import { SystemFieldCard } from "./system-field-card";
import { AgreementCard } from "./agreement-card";
import { CustomQuestionCard } from "./custom-question-card";
import { SectionCard } from "./section-card";
import { buildFieldOptions } from "./field-options";
import { OnboardingPreview, type OnboardingPreviewContext } from "./onboarding-preview";
import { Button } from "@/platform/ui/button";
import { Alert } from "@/platform/ui/alert";
import { Card } from "@/platform/ui/card";

/** Unique, stable drag id per block. `systemKey` / `id` / `key` are each
 *  immutable and unique within a layout, so they double as dnd ids. */
function dndId(block: ContractBlock): string {
  switch (block.kind) {
    case "system_field":
      return `sys:${block.systemKey}`;
    case "agreement":
      return `agr:${block.id}`;
    case "custom_question":
      return `cq:${block.key}`;
    case "section":
      return `sec:${block.id}`;
  }
}

type BlockItem = { id: string; block: ContractBlock; index: number };

export function ContractEditor({
  cycleId,
  initialLayout,
  hasOverride,
  mode = "cycle",
  globalTrack,
  status,
  preview,
}: {
  cycleId: string;
  initialLayout: ContractLayout;
  hasOverride: boolean;
  mode?: "cycle" | "global";
  /** In global mode, the track whose master template this editor edits. */
  globalTrack?: Track;
  status?: string;
  preview: OnboardingPreviewContext;
}) {
  const router = useRouter();
  // The global master template has no cycle, so it has no cycle status to lock
  // on -- only a per-cycle override can be archived out from under an edit.
  const editable = mode === "global" || status !== "ARCHIVED";
  const [layout, setLayout] = useState<ContractLayout>(initialLayout);
  const [seededFrom, setSeededFrom] = useState<ContractLayout>(initialLayout);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  // Re-seed local edit state whenever the server sends a fresh layout (after a
  // successful save or reset triggers router.refresh()). This is React's
  // "adjust state while rendering" idiom: `initialLayout` keeps a stable identity
  // across the editor's own client re-renders, so the re-seed only fires on a
  // real server refresh -- local edits are not clobbered mid-session.
  if (seededFrom !== initialLayout) {
    setSeededFrom(initialLayout);
    setLayout(initialLayout);
  }

  const items: BlockItem[] = layout.blocks.map((block, index) => ({ id: dndId(block), block, index }));

  function handleReorder(orderedIds: string[]): boolean {
    const idToIndex = new Map(layout.blocks.map((b, i) => [dndId(b), i] as const));
    const order: number[] = [];
    for (const id of orderedIds) {
      const idx = idToIndex.get(id);
      if (idx === undefined) return false;
      order.push(idx);
    }
    if (order.length !== layout.blocks.length) return false;
    setLayout(applyBlockOp(layout, { t: "reorder", order }));
    return true;
  }

  const update = (index: number, patch: BlockPatch) =>
    setLayout((prev) => applyBlockOp(prev, { t: "updateBlock", index, patch }));
  const remove = (index: number) =>
    setLayout((prev) => applyBlockOp(prev, { t: "removeBlock", index }));
  const toggle = (index: number, enabled: boolean) =>
    setLayout((prev) => applyBlockOp(prev, { t: "toggleSystem", index, enabled }));
  const addAgreement = () => setLayout((prev) => applyBlockOp(prev, { t: "addAgreement" }));
  const addSection = () => setLayout((prev) => applyBlockOp(prev, { t: "addSection" }));
  const addCustom = (fieldType: FieldType) =>
    setLayout((prev) => applyBlockOp(prev, { t: "addCustom", fieldType }));

  // Conditions can key on the authoritative context (department/track/epic
  // requirement, always present regardless of what the form asks), any
  // answerable custom question already in this layout, or a non-core system
  // field's answer-map key (both client and server put submitted system-field
  // values into the same onboarding answers map a visibleWhen condition
  // reads -- that is exactly why the shipped staffTitle/epicIdExpiration
  // conditions work). Agreements and sections are not offered as controllers:
  // they have no stored answer to branch on. See field-options.ts for the
  // system-field answer-key mapping and the core-field exclusion.
  const fieldOptions = buildFieldOptions(layout);

  function save() {
    setError(null);
    startTransition(async () => {
      const res =
        mode === "global" ? await saveGlobalContractAction(globalTrack!, layout) : await saveContractAction(cycleId, layout);
      if (res.ok) {
        setSaved(true);
        router.refresh();
        window.setTimeout(() => setSaved(false), 2000);
      } else {
        setError(res.error);
      }
    });
  }

  function reset() {
    if (!confirmReset) {
      setConfirmReset(true);
      return;
    }
    setConfirmReset(false);
    setError(null);
    startTransition(async () => {
      const res =
        mode === "global" ? await resetGlobalContractAction(globalTrack!) : await resetContractAction(cycleId);
      if (res.ok) router.refresh();
      else setError(res.error);
    });
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        This is the onboarding contract new applicants complete when they accept an offer in this cycle.
        Edits apply to links sent from now on; already-sent links keep the contract they were issued with.
      </p>

      {mode === "cycle" && status !== undefined && status !== "DRAFT" && (
        <Alert tone="warning">
          This cycle is {status}. Applicants may have already submitted. Changes take effect for new submissions
          immediately; existing answers are kept as-is and may no longer match the updated form.
        </Alert>
      )}

      <SortableList
        items={items}
        onReorder={handleReorder}
        renderItem={(item, handle) => {
          const { block, index } = item;
          if (block.kind === "system_field") {
            return (
              <SystemFieldCard
                block={block}
                handle={handle}
                fieldOptions={fieldOptions}
                onUpdate={(patch) => update(index, patch)}
                onToggle={(enabled) => toggle(index, enabled)}
              />
            );
          }
          if (block.kind === "agreement") {
            return (
              <AgreementCard
                block={block}
                handle={handle}
                fieldOptions={fieldOptions}
                onUpdate={(patch) => update(index, patch)}
                onRemove={() => remove(index)}
              />
            );
          }
          if (block.kind === "section") {
            return (
              <SectionCard
                block={block}
                handle={handle}
                fieldOptions={fieldOptions}
                onUpdate={(patch) => update(index, patch)}
                onRemove={() => remove(index)}
              />
            );
          }
          return (
            <CustomQuestionCard
              block={block}
              handle={handle}
              fieldOptions={fieldOptions}
              onUpdate={(patch) => update(index, patch)}
              onRemove={() => remove(index)}
            />
          );
        }}
      />

      <Card size="compact" className="flex flex-wrap items-center gap-3 border-dashed">
        <Button type="button" variant="outline" size="sm" onClick={addAgreement} disabled={!editable}>
          <Plus className="h-4 w-4" aria-hidden /> Add agreement
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={addSection} disabled={!editable}>
          <Plus className="h-4 w-4" aria-hidden /> Add section
        </Button>
        <TypePicker
          label="Add question"
          onPick={addCustom}
          disabled={!editable}
          types={["SHORT_TEXT", "LONG_TEXT", "SINGLE_SELECT", "MULTI_SELECT", "CHECKBOX", "EMAIL", "PHONE", "NUMBER", "DATE"]}
        />
      </Card>

      {error && <Alert tone="error">{error}</Alert>}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" onClick={() => setPreviewOpen(true)}>
          <Eye className="h-4 w-4" aria-hidden /> Preview form
        </Button>
        <Button type="button" onClick={save} disabled={pending || !editable}>
          {pending ? "Saving…" : "Save contract"}
        </Button>
        {saved && (
          <span className="flex items-center gap-1 text-sm text-success">
            <Check className="h-4 w-4" aria-hidden /> Saved
          </span>
        )}
        {hasOverride && (
          <Button
            type="button"
            variant={confirmReset ? "danger" : "ghost"}
            size="sm"
            onClick={reset}
            disabled={pending || !editable}
            onBlur={() => setConfirmReset(false)}
          >
            {confirmReset ? "Confirm reset to built-in default?" : "Reset to built-in default"}
          </Button>
        )}
      </div>

      <OnboardingPreview
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        layout={layout}
        {...preview}
      />
    </div>
  );
}
