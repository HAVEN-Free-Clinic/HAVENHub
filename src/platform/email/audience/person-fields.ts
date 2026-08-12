import type { Prisma, TechRequestStatus, EpicRequestStatus } from "@prisma/client";
import type { ComplianceStatus } from "@/platform/compliance/rules";
import type { ClearanceSummary } from "@/platform/clearance";
import { YALE_AFFILIATIONS } from "@/platform/affiliation";
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
  /**
   * Full clearance per active-term member, keyed by id. Required only when a
   * clearance-derived condition (isCleared, learningComplete) is present:
   * clearance is derived (profile + HIPAA + training + learning + EHS), never a
   * stored column, so resolveAudience precomputes it via loadClearanceMap.
   */
  clearanceByPerson?: Map<string, ClearanceSummary>;
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

/** IT support ticket statuses that count as "open" (not resolved/closed/cancelled). */
const OPEN_TECH_STATUSES: TechRequestStatus[] = ["SUBMITTED", "IN_PROGRESS", "AWAITING_REQUESTER", "AWAITING_YNHH"];

/** Epic request statuses that count as "open", matching every other code path
 *  (epic.ts, itcm.ts, people.ts, promotion.ts all use PENDING or SUBMITTED). The
 *  audience field previously matched only PENDING, so a request already SUBMITTED
 *  to YNHH read as "no open request". */
const OPEN_EPIC_STATUSES: EpicRequestStatus[] = ["PENDING", "SUBMITTED"];

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

function textCompile(column: string, cond: AudienceCondition, nullable: boolean): Prisma.PersonWhereInput {
  switch (cond.op) {
    case "isEmpty":
      // Prisma rejects a null filter on a NOT NULL scalar (e.g. Person.name) with
      // a PrismaClientValidationError, so only include the null half for nullable
      // columns. For a required column, "empty" means the empty string.
      return (
        nullable ? { OR: [{ [column]: null }, { [column]: "" }] } : { [column]: "" }
      ) as Prisma.PersonWhereInput;
    case "isNotEmpty":
      return (
        nullable
          ? { AND: [{ [column]: { not: null } }, { [column]: { not: "" } }] }
          : { [column]: { not: "" } }
      ) as Prisma.PersonWhereInput;
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

function textField(key: string, label: string, column: string, nullable = true): PersonFieldDef {
  return {
    key,
    label,
    group: "Identity",
    kind: "text",
    operators: TEXT_OPERATORS,
    compile: (cond) => textCompile(column, cond, nullable),
  };
}

function asArray(value: AudienceCondition["value"]): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.length > 0) return [value];
  return [];
}

