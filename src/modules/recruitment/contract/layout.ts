import { z } from "zod";
import type { FieldType } from "@prisma/client";
import { SYSTEM_FIELD_KEYS } from "./system-fields";

export type SystemFieldKey = (typeof SYSTEM_FIELD_KEYS)[number];

export type SystemFieldBlock = {
  kind: "system_field";
  systemKey: SystemFieldKey;
  label?: string;
  helpText?: string;
  enabled?: boolean; // optional fields only; core fields ignore this
};
export type AgreementBlock = {
  kind: "agreement";
  id: string;
  title: string;
  body: string;
  signatureLabel: string;
};
export type CustomQuestionBlock = {
  kind: "custom_question";
  key: string;
  label: string;
  helpText?: string;
  type: FieldType;
  required: boolean;
  options?: { value: string; label: string }[];
};
export type ContractBlock = SystemFieldBlock | AgreementBlock | CustomQuestionBlock;
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

const blockSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("system_field"),
    systemKey: z.enum(SYSTEM_FIELD_KEYS),
    label: z.string().optional(),
    helpText: z.string().optional(),
    enabled: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("agreement"),
    id: z.string().min(1),
    title: z.string().min(1),
    body: z.string(),
    signatureLabel: z.string().min(1),
  }),
  z.object({
    kind: z.literal("custom_question"),
    key: z.string().regex(/^[a-z0-9_]+$/, "key must be lowercase alphanumeric/underscore"),
    label: z.string().min(1),
    helpText: z.string().optional(),
    type: z.enum(FIELD_TYPES),
    required: z.boolean(),
    options: z.array(optionSchema).optional(),
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

  // custom-question keys unique and disjoint from system keys
  const seen = new Set<string>();
  const systemKeySet = new Set<string>(SYSTEM_FIELD_KEYS);
  for (const b of layout.blocks) {
    if (b.kind !== "custom_question") continue;
    if (systemKeySet.has(b.key)) problems.push(`Custom question key "${b.key}" collides with a system field.`);
    if (seen.has(b.key)) problems.push(`Duplicate custom question key "${b.key}".`);
    seen.add(b.key);
  }
  // agreement ids unique
  const seenAgreements = new Set<string>();
  for (const b of layout.blocks) {
    if (b.kind !== "agreement") continue;
    if (seenAgreements.has(b.id)) problems.push(`Duplicate agreement id "${b.id}".`);
    seenAgreements.add(b.id);
  }
  if (problems.length) throw new ContractLayoutError(problems);
  return layout;
}
