import type { EpicRequirement, Track } from "@prisma/client";
import { isFieldVisible } from "../engine/field-visibility";
import { SYSTEM_FIELDS } from "./system-fields";
import type { ContractBlock, ContractLayout } from "./layout";

/** Facts the server knows about the person filling in the contract, which
 *  conditions may key on even though they are never asked as questions. */
export type ContractContext = {
  department: string | null;
  track: Track;
  epicRequirement: EpicRequirement;
};

/**
 * Merges the applicant's form answers with the authoritative context keys.
 * These always win: they come from the Acceptance, the cycle and the
 * department, so a stale or spoofed form field of the same name cannot change
 * which department's responsibilities a person is shown or whether they are
 * asked about Epic. `department` is omitted entirely when unknown, so
 * `op: "is"` conditions correctly match nothing rather than matching an empty
 * string.
 */
export function buildContractAnswers(
  formAnswers: Record<string, string | string[]>,
  ctx: ContractContext,
): Record<string, string | string[]> {
  // Strip the three authoritative keys out of formAnswers before applying
  // ctx, then spread only the remainder. This strip-then-apply order is what
  // makes "context always wins" hold in every case, not just when
  // ctx.department is set. Skipping the strip (spreading formAnswers as-is
  // and only conditionally adding department) would let a submitted value
  // survive whenever the context value is absent: that conditional spread
  // adds nothing when ctx.department is null, so a `department` key already
  // present in formAnswers would remain in the result untouched. That is the
  // exact bug being fixed here.
  const { department: _department, track: _track, epicRequirement: _epicRequirement, ...rest } = formAnswers;
  return {
    ...rest,
    ...(ctx.department ? { department: ctx.department } : {}),
    track: ctx.track,
    epicRequirement: ctx.epicRequirement,
  };
}

/** Filter a block list to those whose visibleWhen passes. Blocks without a
 *  condition are always kept, matching isFieldVisible's contract. A
 *  malformed or unparseable condition also fails open (the block is shown),
 *  inherited from isFieldVisible: on a legal document, wrongly hiding a
 *  required agreement is worse than wrongly showing one, so the evaluator
 *  errs toward showing it. */
export function visibleContractBlocks(
  blocks: ContractBlock[],
  answers: Record<string, string | string[]>,
): ContractBlock[] {
  return blocks.filter((b) => isFieldVisible(b.visibleWhen, answers));
}

/**
 * The blocks an applicant actually sees on the onboarding form: optional system
 * fields a director disabled are dropped (the enabled/core filter), then
 * visibleWhen is evaluated against the applicant's answers merged with the
 * authoritative context. Mirrors the inline computation onboard-form.tsx does at
 * render time; kept here so the builder preview renders from the same logic.
 */
export function visibleOnboardingBlocks(
  layout: ContractLayout,
  formAnswers: Record<string, string | string[]>,
  ctx: ContractContext,
): ContractBlock[] {
  const enabled = layout.blocks.filter(
    (b) => b.kind !== "system_field" || b.enabled !== false || SYSTEM_FIELDS[b.systemKey].core,
  );
  return visibleContractBlocks(enabled, buildContractAnswers(formAnswers, ctx));
}
