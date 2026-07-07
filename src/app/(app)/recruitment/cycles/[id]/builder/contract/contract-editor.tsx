"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Plus } from "lucide-react";
import type { FieldType } from "@prisma/client";
import { applyBlockOp } from "@/modules/recruitment/contract/block-ops";
import type { BlockPatch } from "@/modules/recruitment/contract/block-ops";
import type { ContractBlock, ContractLayout } from "@/modules/recruitment/contract/layout";
import { saveContractAction, resetContractAction } from "./actions";
import { saveGlobalContractAction } from "@/app/(app)/admin/contract/actions";
import { SortableList } from "../sortable-list";
import { TypePicker } from "../type-picker";
import { SystemFieldCard } from "./system-field-card";
import { AgreementCard } from "./agreement-card";
import { CustomQuestionCard } from "./custom-question-card";
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
  }
}

type BlockItem = { id: string; block: ContractBlock; index: number };

export function ContractEditor({
  cycleId,
  initialLayout,
  hasOverride,
  mode = "cycle",
}: {
  cycleId: string;
  initialLayout: ContractLayout;
  hasOverride: boolean;
  mode?: "cycle" | "global";
}) {
  const router = useRouter();
  const [layout, setLayout] = useState<ContractLayout>(initialLayout);
  const [seededFrom, setSeededFrom] = useState<ContractLayout>(initialLayout);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

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
  const addCustom = (fieldType: FieldType) =>
    setLayout((prev) => applyBlockOp(prev, { t: "addCustom", fieldType }));

  function save() {
    setError(null);
    startTransition(async () => {
      const res =
        mode === "global" ? await saveGlobalContractAction(layout) : await saveContractAction(cycleId, layout);
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
      const res = await resetContractAction(cycleId);
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
                onUpdate={(patch) => update(index, patch)}
                onRemove={() => remove(index)}
              />
            );
          }
          return (
            <CustomQuestionCard
              block={block}
              handle={handle}
              onUpdate={(patch) => update(index, patch)}
              onRemove={() => remove(index)}
            />
          );
        }}
      />

      <Card size="compact" className="flex flex-wrap items-center gap-3 border-dashed">
        <Button type="button" variant="outline" size="sm" onClick={addAgreement}>
          <Plus className="h-4 w-4" aria-hidden /> Add agreement
        </Button>
        <TypePicker
          label="Add question"
          onPick={addCustom}
          types={["SHORT_TEXT", "LONG_TEXT", "SINGLE_SELECT", "MULTI_SELECT", "CHECKBOX", "EMAIL", "PHONE", "NUMBER", "DATE"]}
        />
      </Card>

      {error && <Alert tone="error">{error}</Alert>}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={save} disabled={pending}>
          {pending ? "Saving…" : "Save contract"}
        </Button>
        {saved && (
          <span className="flex items-center gap-1 text-sm text-success">
            <Check className="h-4 w-4" aria-hidden /> Saved
          </span>
        )}
        {mode === "cycle" && hasOverride && (
          <Button
            type="button"
            variant={confirmReset ? "danger" : "ghost"}
            size="sm"
            onClick={reset}
            disabled={pending}
            onBlur={() => setConfirmReset(false)}
          >
            {confirmReset ? "Confirm reset to default?" : "Reset to default"}
          </Button>
        )}
      </div>
    </div>
  );
}
