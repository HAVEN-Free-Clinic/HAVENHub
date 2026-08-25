import type { FieldType } from "@prisma/client";
import {
  Type, AlignLeft, ChevronDownSquare, ListChecks, CheckSquare,
  Mail, Phone, Hash, Calendar, Paperclip, Building2, ListOrdered, PenLine, Info, type LucideIcon,
} from "lucide-react";
import { NOTICE_TYPE_LABEL } from "./notice";

export type FieldGroup = "Content" | "Text" | "Choice" | "Contact" | "DateNumber" | "File" | "Department" | "Subcommittee" | "Signature";

export type FieldTypeMeta = {
  label: string;
  icon: LucideIcon;
  group: FieldGroup;
  hasOptions: boolean;
  isFile: boolean;
};

export const FIELD_TYPE_META: Record<FieldType, FieldTypeMeta> = {
  // The label doubles as the seeded heading of a freshly added notice
  // (addFieldAction), which is why it is a noun an author can leave in place
  // rather than an instruction.
  NOTICE: { label: NOTICE_TYPE_LABEL, icon: Info, group: "Content", hasOptions: false, isFile: false },
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
  SIGNATURE: { label: "Signature (drawn)", icon: PenLine, group: "Signature", hasOptions: false, isFile: false },
};

// Content leads: it is the only group that is not a question, and burying the
// notice under eight groups of inputs in a max-h-80 popover is what sent staff
// back to authoring notices as empty sections in the first place.
export const FIELD_GROUP_ORDER: FieldGroup[] = ["Content", "Text", "Choice", "Contact", "DateNumber", "File", "Department", "Subcommittee", "Signature"];

export const FIELD_GROUP_LABELS: Record<FieldGroup, string> = {
  Content: "Content",
  Text: "Text",
  Choice: "Choice",
  Contact: "Contact",
  DateNumber: "Date & number",
  File: "File",
  Department: "Department",
  Subcommittee: "Subcommittee",
  Signature: "Signature",
};

export function fieldTypesByGroup(): { group: FieldGroup; types: FieldType[] }[] {
  return FIELD_GROUP_ORDER.map((group) => ({
    group,
    types: (Object.keys(FIELD_TYPE_META) as FieldType[]).filter((t) => FIELD_TYPE_META[t].group === group),
  }));
}
