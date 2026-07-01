import type { Prisma } from "@prisma/client";
import type { ComplianceStatus } from "@/platform/compliance/rules";
import type { AudienceCondition, ConditionOp } from "./types";

export type PersonFieldKind = "text" | "enum" | "multiEnum" | "boolean";

export type AudienceCtx = {
  activeTermId: string | null;
  /**
   * Live compliance status for every Person, keyed by id. Required only when
   * resolving a `complianceStatus` condition: that status is derived (newest
   * cert + term end), never a stored column, so resolveAudience precomputes it
   * and injects it here. See loadComplianceStatusMap.
   */
  complianceStatusByPerson?: Map<string, ComplianceStatus>;
};

export type PersonFieldDef = {
  key: string;
  label: string;
  group: string;
  kind: PersonFieldKind;
  operators: ConditionOp[];
  options?: { value: string; label: string }[];
  compile: (cond: AudienceCondition, ctx: AudienceCtx) => Prisma.PersonWhereInput;
};

/**
 * The serializable shape of a field, minus the `compile` function. Server
 * components must pass this (not PersonFieldDef) to client components, since
 * functions cannot cross the RSC boundary.
 */
export type PersonFieldView = Omit<PersonFieldDef, "compile">;

const COMPLIANCE_OPTIONS: { value: ComplianceStatus; label: string }[] = [
  { value: "COMPLIANT", label: "Compliant" },
  { value: "EXPIRING_SOON", label: "Expiring soon" },
  { value: "EXPIRED", label: "Expired" },
  { value: "PENDING_VERIFICATION", label: "Awaiting verification" },
  { value: "UNKNOWN_DATE", label: "Unknown date" },
  { value: "NO_CERTIFICATE", label: "No certificate" },
];

const MATCH_NOBODY: Prisma.PersonWhereInput = { id: { in: [] } };

const TEXT_OPERATORS: ConditionOp[] = [
  "contains",
  "eq",
  "startsWith",
  "endsWith",
  "in",
  "isEmpty",
  "isNotEmpty",
];

export function parseTextList(value: AudienceCondition["value"]): string[] {
  const parts = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\n,]/)
      : [];
  return parts.map((s) => s.trim()).filter((s) => s.length > 0);
}

function textCompile(column: string, cond: AudienceCondition): Prisma.PersonWhereInput {
  switch (cond.op) {
    case "isEmpty":
      return { OR: [{ [column]: null }, { [column]: "" }] } as Prisma.PersonWhereInput;
    case "isNotEmpty":
      return {
        AND: [{ [column]: { not: null } }, { [column]: { not: "" } }],
      } as Prisma.PersonWhereInput;
    case "in": {
      // "is any of": case-insensitive match against a pasted list. Prisma ignores
      // mode:"insensitive" on `in` for Postgres, so expand to an OR of equals.
      const list = parseTextList(cond.value);
      if (list.length === 0) return MATCH_NOBODY;
      return {
        OR: list.map((v) => ({ [column]: { equals: v, mode: "insensitive" } })),
      } as Prisma.PersonWhereInput;
    }
    case "contains":
    case "startsWith":
    case "endsWith":
    case "eq": {
      const raw = typeof cond.value === "string" ? cond.value.trim() : "";
      if (raw === "") return MATCH_NOBODY;
      const prismaOp = cond.op === "eq" ? "equals" : cond.op;
      return { [column]: { [prismaOp]: raw, mode: "insensitive" } } as Prisma.PersonWhereInput;
    }
    default:
      throw new Error(`Unsupported text operator: ${cond.op}`);
  }
}

function textField(key: string, label: string, column: string): PersonFieldDef {
  return {
    key,
    label,
    group: "Identity",
    kind: "text",
    operators: TEXT_OPERATORS,
    compile: (cond) => textCompile(column, cond),
  };
}

function asArray(value: AudienceCondition["value"]): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.length > 0) return [value];
  return [];
}

