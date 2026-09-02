import type { Prisma, Track, TechRequestStatus, EpicRequestStatus } from "@prisma/client";
import type { ComplianceStatus } from "@/platform/compliance/rules";
import type { ClearanceSummary } from "@/platform/clearance";
import { YALE_AFFILIATIONS } from "@/platform/affiliation";
import { LANGUAGES } from "@/platform/languages";
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
  mappedDateWhere,
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
   * Live HIPAA certificate expiry date for every Person, keyed by id (`null`
   * when there is no computable expiry). Required only when a `hipaaExpiresAt`
   * condition is present. Expiry is DERIVED (completion date plus the
   * certificate's validity period) and depends on the SAME effective-certificate
   * selection `complianceStatus` uses, never a stored column, so it rides the
   * identical precompute-and-inject seam. See loadHipaaExpiryMap.
   */
  hipaaExpiresAtByPerson?: Map<string, Date | null>;
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
   * Person ids REJECTED in each recruitment cycle, keyed by cycle id. Required
   * only when a `rejectedInCycle` condition is present.
   *
   * A rejection has two sources by design and this bucket unions both:
   * `Application.decision = REJECT` is the routed department's decision on a
   * VOLUNTEER application (no interview), and `Interview.decision = REJECT` is
   * the director-track decision. The schema comment on Application.decision
   * says exactly this. Reading one source would silently drop a whole track.
   * See loadApplicantFacts in resolve.ts.
   */
  rejectedByCycle?: Map<string, Set<string>>;
  /**
   * Person ids who were SENT an interview invite in each recruitment cycle,
   * keyed by cycle id. Required only when an `interviewInvitedInCycle`
   * condition is present.
   *
   * Keyed on `Interview.invitedAt` being non-null, never on the row existing:
   * `createInterview` writes a row with no `scheduledAt` and no `invitedAt`,
   * and `sendInterviewInvite` stamps `invitedAt` only when the invite actually
   * goes out. See loadApplicantFacts in resolve.ts.
   */
  interviewInvitedByCycle?: Map<string, Set<string>>;
  /**
   * Person ids who WITHDREW from each recruitment cycle, keyed by cycle id.
   * Required only when a `withdrewFromCycle` condition is present. Keyed on
   * `Application.status = WITHDRAWN`. See loadApplicantFacts in resolve.ts.
   */
  withdrewByCycle?: Map<string, Set<string>>;
  /**
   * Person ids who applied as each `ApplicantType`, keyed by the enum member
   * (NEW / RENEWAL / TRANSFER). Required only when an `applicantType` condition
   * is present.
   *
   * The one bucket here that is NOT cycle-keyed: the type is a property of the
   * application, not of a cycle, so a condition on it names no cycle and spans
   * all of them. It still rides this precompute rather than a relation filter,
   * because reaching a Person from an application needs the same nullable link
   * plus email/NetID fallback every bucket above needs. See loadApplicantFacts.
   */
  byApplicantType?: Map<string, Set<string>>;
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
  nullable = true,
): PersonFieldDef {
  return {
    key,
    label,
    group,
    kind: "date",
    // isEmpty/isNotEmpty compile (in dateWhere) to `{ [column]: null }` /
    // `{ [column]: { not: null } }` unconditionally -- Prisma throws a
    // PrismaClientValidationError for either shape against a NOT NULL column.
    // Omitting them from a non-nullable field's own operator list means the
    // gate in personFieldWhere (`field.operators.includes(cond.op)`) turns any
    // stored-but-invalid condition into MATCH_NOBODY before it ever reaches
    // dateWhere, the same way textField's `nullable` flag already protects its
    // isEmpty/isNotEmpty branch.
    operators: nullable
      ? DATE_OPERATORS
      : DATE_OPERATORS.filter((op) => op !== "isEmpty" && op !== "isNotEmpty"),
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

/**
 * The one compiled shape every applicant-backed field shares: union the
 * precomputed person-id buckets the condition names, then compare Person.id
 * against that explicit list.
 *
 * Shared rather than copied per field because every invariant below has to hold
 * identically for all seven of them, and a copy that lost one would not fail
 * loudly:
 *
 *   - An empty selection is MATCH_NOBODY, never `{ notIn: [] }`, which is
 *     `NOT false` -- every Person in the table (invariant 1 in operators.ts).
 *   - A missing bucket map THROWS rather than failing closed. A missing map
 *     means buildAudienceCtx did not run the precompute for a condition it did
 *     not notice, which is a wiring bug, not user input. MATCH_NOBODY there is
 *     silently wrong under a NONE group: compileGroup renders NONE as
 *     `NOT { OR: fragments }`, and an always-false leaf contributes nothing to
 *     that OR, so the group would stop excluding the cohort it names. Nothing
 *     catches this, so a send fails outright instead of mailing the wrong list.
 *   - A key the map does not hold contributes no ids. That is the pre-seeding
 *     guard doing its job: every bucket is seeded from the ids the audience
 *     actually asked about before any applicant row is scanned, so
 *     `buckets.get(key)` is a "was this one of the ids requested" filter and a
 *     cycle or subcommittee the audience never named can never pass it.
 *   - Negation is `id: { notIn: ids }` rather than a relation `none`. That is
 *     correct HERE and not for the roster fields: "has not applied", "was not
 *     rejected", "did not withdraw" all genuinely include everyone with no
 *     application at all, which is why these fields are meant to be combined
 *     with a roster condition rather than sent on their own.
 *
 * `notEq` is treated as a negation alongside `notIn` so an enum-kind field
 * (applicantType, whose ENUM_OPERATORS include it) negates correctly. The
 * multiEnum fields declare only in/notIn, so this is inert for them.
 *
 * `allowed`, when given, drops keys outside it BEFORE the emptiness check, so a
 * value that is not a member of the field's enum matches nobody in both
 * polarities -- exactly what enumWhere does for every other enum-kind field
 * here. Without it a stored `applicantType notEq GRADUATE` would find no bucket,
 * negate an empty id list, and mail the entire database.
 *
 * The cycle and subcommittee fields are NOT given one, and that asymmetry is a
 * COST/BENEFIT CALL, not an impossibility. An earlier version of this comment
 * claimed there was no allowlist available for row ids. That is true only of a
 * live cycle with an empty cohort; it is false of a DELETED one, whose id is
 * exactly what `loadAudienceBuilderOptions` already detects well enough to
 * render a "Deleted cycle" checkbox (builder-options.ts). So the widening is
 * reachable and has been verified end to end: with the named cycle deleted, a
 * single `rejectedInCycle notIn ["gone"]` clause resolves to EVERY Person with
 * an address.
 *
 * It is left as-is here for three reasons, none of them "it cannot be done":
 *
 *   1. This shape is byte-identical to what `appliedToCycle` and
 *      `acceptedInCycle` already shipped. Narrowing it is a change to the
 *      meaning of two live fields, and `appliedToCycle` is usable inside an
 *      AudienceScope, which is a send BOUNDARY -- so the change shrinks reach
 *      under `in` and widens it under `notIn` and inside NONE. That needs a
 *      scope-by-scope audit, not a rider on a new field.
 *   2. The reading is defensible on its own terms: "was not rejected in cycle
 *      X" genuinely is everyone when nobody was rejected in X.
 *   3. It is visible three ways before anything is sent. The dead id renders as
 *      a CHECKED "Deleted cycle" box rather than vanishing (#82); the per-node
 *      count next to the clause shows the widened number; and any send over
 *      CAMPAIGN_CONFIRM_THRESHOLD (25) makes the sender retype the exact
 *      recipient count before it will go (campaigns/service.ts).
 *
 * Whoever revisits this should weigh those against the failure mode, rather
 * than re-deriving them.
 */
function bucketedIdWhere(
  buckets: Map<string, Set<string>> | undefined,
  cond: AudienceCondition,
  ctxField: string,
  allowed?: readonly string[],
): Prisma.PersonWhereInput {
  let keys = asArray(cond.value);
  if (allowed) keys = keys.filter((k) => allowed.includes(k));
  if (keys.length === 0) return MATCH_NOBODY;
  if (!buckets) {
    throw new Error(
      `${cond.field} audience requires a precomputed applicant map; resolveAudience must supply ctx.${ctxField}`,
    );
  }
  const ids = new Set<string>();
  for (const key of keys) {
    for (const personId of buckets.get(key) ?? []) ids.add(personId);
  }
  const negated = cond.op === "notIn" || cond.op === "notEq";
  return negated ? { id: { notIn: [...ids] } } : { id: { in: [...ids] } };
}

/** The three ways someone can apply; `Application.applicantType`. */
const APPLICANT_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "NEW", label: "New" },
  { value: "RENEWAL", label: "Renewal" },
  { value: "TRANSFER", label: "Transfer" },
];

