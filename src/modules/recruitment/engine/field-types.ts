import type { FieldType } from "@prisma/client";
import {
  Type, AlignLeft, ChevronDownSquare, ListChecks, CheckSquare,
  Mail, Phone, Hash, Calendar, Paperclip, Building2, ListOrdered, type LucideIcon,
} from "lucide-react";

export type FieldGroup = "Text" | "Choice" | "Contact" | "DateNumber" | "File" | "Department" | "Subcommittee";

export type FieldTypeMeta = {
  label: string;
  icon: LucideIcon;
  group: FieldGroup;
  hasOptions: boolean;
  isFile: boolean;
};

export const FIELD_TYPE_META: Record<FieldType, FieldTypeMeta> = {
  SHORT_TEXT: { label: "Short text", icon: Type, group: "Text", hasOptions: false, isFile: false },
  LONG_TEXT: { label: "Paragraph", icon: AlignLeft, group: "Text", hasOptions: false, isFile: false },
  SINGLE_SELECT: { label: "Dropdown (one)", icon: ChevronDownSquare, group: "Choice", hasOptions: true, isFile: false },
  MULTI_SELECT: { label: "Checkboxes (many)", icon: ListChecks, group: "Choice", hasOptions: true, isFile: false },
  CHECKBOX: { label: "Single checkbox", icon: CheckSquare, group: "Choice", hasOptions: false, isFile: false },
  EMAIL: { label: "Email", icon: Mail, group: "Contact", hasOptions: false, isFile: false },
  PHONE: { label: "Phone", icon: Phone, group: "Contact", hasOptions: false, isFile: false },
  NUMBER: { label: "Number", icon: Hash, group: "DateNumber", hasOptions: false, isFile: false },
  DATE: { label: "Date", icon: Calendar, group: "DateNumber", hasOptions: false, isFile: false },
  FILE: { label: "File upload", icon: Paperclip, group: "File", hasOptions: false, isFile: true },
  DEPARTMENT_CHOICE: { label: "Department picker", icon: Building2, group: "Department", hasOptions: false, isFile: false },
  SUBCOMMITTEE_RANK: { label: "Subcommittee ranking", icon: ListOrdered, group: "Subcommittee", hasOptions: false, isFile: false },
};

export const FIELD_GROUP_ORDER: FieldGroup[] = ["Text", "Choice", "Contact", "DateNumber", "File", "Department", "Subcommittee"];

export function fieldTypesByGroup(): { group: FieldGroup; types: FieldType[] }[] {
  return FIELD_GROUP_ORDER.map((group) => ({
    group,
    types: (Object.keys(FIELD_TYPE_META) as FieldType[]).filter((t) => FIELD_TYPE_META[t].group === group),
  }));
}
