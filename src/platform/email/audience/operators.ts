/**
 * Operator compilation for audience conditions.
 *
 * Every field in `person-fields.ts` reduces to one of a handful of shapes --
 * a text column, an enum column, a set of strings, a year -- and each shape has
 * exactly one correct compilation. Keeping them here rather than inline per
 * field means the two invariants below are stated once instead of being
 * re-derived (and eventually missed) twenty times.
 *
 * ## Invariant 1: a condition that cannot be satisfied matches NOBODY
 *
 * A blank or incomplete condition must compile to `MATCH_NOBODY`, never to
 * `undefined` (which Prisma DROPS from the where clause, silently matching every
 * Person in the table). This has always mattered; with negative operators it
 * matters far more, because the failure is inverted: `{ notIn: [] }` is not
 * "narrow to nothing", it is `NOT false` -- literally everyone. A campaign
 * audience is a send list, so widening bugs mail the whole database.
 *
 * ## Invariant 2: negation over a nullable column keeps NULL rows
 *
 * Prisma's `not` and `NOT` both compile to SQL predicates that are NULL (and so
 * excluded) for NULL columns. "Epic ID is not X" therefore silently drops
 * everyone with no Epic ID at all, which is the opposite of what the words mean.
 * Every negative operator over a nullable column ORs the null case back in.
 * See the `prisma-not-excludes-null` class of bug.
 */

import type { Prisma } from "@prisma/client";
import { parseZonedInput } from "@/platform/dates";
import type { AudienceCondition, ConditionOp } from "./types";
import { shiftDay, startOfDayOffsetFromNow } from "./zoned-day";

/** Empty/incomplete conditions compile to this; never an accidental send-all. */
export const MATCH_NOBODY: Prisma.PersonWhereInput = { id: { in: [] } };

export const TEXT_OPERATORS: ConditionOp[] = [
  "contains",
  "notContains",
  "eq",
  "notEq",
  "startsWith",
  "endsWith",
  "in",
  "notIn",
  "isEmpty",
  "isNotEmpty",
];

export const ENUM_OPERATORS: ConditionOp[] = ["eq", "notEq", "in", "notIn"];

export const MULTI_ENUM_OPERATORS: ConditionOp[] = ["in", "notIn"];

export const YEAR_OPERATORS: ConditionOp[] = [
  "eq",
  "notEq",
  "lt",
  "gt",
  "in",
  "notIn",
  "isEmpty",
  "isNotEmpty",
];

export const BOOLEAN_OPERATORS: ConditionOp[] = ["isTrue", "isFalse"];

export const NUMBER_OPERATORS: ConditionOp[] = [
  "eq",
  "notEq",
  "lt",
  "lte",
  "gt",
  "gte",
  "between",
];

/** Splits a pasted list (newline- or comma-separated) into trimmed, non-empty values. */
export function parseTextList(value: AudienceCondition["value"]): string[] {
  const parts = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\n,]/)
      : [];
  return parts.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Normalises a condition value to a list of non-empty strings. */
export function asArray(value: AudienceCondition["value"]): string[] {
  if (Array.isArray(value)) return value.filter((v) => v !== "");
  if (typeof value === "string" && value.length > 0) return [value];
  return [];
}

/**
 * The `{ in }` / `{ notIn }` half of a set condition, or null when the set is
 * empty. Callers turn null into MATCH_NOBODY; returning null rather than an
 * empty filter is what stops `notIn: []` from matching everyone (invariant 1).
 *
 * `allowed`, when given, drops values outside it. A stored audience naming a
 * department code or enum member that no longer exists must neither throw (an
 * invalid Prisma enum is a 500) nor be dropped wholesale.
 */
export function stringSetFilter(
  cond: AudienceCondition,
  allowed?: readonly string[],
): { in: string[] } | { notIn: string[] } | null {
  let list = parseTextList(cond.value);
  if (allowed) list = list.filter((v) => allowed.includes(v));
  if (list.length === 0) return null;
  return cond.op === "notIn" || cond.op === "notEq" ? { notIn: list } : { in: list };
}

/**
 * Wraps a positive fragment so that NULL rows count as matching its negation.
 * On a NOT NULL column the null half is omitted -- Prisma rejects a null filter
 * on a required scalar with a PrismaClientValidationError.
 */
function orNull(
  column: string,
  nullable: boolean,
  fragment: Prisma.PersonWhereInput,
): Prisma.PersonWhereInput {
  if (!nullable) return fragment;
  return { OR: [{ [column]: null } as Prisma.PersonWhereInput, fragment] };
}

