import type { Track } from "@prisma/client";
import { isFieldVisible } from "../engine/field-visibility";
import type { ContractBlock } from "./layout";

// EpicRequirement is not yet a Prisma enum (Task 5 adds it to the schema).
// This local union mirrors the values it will define. Replace this with
// `import type { EpicRequirement } from "@prisma/client"` once Task 5 lands.
export type EpicRequirement = "ALL" | "NONE" | "SOME";

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
