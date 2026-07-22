import { z } from "zod";
import type { FieldType } from "@prisma/client";
import { SYSTEM_FIELD_KEYS } from "./system-fields";
import type { FieldCondition } from "../engine/field-visibility";

export type SystemFieldKey = (typeof SYSTEM_FIELD_KEYS)[number];

export type ConfirmKind = "signature" | "initials" | "checkbox";

export type SystemFieldBlock = {
  kind: "system_field";
  systemKey: SystemFieldKey;
  label?: string;
  helpText?: string;
  enabled?: boolean; // optional fields only; core fields ignore this
  visibleWhen?: FieldCondition;
};
export type AgreementBlock = {
  kind: "agreement";
  id: string;
  title: string;
  body: string;
  signatureLabel: string;
  confirmKind?: ConfirmKind;
  visibleWhen?: FieldCondition;
};
export type CustomQuestionBlock = {
  kind: "custom_question";
  key: string;
  label: string;
  helpText?: string;
  type: FieldType;
  required: boolean;
  options?: { value: string; label: string }[];
  visibleWhen?: FieldCondition;
};
export type SectionBlock = {
  kind: "section";
  id: string;
  title: string;
  body: string;
  visibleWhen?: FieldCondition;
};
export type ContractBlock = SystemFieldBlock | AgreementBlock | CustomQuestionBlock | SectionBlock;
export type ContractLayout = { blocks: ContractBlock[] };

export class ContractLayoutError extends Error {
  problems: string[];
  constructor(problems: string[]) {
    super(problems.join("; "));
    this.name = "ContractLayoutError";
    this.problems = problems;
  }
}

const FIELD_TYPES: [FieldType, ...FieldType[]] = [
  "SHORT_TEXT", "LONG_TEXT", "SINGLE_SELECT", "MULTI_SELECT", "CHECKBOX",
  "EMAIL", "PHONE", "NUMBER", "DATE", "FILE", "DEPARTMENT_CHOICE", "SUBCOMMITTEE_RANK",
];

const optionSchema = z.object({ value: z.string().min(1), label: z.string().min(1) });

const conditionSchema = z.union([
  z.object({ field: z.string().min(1), op: z.literal("isAnswered") }),
  z.object({ field: z.string().min(1), op: z.enum(["is", "isNot"]), value: z.string() }),
  z.object({ field: z.string().min(1), op: z.literal("isAnyOf"), value: z.array(z.string()) }),
]);

const blockSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("system_field"),
    systemKey: z.enum(SYSTEM_FIELD_KEYS),
    label: z.string().optional(),
    helpText: z.string().optional(),
    enabled: z.boolean().optional(),
    visibleWhen: conditionSchema.optional(),
  }),
  z.object({
    kind: z.literal("agreement"),
    id: z.string().min(1),
    title: z.string().min(1),
    body: z.string(),
    signatureLabel: z.string().min(1),
    confirmKind: z.enum(["signature", "initials", "checkbox"]).optional(),
    visibleWhen: conditionSchema.optional(),
  }),
  z.object({
    kind: z.literal("custom_question"),
    key: z.string().regex(/^[a-z0-9_]+$/, "key must be lowercase alphanumeric/underscore"),
    label: z.string().min(1),
    helpText: z.string().optional(),
    type: z.enum(FIELD_TYPES),
    required: z.boolean(),
    options: z.array(optionSchema).optional(),
    visibleWhen: conditionSchema.optional(),
  }),
  z.object({
    kind: z.literal("section"),
    id: z.string().min(1),
    title: z.string().min(1),
    body: z.string(),
    visibleWhen: conditionSchema.optional(),
  }),
]);

export const contractLayoutSchema: z.ZodType<ContractLayout> = z.object({
  blocks: z.array(blockSchema),
});

export function parseContractLayout(value: unknown): ContractLayout {
  const parsed = contractLayoutSchema.safeParse(value);
  if (!parsed.success) {
    throw new ContractLayoutError(parsed.error.issues.map((i) => i.message));
  }
  const layout = parsed.data;
  const problems: string[] = [];

  // custom-question keys unique, disjoint from system keys, and not reserved
  // for checkbox-agreement confirmations. Checkbox confirmations are stored as
  // customAnswers["confirm__<agreementId>"], spread after the applicant's
  // customAnswers at submit time; a custom_question key literally starting
  // with confirm__ would silently clobber (or be clobbered by) that stored
  // confirmation.
  const seen = new Set<string>();
  const systemKeySet = new Set<string>(SYSTEM_FIELD_KEYS);
  for (const b of layout.blocks) {
    if (b.kind !== "custom_question") continue;
    if (systemKeySet.has(b.key)) problems.push(`Custom question key "${b.key}" collides with a system field.`);
    if (seen.has(b.key)) problems.push(`Duplicate custom question key "${b.key}".`);
    if (b.key.startsWith("confirm__")) {
      problems.push(`Custom question key "${b.key}" is reserved for checkbox confirmations (the confirm__ prefix).`);
    }
    seen.add(b.key);
  }
  // Agreement and section ids share one namespace: both are addressed by id in
  // the builder's drag ids, and an agreement's id also keys stored signatures.
  const seenIds = new Set<string>();
  for (const b of layout.blocks) {
    if (b.kind !== "agreement" && b.kind !== "section") continue;
    if (seenIds.has(b.id)) problems.push(`Duplicate block id "${b.id}".`);
    seenIds.add(b.id);
  }
  // Cross-namespace check: a custom_question key must not equal any agreement
  // or section id either. Both land in the same stored customAnswers/answer
  // keyspace at submit, so a collision here is silent data loss on a legal
  // form just like the confirm__ case above.
  for (const b of layout.blocks) {
    if (b.kind !== "custom_question") continue;
    if (seenIds.has(b.key)) problems.push(`Custom question key "${b.key}" collides with an agreement or section id.`);
  }
  if (problems.length) throw new ContractLayoutError(problems);
  return layout;
}
