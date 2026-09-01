# Outreach Phase 2, Part A: Audience Depth (engine and data) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Part A of two.** Phase 2 is one phase on one branch, but it spans two subsystems, so it is split into two plan documents rather than one unreadable four-thousand-line file. This document is the engine and data work. The builder rewrite is `2026-08-31-outreach-phase2b-builder.md`, and it depends on this part landing first (its controls need the date and count kinds to exist). Both merge together.

**Goal:** Make the audience engine able to express time and quantity, add the four confirmed field domains, and give campaigns manual lists and send-once.

**Architecture:** Two engine changes come first and everything else builds on them. Date conditions thread a `now` instant and the clinic's display zone through the compiler so relative operators re-evaluate on every recurring run. Count conditions reuse the existing precompute-to-id-set seam, because Prisma cannot filter on relation counts. The builder is then rebuilt as a two-pane editor whose right side shows live match counts and the actual recipients.

**Tech Stack:** Next.js App Router (server components + server actions), Prisma/Postgres, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-31-outreach-campaigns-design.md`

**Builds on:** Phase 1 (PR #702, branch `feat/campaign-audience-terms`). This branch is stacked on it, so `main` does not yet contain the `outreach` module or `AudienceScope`.

## Global Constraints

- **No em-dash (U+2014) anywhere in `src/**/*.{ts,tsx}`.** CI-enforced by the `local/no-em-dash` eslint rule, including inside comments. Use a comma, colon, parentheses, or hyphen.
- **A condition that cannot be satisfied MUST compile to `MATCH_NOBODY`, never `undefined`.** Prisma drops `undefined` from a `where`, silently matching every Person. Every new operator inherits this, and the negative/relative forms make it sharper: a malformed relative window must narrow to nobody, never widen.
- **Relative date operators MUST compile against a `now` passed in at resolve time**, never `new Date()` captured at save time and never called inside a compile function. A recurring campaign's whole point is that "expiring in the next 30 days" means something different on each run. This is also what makes the operators testable against a fixed clock.
- **A calendar date means a day in the clinic's configured display zone**, not UTC. Convert day boundaries with `parseZonedInput` from `@/platform/dates`, which is already DST-aware. Treating a date as naive UTC midnight puts "expires today" off by up to a day.
- **Precompute detection must span the campaign audience AND its scope.** `resolveAudience` already merges both trees' conditions before deciding which precomputes to run (Phase 1, `resolve.ts`). Every new precompute must key off that merged list, not `audience.conditions`.
- **Scope intersection must never be weakened.** Manual include lists are intersected with the scope, never unioned on top of it. This is the spec's second named send-all hazard.
- **Do not run the full local suite as a gate.** Run the focused files each task names, plus `npx tsc --noEmit` and `npx eslint src e2e`, then push and let GitHub Actions be the authority.

## Test database

This worktree has its own database, already created and migrated. Vitest does not load `.env`, so set it inline on every run:

```
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_depth
```

## Task map

| # | Task | Depends on |
|---|---|---|
| 1 | Date kind: `now` + zone threading, date operators | - |
| 2 | Number and count kind, count precompute seam | 1 (shared ctx change) |
| 3 | Compliance and training date fields | 1 |
| 4 | Schedule and attendance count fields | 2 |
| 5 | Recruitment outcome fields | 2 |
| 6 | Membership detail fields | 1 |
| 7 | Send-once per campaign | - |
| 8 | Manual include / exclude / paste lists | 7 |

A reviewer can reject any one without blocking its neighbours, except where the table names a dependency. Part B (the builder) begins after Task 8.

---

### Task 1: Date kind, with `now` and zone threaded through the compiler

This is the task the rest of the date work rests on. It changes a signature used by every field, so it lands before any field uses it.

**Files:**
- Modify: `src/platform/email/audience/types.ts` (add the date operators to `ConditionOp`)
- Modify: `src/platform/email/audience/operators.ts` (add `DATE_OPERATORS` and `dateWhere`)
- Create: `src/platform/email/audience/date-operators.test.ts`
- Modify: `src/platform/email/audience/person-fields.ts` (`PersonFieldKind`, `AudienceCtx`)
- Modify: `src/platform/email/audience/compile.ts` (thread ctx unchanged; no signature change needed here)
- Modify: `src/platform/email/audience/resolve.ts` (populate `now` and `zone` on the ctx)
- Modify: `src/platform/email/audience/resolve.test.ts`

**Interfaces:**
- Consumes: `AudienceCtx`, `AudienceCondition`, `MATCH_NOBODY` (all existing).
- Produces:
  - `ConditionOp` gains `"before" | "after" | "onOrBefore" | "onOrAfter" | "between" | "withinNextDays" | "withinLastDays"`.
  - `PersonFieldKind` gains `"date"`.
  - `AudienceCtx` gains `now: Date` and `zone: DisplayTimeZone` (both REQUIRED, not optional).
  - `DATE_OPERATORS: ConditionOp[]`
  - `dateWhere(column: string, cond: AudienceCondition, ctx: { now: Date; zone: string }): Prisma.PersonWhereInput`
  - `dateField(key, label, group, column, opts?): PersonFieldDef` helper in `person-fields.ts`, mirroring the existing `textField` helper.

- [ ] **Step 1: Write the failing operator tests**

Create `src/platform/email/audience/date-operators.test.ts`. These are pure and run without a database:

```ts
import { describe, expect, it } from "vitest";
import { dateWhere } from "./operators";
import type { AudienceCondition } from "./types";

// A fixed clock. 2026-03-15T18:00Z is 14:00 in New York (EDT, UTC-4), so the
// local day boundary is 04:00Z the same date. Chosen deliberately inside
// daylight saving so a naive UTC-midnight implementation fails these tests.
const NOW = new Date("2026-03-15T18:00:00.000Z");
const CTX = { now: NOW, zone: "America/New_York" };

function cond(op: AudienceCondition["op"], value?: string | string[]): AudienceCondition {
  return { field: "expiresAt", op, value };
}