/** Case-insensitive OR-of-equals; Postgres ignores `mode: "insensitive"` on `in`. */
function orOfEquals(column: string, list: string[]): Prisma.PersonWhereInput {
  return {
    OR: list.map((v) => ({ [column]: { equals: v, mode: "insensitive" } })),
  } as Prisma.PersonWhereInput;
}

export function textWhere(
  column: string,
  cond: AudienceCondition,
  nullable: boolean,
): Prisma.PersonWhereInput {
  switch (cond.op) {
    case "isEmpty":
      return (
        nullable ? { OR: [{ [column]: null }, { [column]: "" }] } : { [column]: "" }
      ) as Prisma.PersonWhereInput;

    case "isNotEmpty":
      return (
        nullable
          ? { AND: [{ [column]: { not: null } }, { [column]: { not: "" } }] }
          : { [column]: { not: "" } }
      ) as Prisma.PersonWhereInput;

    case "in":
    case "notIn": {
      const list = parseTextList(cond.value);
      if (list.length === 0) return MATCH_NOBODY;
      const positive = orOfEquals(column, list);
      if (cond.op === "in") return positive;
      return orNull(column, nullable, { NOT: positive });
    }

    case "contains":
    case "notContains":
    case "startsWith":
    case "endsWith":
    case "eq":
    case "notEq": {
      const raw = typeof cond.value === "string" ? cond.value.trim() : "";
      if (raw === "") return MATCH_NOBODY;

      if (cond.op === "notEq") {
        return orNull(column, nullable, {
          [column]: { not: raw, mode: "insensitive" },
        } as Prisma.PersonWhereInput);
      }
      if (cond.op === "notContains") {
        return orNull(column, nullable, {
          NOT: { [column]: { contains: raw, mode: "insensitive" } },
        } as Prisma.PersonWhereInput);
      }

      const prismaOp = cond.op === "eq" ? "equals" : cond.op;
      return { [column]: { [prismaOp]: raw, mode: "insensitive" } } as Prisma.PersonWhereInput;
    }

    default:
      throw new Error(`Unsupported text operator: ${cond.op}`);
  }
}

/**
 * An enum-backed scalar column. Unlike text, values are machine keys chosen from
 * a fixed list, so matching is exact (not case-insensitive) and `allowed` gates
 * what can reach Prisma.
 */
export function enumWhere(
  column: string,
  cond: AudienceCondition,
  nullable: boolean,
  allowed?: readonly string[],
): Prisma.PersonWhereInput {
  switch (cond.op) {
    case "eq":
    case "notEq": {
      const raw = typeof cond.value === "string" ? cond.value.trim() : "";
      if (raw === "") return MATCH_NOBODY;
      if (allowed && !allowed.includes(raw)) return MATCH_NOBODY;
      if (cond.op === "eq") return { [column]: raw } as Prisma.PersonWhereInput;
      return orNull(column, nullable, { [column]: { not: raw } } as Prisma.PersonWhereInput);
    }

    case "in":
    case "notIn": {
      const filter = stringSetFilter(cond, allowed);
      if (!filter) return MATCH_NOBODY;
      if (cond.op === "in") return { [column]: filter } as Prisma.PersonWhereInput;
      return orNull(column, nullable, { [column]: filter } as Prisma.PersonWhereInput);
    }

    default:
      throw new Error(`Unsupported enum operator: ${cond.op}`);
  }
}

/** A clean 4-digit year, the only shape an ordered comparison can trust. */
const YEAR_RE = /^\d{4}$/;

/**
 * A year held in a String column (Person.gradYear). Ordered comparison is
 * lexicographic, which is identical to numeric order for equal-length 4-digit
 * years -- and wrong for anything else, so `lt`/`gt` reject any other shape
 * rather than quietly mis-sorting "'26" or "2026 (expected)".
 */
export function yearWhere(column: string, cond: AudienceCondition): Prisma.PersonWhereInput {
  if (cond.op === "lt" || cond.op === "gt") {
    const raw = typeof cond.value === "string" ? cond.value.trim() : "";
    if (!YEAR_RE.test(raw)) return MATCH_NOBODY;
    return { [column]: { [cond.op]: raw } } as Prisma.PersonWhereInput;
  }
  return textWhere(column, cond, true);
}

export const DATE_OPERATORS: ConditionOp[] = [
  "before",
  "after",
  "onOrBefore",
  "onOrAfter",
  "between",
  "withinNextDays",
  "withinLastDays",
  "isEmpty",
  "isNotEmpty",
];

/** A calendar date with no time part, the only shape the absolute operators accept. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A whole, non-negative day count, the only shape the window operators accept. */
const WINDOW_RE = /^\d+$/;