/** Enum members the applicantType precompute buckets, in registry order. */
export const APPLICANT_TYPE_VALUES: string[] = APPLICANT_TYPE_OPTIONS.map((o) => o.value);

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
    group: "Recruitment",
    kind: "multiEnum",
    operators: MULTI_ENUM_OPERATORS,
    // Resolved from a precomputed per-cycle id set rather than a relation filter,
    // because an application links to a Person only for signed-in renewals; every
    // other applicant is matched back by email. See ctx.appliedByCycle, and
    // bucketedIdWhere for why the negation is an id list rather than a `none`.
    compile: (cond, ctx) => bucketedIdWhere(ctx.appliedByCycle, cond, "appliedByCycle"),
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
    compile: (cond, ctx) => bucketedIdWhere(ctx.acceptedByCycle, cond, "acceptedByCycle"),
  },
  {
    key: "rejectedInCycle",
    label: "Rejected in cycle",
    group: "Recruitment",
    kind: "multiEnum",
    operators: MULTI_ENUM_OPERATORS,
    // The counterpart of acceptedInCycle, and it has to read TWO columns.
    // `Application.decision = REJECT` is the routed department's decision on a
    // VOLUNTEER application (no interview); `Interview.decision = REJECT` is the
    // director-track decision. The schema comment on Application.decision says
    // so in as many words. Matching one would silently drop a whole track.
    //
    // Keyed on the DECISION, not on `Application.rejectionEmailedAt`, so that
    // this field and acceptedInCycle agree about what "outcome" means:
    // acceptedInCycle already keys on the factual Acceptance row rather than on
    // its emailedAt. The cost is that a sender who specifically wants "people we
    // have already TOLD they were not selected" cannot express it -- the emailed
    // stamp is deliberately not exposed as a field. Combine with a date
    // condition once one exists, or add the stamp as its own field; do not
    // quietly redefine this one, because the two readings differ for every
    // applicant decided but not yet released.
    compile: (cond, ctx) => bucketedIdWhere(ctx.rejectedByCycle, cond, "rejectedByCycle"),
  },
  {
    key: "interviewInvitedInCycle",
    label: "Invited to interview in cycle",
    group: "Recruitment",
    kind: "multiEnum",
    operators: MULTI_ENUM_OPERATORS,
    // Deliberately NOT called "interviewed", and deliberately not keyed on the
    // Interview row existing. createInterview (recruitment/services/interviews.ts)
    // writes a row with no scheduledAt and no invitedAt; the time is patched
    // separately and sendInterviewInvite stamps invitedAt only after the invite
    // has actually been queued, guarded on scheduledAt existing. So a bare row
    // is internal review state the applicant has never seen, and matching it
    // would mail people about an interview nobody told them about. invitedAt is
    // the only stamp the applicant's own inbox can corroborate, so the field is
    // named for what the data actually says rather than for a fuzzier word.
    compile: (cond, ctx) =>
      bucketedIdWhere(ctx.interviewInvitedByCycle, cond, "interviewInvitedByCycle"),
  },
  {
    key: "withdrewFromCycle",
    label: "Withdrew from cycle",
    group: "Recruitment",
    kind: "multiEnum",
    operators: MULTI_ENUM_OPERATORS,
    // Keyed on `Application.status = WITHDRAWN` rather than on `withdrawnAt`
    // being set. Both writes in withdraw.ts set the two together in ONE guarded
    // update (withdrawSelf claims on status: "SUBMITTED";
    // reopenWithdrawnApplication claims on status: "WITHDRAWN" and clears both),
    // so they cannot disagree -- and status is the canonical state, a plain enum
    // column rather than a stamp that reads as "when", so a future write that
    // forgot the timestamp would still be caught here.
    compile: (cond, ctx) => bucketedIdWhere(ctx.withdrewByCycle, cond, "withdrewByCycle"),
  },
  {
    key: "applicantType",
    label: "Applicant type",
    group: "Recruitment",
    kind: "enum",
    operators: ENUM_OPERATORS,
    options: APPLICANT_TYPE_OPTIONS,
    // The odd one out among the recruitment fields: an enum with fixed options
    // rather than a cycle-keyed set, because `Application.applicantType` is a
    // property of the application and not of a cycle. A condition on it
    // therefore names no cycle and spans every one of them.
    //
    // It still rides the applicant precompute rather than compiling to a naive
    // relation filter over Person. Person has no relation to Application at all
    // except `Applicant.applicantPerson`, which is null for everyone who applied
    // anonymously, so a relation filter would match only signed-in renewals --
    // and RENEWAL is precisely the value a sender is most likely to ask for.
    //
    // APPLICANT_TYPE_VALUES is passed as the allowlist for the same reason every
    // other enum field passes one to enumWhere: an unknown value (a hand-edited
    // or migrated audience naming a type that is not in the enum) must match
    // nobody in BOTH polarities. Left unchecked, `notEq GRADUATE` would negate
    // an empty id list into `{ notIn: [] }` and mail the whole database. The
    // buckets are pre-seeded from the same list, so a valid type with no
    // applicants still resolves to an empty set rather than a missing key.
    compile: (cond, ctx) =>
      bucketedIdWhere(ctx.byApplicantType, cond, "byApplicantType", APPLICANT_TYPE_VALUES),
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
    compile: (cond, ctx) => bucketedIdWhere(ctx.bySubcommittee, cond, "bySubcommittee"),
  },
  {
    key: "complianceStatus",
    label: "HIPAA compliance status",
    group: "Compliance",
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
    group: "Identity",
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
    group: "Compliance",
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
    group: "Compliance",
    kind: "boolean",
    operators: BOOLEAN_OPERATORS,
    compile: (cond) => ({ addedToEhs: cond.op === "isTrue" }),
  },
  {
    key: "completedVolunteerTraining",
    label: "Completed volunteer training",
    group: "Training",
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
    group: "Training",
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
  dateField("joinedAt", "Joined the roster", "Identity", "createdAt", false), // Person.createdAt is NOT NULL
  countField("shiftCountThisTerm", "Shifts assigned this term", "Schedule", shiftCountThisTerm),
  countField("attendanceCountThisTerm", "Clinic days attended this term", "Schedule", attendanceCountThisTerm),
  countField("noShowCountThisTerm", "Assigned shifts not attended", "Schedule", noShowCountThisTerm),
  countField("upcomingShiftCount", "Upcoming assigned shifts", "Schedule", upcomingShiftCount),
  {
    key: "speaksLanguage",
    label: "Speaks a language (verified)",
    group: "Attributes",
    kind: "multiEnum",
    operators: MULTI_ENUM_OPERATORS,
    options: LANGUAGES.map((l) => ({ value: l.code, label: l.label })),
    // Generalises spanishVerified to the full catalog: same `verified: true` +
    // `verifiedAt: { not: null }` pair (verified alone is meaningless -- see the
    // PersonLanguage.verified schema comment -- because verified: false WITH
    // verifiedAt set means "assessed and did not pass"), now over an `in` set of
    // language codes instead of a bare "es".
    compile: (cond) => {
      const filter = stringSetFilter(
        cond,
        LANGUAGES.map((l) => l.code),
      );
      if (!filter) return MATCH_NOBODY;
      const verifiedIn = (languages: string[]) => ({
        language: { in: languages },
        verified: true,
        verifiedAt: { not: null },
      });
      // `none`, not `some: { verified: false }`: excluding a language must also
      // exclude everyone with no language row at all, not only those assessed
      // and failed in it -- the same invariant spanishVerified's isFalse branch
      // documents.
      if ("notIn" in filter) return { languages: { none: verifiedIn(filter.notIn) } };
      return { languages: { some: verifiedIn(filter.in) } };
    },
  },
  {
    key: "claimsLanguage",
    label: "Claims a language (self-reported)",
    group: "Attributes",
    kind: "multiEnum",
    operators: MULTI_ENUM_OPERATORS,
    options: LANGUAGES.map((l) => ({ value: l.code, label: l.label })),
    // Generalises spanishSelfReported the same way: an intake claim, never a
    // qualification, so no `verified`/`verifiedAt` check at all.
    compile: (cond) => {
      const filter = stringSetFilter(
        cond,
        LANGUAGES.map((l) => l.code),
      );
      if (!filter) return MATCH_NOBODY;
      const selfReportedIn = (languages: string[]) => ({
        language: { in: languages },
        selfReported: true,
      });
      if ("notIn" in filter) return { languages: { none: selfReportedIn(filter.notIn) } };
      return { languages: { some: selfReportedIn(filter.in) } };
    },
  },
  {
    key: "hasServiceCredential",
    label: "Has a service credential",
    group: "Records",
    kind: "boolean",
    operators: BOOLEAN_OPERATORS,
    // Person.serviceCredential is a nullable one-to-one, not a list, so this is
    // a relation-presence check rather than a some/none over rows -- but
    // presence alone is not enough. ServiceCredential.revokedAt is the SOLE
    // invalidating signal everywhere else a credential is read (see
    // src/modules/passport/services/credential.ts: getCredentialByToken,
    // revokeServiceCredential, restoreServiceCredential all key off it alone).
    // publicToken/unpublishedAt are ORTHOGONAL -- they gate whether the public
    // credential page is visible, not whether the underlying service record is
    // valid -- so they play no part here. A credential revoked for falsified
    // service must not count as "has a service credential".
    //
    // Prisma's `is`/`isNot` on a nullable to-one relation give exactly the
    // needed positive/negative pair from one shared inner filter:
    //   is:    { revokedAt: null } -- a credential row exists AND is unrevoked.
    //   isNot: { revokedAt: null } -- NOT(exists AND unrevoked), i.e. either no
    //          credential row at all, OR a credential row that IS revoked.
    // The isNot branch is what makes the negative case correct: a naive
    // `{ is: null }` (bare relation-absence) would miss the revoked-but-present
    // row, silently keeping a falsified credential in the "does not have a
    // valid credential" cohort's complement. Verified against a live Postgres
    // database with three people (active credential / revoked credential / no
    // credential row) -- see membership-fields.test.ts's three-way test.
    compile: (cond) => ({
      serviceCredential:
        cond.op === "isTrue" ? { is: { revokedAt: null } } : { isNot: { revokedAt: null } },
    }),
  },
  {
    key: "hipaaExpiresAt",
    label: "HIPAA certificate expires",
    group: "Compliance",
    kind: "date",
    // Full DATE_OPERATORS, including isEmpty/isNotEmpty: "no computable expiry"
    // (no certificate at all, or the effective certificate has no parsed
    // completionDate) is a real, meaningful state for this field, the same way
    // a null relation date is for hipaaCompletedAt.
    operators: DATE_OPERATORS,
    // Expiry is DERIVED (completionDate + CERT_VALIDITY_DAYS -- see
    // compliance/rules.ts's certExpiresAt), not a stored column, so it cannot be
    // a relationDateField over hipaaCertificates the way hipaaCompletedAt is.
    // It also cannot be expressed as completionDate shifted by the validity
    // window in the OPERATOR layer: the certificate that determines expiry is
    // not always the newest one (see effectiveCompliance's verified-fallback --
    // an unverified early renewal defers to an older still-valid VERIFIED
    // cert), and relationDateField's `some` has no way to pick that SAME row.
    // So this rides the same precompute-and-inject seam complianceStatus does:
    // resolveAudience precomputes ctx.hipaaExpiresAtByPerson via
    // loadHipaaExpiryMap (which reuses effectiveCompliance directly), and this
    // field resolves the condition against that map with mappedDateWhere --
    // the same date-boundary logic dateWhere uses for a real column, just
    // evaluated against an in-memory Date instead of a SQL predicate. See
    // loadHipaaExpiryMap's doc comment for the full reasoning.
    compile: (cond, ctx) => {
      if (!ctx.hipaaExpiresAtByPerson) {
        throw new Error(
          "hipaaExpiresAt audience requires a precomputed expiry map; resolveAudience must supply ctx.hipaaExpiresAtByPerson",
        );
      }
      return mappedDateWhere(ctx.hipaaExpiresAtByPerson, cond, ctx);
    },
  },
];

