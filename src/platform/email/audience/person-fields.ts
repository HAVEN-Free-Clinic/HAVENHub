import type { Prisma } from "@prisma/client";
import type { AudienceCondition } from "./types";

export type PersonFieldKind = "enum" | "multiEnum" | "boolean";
export type PersonFieldDef = {
  key: string;
  label: string;
  kind: PersonFieldKind;
  options?: { value: string; label: string }[];
};

export type AudienceCtx = { activeTermId: string | null };

const COMPLIANCE_VALUES = ["COMPLIANT", "EXPIRING_SOON", "EXPIRED", "UNKNOWN_DATE", "NO_CERTIFICATE"];

export const PERSON_FIELDS: PersonFieldDef[] = [
  { key: "status", label: "Account status", kind: "enum", options: [
    { value: "ACTIVE", label: "Active" }, { value: "OFFBOARDED", label: "Offboarded" } ] },
  { key: "role", label: "Role (this term)", kind: "enum", options: [
    { value: "DIRECTOR", label: "Director" }, { value: "VOLUNTEER", label: "Volunteer" } ] },
  { key: "department", label: "Department (this term)", kind: "multiEnum" },
  { key: "complianceStatus", label: "HIPAA compliance status", kind: "multiEnum",
    options: COMPLIANCE_VALUES.map((v) => ({ value: v, label: v })) },
  { key: "hasEpicId", label: "Has an Epic ID", kind: "boolean" },
];

function asArray(value: AudienceCondition["value"]): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.length > 0) return [value];
  return [];
}

export function personFieldWhere(cond: AudienceCondition, ctx: AudienceCtx): Prisma.PersonWhereInput {
  switch (cond.field) {
    case "status":
      return { status: cond.value as "ACTIVE" | "OFFBOARDED" };
    case "role":
      return { memberships: { some: { termId: ctx.activeTermId ?? "", status: "ACTIVE", kind: cond.value as "DIRECTOR" | "VOLUNTEER" } } };
    case "department":
      return { memberships: { some: { termId: ctx.activeTermId ?? "", status: "ACTIVE", department: { code: { in: asArray(cond.value) } } } } };
    case "complianceStatus":
      return { complianceReminder: { lastStatus: { in: asArray(cond.value) } } };
    case "hasEpicId":
      return cond.op === "isFalse" ? { epicId: null } : { epicId: { not: null } };
    default:
      throw new Error(`Unknown audience field: ${cond.field}`);
  }
}