describe("dateWhere", () => {
  it("compiles `before` to a lt at the local start of that day", () => {
    const w = dateWhere("expiresAt", cond("before", "2026-03-20"), CTX);
    expect(w).toEqual({ expiresAt: { lt: new Date("2026-03-20T04:00:00.000Z") } });
  });

  it("compiles `after` to a gte at the local start of the NEXT day", () => {
    // "after March 20" must exclude every instant on March 20 itself, so the
    // boundary is the start of March 21, not the start of March 20.
    const w = dateWhere("expiresAt", cond("after", "2026-03-20"), CTX);
    expect(w).toEqual({ expiresAt: { gte: new Date("2026-03-21T04:00:00.000Z") } });
  });

  it("compiles `onOrBefore` to include the whole named day", () => {
    const w = dateWhere("expiresAt", cond("onOrBefore", "2026-03-20"), CTX);
    expect(w).toEqual({ expiresAt: { lt: new Date("2026-03-21T04:00:00.000Z") } });
  });

  it("compiles `onOrAfter` to the local start of the named day", () => {
    const w = dateWhere("expiresAt", cond("onOrAfter", "2026-03-20"), CTX);
    expect(w).toEqual({ expiresAt: { gte: new Date("2026-03-20T04:00:00.000Z") } });
  });

  it("compiles `between` as a half-open range covering both endpoint days", () => {
    const w = dateWhere("expiresAt", cond("between", ["2026-03-18", "2026-03-20"]), CTX);
    expect(w).toEqual({
      expiresAt: {
        gte: new Date("2026-03-18T04:00:00.000Z"),
        lt: new Date("2026-03-21T04:00:00.000Z"),
      },
    });
  });

  it("compiles `withinNextDays` from now to the end of the Nth day ahead", () => {
    const w = dateWhere("expiresAt", cond("withinNextDays", "5"), CTX);
    expect(w).toEqual({
      expiresAt: { gte: NOW, lt: new Date("2026-03-21T04:00:00.000Z") },
    });
  });

  it("compiles `withinLastDays` from the start of the Nth day back to now", () => {
    const w = dateWhere("expiresAt", cond("withinLastDays", "5"), CTX);
    expect(w).toEqual({
      expiresAt: { gte: new Date("2026-03-10T04:00:00.000Z"), lte: NOW },
    });
  });

  it("handles isEmpty and isNotEmpty", () => {
    expect(dateWhere("expiresAt", cond("isEmpty"), CTX)).toEqual({ expiresAt: null });
    expect(dateWhere("expiresAt", cond("isNotEmpty"), CTX)).toEqual({
      expiresAt: { not: null },
    });
  });

  // The match-nobody invariant, in every shape that can go wrong.
  it.each([
    ["a blank absolute value", cond("before", "")],
    ["a malformed date", cond("before", "not-a-date")],
    ["a partial date", cond("before", "2026-03")],
    ["a between with one endpoint", cond("between", ["2026-03-18"])],
    ["a between with a malformed endpoint", cond("between", ["2026-03-18", "nope"])],
    ["a non-numeric window", cond("withinNextDays", "soon")],
    ["a negative window", cond("withinNextDays", "-5")],
    ["a fractional window", cond("withinNextDays", "1.5")],
    ["a blank window", cond("withinLastDays", "")],
  ])("matches nobody for %s", (_label, c) => {
    expect(dateWhere("expiresAt", c, CTX)).toEqual({ id: { in: [] } });
  });

  it("crosses a DST boundary correctly", () => {
    // 2026-03-08 is the US spring-forward date. A window spanning it must still
    // land on real local midnights, which differ in UTC offset on either side.
    const beforeDst = { now: new Date("2026-03-05T18:00:00.000Z"), zone: "America/New_York" };
    const w = dateWhere("expiresAt", cond("onOrAfter", "2026-03-01"), beforeDst);
    // March 1 is still EST (UTC-5), so local midnight is 05:00Z.
    expect(w).toEqual({ expiresAt: { gte: new Date("2026-03-01T05:00:00.000Z") } });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run src/platform/email/audience/date-operators.test.ts
```

Expected: FAIL, `dateWhere` is not exported from `./operators`.

- [ ] **Step 3: Add the date operators to the type union**

In `src/platform/email/audience/types.ts`, extend `ConditionOp`. Place them after the existing ordered comparisons, with a comment:

```ts
  // Ordered comparison, used by year-kind fields (see gradYear).
  | "lt"
  | "gt"
  // Date operators. `before`/`after`/`onOrBefore`/`onOrAfter`/`between` take
  // calendar dates ("YYYY-MM-DD") and resolve against the clinic's display zone.
  // `withinNextDays`/`withinLastDays` take a whole number of days and resolve
  // against `now` AT RESOLVE TIME, which is what lets a recurring campaign mean
  // something different on each run.
  | "before"
  | "after"
  | "onOrBefore"
  | "onOrAfter"
  | "between"
  | "withinNextDays"
  | "withinLastDays";
```

Also add the two window operators to the existing `VALUELESS_OPS` neighbours only if they take no value; they DO take a value, so leave `VALUELESS_OPS` unchanged.

- [ ] **Step 4: Implement `dateWhere`**

Append to `src/platform/email/audience/operators.ts`:

```ts
import { parseZonedInput } from "@/platform/dates";

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
  const start = startOfDay(day, zone);
  if (!start) return null;
  // Add 24h then re-normalise through the zone, so a DST transition inside the
  // added day does not leave the boundary an hour off.
  const approx = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(approx);
  const g = (t: string) => parts.find((p) => p.type === t)!.value;
  return parseZonedInput(`${g("year")}-${g("month")}-${g("day")}T00:00`, zone);
}

/** Shifts `now` by whole days and returns the local start of that day. */
function startOfDayOffsetFromNow(now: Date, days: number, zone: string): Date | null {
  const shifted = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(shifted);
  const g = (t: string) => parts.find((p) => p.type === t)!.value;
  return parseZonedInput(`${g("year")}-${g("month")}-${g("day")}T00:00`, zone);
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
```

- [ ] **Step 5: Run the operator tests to verify they pass**

```bash
npx vitest run src/platform/email/audience/date-operators.test.ts
```

Expected: PASS, all cases including the DST one.

- [ ] **Step 6: Add `now` and `zone` to the audience context**

In `src/platform/email/audience/person-fields.ts`, extend the kind union and the context. Both new context fields are REQUIRED, not optional, so a caller cannot forget them and silently get `undefined` inside a date comparison:

```ts
export type PersonFieldKind = "text" | "enum" | "multiEnum" | "boolean" | "year" | "date";
```

```ts
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
  // ...existing optional precompute maps unchanged
};
```

Import the type: `import type { DisplayTimeZone } from "@/platform/dates/zone";`

Add the field helper next to `textField`:

```ts
function dateField(
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
```

Import `DATE_OPERATORS` and `dateWhere` from `./operators`.

- [ ] **Step 7: Populate the context in resolveAudience**

In `src/platform/email/audience/resolve.ts`, extend the signature and the ctx. `now` is injectable so tests can pin the clock:

```ts
export async function resolveAudience(
  audience: Audience,
  opts: { scope?: Audience | null; now?: Date } = {},
): Promise<ResolvedAudience> {
  const activeTerm = await getActiveTerm();
  const now = opts.now ?? new Date();
  const zone = await getDisplayTimeZone();
```

Import `getDisplayTimeZone` from `@/platform/dates/resolve`.

Then add both to the ctx object built before `compilePersonWhere`:

```ts
  const ctx = {
    activeTermId: activeTerm?.id ?? null,
    now,
    zone,
    complianceStatusByPerson,
    clearanceByPerson,
    appliedByCycle,
  };
```

Both trees already compile against this same ctx from Phase 1; do not change that.

- [ ] **Step 8: Add a resolve-level test proving the clock is per-run**

Append to `src/platform/email/audience/resolve.test.ts`:

```ts
describe("relative date conditions re-evaluate per run", () => {
  it("matches a different set as `now` advances", async () => {
    // A certificate completed on a fixed date. Whether it falls inside
    // "the last 7 days" depends entirely on when the run happens.
    const p = await prisma.person.create({
      data: { name: "Cert Holder", contactEmail: "cert@example.com", status: "ACTIVE" },
    });
    await prisma.hipaaCertificate.create({
      data: {
        personId: p.id,
        fileName: "c.pdf",
        storedName: "c.pdf",
        size: 1,
        mimeType: "application/pdf",
        completionDate: new Date("2026-03-10T12:00:00.000Z"),
      },
    });

    const audience: Audience = {
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "hipaaCompletedAt", op: "withinLastDays", value: "7" }],
    };

    const near = await resolveAudience(audience, { now: new Date("2026-03-12T18:00:00.000Z") });
    expect(near.recipients.map((r) => r.email)).toEqual(["cert@example.com"]);

    const far = await resolveAudience(audience, { now: new Date("2026-04-30T18:00:00.000Z") });
    expect(far.recipients).toEqual([]);
  });
});
```

This test depends on the `hipaaCompletedAt` field, which Task 3 adds. Write it now but expect it to fail until Task 3 lands; mark it with `it.skip` and a comment naming Task 3, then Task 3's first step is to un-skip it. That keeps the clock-threading requirement visible in this task rather than being forgotten.

- [ ] **Step 9: Run the audience suite**

```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_depth \
  npx vitest run src/platform/email/audience/
npx tsc --noEmit
```

Expected: PASS, with the one skipped test named above. `tsc` will flag every place constructing an `AudienceCtx` without `now`/`zone`; fix each by threading the real values, never by making the fields optional.

- [ ] **Step 10: Commit**

```bash
git add src/platform/email/audience/
git commit -m "feat(outreach): add date conditions with a per-run clock and zone-aware day boundaries"
```

---

### Task 2: Number and count conditions

**Files:**
- Modify: `src/platform/email/audience/types.ts` (`lte`, `gte` operators)
- Modify: `src/platform/email/audience/operators.ts` (`NUMBER_OPERATORS`, `numberWhere`, `countWhere`)
- Create: `src/platform/email/audience/number-operators.test.ts`
- Modify: `src/platform/email/audience/person-fields.ts` (`PersonFieldKind`, `countField` helper, `AudienceCtx.countsByField`)
- Modify: `src/platform/email/audience/resolve.ts` (count precompute dispatch)

**Interfaces:**
- Consumes: Task 1's `AudienceCtx` shape.
- Produces:
  - `ConditionOp` gains `"lte" | "gte"`.
  - `PersonFieldKind` gains `"count"`.
  - `NUMBER_OPERATORS: ConditionOp[]` = `["eq", "notEq", "lt", "lte", "gt", "gte", "between"]`
  - `countWhere(counts: Map<string, number>, cond: AudienceCondition): Prisma.PersonWhereInput`
  - `AudienceCtx` gains `countsByField?: Map<string, Map<string, number>>` (field key to person id to count).
  - `type CountLoader = (ctx: { activeTermId: string | null }) => Promise<Map<string, number>>` registered per field. Lives in `types.ts`, not `person-fields.ts`, so `count-loaders.ts` and `person-fields.ts` do not import from each other.

- [ ] **Step 1: Write the failing tests**

Create `src/platform/email/audience/number-operators.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { countWhere } from "./operators";
import type { AudienceCondition } from "./types";

const COUNTS = new Map<string, number>([
  ["p-zero", 0],
  ["p-one", 1],
  ["p-three", 3],
  ["p-ten", 10],
]);

function cond(op: AudienceCondition["op"], value?: string | string[]): AudienceCondition {
  return { field: "shiftCount", op, value };
}

/** countWhere returns { id: { in: [...] } }; compare as a sorted set. */
function ids(w: ReturnType<typeof countWhere>): string[] {
  const inList = (w as { id?: { in?: string[] } }).id?.in ?? [];
  return [...inList].sort();
}

describe("countWhere", () => {
  it("eq selects exactly that count", () => {
    expect(ids(countWhere(COUNTS, cond("eq", "3")))).toEqual(["p-three"]);
  });

  it("notEq selects everyone else IN THE MAP, including zero", () => {
    // The map is the universe here: a person with no rows must still appear
    // with a count of 0, or "fewer than 3 shifts" would silently exclude
    // everyone who has never signed up, which is the opposite of the intent.
    expect(ids(countWhere(COUNTS, cond("notEq", "3")))).toEqual(["p-one", "p-ten", "p-zero"]);
  });

  it("lt, lte, gt, gte compare numerically", () => {
    expect(ids(countWhere(COUNTS, cond("lt", "3")))).toEqual(["p-one", "p-zero"]);
    expect(ids(countWhere(COUNTS, cond("lte", "3")))).toEqual(["p-one", "p-three", "p-zero"]);
    expect(ids(countWhere(COUNTS, cond("gt", "3")))).toEqual(["p-ten"]);
    expect(ids(countWhere(COUNTS, cond("gte", "3")))).toEqual(["p-ten", "p-three"]);
  });

  it("between is inclusive on both ends", () => {
    expect(ids(countWhere(COUNTS, cond("between", ["1", "3"])))).toEqual(["p-one", "p-three"]);
  });

  it.each([
    ["a blank value", cond("eq", "")],
    ["a non-numeric value", cond("eq", "three")],
    ["a negative value", cond("gte", "-1")],
    ["a fractional value", cond("eq", "1.5")],
    ["a between with one endpoint", cond("between", ["1"])],
    ["a between with a bad endpoint", cond("between", ["1", "x"])],
    ["an inverted between", cond("between", ["5", "2"])],
  ])("matches nobody for %s", (_label, c) => {
    expect(countWhere(COUNTS, c)).toEqual({ id: { in: [] } });
  });

  it("matches nobody when the map is empty", () => {
    expect(countWhere(new Map(), cond("gte", "1"))).toEqual({ id: { in: [] } });
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run src/platform/email/audience/number-operators.test.ts
```

Expected: FAIL, `countWhere` is not exported.

- [ ] **Step 3: Add the operators and `countWhere`**

In `types.ts`, add `| "lte" | "gte"` beside the existing `lt`/`gt`.

In `operators.ts`:

```ts
export const NUMBER_OPERATORS: ConditionOp[] = [
  "eq",
  "notEq",
  "lt",
  "lte",
  "gt",
  "gte",
  "between",
];

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
```

- [ ] **Step 4: Add the count field kind and its loader registry**

In `person-fields.ts`:

```ts
export type PersonFieldKind = "text" | "enum" | "multiEnum" | "boolean" | "year" | "date" | "count";
```

Extend `AudienceCtx`:

```ts
  /**
   * Per-person counts for each count-kind field actually named in the audience,
   * keyed by field key then person id. Populated by resolveAudience only for
   * fields the audience uses, since each loader is a table scan.
   */
  countsByField?: Map<string, Map<string, number>>;
```

Add the helper and the loader registry:

```ts
/**
 * Loads a count per person for a count-kind field. Every loader MUST return an
 * entry for every ACTIVE-status person, defaulting to 0, so that "fewer than N"
 * includes people with no rows at all. See countWhere.
 */
export type CountLoader = (ctx: { activeTermId: string | null }) => Promise<Map<string, number>>;

export const COUNT_LOADERS: Record<string, CountLoader> = {};

function countField(
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
      // A missing map means resolveAudience did not run this field's loader,
      // which is a wiring bug rather than an empty result. Fail closed and loudly.
      if (!counts) return MATCH_NOBODY;
      return countWhere(counts, cond);
    },
  };
}
```

Export `countField` so the field tasks can use it.

- [ ] **Step 5: Dispatch the loaders in resolveAudience**

In `resolve.ts`, after the existing precomputes and BEFORE building `ctx`:

```ts
  // Count fields each cost a scan, so run only the loaders the audience (or its
  // scope) actually names. `conditions` already spans both trees.
  const countFieldKeys = [
    ...new Set(conditions.map((c) => c.field).filter((f) => f in COUNT_LOADERS)),
  ];
  const countsByField = new Map<string, Map<string, number>>();
  for (const key of countFieldKeys) {
    countsByField.set(key, await COUNT_LOADERS[key]({ activeTermId: activeTerm?.id ?? null }));
  }
```

Add `countsByField` to the ctx object. Import `COUNT_LOADERS` from `./person-fields`.

- [ ] **Step 6: Verify**

```bash
npx vitest run src/platform/email/audience/number-operators.test.ts
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_depth \
  npx vitest run src/platform/email/audience/
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/platform/email/audience/
git commit -m "feat(outreach): add count conditions over a per-field precompute seam"
```

---

### Task 3: Compliance and training date fields

**Files:**
- Modify: `src/platform/email/audience/person-fields.ts`
- Modify: `src/platform/email/audience/resolve.test.ts` (un-skip Task 1's clock test)
- Create: `src/platform/email/audience/date-fields.test.ts`

**Interfaces:**
- Consumes: `dateField` from Task 1.
- Produces: five new field keys, listed below.

These are relation-shaped, not plain Person columns, so they cannot use Task 1's plain `dateField` helper directly. Each compiles to a `some` filter over the relation with the date predicate inside it.

| Field key | Label | Group | Source | Predicate shape |
|---|---|---|---|---|
| `hipaaCompletedAt` | HIPAA certificate completion date | Compliance | `HipaaCertificate.completionDate` | `{ hipaaCertificates: { some: { completionDate: <datePredicate> } } }` |
| `hipaaVerifiedAt` | HIPAA certificate verified date | Compliance | `HipaaCertificate.verifiedAt` | `{ hipaaCertificates: { some: { verifiedAt: <datePredicate> } } }` |
| `ehsCompletedAt` | EHS training completion date | Compliance | `EhsCompletion.completedAt` | `{ ehsCompletions: { some: { completedAt: <datePredicate> } } }` |
| `trainingCompletedAt` | Volunteer training completion date | Training | `Training.completedAt` | `{ trainings: { some: { completedAt: <datePredicate> } } }` |
| `joinedAt` | Joined the roster | Identity | `Person.createdAt` | plain column, use `dateField` |

- [ ] **Step 1: Un-skip Task 1's clock test**

In `resolve.test.ts`, change the `it.skip` added by Task 1 back to `it` and drop the comment naming this task. Run it and confirm it FAILS with an unknown field, proving it is wired to the real field rather than passing vacuously:

```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_depth \
  npx vitest run src/platform/email/audience/resolve.test.ts
```

Expected: FAIL on the unknown `hipaaCompletedAt` field.

- [ ] **Step 2: Write the failing field tests**

Create `src/platform/email/audience/date-fields.test.ts`. Verify the exact relation name on `Person` for each source model before writing (`grep -n "hipaaCertificates\|ehsCompletions\|trainings" prisma/schema.prisma`) and use the real names:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { resolveAudience } from "./resolve";
import type { Audience } from "./types";

beforeEach(resetDb);

const NOW = new Date("2026-03-15T18:00:00.000Z");

function audienceFor(field: string, op: string, value: string | string[]): Audience {
  return {
    recordType: "PERSON",
    match: "ALL",
    conditions: [{ field, op: op as never, value }],
  };
}

async function personWithCert(name: string, email: string, completionDate: Date | null) {
  const p = await prisma.person.create({
    data: { name, contactEmail: email, status: "ACTIVE" },
  });
  await prisma.hipaaCertificate.create({
    data: {
      personId: p.id,
      fileName: "c.pdf",
      storedName: "c.pdf",
      size: 1,
      mimeType: "application/pdf",
      completionDate,
    },
  });
  return p;
}

describe("compliance and training date fields", () => {
  it("finds certificates completed within a relative window", async () => {
    await personWithCert("Recent", "recent@x.com", new Date("2026-03-12T12:00:00.000Z"));
    await personWithCert("Old", "old@x.com", new Date("2025-01-01T12:00:00.000Z"));

    const { recipients } = await resolveAudience(
      audienceFor("hipaaCompletedAt", "withinLastDays", "7"),
      { now: NOW },
    );
    expect(recipients.map((r) => r.email)).toEqual(["recent@x.com"]);
  });

  it("finds certificates before an absolute date", async () => {
    await personWithCert("Recent", "recent@x.com", new Date("2026-03-12T12:00:00.000Z"));
    await personWithCert("Old", "old@x.com", new Date("2025-01-01T12:00:00.000Z"));

    const { recipients } = await resolveAudience(
      audienceFor("hipaaCompletedAt", "before", "2026-01-01"),
      { now: NOW },
    );
    expect(recipients.map((r) => r.email)).toEqual(["old@x.com"]);
  });

  it("excludes a person whose certificate has a null date under isNotEmpty", async () => {
    await personWithCert("Dated", "dated@x.com", new Date("2026-03-12T12:00:00.000Z"));
    await personWithCert("Undated", "undated@x.com", null);

    const { recipients } = await resolveAudience(
      audienceFor("hipaaCompletedAt", "isNotEmpty", ""),
      { now: NOW },
    );
    expect(recipients.map((r) => r.email)).toEqual(["dated@x.com"]);
  });

  it("matches on joinedAt, a plain Person column", async () => {
    const old = await prisma.person.create({
      data: { name: "Founder", contactEmail: "founder@x.com", status: "ACTIVE" },
    });
    await prisma.person.update({
      where: { id: old.id },
      data: { createdAt: new Date("2024-01-01T12:00:00.000Z") },
    });
    await prisma.person.create({
      data: { name: "New", contactEmail: "new@x.com", status: "ACTIVE" },
    });

    const { recipients } = await resolveAudience(
      audienceFor("joinedAt", "before", "2025-01-01"),
      { now: NOW },
    );
    expect(recipients.map((r) => r.email)).toEqual(["founder@x.com"]);
  });
});
```

- [ ] **Step 3: Run to verify failure**

```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_depth \
  npx vitest run src/platform/email/audience/date-fields.test.ts
```

Expected: FAIL, unknown fields.

- [ ] **Step 4: Add a relation-date helper and the five fields**

In `person-fields.ts`, add beside `dateField`:

```ts
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
```

Then append to `PERSON_FIELDS`:

```ts
  relationDateField("hipaaCompletedAt", "HIPAA certificate completion date", "Compliance", "hipaaCertificates", "completionDate"),
  relationDateField("hipaaVerifiedAt", "HIPAA certificate verified date", "Compliance", "hipaaCertificates", "verifiedAt"),
  relationDateField("ehsCompletedAt", "EHS training completion date", "Compliance", "ehsCompletions", "completedAt"),
  relationDateField("trainingCompletedAt", "Volunteer training completion date", "Training", "trainings", "completedAt"),
  dateField("joinedAt", "Joined the roster", "Identity", "createdAt"),
```

Confirm each relation name against `model Person` in `prisma/schema.prisma` before writing; the names above are the expected ones but the schema is authoritative.

- [ ] **Step 5: Verify**

```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_depth \
  npx vitest run src/platform/email/audience/
npx tsc --noEmit && npx eslint src
```

Expected: PASS, including Task 1's previously-skipped clock test.

- [ ] **Step 6: Commit**

```bash
git add src/platform/email/audience/
git commit -m "feat(outreach): add compliance and training date audience fields"
```

---
### Task 4: Schedule and attendance count fields

**Files:**
- Create: `src/platform/email/audience/count-loaders.ts`
- Create: `src/platform/email/audience/count-fields.test.ts`
- Modify: `src/platform/email/audience/person-fields.ts`

**Interfaces:**
- Consumes: `countField` and `CountLoader` from Task 2.
- Produces four field keys, each with a loader in `count-loaders.ts`:

| Field key | Label | Group | Counts |
|---|---|---|---|
| `shiftCountThisTerm` | Shifts assigned this term | Schedule | `ShiftAssignment` rows for the active term |
| `attendanceCountThisTerm` | Clinic days attended this term | Schedule | `ClinicAttendance` rows for the active term |
| `noShowCountThisTerm` | Assigned shifts not attended | Schedule | assigned `clinicDate`s with no attendance row on that date |
| `upcomingShiftCount` | Upcoming assigned shifts | Schedule | active-term `ShiftAssignment` rows with `clinicDate` at or after today |

**The zero-count rule is the whole point of this task.** Every loader must return an entry for each ACTIVE person, defaulting to 0. A map built only from grouped rows would make "fewer than 3 shifts" silently mean "has 1 or 2 shifts", excluding everyone who signed up for none, who are exactly the people such a campaign is about.

- [ ] **Step 1: Write the failing tests**

Create `src/platform/email/audience/count-fields.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { resolveAudience } from "./resolve";
import type { Audience } from "./types";

beforeEach(resetDb);

function audienceFor(field: string, op: string, value: string | string[]): Audience {
  return { recordType: "PERSON", match: "ALL", conditions: [{ field, op: op as never, value }] };
}

/**
 * An active term, a department, and three people with two, one, and zero
 * shifts. Read prisma/schema.prisma for the required Term / Department /
 * ShiftAssignment fields before writing; the shapes below are expected, and the
 * schema is authoritative.
 */
async function rosterWithShifts() {
  const term = await prisma.term.create({
    data: {
      code: "SP26", name: "Spring 2026", status: "ACTIVE",
      startDate: new Date("2026-01-01"), endDate: new Date("2026-06-01"),
    },
  });
  const dept = await prisma.department.create({ data: { code: "TST", name: "Test" } });

  const make = async (name: string, email: string, shifts: number) => {
    const p = await prisma.person.create({
      data: { name, contactEmail: email, status: "ACTIVE" },
    });
    await prisma.termMembership.create({
      data: { personId: p.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" },
    });
    for (let i = 0; i < shifts; i++) {
      await prisma.shiftAssignment.create({
        data: {
          termId: term.id, departmentId: dept.id, personId: p.id,
          clinicDate: new Date(Date.UTC(2026, 2, 7 + i, 12, 0, 0)),
          role: "VOLUNTEER",
        },
      });
    }
    return p;
  };

  await make("Two", "two@x.com", 2);
  await make("One", "one@x.com", 1);
  await make("Zero", "zero@x.com", 0);
  return term;
}

describe("schedule count fields", () => {
  it("counts assigned shifts", async () => {
    await rosterWithShifts();
    const { recipients } = await resolveAudience(audienceFor("shiftCountThisTerm", "gte", "2"));
    expect(recipients.map((r) => r.email)).toEqual(["two@x.com"]);
  });

  // The regression this task exists to prevent.
  it("includes people with ZERO shifts under a `less than` comparison", async () => {
    await rosterWithShifts();
    const { recipients } = await resolveAudience(audienceFor("shiftCountThisTerm", "lt", "1"));
    expect(recipients.map((r) => r.email)).toEqual(["zero@x.com"]);
  });

  it("treats a between range inclusively", async () => {
    await rosterWithShifts();
    const { recipients } = await resolveAudience(
      audienceFor("shiftCountThisTerm", "between", ["1", "2"]),
    );
    expect(recipients.map((r) => r.email).sort()).toEqual(["one@x.com", "two@x.com"]);
  });

  it("counts no-shows as assigned dates with no attendance row", async () => {
    const term = await rosterWithShifts();
    const two = await prisma.person.findFirstOrThrow({ where: { contactEmail: "two@x.com" } });
    await prisma.clinicAttendance.create({
      data: {
        termId: term.id, personId: two.id,
        clinicDate: new Date(Date.UTC(2026, 2, 7, 12, 0, 0)),
        method: "STAFF",
      },
    });

    const { recipients } = await resolveAudience(audienceFor("noShowCountThisTerm", "gte", "1"));
    expect(recipients.map((r) => r.email)).toEqual(["two@x.com"]);
  });

  it("matches nobody when there is no active term", async () => {
    await prisma.person.create({
      data: { name: "Orphan", contactEmail: "orphan@x.com", status: "ACTIVE" },
    });
    const { recipients } = await resolveAudience(audienceFor("shiftCountThisTerm", "gte", "0"));
    expect(recipients).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_depth \
  npx vitest run src/platform/email/audience/count-fields.test.ts
```

Expected: FAIL, unknown fields.

- [ ] **Step 3: Write the loaders**

Create `src/platform/email/audience/count-loaders.ts`:

```ts
/**
 * Per-person count loaders for count-kind audience fields.
 *
 * Every loader obeys one rule that is easy to get wrong and expensive when
 * missed: the returned map contains an entry for EVERY candidate person,
 * defaulting to zero, not only for people who have rows. Without that, a
 * "fewer than N" comparison silently excludes everyone with none, which is
 * usually the exact cohort the campaign is trying to reach.
 *
 * Each loader is a table scan, so resolveAudience runs only the ones an
 * audience actually names.
 */
import { prisma } from "@/platform/db";
import type { CountLoader } from "./person-fields";

/** Every ACTIVE person, seeded to zero. The universe each loader fills in. */
async function zeroedByPerson(): Promise<Map<string, number>> {
  const people = await prisma.person.findMany({
    where: { status: "ACTIVE" },
    select: { id: true },
  });
  return new Map(people.map((p) => [p.id, 0]));
}

/**
 * With no active term, a "this term" count is unanswerable. Return an EMPTY map
 * rather than a zeroed one: an empty map makes countWhere match nobody, while a
 * zeroed map would make "fewer than 3 shifts" match the entire roster.
 */
function noTerm(activeTermId: string | null): boolean {
  return activeTermId === null;
}

export const shiftCountThisTerm: CountLoader = async ({ activeTermId }) => {
  if (noTerm(activeTermId)) return new Map();
  const counts = await zeroedByPerson();
  const rows = await prisma.shiftAssignment.groupBy({
    by: ["personId"],
    where: { termId: activeTermId! },
    _count: { _all: true },
  });
  for (const r of rows) if (counts.has(r.personId)) counts.set(r.personId, r._count._all);
  return counts;
};

export const attendanceCountThisTerm: CountLoader = async ({ activeTermId }) => {
  if (noTerm(activeTermId)) return new Map();
  const counts = await zeroedByPerson();
  const rows = await prisma.clinicAttendance.groupBy({
    by: ["personId"],
    where: { termId: activeTermId! },
    _count: { _all: true },
  });
  for (const r of rows) if (counts.has(r.personId)) counts.set(r.personId, r._count._all);
  return counts;
};

/**
 * Assigned clinic dates with no attendance row on the SAME date.
 *
 * Compared by UTC day key rather than raw timestamp, because both
 * ShiftAssignment.clinicDate and ClinicAttendance.clinicDate are noon-UTC
 * anchored calendar dates (see their schema comments). ClinicAttendance
 * .checkedInAt is a true instant and is deliberately not used here.
 */
export const noShowCountThisTerm: CountLoader = async ({ activeTermId }) => {
  if (noTerm(activeTermId)) return new Map();
  const counts = await zeroedByPerson();

  const [assigned, attended] = await Promise.all([
    prisma.shiftAssignment.findMany({
      where: { termId: activeTermId! },
      select: { personId: true, clinicDate: true },
    }),
    prisma.clinicAttendance.findMany({
      where: { termId: activeTermId! },
      select: { personId: true, clinicDate: true },
    }),
  ]);

  const dayKey = (d: Date) => d.toISOString().slice(0, 10);
  const attendedKeys = new Set(attended.map((a) => `${a.personId}:${dayKey(a.clinicDate)}`));

  for (const a of assigned) {
    if (!counts.has(a.personId)) continue;
    if (attendedKeys.has(`${a.personId}:${dayKey(a.clinicDate)}`)) continue;
    counts.set(a.personId, (counts.get(a.personId) ?? 0) + 1);
  }
  return counts;
};

export const upcomingShiftCount: CountLoader = async ({ activeTermId }) => {
  if (noTerm(activeTermId)) return new Map();
  const counts = await zeroedByPerson();
  // Clinic dates are noon-UTC anchored, so "today or later" is the start of
  // today's UTC day; a noon anchor on today sorts after it.
  const startOfToday = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z");
  const rows = await prisma.shiftAssignment.groupBy({
    by: ["personId"],
    where: { termId: activeTermId!, clinicDate: { gte: startOfToday } },
    _count: { _all: true },
  });
  for (const r of rows) if (counts.has(r.personId)) counts.set(r.personId, r._count._all);
  return counts;
};
```

- [ ] **Step 4: Register the four fields**

In `person-fields.ts`, import the loaders and append to `PERSON_FIELDS`:

```ts
  countField("shiftCountThisTerm", "Shifts assigned this term", "Schedule", shiftCountThisTerm),
  countField("attendanceCountThisTerm", "Clinic days attended this term", "Schedule", attendanceCountThisTerm),
  countField("noShowCountThisTerm", "Assigned shifts not attended", "Schedule", noShowCountThisTerm),
  countField("upcomingShiftCount", "Upcoming assigned shifts", "Schedule", upcomingShiftCount),
```

- [ ] **Step 5: Verify**

```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_depth \
  npx vitest run src/platform/email/audience/
npx tsc --noEmit && npx eslint src
```

- [ ] **Step 6: Commit**

```bash
git add src/platform/email/audience/
git commit -m "feat(outreach): add schedule and attendance count audience fields"
```

---

### Task 5: Recruitment outcome and subcommittee fields

**Files:**
- Modify: `src/platform/email/audience/resolve.ts`
- Modify: `src/platform/email/audience/person-fields.ts`
- Modify: `src/platform/email/audience/builder-options.ts` and `references.ts`
- Create: `src/platform/email/audience/recruitment-fields.test.ts`

**The structural problem this task must solve.** An `Application` reaches a `Person` only through `Applicant.applicantPersonId`, which is set solely for signed-in renewals. Everyone who applied anonymously has a null link. Phase 1's `loadAppliedByCycle` already works around this by matching unlinked applicants back to a Person by lowercased email and by NetID, and its doc comment explains why: matching only the link would UNDER-match, which on an "exclude people who already applied" condition means re-nagging exactly the people who did the thing you asked.

Every field here inherits that problem and **must reuse the same resolution rather than adding a second, weaker one.**

Subcommittee is in this task, not with the other membership fields, for the same reason: `Subcommittee` has NO Person relation. Its only link is `Application.assignedSubcommitteeId`, so "which subcommittee is this person on" is a recruitment question wearing a membership disguise.

- [ ] **Step 1: Generalise the applicant precompute**

Refactor `loadAppliedByCycle` in `resolve.ts` into one pass that resolves applications to person ids ONCE and buckets them several ways. Keep the existing email/NetID fallback exactly as it is; only the bucketing is new.

```ts
type ApplicantFacts = {
  /** Person ids with any application, keyed by cycle id. */
  appliedByCycle: Map<string, Set<string>>;
  /** Person ids whose application in that cycle has at least one Acceptance. */
  acceptedByCycle: Map<string, Set<string>>;
  /** Person ids assigned to each subcommittee, keyed by subcommittee id. */
  bySubcommittee: Map<string, Set<string>>;
};
```

Read `model Application` and `model Acceptance` before writing the accepted branch: acceptance is a separate `Acceptance` row joined to `Application`, not a status column, so "accepted" means the application has at least one `Acceptance`.

- [ ] **Step 2: Write the failing tests**

Create `src/platform/email/audience/recruitment-fields.test.ts` covering, as real assertions:

- a person who applied while signed in (linked via `applicantPersonId`) matches `acceptedInCycle` once an `Acceptance` exists;
- **a person who applied anonymously, linked only by lowercased email, also matches.** This is the case the link alone misses, and the reason the fallback exists;
- a person with an application but no `Acceptance` does NOT match `acceptedInCycle`;
- `subcommittee` matches via the assigned application, including the anonymous-email case;
- a condition naming a deleted cycle or subcommittee id matches nobody rather than throwing.

Model the fixtures on the existing applicant fixtures in `resolve.test.ts`, which already build an `Applicant` with `emailLower` set.

- [ ] **Step 3: Run to verify failure, then add the fields**

| Field key | Label | Group | Kind | Resolution |
|---|---|---|---|---|
| `acceptedInCycle` | Accepted in recruitment cycle | Recruitment | multiEnum | `acceptedByCycle` id sets |
| `subcommittee` | Assigned subcommittee | Recruitment | multiEnum | `bySubcommittee` id sets |

Each compiles the way `appliedToCycle` already does: union the id sets for the selected values, then `{ id: { in: [...] } }`, and `MATCH_NOBODY` when the selection is empty. Follow that field's implementation rather than inventing a parallel shape.

The builder needs subcommittee options: extend `loadAudienceBuilderOptions` with a `subcommittees` list, giving it the same deleted-reference union treatment departments, terms, and cycles already get, and add `subcommitteeIds` to `collectAudienceReferences`.

- [ ] **Step 4: Verify and commit**

```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_depth \
  npx vitest run src/platform/email/audience/
npx tsc --noEmit && npx eslint src
git add src/platform/email/audience/
git commit -m "feat(outreach): add recruitment outcome and subcommittee audience fields"
```

---

### Task 6: Membership detail fields

**Files:**
- Modify: `src/platform/email/audience/person-fields.ts`
- Create: `src/platform/email/audience/membership-fields.test.ts`

Four plain relation predicates over Person. No precompute.

| Field key | Label | Group | Kind | Predicate |
|---|---|---|---|---|
| `membershipKind` | Membership kind | Roster | enum (`DIRECTOR`, `VOLUNTEER`) | `{ memberships: { some: { ...termScope, status: "ACTIVE", kind } } }` |
| `speaksLanguage` | Speaks a language (verified) | Identity | multiEnum over `LANGUAGE_CODES` | `{ languages: { some: { language, verified: true, verifiedAt: { not: null } } } }` |
| `claimsLanguage` | Claims a language (self-reported) | Identity | multiEnum over `LANGUAGE_CODES` | `{ languages: { some: { language, selfReported: true } } }` |
| `hasServiceCredential` | Has a service credential | Volunteers | boolean | `{ serviceCredential: { isNot: null } }` |

Two things to get right, both already established in this file:

- **`membershipKind` is term-scoped.** Set `termScoped: true` and use the existing `termScope(cond, ctx)` helper so the kind and the term collapse into ONE `memberships.some` clause. Two separate `some` clauses could be satisfied by two different membership rows, matching a director's past stint against this term's volunteer row.
- **`speaksLanguage` means verified, not claimed.** `PersonLanguage.verified` is meaningless until `verifiedAt` is set; the schema comment says to read the two together, never `verified` alone. The existing Spanish fields already model this. Follow them.

- [ ] **Step 1: Write failing tests** covering: a verified speaker matches `speaksLanguage`; a person assessed and FAILED (`verified: false`, `verifiedAt` set) does not match; a self-reported-only person does not match `speaksLanguage` but does match `claimsLanguage`; `membershipKind` scoped to a past term matches that term's row and not the active one.

- [ ] **Step 2: Run to verify failure, add the fields, verify, commit**

```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_depth \
  npx vitest run src/platform/email/audience/
npx tsc --noEmit && npx eslint src
git add src/platform/email/audience/
git commit -m "feat(outreach): add membership, language, and credential audience fields"
```

---

### Task 7: Send-once per campaign

Recurring campaigns currently re-mail everyone who still matches, every run. `@@unique([campaignRunId, toEmail])` dedups within a run, never across runs.

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260902120000_campaign_send_once/migration.sql`
- Modify: `src/platform/email/campaigns/service.ts` and its test
- Modify: `src/app/(app)/outreach/campaigns/[id]/page.tsx`

**Interfaces:** `EmailCampaign.sendOncePerPerson Boolean @default(false)`; `resolveCampaignAudience` gains exclusion of already-mailed people.

- [ ] **Step 1: Write the failing tests**

Two cases. The second is what proves the flag is actually consulted rather than the behavior being unconditional:

```ts
  it("mails each person once across runs when sendOncePerPerson is set", async () => {
    // Seed one ACTIVE person, create a campaign with sendOncePerPerson true,
    // execute two runs, assert exactly ONE EmailLog row for that address.
  });

  it("mails again on the next run when the flag is off", async () => {
    // Identical, flag left false, assert TWO EmailLog rows.
  });
```

Read `executeRun`'s real signature in `service.ts` before writing these; it takes a claim predicate whose shape the source is authoritative on.

- [ ] **Step 2: Add the column and migration**

```prisma
  /// When set, a person who already received any run of this campaign is
  /// skipped on later runs, so a recurring campaign catches only newly-matching
  /// people. Left false, every run mails everyone who matches, which is correct
  /// for a digest.
  sendOncePerPerson Boolean @default(false)
```

```sql
ALTER TABLE "EmailCampaign" ADD COLUMN "sendOncePerPerson" BOOLEAN NOT NULL DEFAULT false;

-- Supports the already-mailed lookup: EmailLog rows for this campaign's runs,
-- projected to personId. campaignRunId already leads the (campaignRunId,
-- toEmail) unique, but that index cannot serve a personId projection, and this
-- lookup runs once per recurring dispatch.
CREATE INDEX "EmailLog_campaignRunId_personId_idx" ON "EmailLog"("campaignRunId", "personId");
```

Apply to the dev database and this worktree's test database, then `npx prisma generate`.

- [ ] **Step 3: Exclude already-mailed people**

In `resolveCampaignAudience`, after resolving and before returning:

```ts
  if (!campaign.sendOncePerPerson) return resolved;

  // Everyone who already received any run of this campaign. Matched on
  // personId, not email, so a person whose address changed between runs is
  // still recognised as already-mailed.
  const priorRuns = await prisma.emailCampaignRun.findMany({
    where: { campaignId: campaign.id },
    select: { id: true },
  });
  if (priorRuns.length === 0) return resolved;

  const mailed = await prisma.emailLog.findMany({
    where: { campaignRunId: { in: priorRuns.map((r) => r.id) }, personId: { not: null } },
    select: { personId: true },
    distinct: ["personId"],
  });
  const already = new Set(mailed.map((m) => m.personId!));
  return {
    recipients: resolved.recipients.filter((r) => !already.has(r.recordId)),
    excludedNoEmail: resolved.excludedNoEmail,
  };
```

Widen `resolveCampaignAudience`'s parameter type to include `id` and `sendOncePerPerson`.

- [ ] **Step 4: Add the toggle to the editor**

A checkbox in the Timing section of the campaign editor, persisted through the existing save action, labelled "Send to each person only once" with helper text "Later runs skip anyone who already received this campaign. Leave off for a recurring digest."

- [ ] **Step 5: Verify and commit**

```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_depth \
  npx vitest run src/platform/email/
npx tsc --noEmit && npx eslint src
git add -A
git commit -m "feat(outreach): add per-campaign send-once semantics"
```

---

### Task 8: Manual include, exclude, and pasted lists

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260902130000_campaign_manual_lists/migration.sql`
- Modify: `src/platform/email/campaigns/service.ts` and its test

**Resolution order, a security requirement rather than a preference:**

```
(matched union include union pasted) intersect scope minus exclude
```

The intersection with scope applies to the manual additions too. This is the spec's second named send-all hazard: if include were unioned on top of the scope rather than intersected inside it, "add anyone by email" would defeat delegation entirely. Exclusion always wins and is applied last.

- [ ] **Step 1: Write the failing tests**

The load-bearing cases, written as real assertions against `resolveCampaignAudience` WITH a scope, following the Phase 1 scope tests for fixture shape:

- a manual include naming a person OUTSIDE the campaign's scope does not reach them;
- the same via `pastedEmails`;
- exclude removes someone the conditions matched;
- exclude overrides an explicit include of the same person;
- a pasted address matching no person is ignored without crashing or producing a phantom recipient.

- [ ] **Step 2: Add the columns**

```prisma
  /// People always considered for this campaign regardless of the conditions.
  /// Still intersected with the campaign's scope: an include is an addition
  /// WITHIN the boundary, never a way around it.
  includePersonIds String[] @default([])
  /// People never mailed by this campaign. Applied last, so exclusion beats
  /// both the conditions and an explicit include.
  excludePersonIds String[] @default([])
  /// Raw addresses pasted by the sender, resolved to people at send time and
  /// then subject to exactly the same scope intersection as includePersonIds.
  pastedEmails     String[] @default([])
```

Three `ADD COLUMN ... TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]` statements. Write this SQL by hand: `prisma migrate dev` has a known drift-folding hazard in this repo, and `String[]` defaults are one of the shapes it gets wrong.

- [ ] **Step 3: Implement the resolution order**

Resolve `pastedEmails` case-insensitively against `Person.contactEmail` the way `loadAppliedByCycle` already does (Prisma ignores `mode: "insensitive"` on `in` for Postgres, so lowercase both sides in memory rather than pushing it into the query). Union with `includePersonIds`, re-run the scope predicate over that union, then remove `excludePersonIds`.

Carry a comment at the intersection point saying why it is there:

```ts
  // Manual additions go through the SAME scope filter the conditions went
  // through. Skipping that would let a pasted address reach anyone in the
  // database, which is the thing scopes exist to prevent.
```

- [ ] **Step 4: Verify and commit**

```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_depth \
  npx vitest run src/platform/email/
npx tsc --noEmit && npx eslint src
git add -A
git commit -m "feat(outreach): add manual include, exclude, and pasted recipient lists"
```

---

## Self-review notes

**Spec coverage.** Date kind (Task 1), number and count kind (Task 2), the four confirmed field domains (Tasks 3-6), send-once (Task 7), manual lists (Task 8). The builder rewrite is Part B.

**Where the risk concentrates.** Task 1 changes a signature every field uses, and is the only task where a wrong answer is silently plausible: an off-by-one-day boundary looks fine until a certificate expires on the wrong side of it. Task 4's zero-count rule and Task 8's scope intersection are the two places where the natural-looking implementation is a correctness or security bug.

**A note on Task 5's placement.** Subcommittee reads like a membership attribute and was originally grouped with Task 6. It is in Task 5 because `Subcommittee` has no Person relation at all: it hangs off `Application.assignedSubcommitteeId`, so it inherits the anonymous-applicant linking problem and must reuse that precompute.

**Deliberately deferred.** Support ticket counts, info-session attendance, and passport-beyond-credential were in the spec's original "roughly 25 fields" estimate and are dropped for want of a confirmed use case.
