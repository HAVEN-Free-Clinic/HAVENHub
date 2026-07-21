import type { FieldType } from "@prisma/client";
import { uniqueKey } from "../engine/field-key";
import type {
  AgreementBlock,
  ContractBlock,
  ContractLayout,
  CustomQuestionBlock,
  SectionBlock,
  SystemFieldBlock,
} from "./layout";
import { ContractLayoutError } from "./layout";
import { SYSTEM_FIELDS, SYSTEM_FIELD_KEYS } from "./system-fields";

/* ------------------------------------------------------------------ */
/* Pure: block-op mutations                                            */
/* ------------------------------------------------------------------ */

/** Fields an `updateBlock` op may patch. The discriminant ("kind") and each
 *  block kind's identity field -- a system field's "systemKey", an
 *  agreement's "id", a custom question's "key" -- are immutable -- swap the
 *  block via remove+add instead of patching them. */
export type BlockPatch = Partial<Omit<SystemFieldBlock, "kind" | "systemKey">> &
  Partial<Omit<AgreementBlock, "kind" | "id">> &
  Partial<Omit<CustomQuestionBlock, "kind" | "key">>;

export type BlockOp =
  | { t: "addAgreement" }
  | { t: "addCustom"; fieldType: FieldType }
  | { t: "updateBlock"; index: number; patch: BlockPatch }
  | { t: "removeBlock"; index: number }
  | { t: "reorder"; order: number[] }
  | { t: "toggleSystem"; index: number; enabled: boolean };

function assertIndex(blocks: ContractBlock[], index: number, op: string): void {
  if (!Number.isInteger(index) || index < 0 || index >= blocks.length) {
    throw new RangeError(`${op}: index ${index} out of range (0..${blocks.length - 1}).`);
  }
}

function nextAgreementId(blocks: ContractBlock[]): string {
  const existing = blocks
    .filter((b): b is AgreementBlock => b.kind === "agreement")
    .map((b) => b.id);
  return uniqueKey("agreement", existing);
}

function nextCustomKey(blocks: ContractBlock[]): string {
  const existing = [
    ...SYSTEM_FIELD_KEYS,
    ...blocks
      .filter((b): b is CustomQuestionBlock => b.kind === "custom_question")
      .map((b) => b.key),
  ];
  return uniqueKey("New question", existing);
}

/** Merges `patch` into `block`, then forces the discriminant and the
 *  block's identity field back onto the result -- a defense at runtime
 *  (BlockPatch already excludes these at the type level) in case a server
 *  action passes an untyped patch that includes `systemKey` / `id` / `key`.
 *  Renaming an agreement's id or a custom question's key in place would
 *  orphan already-stored `signatures[id]` / `customAnswers[key]` data. */
function patchBlock(block: ContractBlock, patch: BlockPatch): ContractBlock {
  if (block.kind === "system_field") {
    return { ...block, ...patch, kind: "system_field", systemKey: block.systemKey } as SystemFieldBlock;
  }
  if (block.kind === "agreement") {
    return { ...block, ...patch, kind: "agreement", id: block.id } as AgreementBlock;
  }
  if (block.kind === "section") {
    // Task 2 scope: the layout model supports section blocks; builder
    // authoring for them (and thus patching one in place) lands in a later task.
    return { ...block, ...patch, kind: "section", id: block.id } as SectionBlock;
  }
  return { ...block, ...patch, kind: "custom_question", key: block.key } as CustomQuestionBlock;
}

function reorderBlocks(blocks: ContractBlock[], order: number[]): ContractBlock[] {
  if (order.length !== blocks.length) {
    throw new RangeError("reorder: order length must match the number of blocks.");
  }
  const seen = new Set<number>();
  for (const idx of order) {
    if (!Number.isInteger(idx) || idx < 0 || idx >= blocks.length || seen.has(idx)) {
      throw new RangeError("reorder: order must be a permutation of the current block indices.");
    }
    seen.add(idx);
  }
  return order.map((idx) => blocks[idx]);
}

/** Immutable block-level edits for the contract editor. Never mutates `layout`. */
export function applyBlockOp(layout: ContractLayout, op: BlockOp): ContractLayout {
  switch (op.t) {
    case "addAgreement": {
      const block: AgreementBlock = {
        kind: "agreement",
        id: nextAgreementId(layout.blocks),
        title: "New agreement",
        body: "",
        signatureLabel: "type your full name",
      };
      return { blocks: [...layout.blocks, block] };
    }
    case "addCustom": {
      const block: CustomQuestionBlock = {
        kind: "custom_question",
        key: nextCustomKey(layout.blocks),
        label: "New question",
        type: op.fieldType,
        required: false,
      };
      return { blocks: [...layout.blocks, block] };
    }
    case "updateBlock": {
      assertIndex(layout.blocks, op.index, "updateBlock");
      return {
        blocks: layout.blocks.map((b, i) => (i === op.index ? patchBlock(b, op.patch) : b)),
      };
    }
    case "removeBlock": {
      assertIndex(layout.blocks, op.index, "removeBlock");
      return { blocks: layout.blocks.filter((_, i) => i !== op.index) };
    }
    case "reorder": {
      return { blocks: reorderBlocks(layout.blocks, op.order) };
    }
    case "toggleSystem": {
      assertIndex(layout.blocks, op.index, "toggleSystem");
      const block = layout.blocks[op.index];
      if (block.kind !== "system_field") {
        throw new RangeError(`toggleSystem: block at index ${op.index} is not a system_field.`);
      }
      return {
        blocks: layout.blocks.map((b, i) => (i === op.index ? { ...b, enabled: op.enabled } : b)),
      };
    }
  }
}

/**
 * Enforce the two-tier contract: every CORE system field (per SYSTEM_FIELDS)
 * must appear exactly once, as an enabled `system_field` block. Optional
 * system fields may be missing or disabled. Also rejects duplicate
 * `system_field` blocks for the same key (parseContractLayout does not check
 * this -- it only guards custom-question/agreement identifiers).
 */
export function assertTwoTier(layout: ContractLayout): void {
  const problems: string[] = [];
  const byKey = new Map<string, SystemFieldBlock[]>();
  for (const b of layout.blocks) {
    if (b.kind !== "system_field") continue;
    const list = byKey.get(b.systemKey) ?? [];
    list.push(b);
    byKey.set(b.systemKey, list);
  }

  for (const [key, blocks] of byKey) {
    if (blocks.length > 1) problems.push(`Duplicate system field block for "${key}".`);
  }

  for (const key of SYSTEM_FIELD_KEYS) {
    const spec = SYSTEM_FIELDS[key];
    if (!spec.core) continue;
    const blocks = byKey.get(key) ?? [];
    if (blocks.length === 0) {
      problems.push(`Core field "${key}" cannot be removed.`);
      continue;
    }
    if (blocks.some((b) => b.enabled === false)) {
      problems.push(`Core field "${key}" cannot be disabled.`);
    }
  }

  if (problems.length) throw new ContractLayoutError(problems);
}