/**
 * A stored audience naming a field that no longer exists.
 *
 * Typed rather than a bare Error so a caller can degrade on THIS and nothing
 * else. It is a reachable legacy state, not a programmer bug: `isAudience`
 * admits any leaf carrying a string `field`, so a renamed or retired field
 * survives in `audienceJson` indefinitely, and field-picker.tsx exists
 * specifically to render it as "Unknown field" and let a sender remove it. The
 * builder's live counts compile that same tree on every editor load, so they
 * need to recognise this one case without also swallowing a genuine wiring bug
 * from elsewhere in the compiler.
 */
export class UnknownAudienceFieldError extends Error {
  constructor(field: string) {
    super(`Unknown audience field: ${field}`);
    this.name = "UnknownAudienceFieldError";
  }
}

export function personFieldWhere(cond: AudienceCondition, ctx: AudienceCtx): Prisma.PersonWhereInput {
  const field = PERSON_FIELDS.find((f) => f.key === cond.field);
  if (!field) throw new UnknownAudienceFieldError(cond.field);
  // An operator the field does not declare can only arrive from a hand-edited or
  // stale stored audience. Compiling it would either throw deep in a helper or,
  // worse, fall through to a default branch; match nobody instead.
  //
  // This was deliberately NOT changed to throw (the way countField's missing
  // precompute map does) even though the reasoning is the same in spirit -- an
  // operator/field mismatch is a wiring or corruption bug, not user input -- and
  // even though MATCH_NOBODY here is unsafe under a NONE group: compileGroup
  // renders NONE as `NOT { OR: fragments } }`, and a fragment that always
  // evaluates false contributes nothing to that OR, so the surrounding NONE
  // widens to match EVERY Person instead of excluding the intended cohort. Two
  // reasons kept this as MATCH_NOBODY:
  //
  // 1. dateField's `nullable` parameter (see above) relies on exactly this gate
  //    to turn a non-nullable date field's isEmpty/isNotEmpty into a safe no-op
  //    rather than a PrismaClientValidationError -- that is the documented,
  //    intended behavior for that case, so this gate cannot unconditionally
  //    throw without breaking it.
  // 2. The concrete widening bug this gate could otherwise cause (a freshly
  //    added date/count condition landing on an operator its own kind doesn't
  //    declare, e.g. the enum-shaped fallback `eq` on a date field) is closed
  //    upstream instead: defaultConditionFor in audience-builder.tsx now has a
  //    branch for every PersonFieldKind, and a test asserts every field's
  //    default operator is a member of that field's own `operators` array. That
  //    closes the only path normal use of the builder has to reach this gate at
  //    all, for both existing and future field kinds.
  //
  // What remains open, by choice, is a stored audience whose JSON was edited or
  // corrupted by hand (or a migration) to name an operator its field no longer
  // declares -- that condition still widens if it lands inside a NONE group.
  // This is not a new hole: an ordinary, syntactically VALID condition with an
  // unsatisfiable value (an empty `contains` string, an empty `in` list) has
  // always compiled to this same MATCH_NOBODY and has always had the same
  // effect under NONE. Closing that general class -- rejecting an incomplete
  // condition inside a NONE group outright, everywhere, at compile time -- is a
  // larger, cross-cutting change deferred rather than folded into this fix.
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
