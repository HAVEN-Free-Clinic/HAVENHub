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

/** The calendar Y/M/D that `instant` falls on in `zone`. */
function localDayParts(instant: Date, zone: string): { y: string; m: string; d: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const g = (t: string) => parts.find((p) => p.type === t)!.value;
  return { y: g("year"), m: g("month"), d: g("day") };
}

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

/**
 * The calendar day `days` after `day` (a "YYYY-MM-DD" string).
 *
 * Deliberately pure calendar arithmetic with no zone involved: adding 24 hours
 * to an instant is NOT the same as adding a day, because a DST fall-back day is
 * 25 hours long and a spring-forward day is 23. Doing it on the date itself
 * sidesteps that entirely, and parseZonedInput then resolves the resulting
 * midnight correctly whichever side of a transition it lands on.
 */
function shiftDay(day: string, days: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/** The instant at which the day AFTER `day` begins in `zone`. */
function startOfNextDay(day: string, zone: string): Date | null {
  const raw = day.trim();
  if (!DATE_RE.test(raw)) return null;
  return parseZonedInput(`${shiftDay(raw, 1)}T00:00`, zone);
}

/** Shifts `now` by whole days and returns the local start of that day. */
function startOfDayOffsetFromNow(now: Date, days: number, zone: string): Date | null {
  // Today's calendar date IN ZONE first, then calendar arithmetic on it.
  const { y, m, d } = localDayParts(now, zone);
  return parseZonedInput(`${shiftDay(`${y}-${m}-${d}`, days)}T00:00`, zone);
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
  const single = typeof cond.value === "string" ? cond.value : "";

  switch (cond.op) {
    case "isEmpty":
      return { [column]: null } as Prisma.PersonWhereInput;
    case "isNotEmpty":
      return { [column]: { not: null } } as Prisma.PersonWhereInput;

    case "before": {
      const b = startOfDay(single, ctx.zone);
      if (!b) return MATCH_NOBODY;
      return { [column]: { lt: b } } as Prisma.PersonWhereInput;
    }
    case "onOrAfter": {
      const b = startOfDay(single, ctx.zone);
      if (!b) return MATCH_NOBODY;
      return { [column]: { gte: b } } as Prisma.PersonWhereInput;
    }
    case "after": {
      const b = startOfNextDay(single, ctx.zone);
      if (!b) return MATCH_NOBODY;
      return { [column]: { gte: b } } as Prisma.PersonWhereInput;
    }
    case "onOrBefore": {
      const b = startOfNextDay(single, ctx.zone);
      if (!b) return MATCH_NOBODY;
      return { [column]: { lt: b } } as Prisma.PersonWhereInput;
    }

    case "between": {
      const pair = asArray(cond.value);
      if (pair.length !== 2) return MATCH_NOBODY;
      const gte = startOfDay(pair[0], ctx.zone);
      const lt = startOfNextDay(pair[1], ctx.zone);
      if (!gte || !lt) return MATCH_NOBODY;
      return { [column]: { gte, lt } } as Prisma.PersonWhereInput;
    }

    case "withinNextDays": {
      if (!WINDOW_RE.test(single.trim())) return MATCH_NOBODY;
      const lt = startOfDayOffsetFromNow(ctx.now, Number(single) + 1, ctx.zone);
      if (!lt) return MATCH_NOBODY;
      return { [column]: { gte: ctx.now, lt } } as Prisma.PersonWhereInput;
    }
    case "withinLastDays": {
      if (!WINDOW_RE.test(single.trim())) return MATCH_NOBODY;
      const gte = startOfDayOffsetFromNow(ctx.now, -Number(single), ctx.zone);
      if (!gte) return MATCH_NOBODY;
      return { [column]: { gte, lte: ctx.now } } as Prisma.PersonWhereInput;
    }

    default:
      throw new Error(`Unsupported date operator: ${cond.op}`);
  }
}
