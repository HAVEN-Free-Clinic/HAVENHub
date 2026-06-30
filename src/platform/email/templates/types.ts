export type VariableDef = { name: string; label: string; sampleValue: string };
export type TemplateCategory = "transactional" | "layout" | "campaign";

/** Module/group a template belongs to, used for per-category sender rules. */
export type TemplateGroup = "recruitment" | "compliance" | "epic" | "campaign" | "layout";

export type TemplateDescriptor = {
  key: string;
  name: string;
  category: TemplateCategory;
  /** Group for sender-rule resolution (distinct from the render category above). */
  group: TemplateGroup;
  variables: VariableDef[];
  defaultSubject: string;
  defaultBody: string;
};
