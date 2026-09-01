import type { Prisma, Track, TechRequestStatus, EpicRequestStatus } from "@prisma/client";
import type { ComplianceStatus } from "@/platform/compliance/rules";
import type { ClearanceSummary } from "@/platform/clearance";
import { YALE_AFFILIATIONS } from "@/platform/affiliation";
import type { DisplayTimeZone } from "@/platform/dates/zone";
import type { AudienceCondition, ConditionOp, CountLoader } from "./types";
import {
  attendanceCountThisTerm,
  noShowCountThisTerm,
  shiftCountThisTerm,
  upcomingShiftCount,
} from "./count-loaders";
import {
  BOOLEAN_OPERATORS,
  DATE_OPERATORS,
  ENUM_OPERATORS,
  MATCH_NOBODY,
  MULTI_ENUM_OPERATORS,
  NUMBER_OPERATORS,
  TEXT_OPERATORS,
  YEAR_OPERATORS,
  asArray,
  countWhere,
  dateWhere,
  enumWhere,
  stringSetFilter,
  textWhere,
  yearWhere,
} from "./operators";

export type PersonFieldKind =
  | "text"
  | "enum"
  | "multiEnum"
  | "boolean"
  | "year"
  | "date"
  | "count";

export type AudienceCtx = {
  activeTermId: string | null;
  /**
   * The instant this resolve is happening. Required, and threaded rather than
   * read from the clock inside a compile function, for two reasons: a recurring
   * campaign's relative windows must re-evaluate on every run against the run's
   * own clock, and a fixed clock is what makes the operators testable.
   */
  now: Date;
  /**
   * The clinic's configured display zone. Date conditions compare by CALENDAR
   * DAY in this zone, so "expires on the 20th" means the local 20th.
   */
  zone: DisplayTimeZone;
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
  /**
   * Person ids that have an application in each recruitment cycle, keyed by
   * cycle id. Required only when an `appliedToCycle` condition is present.
   *
   * Precomputed rather than compiled to a relation filter because an
   * application links to a Person only for signed-in renewals
   * (`Applicant.applicantPersonId`); anonymous applicants are matched back to a
   * Person by email, which no Prisma predicate over Person can express. See
   * loadAppliedByCycle in resolve.ts.
   */
  appliedByCycle?: Map<string, Set<string>>;
  /**
   * Person ids whose application in each recruitment cycle has at least one
   * `Acceptance` row, keyed by cycle id. Required only when an `acceptedInCycle`
   * condition is present. Resolved through the same email/NetID fallback as
   * `appliedByCycle` -- an anonymous applicant who was accepted reaches a Person
   * the identical way an anonymous applicant who merely applied does. See
   * loadApplicantFacts in resolve.ts.
   */
  acceptedByCycle?: Map<string, Set<string>>;
  /**
   * Person ids assigned to each subcommittee, keyed by subcommittee id.
   * Required only when a `subcommittee` condition is present.
   *
   * `Subcommittee` has no relation to `Person` at all; its only link is
   * `Application.assignedSubcommitteeId`, so this is a recruitment question
   * wearing a membership disguise and is resolved through the same
   * email/NetID fallback as the cycle buckets above. See loadApplicantFacts.
   */
  bySubcommittee?: Map<string, Set<string>>;
  /**
   * Per-person counts for each count-kind field actually named in the audience,
   * keyed by field key then person id. Populated by resolveAudience only for
   * fields the audience uses, since each loader is a table scan.
   */
  countsByField?: Map<string, Map<string, number>>;
};

