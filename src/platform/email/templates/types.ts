export type VariableDef = { name: string; label: string; sampleValue: string };
export type TemplateCategory = "transactional" | "layout" | "campaign";

export type TemplateDescriptor = {
  key: string;
  name: string;
  category: TemplateCategory;
  variables: VariableDef[];
  defaultSubject: string;
  defaultBody: string;
};
