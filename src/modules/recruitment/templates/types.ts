import type { ApplicantScope, FieldType, FormPurpose } from "@prisma/client";

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
