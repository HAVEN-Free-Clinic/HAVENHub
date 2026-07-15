import { z } from "zod";
import {
  visibleSections,
  type SectionVisibilityInput,
  type VisibilityContext,
} from "./visibility";
import { isFieldVisible } from "./field-visibility";

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
  visibleWhen?: unknown;
};

export type SectionDef = SectionVisibilityInput & { fields: FieldDef[] };

/** buildApplicationSchema/requiredFileKeys need the current answers so they can
 *  skip fields whose visibleWhen condition is unmet. Optional (defaults to {})
 *  so callers that never use conditional fields are unaffected. */
export type SchemaContext = VisibilityContext & {
  answers?: Record<string, string | string[] | undefined>;
};

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
      // HTML number inputs always submit their key ("" when blank) and Number("") === 0,
      // so a bare z.coerce.number() would silently accept a required blank as 0 and store
      // 0 for an untouched optional field. Normalize "" (and null) to undefined: the
      // required branch then rejects it (coerces to NaN), the optional branch drops it.
      const blankToUndefined = (val: unknown) => (val === "" || val == null ? undefined : val);
      return field.required ? z.preprocess(blankToUndefined, n) : z.preprocess(blankToUndefined, n.optional());
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
      // Checkboxes sharing one name serialize to a scalar string when exactly one is
      // checked, an array when several are, and are absent when none are (see the apply
      // action serializer). Without normalization a single selection reaches the schema
      // as a string and fails "expected array", hard-blocking an applicant who answered.
      const toRequired = (val: unknown) => (val == null || val === "" ? [] : Array.isArray(val) ? val : [val]);
      const toOptional = (val: unknown) => {
        if (val == null || val === "") return undefined;
        const a = Array.isArray(val) ? val : [val];
        return a.length > 0 ? a : undefined;
      };
      return field.required ? z.preprocess(toRequired, arr) : z.preprocess(toOptional, arr.optional());
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
  ctx: SchemaContext
): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  const answers = ctx.answers ?? {};
  for (const section of visibleSections(sections, ctx)) {
    for (const field of section.fields) {
      if (field.type === "FILE") continue;
      if (field.type === "SUBCOMMITTEE_RANK") continue; // ordered ranking is validated + hoisted in submissions
      if (!isFieldVisible(field.visibleWhen, answers)) continue; // condition-hidden: excluded from validation
      shape[field.key] = fieldSchema(field);
    }
  }
  return z.object(shape);
}

/** Keys of required FILE fields that are visible for this context. */
export function requiredFileKeys(sections: SectionDef[], ctx: SchemaContext): string[] {
  const keys: string[] = [];
  const answers = ctx.answers ?? {};
  for (const section of visibleSections(sections, ctx)) {
    for (const field of section.fields) {
      if (field.type === "FILE" && field.required && isFieldVisible(field.visibleWhen, answers)) keys.push(field.key);
    }
  }
  return keys;
}
