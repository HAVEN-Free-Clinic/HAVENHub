import type { Prisma } from "@prisma/client";
import type { AudienceCondition, ConditionOp } from "./types";

export type PersonFieldKind = "text" | "enum" | "multiEnum" | "boolean";

export type AudienceCtx = { activeTermId: string | null };

export type PersonFieldDef = {
  key: string;
  label: string;
  group: string;
  kind: PersonFieldKind;
  operators: ConditionOp[];
  options?: { value: string; label: string }[];
  compile: (cond: AudienceCondition, ctx: AudienceCtx) => Prisma.PersonWhereInput;
};

const COMPLIANCE_VALUES = ["COMPLIANT", "EXPIRING_SOON", "EXPIRED", "UNKNOWN_DATE", "NO_CERTIFICATE"];

function asArray(value: AudienceCondition["value"]): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.length > 0) return [value];
  return [];
}

export const PERSON_FIELDS: PersonFieldDef[] = [
  {
    key: "status",
    label: "Account status",
    group: "Status & roles",
    kind: "enum",
    operators: ["eq"],
    options: [
      { value: "ACTIVE", label: "Active" },
      { value: "OFFBOARDED", label: "Offboarded" },
    ],
    compile: (cond) => ({ status: cond.value as "ACTIVE" | "OFFBOARDED" }),
  },
  {
    key: "role",
    label: "Role (this term)",
    group: "Status & roles",
    kind: "enum",
    operators: ["eq"],
    options: [
      { value: "DIRECTOR", label: "Director" },
      { value: "VOLUNTEER", label: "Volunteer" },
    ],
    compile: (cond, ctx) => ({
      memberships: {
        some: { termId: ctx.activeTermId ?? "", status: "ACTIVE", kind: cond.value as "DIRECTOR" | "VOLUNTEER" },
      },
    }),
  },
  {
    key: "department",
    label: "Department (this term)",
    group: "Status & roles",
    kind: "multiEnum",
    operators: ["in"],
    compile: (cond, ctx) => ({
      memberships: {
        some: { termId: ctx.activeTermId ?? "", status: "ACTIVE", department: { code: { in: asArray(cond.value) } } },
      },
    }),
  },
  {
    key: "complianceStatus",
    label: "HIPAA compliance status",
    group: "Status & roles",
    kind: "multiEnum",
    operators: ["in"],
    options: COMPLIANCE_VALUES.map((v) => ({ value: v, label: v })),
    compile: (cond) => ({ complianceReminder: { lastStatus: { in: asArray(cond.value) } } }),
  },
  {
    key: "hasEpicId",
    label: "Has an Epic ID",
    group: "Attributes",
    kind: "boolean",
    operators: ["isTrue", "isFalse"],
    compile: (cond) => (cond.op === "isFalse" ? { epicId: null } : { epicId: { not: null } }),
  },
];

export function personFieldWhere(cond: AudienceCondition, ctx: AudienceCtx): Prisma.PersonWhereInput {
  const field = PERSON_FIELDS.find((f) => f.key === cond.field);
  if (!field) throw new Error(`Unknown audience field: ${cond.field}`);
  return field.compile(cond, ctx);
}