export const PERSON_FIELDS: PersonFieldDef[] = [
  textField("name", "Full name", "name"),
  textField("netId", "NetID", "netId"),
  textField("contactEmail", "Email", "contactEmail"),
  textField("epicId", "Epic ID", "epicId"),
  textField("phone", "Phone", "phone"),
  textField("yaleAffiliation", "Yale affiliation", "yaleAffiliation"),
  textField("gradYear", "Grad year", "gradYear"),
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
    options: COMPLIANCE_OPTIONS,
    // Compliance status is derived live (newest cert + active term end), never a
    // stored column, so it can't be a Prisma predicate. resolveAudience
    // precomputes the per-person status map (ctx.complianceStatusByPerson); we
    // resolve the selected statuses to a concrete id list here.
    compile: (cond, ctx) => {
      const wanted = new Set(asArray(cond.value));
      if (wanted.size === 0) return MATCH_NOBODY;
      if (!ctx.complianceStatusByPerson) {
        throw new Error(
          "complianceStatus audience requires a precomputed status map; resolveAudience must supply ctx.complianceStatusByPerson",
        );
      }
      const ids: string[] = [];
      for (const [personId, status] of ctx.complianceStatusByPerson) {
        if (wanted.has(status)) ids.push(personId);
      }
      return { id: { in: ids } };
    },
  },
  {
    key: "hasEpicId",
    label: "Has an Epic ID",
    group: "Attributes",
    kind: "boolean",
    operators: ["isTrue", "isFalse"],
    compile: (cond) => (cond.op === "isFalse" ? { epicId: null } : { epicId: { not: null } }),
  },
  {
    key: "spanishVerified",
    label: "Spanish-speaking (verified)",
    group: "Attributes",
    kind: "boolean",
    operators: ["isTrue", "isFalse"],
    compile: (cond) => ({ spanishVerified: cond.op === "isTrue" }),
  },
  {
    key: "spanishSelfReported",
    label: "Spanish-speaking (self-reported)",
    group: "Attributes",
    kind: "boolean",
    operators: ["isTrue", "isFalse"],
    compile: (cond) => ({ spanishSelfReported: cond.op === "isTrue" }),
  },
  {
    key: "licensedRN",
    label: "Licensed RN",
    group: "Attributes",
    kind: "boolean",
    operators: ["isTrue", "isFalse"],
    compile: (cond) => ({ licensedRN: cond.op === "isTrue" }),
  },
  {
    key: "hasOpenEpicRequest",
    label: "Has an open EPIC request",
    group: "Records",
    kind: "boolean",
    operators: ["isTrue", "isFalse"],
    compile: (cond) =>
      cond.op === "isFalse"
        ? { epicRequests: { none: { status: "PENDING" } } }
        : { epicRequests: { some: { status: "PENDING" } } },
  },
  {
    key: "hasDisciplinaryAction",
    label: "Has a disciplinary action",
    group: "Records",
    kind: "boolean",
    operators: ["isTrue", "isFalse"],
    compile: (cond) =>
      cond.op === "isFalse"
        ? { disciplinaryActions: { none: {} } }
        : { disciplinaryActions: { some: {} } },
  },
];

export function personFieldWhere(cond: AudienceCondition, ctx: AudienceCtx): Prisma.PersonWhereInput {
  const field = PERSON_FIELDS.find((f) => f.key === cond.field);
  if (!field) throw new Error(`Unknown audience field: ${cond.field}`);
  return field.compile(cond, ctx);
}

/**
 * Serializable field metadata for client components. Strips the `compile`
 * function so the registry can cross the server -> client boundary.
 */
export const PERSON_FIELD_VIEWS: PersonFieldView[] = PERSON_FIELDS.map((f) => ({
  key: f.key,
  label: f.label,
  group: f.group,
  kind: f.kind,
  operators: f.operators,
  options: f.options,
}));
