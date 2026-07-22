import { SYSTEM_FIELDS } from "@/modules/recruitment/contract/system-fields";
import type { ContractBlock, ContractLayout, SystemFieldKey } from "@/modules/recruitment/contract/layout";

/**
 * Maps a non-core system field's `systemKey` to the name it actually uses in
 * the onboarding answers map -- its rendered form input's `name` -- mirroring
 * the `nameByKey` maps in onboard/[token]/contract-field.tsx and the
 * `systemAnswers` object built by `submitContract` in services/onboarding.ts.
 * Only fields that are actually wired to `onAnswer` on the client and fed
 * into `systemAnswers` on the server appear here: the "spanish"/"licensedRN"
 * checkboxes and "initials" render without ever reporting a value into the
 * answers map (no onChange, no server-side systemAnswers entry), so a
 * visibleWhen condition could never actually key on them and they are
 * deliberately left out. Keep this in sync with contract-field.tsx and
 * submitContract if either mapping changes.
 */
const SYSTEM_FIELD_ANSWER_KEY: Partial<Record<SystemFieldKey, string>> = {
  netId: "netId",
  phone: "phone",
  dob: "dateOfBirth",
  dietary: "dietaryRestrictions",
  yaleAffiliation: "yaleAffiliation",
  gradYear: "gradYear",
  pronouns: "pronouns",
  staffTitle: "staffTitle",
  epicIdExpiration: "epicIdExpiration",
};

/**
 * Field options offered to the builder's ConditionEditor "When" dropdown:
 * everything a block's `visibleWhen` can key on. Covers the three
 * authoritative context keys (always present, sourced from the Acceptance ->
 * application -> cycle -> department chain, never from the form), every
 * custom question already in the layout, the layout's non-core system fields
 * (by their answer-map key, not their systemKey -- e.g. "dob" is offered as
 * "dateOfBirth"), and the special "hasEpic" controller (the Epic block's own
 * checkbox, not itself a SYSTEM_FIELD_KEYS entry) when the layout includes
 * the epic block.
 *
 * CORE system fields (name/email/epic/hipaa) are never offered as
 * controllers: they are always shown and always required regardless of any
 * visibleWhen (submitContract validates them unconditionally), so gating
 * another block on one is never meaningful. This mirrors the parallel guard
 * in system-field-card.tsx that keeps a condition from being authored ON a
 * core field in the first place.
 *
 * Both client (onboard-form.tsx / contract-field.tsx) and server
 * (submitContract in services/onboarding.ts) put submitted system-field
 * values into the same onboarding answers map a visibleWhen condition reads,
 * which is why the shipped staffTitle (gated on yaleAffiliation) and
 * epicIdExpiration (gated on hasEpic) conditions work at all.
 */
export function buildFieldOptions(layout: ContractLayout): { value: string; label: string }[] {
  const systemFieldBlocks = layout.blocks.filter(
    (b): b is Extract<ContractBlock, { kind: "system_field" }> => b.kind === "system_field",
  );
  const systemFieldOptions = systemFieldBlocks.flatMap((b) => {
    const answerKey = SYSTEM_FIELD_ANSWER_KEY[b.systemKey];
    if (!answerKey) return [];
    return [{ value: answerKey, label: b.label ?? SYSTEM_FIELDS[b.systemKey].defaultLabel }];
  });
  const hasEpicBlock = systemFieldBlocks.some((b) => b.systemKey === "epic");

  return [
    { value: "department", label: "Department" },
    { value: "track", label: "Track" },
    { value: "epicRequirement", label: "Epic requirement" },
    ...systemFieldOptions,
    ...(hasEpicBlock ? [{ value: "hasEpic", label: "Has Epic ID" }] : []),
    ...layout.blocks
      .filter((b): b is Extract<ContractBlock, { kind: "custom_question" }> => b.kind === "custom_question")
      .map((b) => ({ value: b.key, label: b.label })),
  ];
}