/**
 * The instant at which `day` begins in `zone`.
 *
 * Delegates to parseZonedInput rather than reimplementing the offset maths: it
 * already resolves the offset twice to settle DST transitions, so a date on the
 * far side of a spring-forward lands on the real local midnight rather than an
 * hour off. Returns null for anything that is not a bare calendar date, which
 * every caller turns into MATCH_NOBODY.
 */
function startOfDay(day: string, zone: string): Date | null {
  const raw = day.trim();
  if (!DATE_RE.test(raw)) return null;
  return parseZonedInput(`${raw}T00:00`, zone);
}

/** The instant at which the day AFTER `day` begins in `zone`. */
function startOfNextDay(day: string, zone: string): Date | null {
  const raw = day.trim();
  if (!DATE_RE.test(raw)) return null;
  return parseZonedInput(`${shiftDay(raw, 1)}T00:00`, zone);
}

/**
 * The boundary a date condition resolves to, independent of WHERE the value
 * being compared lives (a Prisma column, or a plain in-memory Date for a
 * derived field with no column at all -- see `mappedDateWhere`).
 *
 * Extracted out of `dateWhere` so the boundary math -- zoned midnights, the
 * next-day shift for the inclusive operators, the `now`-anchored windows --
 * is computed in exactly one place. A derived date field (certificate expiry;
 * see person-fields.ts's `hipaaExpiresAt`) needs the identical resolution a
 * real column gets, or the same condition would silently mean two different
 * date ranges depending on which kind of field it was attached to.
 */
type DateBoundary =
  | { kind: "isEmpty" }
  | { kind: "isNotEmpty" }
  | { kind: "range"; gte?: Date; lt?: Date; lte?: Date }
  | { kind: "nobody" };

function dateBoundaryFor(cond: AudienceCondition, ctx: { now: Date; zone: string }): DateBoundary {
  const single = typeof cond.value === "string" ? cond.value : "";

  switch (cond.op) {
    case "isEmpty":
      return { kind: "isEmpty" };
    case "isNotEmpty":
      return { kind: "isNotEmpty" };

    case "before": {
      const b = startOfDay(single, ctx.zone);
      if (!b) return { kind: "nobody" };
      return { kind: "range", lt: b };
    }
    case "onOrAfter": {
      const b = startOfDay(single, ctx.zone);
      if (!b) return { kind: "nobody" };
      return { kind: "range", gte: b };
    }
    case "after": {
      const b = startOfNextDay(single, ctx.zone);
      if (!b) return { kind: "nobody" };
      return { kind: "range", gte: b };
    }
    case "onOrBefore": {
      const b = startOfNextDay(single, ctx.zone);
      if (!b) return { kind: "nobody" };
      return { kind: "range", lt: b };
    }

    case "between": {
      const pair = asArray(cond.value);
      if (pair.length !== 2) return { kind: "nobody" };
      const gte = startOfDay(pair[0], ctx.zone);
      const lt = startOfNextDay(pair[1], ctx.zone);
      if (!gte || !lt) return { kind: "nobody" };
      return { kind: "range", gte, lt };
    }

    case "withinNextDays": {
      if (!WINDOW_RE.test(single.trim())) return { kind: "nobody" };
      const lt = startOfDayOffsetFromNow(ctx.now, Number(single) + 1, ctx.zone);
      if (!lt) return { kind: "nobody" };
      return { kind: "range", gte: ctx.now, lt };
    }
    case "withinLastDays": {
      if (!WINDOW_RE.test(single.trim())) return { kind: "nobody" };
      const gte = startOfDayOffsetFromNow(ctx.now, -Number(single), ctx.zone);
      if (!gte) return { kind: "nobody" };
      return { kind: "range", gte, lte: ctx.now };
    }

    default:
      throw new Error(`Unsupported date operator: ${cond.op}`);
  }
}

/**
 * A DateTime column compared by CALENDAR DAY in the clinic's display zone.
 *
 * Every absolute operator resolves its boundary to a real local midnight, so
 * "expires on or before the 20th" includes the whole of the 20th wherever the
 * clinic is, rather than cutting off at 20:00 local because UTC midnight came
 * first.
 *
 * The window operators (`withinNextDays`, `withinLastDays`) resolve against
 * `ctx.now`, which resolveAudience supplies fresh on every run. They are the
 * reason this function takes a context at all: freezing them at save time would
 * make a recurring "expiring in the next 30 days" campaign mean the same fixed
 * range forever.
 */
