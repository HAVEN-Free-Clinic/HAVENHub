import { z } from "zod";
import {
  visibleSections,
  type SectionVisibilityInput,
  type VisibilityContext,
} from "./visibility";

export type FieldType =
  | "SHORT_TEXT"
  | "LONG_TEXT"
  | "SINGLE_SELECT"
  | "MULTI_SELECT"
  | "CHECKBOX"
  | "EMAIL"
  | "PHONE"
  | "NUMBER"
  | "DATE"
  | "FILE"
  | "DEPARTMENT_CHOICE"
  | "SUBCOMMITTEE_RANK";

export type FieldValidation = {
  min?: number;
  max?: number;
  regex?: string;
  maxFileMB?: number;
  acceptedTypes?: string[];
  rankCount?: number;
};

export type FieldDef = {
  key: string;
  type: FieldType;
  required: boolean;
  options?: { value: string; label: string }[] | null;
  validation?: FieldValidation | null;
};

export type SectionDef = SectionVisibilityInput & { fields: FieldDef[] };

/** Optional-string helper: required maps to min length 1. */
function reqString(required: boolean, min?: number): z.ZodTypeAny {
  let s = z.string();
  if (required) s = s.min(Math.max(1, min ?? 1));
  else if (min) s = s.min(min);
  return required ? s : s.optional().or(z.literal(""));
}

function fieldSchema(field: FieldDef): z.ZodTypeAny {
  const v = field.validation ?? {};
  switch (field.type) {
    case "SHORT_TEXT":
    case "LONG_TEXT": {
      let s = z.string();
      if (field.required) s = s.min(Math.max(1, v.min ?? 1));
      else if (v.min) s = s.min(v.min);
      if (v.max) s = s.max(v.max);
      if (v.regex) s = s.regex(new RegExp(v.regex));
      return field.required ? s : z.union([s, z.literal("")]).optional();
    }
    case "EMAIL": {
      const s = z.string().email();
      return field.required ? s : z.union([s, z.literal("")]).optional();
    }
    case "PHONE":
      return reqString(field.required);
    case "NUMBER": {
      let n = z.coerce.number();
      if (v.min !== undefined) n = n.min(v.min);
      if (v.max !== undefined) n = n.max(v.max);
      return field.required ? n : n.optional();
    }
    case "DATE": {
      const s = z.string().refine((val) => !Number.isNaN(Date.parse(val)), "invalid date");
      return field.required ? s : z.union([s, z.literal("")]).optional();
    }
    case "CHECKBOX":
      return field.required ? z.coerce.boolean().refine((b) => b === true, "required") : z.coerce.boolean().optional();
    case "SINGLE_SELECT":
    case "DEPARTMENT_CHOICE": {
      const values = (field.options ?? []).map((o) => o.value);
      const base = values.length > 0 ? z.enum(values as [string, ...string[]]) : z.string();
      return field.required ? base : z.union([base, z.literal("")]).optional();
    }
    case "MULTI_SELECT": {
      const values = (field.options ?? []).map((o) => o.value);
      const item = values.length > 0 ? z.enum(values as [string, ...string[]]) : z.string();
      let arr = z.array(item);
      if (field.required) arr = arr.min(1);
      if (v.max !== undefined) arr = arr.max(v.max);
      return field.required ? arr : arr.optional();
    }
    case "FILE":
      return z.any().optional();
    default:
      return z.any().optional();
  }
}

/** Build a zod schema for the scalar answers of every visible section. */
export function buildApplicationSchema(
  sections: SectionDef[],
  ctx: VisibilityContext
): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const section of visibleSections(sections, ctx)) {
    for (const field of section.fields) {
      if (field.type === "FILE") continue;
      if (field.type === "SUBCOMMITTEE_RANK") continue; // ordered ranking is validated + hoisted in submissions
      shape[field.key] = fieldSchema(field);
    }
  }
  return z.object(shape);
}

/** Keys of required FILE fields that are visible for this context. */
export function requiredFileKeys(sections: SectionDef[], ctx: VisibilityContext): string[] {
  const keys: string[] = [];
  for (const section of visibleSections(sections, ctx)) {
    for (const field of section.fields) {
      if (field.type === "FILE" && field.required) keys.push(field.key);
    }
  }
  return keys;
}
