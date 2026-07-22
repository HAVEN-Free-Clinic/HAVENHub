import type { EpicRequirement, Track } from "@prisma/client";
import { isFieldVisible } from "../engine/field-visibility";
import type { ContractBlock } from "./layout";

/** Facts the server knows about the person filling in the contract, which
 *  conditions may key on even though they are never asked as questions. */
export type ContractContext = {
  department: string | null;
  track: Track;
  epicRequirement: EpicRequirement;
  /** The Epic ID already on file for this applicant (matched Person), or null.
   *  When set, the Epic section confirms it instead of re-collecting. */
  storedEpicId: string | null;
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
  const {
    department: _department, track: _track, epicRequirement: _epicRequirement,
    epicSection: _epicSection, epicAsk: _epicAsk, ...rest
  } = formAnswers;
  // The Epic section (heading + collection) shows when the applicant either
  // already has an Epic ID on file (nothing to collect, we just confirm it) or
  // is in a department that uses Epic. It hides only when neither holds.
  const epicSection = ctx.storedEpicId || ctx.epicRequirement !== "NONE" ? "show" : "hide";
  // The "do you need Epic?" question is only asked for a SOME department when we
  // have no id on file. ALL/NONE are decided without asking; a stored id makes
  // the question moot. Both keys are derived from authoritative context alone,
  // so client and server compute them identically and a spoofed form value
  // cannot force the section or question open or closed.
  const epicAsk = ctx.epicRequirement === "SOME" && !ctx.storedEpicId ? "yes" : "no";
  return {
    ...rest,
    ...(ctx.department ? { department: ctx.department } : {}),
    track: ctx.track,
    epicRequirement: ctx.epicRequirement,
    epicSection,
    epicAsk,
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