export function dateWhere(
  column: string,
  cond: AudienceCondition,
  ctx: { now: Date; zone: string },
): Prisma.PersonWhereInput {
  const boundary = dateBoundaryFor(cond, ctx);
  switch (boundary.kind) {
    case "isEmpty":
      return { [column]: null } as Prisma.PersonWhereInput;
    case "isNotEmpty":
      return { [column]: { not: null } } as Prisma.PersonWhereInput;
    case "nobody":
      return MATCH_NOBODY;
    case "range": {
      const range: Record<string, Date> = {};
      if (boundary.gte !== undefined) range.gte = boundary.gte;
      if (boundary.lt !== undefined) range.lt = boundary.lt;
      if (boundary.lte !== undefined) range.lte = boundary.lte;
      return { [column]: range } as Prisma.PersonWhereInput;
    }
  }
}

/**
 * A date comparison resolved against a precomputed per-person map, for a
 * DERIVED date that cannot live as a Prisma column at all (e.g. certificate
 * expiry, which is completion date plus a validity period computed in
 * application code -- see `loadHipaaExpiryMap`). Shares `dateBoundaryFor` with
 * `dateWhere`, so the same condition -- same operator, same value, same `now`
 * -- resolves to the identical boundary whether the field is a real column or
 * a derived one; only the evaluation target (an in-memory Date vs. a SQL
 * column) differs.
 *
 * The map MUST contain an entry (a Date, or null for "not computable") for
 * every candidate Person, the same requirement `countWhere`'s map carries: an
 * absent entry would make `isEmpty` silently under- or over-match instead of
 * reflecting "no date for this person" for everyone the audience should see.
 */
export function mappedDateWhere(
  values: Map<string, Date | null>,
  cond: AudienceCondition,
  ctx: { now: Date; zone: string },
): Prisma.PersonWhereInput {
  const boundary = dateBoundaryFor(cond, ctx);
  if (boundary.kind === "nobody") return MATCH_NOBODY;

  const matched: string[] = [];
  for (const [personId, value] of values) {
    if (dateValueMatchesBoundary(value, boundary)) matched.push(personId);
  }
  if (matched.length === 0) return MATCH_NOBODY;
  return { id: { in: matched } };
}

function dateValueMatchesBoundary(value: Date | null, boundary: DateBoundary): boolean {
  if (boundary.kind === "isEmpty") return value === null;
  if (boundary.kind === "isNotEmpty") return value !== null;
  if (boundary.kind === "nobody") return false;
  // A null (not computable) date satisfies no ordered comparison -- the same
  // reading SQL gives a NULL column against gte/lt/lte.
  if (value === null) return false;
  const t = value.getTime();
  if (boundary.gte !== undefined && t < boundary.gte.getTime()) return false;
  if (boundary.lt !== undefined && t >= boundary.lt.getTime()) return false;
  if (boundary.lte !== undefined && t > boundary.lte.getTime()) return false;
  return true;
}

/** A whole, non-negative count. Nothing else is a valid comparison target. */
const COUNT_RE = /^\d+$/;

function parseCount(raw: unknown): number | null {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!COUNT_RE.test(s)) return null;
  return Number(s);
}

/**
 * A count comparison, resolved against a precomputed per-person map.
 *
 * Prisma cannot filter on a relation count inside `where`, so counts take the
 * same precompute-to-id-set route resolve.ts already uses for recruitment
 * applications: the loader produces one map, this turns the comparison into an
 * explicit id list.
 *
 * The map MUST contain an entry for every candidate person, including those
 * whose count is zero. A map built only from rows that exist would make
 * "fewer than 3 shifts" quietly mean "has between 1 and 2 shifts", excluding
 * exactly the people the question is usually about.
 */
export function countWhere(
  counts: Map<string, number>,
  cond: AudienceCondition,
): Prisma.PersonWhereInput {
  let predicate: ((n: number) => boolean) | null = null;

  if (cond.op === "between") {
    const pair = asArray(cond.value);
    if (pair.length !== 2) return MATCH_NOBODY;
    const lo = parseCount(pair[0]);
    const hi = parseCount(pair[1]);
    if (lo === null || hi === null || lo > hi) return MATCH_NOBODY;
    predicate = (n) => n >= lo && n <= hi;
  } else {
    const target = parseCount(cond.value);
    if (target === null) return MATCH_NOBODY;
    switch (cond.op) {
      case "eq": predicate = (n) => n === target; break;
      case "notEq": predicate = (n) => n !== target; break;
      case "lt": predicate = (n) => n < target; break;
      case "lte": predicate = (n) => n <= target; break;
      case "gt": predicate = (n) => n > target; break;
      case "gte": predicate = (n) => n >= target; break;
      default: throw new Error(`Unsupported count operator: ${cond.op}`);
    }
  }

  const matched: string[] = [];
  for (const [personId, n] of counts) if (predicate(n)) matched.push(personId);
  if (matched.length === 0) return MATCH_NOBODY;
  return { id: { in: matched } };
}