export type PersonFieldDef = {
  key: string;
  label: string;
  group: string;
  kind: PersonFieldKind;
  operators: ConditionOp[];
  options?: { value: string; label: string }[];
  /**
   * True for roster-shaped fields, whose meaning depends on WHICH term. The
   * builder shows a term picker for these; `AudienceCondition.terms` carries the
   * choice, and an empty choice means the active term (the pre-existing meaning
   * of every stored audience).
   */
  termScoped?: boolean;
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

/** IT support ticket statuses that count as "open" (not resolved/closed/cancelled). */
const OPEN_TECH_STATUSES: TechRequestStatus[] = ["SUBMITTED", "IN_PROGRESS", "AWAITING_REQUESTER", "AWAITING_YNHH"];

/** Epic request statuses that count as "open", matching every other code path
 *  (epic.ts, itcm.ts, people.ts, promotion.ts all use PENDING or SUBMITTED). The
 *  audience field previously matched only PENDING, so a request already SUBMITTED
 *  to YNHH read as "no open request". */
const OPEN_EPIC_STATUSES: EpicRequestStatus[] = ["PENDING", "SUBMITTED"];

// ---------------------------------------------------------------------------
// Term scoping
// ---------------------------------------------------------------------------

/** A `termId` filter over the condition's chosen terms, or null when there is nothing to scope to. */
type TermScope = { termId: string } | { termId: { in: string[] } };

/**
 * Resolves a roster condition's term scope.
 *
 * An explicit `cond.terms` wins; otherwise the scope is the ACTIVE term, which
 * is what every roster field meant before term scoping existed. Returns null
 * when neither is available -- with no active term there is no roster to hold a
 * role on, and the caller must return MATCH_NOBODY rather than drop the filter.
 *
 * A single term emits a bare `termId: "x"` (not a one-element `in`) so the
 * generated SQL and the pre-existing tests both stay unchanged for the common case.
 */
function termScope(cond: AudienceCondition, ctx: AudienceCtx): TermScope | null {
  const chosen = (cond.terms ?? []).map((t) => t.trim()).filter((t) => t.length > 0);
  if (chosen.length === 1) return { termId: chosen[0] };
  if (chosen.length > 1) return { termId: { in: chosen } };
  if (ctx.activeTermId) return { termId: ctx.activeTermId };
  return null;
}

/**
 * "On the roster in scope, but NOT matching `inner`."
 *
 * Negating a relation is the sharpest edge in this file. The naive form --
 * `{ memberships: { none: inner } }` -- is true for every Person with no
 * memberships AT ALL: alumni, applicant-created rows, staff. On a send list
 * that is the whole database. So a negated roster condition is always two
 * halves: still on the roster (positive), and not matching the attribute
 * (negative). The same bug is documented on `completedVolunteerTraining` below.
 *
 * `none` is also the reason this takes the whole membership predicate rather
 * than just the attribute: "not in department X" must mean "in no membership of
 * X", not "in some membership that isn't X" -- otherwise a person in both X and
 * Y matches, which is not what "none of" says.
 */
function notOnRosterAs(
  scope: TermScope,
  inner: Prisma.TermMembershipWhereInput,
): Prisma.PersonWhereInput {
  return {
    AND: [
      { memberships: { some: { ...scope, status: "ACTIVE" } } },
      { memberships: { none: { ...scope, status: "ACTIVE", ...inner } } },
    ],
  };
}

function textField(key: string, label: string, column: string, nullable = true): PersonFieldDef {
  return {
    key,
    label,
    group: "Identity",
    kind: "text",
    operators: TEXT_OPERATORS,
    compile: (cond) => textWhere(column, cond, nullable),
  };
}

export function dateField(
  key: string,
  label: string,
  group: string,
  column: string,
): PersonFieldDef {
  return {
    key,
    label,
    group,
    kind: "date",
    operators: DATE_OPERATORS,
    compile: (cond, ctx) => dateWhere(column, cond, ctx),
  };
}

/**
 * A date living on a RELATED row rather than on Person.
 *
 * Compiles to `{ <relation>: { some: { <column>: <datePredicate> } } }`, so a
 * person matches when ANY of their related rows satisfies the date. That is the
 * right reading for certificates and completions, where the question is "did
 * this ever happen in that window", not "did all of them".
 *
 * `isEmpty` is the one operator that cannot use `some`: "has no completion date"
 * must also match a person with no related rows AT ALL, which `some` never does.
 */
function relationDateField(
  key: string,
  label: string,
  group: string,
  relation: string,
  column: string,
): PersonFieldDef {
  return {
    key,
    label,
    group,
    kind: "date",
    operators: DATE_OPERATORS,
    compile: (cond, ctx) => {
      const inner = dateWhere(column, cond, ctx) as Record<string, unknown>;
      // dateWhere returns MATCH_NOBODY as { id: { in: [] } }, which is a Person
      // predicate, not a relation one. Pass it straight through.
      if ("id" in inner) return inner as Prisma.PersonWhereInput;

      if (cond.op === "isEmpty") {
        return {
          OR: [
            { [relation]: { none: {} } },
            { [relation]: { some: { [column]: null } } },
          ],
        } as Prisma.PersonWhereInput;
      }
      return { [relation]: { some: inner } } as Prisma.PersonWhereInput;
    },
  };
}

/**
 * Loaders for every registered count-kind field, keyed by field key.
 * resolveAudience runs only the loaders for fields the audience actually
 * names (see resolve.ts), since each one is a table scan.
 */
export const COUNT_LOADERS: Record<string, CountLoader> = {};

/**
 * A count-kind field: compares a per-person count (shifts attended, strikes,
 * etc.) against a numeric condition. Prisma cannot filter on a relation count
 * inside `where`, so the field's loader precomputes the whole map and
 * countWhere turns the comparison into an explicit id list.
 */
export function countField(
  key: string,
  label: string,
  group: string,
  loader: CountLoader,
): PersonFieldDef {
  COUNT_LOADERS[key] = loader;
  return {
    key,
    label,
    group,
    kind: "count",
    operators: NUMBER_OPERATORS,
    compile: (cond, ctx) => {
      const counts = ctx.countsByField?.get(key);
      // A missing map means resolveAudience did not run this field's loader --
      // a WIRING bug, not malformed user input, so this does not follow the
      // MATCH_NOBODY convention the rest of this file uses for a bad condition
      // value. Failing closed here would be silently wrong under a NONE group:
      // compileGroup renders NONE as `NOT { OR: fragments } }`, and a leaf that
      // always evaluates false never contributes to that OR, so the condition
      // would exclude nobody -- the opposite of what a NONE group over this
      // field is supposed to do, and a widening bug via NOT (see the invariants
      // at the top of operators.ts). Throwing instead surfaces the bug loudly:
      // compilePersonWhere has no surrounding try/catch, so nothing gets sent
      // rather than sending to people who should have been filtered out. Every
      // sibling precompute field in this file (appliedToCycle, complianceStatus,
      // isCleared, learningComplete) already throws for the same reason.
      if (!counts) {
        throw new Error(
          `${key} audience requires a precomputed count map; resolveAudience did not run its loader.`,
        );
      }
      return countWhere(counts, cond);
    },
  };
}

const TRACKS = ["DIRECTOR", "VOLUNTEER"] as const;

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
    operators: ENUM_OPERATORS,
    options: YALE_AFFILIATIONS,
    // The column holds stable machine keys, so free-text matching would mean ops
    // typing "ysm_md" blind. enumWhere carries both safeties: a blank value
    // compiles to match-nobody (never `{ yaleAffiliation: undefined }`, which
    // Prisma DROPS, matching everyone), and a negative operator ORs NULL rows
    // back in, so "affiliation is not YSM MD" includes people with none recorded.
    compile: (cond) =>
      enumWhere("yaleAffiliation", cond, true, YALE_AFFILIATIONS.map((a) => a.value)),
  },
  {
    key: "gradYear",
    label: "Grad year",
    group: "Identity",
    kind: "year",
    // Ordered comparison ("graduated before 2026") on top of the text operators.
    // Person.gradYear is a String column, so lt/gt are lexicographic and only
    // accept a clean 4-digit year; see yearWhere.
    operators: YEAR_OPERATORS,
    compile: (cond) => yearWhere("gradYear", cond),
  },
  {
    key: "status",
    label: "Account status",
    group: "Status & roles",
    kind: "enum",
    operators: ENUM_OPERATORS,
    options: [
      { value: "ACTIVE", label: "Active" },
      { value: "OFFBOARDED", label: "Offboarded" },
    ],
    compile: (cond) => enumWhere("status", cond, false, ["ACTIVE", "OFFBOARDED"]),
  },
  {
    key: "onRoster",
    label: "On the roster",
    group: "Status & roles",
    kind: "boolean",
    operators: BOOLEAN_OPERATORS,
    termScoped: true,
    // "Was a member at all", regardless of track -- the field that makes
    // "everyone who served in Spring or Summer" expressible in one condition.
    compile: (cond, ctx) => {
      const scope = termScope(cond, ctx);
      if (!scope) return MATCH_NOBODY;
      const some = { ...scope, status: "ACTIVE" as const };
      // `none` is safe here and ONLY here among the roster fields: "was not on
      // the roster" genuinely does include people with no memberships at all.
      return cond.op === "isFalse" ? { memberships: { none: some } } : { memberships: { some } };
    },
  },
  {
    key: "role",
    label: "Role",
    group: "Status & roles",
    kind: "enum",
    operators: ENUM_OPERATORS,
    termScoped: true,
    options: [
      { value: "DIRECTOR", label: "Director" },
      { value: "VOLUNTEER", label: "Volunteer" },
    ],
    // The role and its terms compile into ONE `some` clause, so a single
    // membership row has to satisfy both. Two separate conditions ANDed together
    // would each get their own `some`, and a director's SP26 stint would satisfy
    // the term half while this term's volunteer membership satisfied the role half.
    compile: (cond, ctx) => {
      const scope = termScope(cond, ctx);
      if (!scope) return MATCH_NOBODY;
      const filter = stringSetFilter(cond, TRACKS);
      if (!filter) return MATCH_NOBODY;
      if ("notIn" in filter) {
        return notOnRosterAs(scope, { kind: { in: filter.notIn as Track[] } });
      }
      // A single track emits a bare `kind: "VOLUNTEER"` rather than a one-element
      // `in`, matching the shape this field has always produced.
      const kind =
        filter.in.length === 1 ? (filter.in[0] as Track) : { in: filter.in as Track[] };
      return {
        memberships: { some: { ...scope, status: "ACTIVE", kind } },
      } as Prisma.PersonWhereInput;
    },
  },
  {
    key: "department",
    label: "Department",
    group: "Status & roles",
    kind: "multiEnum",
    operators: MULTI_ENUM_OPERATORS,
    termScoped: true,
    compile: (cond, ctx) => {
      const scope = termScope(cond, ctx);
      if (!scope) return MATCH_NOBODY;
      const filter = stringSetFilter(cond);
      if (!filter) return MATCH_NOBODY;
      if ("notIn" in filter) {
        return notOnRosterAs(scope, { department: { code: { in: filter.notIn } } });
      }
      return {
        memberships: {
          some: { ...scope, status: "ACTIVE", department: { code: { in: filter.in } } },
        },
      };
    },
  },
  {
    key: "appliedToCycle",
    label: "Applied to recruitment cycle",
    group: "Records",
    kind: "multiEnum",
    operators: MULTI_ENUM_OPERATORS,
    // Resolved from a precomputed per-cycle id set rather than a relation filter,
    // because an application links to a Person only for signed-in renewals; every
    // other applicant is matched back by email. See ctx.appliedByCycle.
    compile: (cond, ctx) => {
      const cycles = asArray(cond.value);
      if (cycles.length === 0) return MATCH_NOBODY;
      if (!ctx.appliedByCycle) {
        throw new Error(
          "appliedToCycle audience requires a precomputed applicant map; resolveAudience must supply ctx.appliedByCycle",
        );
      }
      const ids = new Set<string>();
      for (const cycleId of cycles) {
        for (const personId of ctx.appliedByCycle.get(cycleId) ?? []) ids.add(personId);
      }
      // `notIn` over an id list is the correct negation here: "has not applied"
      // truly does include everyone with no application, unlike the roster fields
      // above where the same shape would mean "everyone who was never a member".
      // An empty id set therefore means every Person, which is right -- nobody
      // applied to that cycle -- and is why this field is meant to be combined
      // with a roster condition, not sent on its own.
      return cond.op === "notIn" ? { id: { notIn: [...ids] } } : { id: { in: [...ids] } };
    },
  },
  {
    key: "acceptedInCycle",
    label: "Accepted in recruitment cycle",
    group: "Recruitment",
    kind: "multiEnum",
    operators: MULTI_ENUM_OPERATORS,
    // Same precomputed-id-set shape as appliedToCycle, over a narrower bucket:
    // the application has at least one Acceptance row (acceptance is a separate
    // row, not a status column). See ctx.acceptedByCycle.
    compile: (cond, ctx) => {
      const cycles = asArray(cond.value);
      if (cycles.length === 0) return MATCH_NOBODY;
      if (!ctx.acceptedByCycle) {
        throw new Error(
          "acceptedInCycle audience requires a precomputed applicant map; resolveAudience must supply ctx.acceptedByCycle",
        );
      }
      const ids = new Set<string>();
      for (const cycleId of cycles) {
        for (const personId of ctx.acceptedByCycle.get(cycleId) ?? []) ids.add(personId);
      }
      // Same reasoning as appliedToCycle: "not accepted" legitimately includes
      // everyone with no application at all, so `notIn` over the id list (not a
      // relation `none`) is correct here too.
      return cond.op === "notIn" ? { id: { notIn: [...ids] } } : { id: { in: [...ids] } };
    },
  },
  {
    key: "subcommittee",
    label: "Assigned subcommittee",
    group: "Recruitment",
    kind: "multiEnum",
    operators: MULTI_ENUM_OPERATORS,
    // Subcommittee has NO relation to Person at all -- its only link is
    // Application.assignedSubcommitteeId -- so this is a recruitment question
    // wearing a membership disguise and resolves through the same precomputed,
    // email/NetID-backed bucket as the cycle fields above. See ctx.bySubcommittee.
    compile: (cond, ctx) => {
      const subcommittees = asArray(cond.value);
      if (subcommittees.length === 0) return MATCH_NOBODY;
      if (!ctx.bySubcommittee) {
        throw new Error(
          "subcommittee audience requires a precomputed applicant map; resolveAudience must supply ctx.bySubcommittee",
        );
      }
      const ids = new Set<string>();
      for (const subcommitteeId of subcommittees) {
        for (const personId of ctx.bySubcommittee.get(subcommitteeId) ?? []) ids.add(personId);
      }
      return cond.op === "notIn" ? { id: { notIn: [...ids] } } : { id: { in: [...ids] } };
    },
  },
  {
    key: "complianceStatus",
    label: "HIPAA compliance status",
    group: "Status & roles",
    kind: "multiEnum",
    operators: MULTI_ENUM_OPERATORS,
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
        if (wanted.has(status) !== (cond.op === "notIn")) ids.push(personId);
      }
      // Both polarities resolve to an explicit `in` list rather than a `notIn`,
      // so neither can widen past the map. Note the map scores EVERY Person
      // (loadComplianceStatusMap has no where clause), so "is none of Compliant"
      // legitimately includes alumni and applicant-created rows -- wide, but what
      // the words say, and visible in the preview before anything is sent.
      return { id: { in: ids } };
    },
  },
  {
    key: "hasEpicId",
    label: "Has an Epic ID",
    group: "Attributes",
    kind: "boolean",
    operators: BOOLEAN_OPERATORS,
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
    operators: BOOLEAN_OPERATORS,
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
    operators: BOOLEAN_OPERATORS,
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
    operators: BOOLEAN_OPERATORS,
    compile: (cond) => ({ licensedRN: cond.op === "isTrue" }),
  },
  {
    key: "hasOpenEpicRequest",
    label: "Has an open Epic request",
    group: "Records",
    kind: "boolean",
    operators: BOOLEAN_OPERATORS,
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
    operators: BOOLEAN_OPERATORS,
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
    operators: BOOLEAN_OPERATORS,
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
    operators: BOOLEAN_OPERATORS,
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
    operators: BOOLEAN_OPERATORS,
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
    operators: BOOLEAN_OPERATORS,
    compile: (cond) => ({ addedToEhs: cond.op === "isTrue" }),
  },
  {
    key: "completedVolunteerTraining",
    label: "Completed volunteer training",
    group: "Status & roles",
    kind: "boolean",
    operators: BOOLEAN_OPERATORS,
    termScoped: true,
    compile: (cond, ctx) => {
      // With no term in scope there is nothing to have completed. The positive
      // branch already matches nobody; the negative branch, without this guard,
      // compiled to `none: { termId: "" }` which is TRUE for every Person in the
      // table (including alumni and applicant-created rows that were never on a
      // roster), so "has NOT completed training" would email the whole database.
      const scope = termScope(cond, ctx);
      if (!scope) return MATCH_NOBODY;
      const some = { ...scope, track: "VOLUNTEER" as const, status: "COMPLETE" as const };
      return cond.op === "isFalse"
        ? { trainings: { none: some } }
        : { trainings: { some } };
    },
  },
  {
    key: "flaggedForOffboarding",
    label: "Flagged for offboarding",
    group: "Status & roles",
    kind: "boolean",
    operators: BOOLEAN_OPERATORS,
    termScoped: true,
    compile: (cond, ctx) => {
      // Same no-term guard as completedVolunteerTraining: without it the negative
      // branch (`none: { termId: "" }`) matches every Person in the table.
      const scope = termScope(cond, ctx);
      if (!scope) return MATCH_NOBODY;
      return cond.op === "isFalse"
        ? { offboardFlags: { none: scope } }
        : { offboardFlags: { some: scope } };
    },
  },
  {
    key: "isCleared",
    label: "Cleared to volunteer (full clearance)",
    group: "Status & roles",
    kind: "boolean",
    operators: BOOLEAN_OPERATORS,
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
    operators: BOOLEAN_OPERATORS,
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
  relationDateField("hipaaCompletedAt", "HIPAA certificate completion date", "Compliance", "hipaaCertificates", "completionDate"),
  relationDateField("hipaaVerifiedAt", "HIPAA certificate verified date", "Compliance", "hipaaCertificates", "verifiedAt"),
  relationDateField("ehsCompletedAt", "EHS training completion date", "Compliance", "ehsCompletions", "completedAt"),
  relationDateField("trainingCompletedAt", "Volunteer training completion date", "Training", "trainings", "completedAt"),
  dateField("joinedAt", "Joined the roster", "Identity", "createdAt"),
  countField("shiftCountThisTerm", "Shifts assigned this term", "Schedule", shiftCountThisTerm),
  countField("attendanceCountThisTerm", "Clinic days attended this term", "Schedule", attendanceCountThisTerm),
  countField("noShowCountThisTerm", "Assigned shifts not attended", "Schedule", noShowCountThisTerm),
  countField("upcomingShiftCount", "Upcoming assigned shifts", "Schedule", upcomingShiftCount),
];

export function personFieldWhere(cond: AudienceCondition, ctx: AudienceCtx): Prisma.PersonWhereInput {
  const field = PERSON_FIELDS.find((f) => f.key === cond.field);
  if (!field) throw new Error(`Unknown audience field: ${cond.field}`);
  // An operator the field does not declare can only arrive from a hand-edited or
  // stale stored audience. Compiling it would either throw deep in a helper or,
  // worse, fall through to a default branch; match nobody instead.
  if (!field.operators.includes(cond.op)) return MATCH_NOBODY;
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
  termScoped: f.termScoped,
}));

/** Field keys whose conditions carry a term scope; used by the builder and the page. */
export const TERM_SCOPED_FIELD_KEYS = PERSON_FIELDS.filter((f) => f.termScoped).map((f) => f.key);
