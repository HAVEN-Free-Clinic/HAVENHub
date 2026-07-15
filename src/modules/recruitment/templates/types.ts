import type { ApplicantScope, FieldType, FormPurpose } from "@prisma/client";
import type { FieldCondition } from "../engine/field-visibility";

export type TemplateOption = { label: string; value: string };

export type TemplateField = {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  helpText?: string;
  options?: TemplateOption[];
  correctValue?: string;
  order: number;
  visibleWhen?: FieldCondition;
};

export type TemplateSection = {
  title: string;
  description?: string;
  order: number;
  appliesTo: ApplicantScope;
  departmentCode: string | null;
  purpose: FormPurpose;
  fields: TemplateField[];
};