export const PERSON_FIELDS: PersonFieldDef[] = [
  textField("name", "Full name", "name", false), // Person.name is NOT NULL
  textField("netId", "NetID", "netId"),
  textField("contactEmail", "Email", "contactEmail"),
  textField("epicId", "Epic ID", "epicId"),
  textField("phone", "Phone", "phone"),
  {
    key: "yaleAffiliation",
    label: "Yale affiliation",
    group: "Identity",
    kind: "enum",
    operators: ["eq"],
    options: YALE_AFFILIATIONS,
    // The column now holds stable machine keys, so free-text matching would mean
    // ops typing "ysm_md" blind. An empty value must never compile to
    // `{ yaleAffiliation: undefined }`, which Prisma drops, matching EVERYONE:
    // same match-nobody safety the status field uses.
    compile: (cond) => {
      const value = typeof cond.value === "string" ? cond.value.trim() : "";
      if (value === "") return MATCH_NOBODY;
      return { yaleAffiliation: value };
    },
  },
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
    // An empty value must never compile to `{ status: undefined }` (which Prisma
    // treats as "no filter", matching EVERYONE). Mirror the match-nobody safety
    // the text/enum fields use on a blank value.
    compile: (cond) => {
      const value = typeof cond.value === "string" ? cond.value.trim() : "";
      if (value === "") return MATCH_NOBODY;
      return { status: value as "ACTIVE" | "OFFBOARDED" };
    },
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
    // An empty value must never compile to `{ kind: "" }` (invalid Track enum,
    // Prisma throws a 500) nor `{ kind: undefined }` (dropped, matching EVERY
    // active member). Mirror the match-nobody safety the status field uses: only
    // the two valid Track values pass through.
    compile: (cond, ctx) => {
      const value = typeof cond.value === "string" ? cond.value.trim() : "";
      if (value !== "DIRECTOR" && value !== "VOLUNTEER") return MATCH_NOBODY;
      // With no active term there is no roster to hold a role on. The old
      // `termId: ctx.activeTermId ?? ""` did match nobody, but only because no
      // membership carries an empty term id -- say it outright, the way the
      // other term-scoped fields do, so the guarantee does not rest on that.
      if (!ctx.activeTermId) return MATCH_NOBODY;
      return {
        memberships: {
          some: { termId: ctx.activeTermId, status: "ACTIVE", kind: value },
        },
      };
    },
  },
  {
    key: "department",
    label: "Department (this term)",
    group: "Status & roles",
    kind: "multiEnum",
    operators: ["in"],
    compile: (cond, ctx) => {
      // Same no-active-term guard as `role` above, and for the same reason.
      if (!ctx.activeTermId) return MATCH_NOBODY;
      return {
        memberships: {
          some: { termId: ctx.activeTermId, status: "ACTIVE", department: { code: { in: asArray(cond.value) } } },
        },
      };
    },
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
  // Language capability moved off Person into PersonLanguage, so these compile
  // to a relation filter. `isFalse` uses `none`, which correctly includes people
  // with no language rows at all; a naive `some: { verified: false }` would only
  // match people who were assessed and failed.
  {
    key: "spanishVerified",
    label: "Spanish-speaking (verified)",
    group: "Attributes",
    kind: "boolean",
    operators: ["isTrue", "isFalse"],
    compile: (cond) =>
      cond.op === "isTrue"
        ? { languages: { some: { language: "es", verified: true, verifiedAt: { not: null } } } }
        : { languages: { none: { language: "es", verified: true, verifiedAt: { not: null } } } },
  },
  {
    key: "spanishSelfReported",
    label: "Spanish-speaking (self-reported)",
    group: "Attributes",
    kind: "boolean",
    operators: ["isTrue", "isFalse"],
    compile: (cond) =>
      cond.op === "isTrue"
        ? { languages: { some: { language: "es", selfReported: true } } }
        : { languages: { none: { language: "es", selfReported: true } } },
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
    label: "Has an open Epic request",
    group: "Records",
    kind: "boolean",
    operators: ["isTrue", "isFalse"],
    compile: (cond) =>
      cond.op === "isFalse"
        ? { epicRequests: { none: { status: { in: OPEN_EPIC_STATUSES } } } }
        : { epicRequests: { some: { status: { in: OPEN_EPIC_STATUSES } } } },
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
  {
    key: "hasApprovedStrike",
    label: "Has an approved strike",
    group: "Records",
    kind: "boolean",
    operators: ["isTrue", "isFalse"],
    compile: (cond) =>
      cond.op === "isFalse"
        ? { incidentSubjectLinks: { none: { strikeDecision: "APPROVED" } } }
        : { incidentSubjectLinks: { some: { strikeDecision: "APPROVED" } } },
  },
  {
    key: "hasOpenTechTicket",
    label: "Has an open IT support ticket",
    group: "Records",
    kind: "boolean",
    operators: ["isTrue", "isFalse"],
    compile: (cond) =>
      cond.op === "isFalse"
        ? { techRequests: { none: { status: { in: OPEN_TECH_STATUSES } } } }
        : { techRequests: { some: { status: { in: OPEN_TECH_STATUSES } } } },
  },
  {
    key: "hasVerifiedCertificate",
    label: "Has a verified HIPAA certificate",
    group: "Records",
    kind: "boolean",
    operators: ["isTrue", "isFalse"],
    compile: (cond) =>
      cond.op === "isFalse"
        ? { hipaaCertificates: { none: { verifiedAt: { not: null } } } }
        : { hipaaCertificates: { some: { verifiedAt: { not: null } } } },
  },
  {
    key: "addedToEhs",
    label: "Added to Yale EHS",
    group: "Attributes",
    kind: "boolean",
    operators: ["isTrue", "isFalse"],
    compile: (cond) => ({ addedToEhs: cond.op === "isTrue" }),
  },
  {
    key: "completedVolunteerTraining",
    label: "Completed volunteer training (this term)",
    group: "Status & roles",
    kind: "boolean",
    operators: ["isTrue", "isFalse"],
    compile: (cond, ctx) => {
      // With no active term there is nothing to have completed. The positive
      // branch already matches nobody; the negative branch, without this guard,
      // compiled to `none: { termId: "" }` which is TRUE for every Person in the
      // table (including alumni and applicant-created rows that were never on a
      // roster), so "has NOT completed training" would email the whole database.
      if (!ctx.activeTermId) return MATCH_NOBODY;
      const some = { termId: ctx.activeTermId, track: "VOLUNTEER" as const, status: "COMPLETE" as const };
      return cond.op === "isFalse"
        ? { trainings: { none: some } }
        : { trainings: { some } };
    },
  },
  {
    key: "flaggedForOffboarding",
    label: "Flagged for offboarding (this term)",
    group: "Status & roles",
    kind: "boolean",
    operators: ["isTrue", "isFalse"],
    compile: (cond, ctx) => {
      // Same no-active-term guard as completedVolunteerTraining: without it the
      // negative branch (`none: { termId: "" }`) matches every Person in the table.
      if (!ctx.activeTermId) return MATCH_NOBODY;
      const some = { termId: ctx.activeTermId };
      return cond.op === "isFalse"
        ? { offboardFlags: { none: some } }
        : { offboardFlags: { some } };
    },
  },
  {
    key: "isCleared",
    label: "Cleared to volunteer (full clearance)",
    group: "Status & roles",
    kind: "boolean",
    operators: ["isTrue", "isFalse"],
    // Derived from full onboarding clearance (profile + HIPAA + training + learning +
    // EHS), precomputed per active-term member by resolveAudience via loadClearanceMap.
    compile: (cond, ctx) => {
      if (!ctx.clearanceByPerson) {
        throw new Error(
          "isCleared audience requires a precomputed clearance map; resolveAudience must supply ctx.clearanceByPerson",
        );
      }
      const want = cond.op === "isTrue";
      const ids: string[] = [];
      for (const [personId, c] of ctx.clearanceByPerson) {
        if (c.cleared === want) ids.push(personId);
      }
      return { id: { in: ids } };
    },
  },
  {
    key: "learningComplete",
    label: "Completed all assigned learning",
    group: "Status & roles",
    kind: "boolean",
    operators: ["isTrue", "isFalse"],
    compile: (cond, ctx) => {
      if (!ctx.clearanceByPerson) {
        throw new Error(
          "learningComplete audience requires a precomputed clearance map; resolveAudience must supply ctx.clearanceByPerson",
        );
      }
      const wantComplete = cond.op === "isTrue";
      const ids: string[] = [];
      for (const [personId, c] of ctx.clearanceByPerson) {
        const learningDone = !c.missing.includes("learning");
        if (learningDone === wantComplete) ids.push(personId);
      }
      return { id: { in: ids } };
    },
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
