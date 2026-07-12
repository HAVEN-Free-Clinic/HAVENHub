# Eastern Time Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display every real timestamp across HAVEN Hub in a single admin-configurable time zone (default Eastern, DST-correct label), interpret the three `datetime-local` admin inputs in that zone, and leave calendar-day markers stable.

**Architecture:** A new `src/platform/dates/` folder splits date handling into zone-aware **display** (instants) and UTC **logic/calendar** paths. A React-`cache()` resolver reads a `display.timeZone` operational setting once per request. Server pages render instants through async `<DateTime>`/`<DateOnly>`/`<TimeOnly>` components and calendar days through a sync UTC `<CalendarDate>`; two client components read the zone from a `TimeZoneProvider`. Non-JSX contexts (emails, PDFs) call pure `format.ts` functions with a resolved zone.

**Tech Stack:** Next.js 16 App Router (React Server Components), TypeScript (strict), Prisma, Zod, Vitest, Playwright. Formatting uses native `Intl.DateTimeFormat` only — **no new dependency**.

## Global Constraints

- **No new npm dependencies.** All formatting/parsing uses native `Date` + `Intl`.
- **No em-dashes** anywhere (code, comments, copy). ESLint rule enforces this. Use commas, colons, or parentheses.
- **`react-hooks/purity`**: never call `Date.now()` in render. `new Date()` is the allowed form and is fine in a client render.
- **CI runs lint BEFORE tests**, and a lint failure hides test results. Keep every commit lint-clean.
- **Calendar-day markers always format in UTC** (`<CalendarDate>` / `formatCalendarDate`). Some markers (`occurredAt`) are midnight-UTC anchored, so UTC is required to avoid a previous-day shift. **Only real instants** format in the configured zone.
- **Never touch `isoDateKey` semantics or availability day math** — they stay UTC. `isoDateKey` is re-exported from `src/modules/schedule/engine/map.ts`; leave both surfaces intact.
- **Keep shared constants (`US_TIME_ZONES`, `US_TIME_ZONE_IDS`) out of any `"use client"` module** (the "use client plain-data proxy" hazard: arrays exported from a client module become proxies and `.includes()` throws at runtime). `zone.ts` and `format.ts` carry no directive and are imported by both server and client.
- **Every commit must leave `npx tsc --noEmit`, `npm run lint`, and `npx vitest run` green.** The legacy `fmtDate`/`fmtDateTime` shims stay in place until the final task so intermediate commits compile.
- **Test DB isolation**: run vitest with a per-worktree `TEST_DATABASE_URL` (vitest ignores `.env`, which points at shared Neon). Do NOT `prisma migrate`/`resetDb` against the repo `.env`.
- **Ship as a single CI-gated PR** on branch `feat/eastern-time-display`; the full Playwright suite (workers:1) must pass.

## Migration transformation rules (referenced by Tasks 6-16)

Each display site is classified in the inventory as **instant** or **calendar**. Apply by kind and by context:

| Site shape | Replacement |
|---|---|
| **instant**, date+time (`fmtDateTime(x)`, `x.toLocaleString()`), JSX child | `<DateTime value={x} />` |
| **instant**, date only (`fmtDate(x)`, `x.toLocaleDateString()`), JSX child | `<DateOnly value={x} />` |
| **instant**, time only, JSX child | `<TimeOnly value={x} />` |
| **calendar** marker (`fmtDate(cd)`, `toLocaleDateString(..., timeZone:"UTC")`), JSX child | `<CalendarDate value={cd} />` (add `opts={{...}}` for weekday/long/month-year shapes) |
| **any**, string context (template literal, string prop, non-JSX return) | resolve `const zone = await getDisplayTimeZone()` once in the (async) server component, then `formatDateTime(x, zone)` / `formatDateOnly(x, zone)` / `formatCalendarDate(cd)` |
| **local formatter definition** used at many call sites (`formatUtcDate`, `fmtLongDate`, ...) | reimplement only the function body to delegate to the shared helper; leave call sites untouched. For a **calendar** helper this needs no zone; for an **instant** helper the whole component becomes `async` with a resolved zone, or the call sites move to components. |

**Making a sync server component async is safe** in RSC. When a file needs a zone in string context, add `async` to the component and `const zone = await getDisplayTimeZone();` at the top. A sync server component may still render async `<DateTime>` children directly.

---

### Task 1: Zone module, env var, and setting

**Files:**
- Create: `src/platform/dates/zone.ts` (pure: constants, `DisplayTimeZone`, `normalizeZone` — NO imports, client-safe)
- Create: `src/platform/dates/resolve.ts` (server-only `getDisplayTimeZone`, split out of `zone.ts` so the pure constants never drag `@/platform/settings/service` -> `@prisma/client` into a client bundle; `index.ts` must NOT re-export it)
- Modify: `src/platform/config.ts` (add `DISPLAY_TIME_ZONE` after the last schema field, before the `z.object` closes at ~line 134)
- Modify: `src/platform/settings/registry.ts` (append one `define<...>` to the `SETTINGS` array before its close at ~line 291)
- Test: `src/platform/dates/zone.test.ts`

**Interfaces:**
- Produces: `DEFAULT_TIME_ZONE: DisplayTimeZone`, `US_TIME_ZONES: readonly {value,label}[]`, `US_TIME_ZONE_IDS: readonly string[]`, `type DisplayTimeZone`, `normalizeZone(raw: string|null|undefined): DisplayTimeZone`, `getDisplayTimeZone(): Promise<DisplayTimeZone>`.
- Consumes: `getSetting<T>(key): Promise<T>` from `@/platform/settings/service`; `cache` from `react`.

- [ ] **Step 1: Write the failing test**

```ts
// src/platform/dates/zone.test.ts
import { describe, it, expect } from "vitest";
import { normalizeZone, DEFAULT_TIME_ZONE, US_TIME_ZONE_IDS, US_TIME_ZONES } from "./zone";

describe("normalizeZone", () => {
  it("passes through a known US zone", () => {
    expect(normalizeZone("America/Chicago")).toBe("America/Chicago");
  });
  it("falls back to the default for unknown/empty/null", () => {
    expect(normalizeZone("Europe/Paris")).toBe(DEFAULT_TIME_ZONE);
    expect(normalizeZone("")).toBe(DEFAULT_TIME_ZONE);
    expect(normalizeZone(null)).toBe(DEFAULT_TIME_ZONE);
    expect(normalizeZone(undefined)).toBe(DEFAULT_TIME_ZONE);
  });
  it("default is Eastern and is a member of the id list", () => {
    expect(DEFAULT_TIME_ZONE).toBe("America/New_York");
    expect(US_TIME_ZONE_IDS).toContain(DEFAULT_TIME_ZONE);
  });
  it("every option value is in the id tuple", () => {
    for (const o of US_TIME_ZONES) expect(US_TIME_ZONE_IDS).toContain(o.value);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/platform/dates/zone.test.ts`
Expected: FAIL, "Cannot find module './zone'".

- [ ] **Step 3: Create the zone module**

```ts
// src/platform/dates/zone.ts
import { cache } from "react";
import { getSetting } from "@/platform/settings/service";

/** Curated set of US display zones offered in the admin picker. */
export const US_TIME_ZONES = [
  { value: "America/New_York", label: "Eastern (New York)" },
  { value: "America/Chicago", label: "Central (Chicago)" },
  { value: "America/Denver", label: "Mountain (Denver)" },
  { value: "America/Phoenix", label: "Mountain, no daylight saving (Phoenix)" },
  { value: "America/Los_Angeles", label: "Pacific (Los Angeles)" },
  { value: "America/Anchorage", label: "Alaska (Anchorage)" },
  { value: "Pacific/Honolulu", label: "Hawaii (Honolulu)" },
] as const;

export const US_TIME_ZONE_IDS = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
] as const;

export type DisplayTimeZone = (typeof US_TIME_ZONE_IDS)[number];

export const DEFAULT_TIME_ZONE: DisplayTimeZone = "America/New_York";

/** Coerce a stored/raw zone string to a known display zone, else the default. */
export function normalizeZone(raw: string | null | undefined): DisplayTimeZone {
  return (US_TIME_ZONE_IDS as readonly string[]).includes(raw ?? "")
    ? (raw as DisplayTimeZone)
    : DEFAULT_TIME_ZONE;
}

/**
 * The app-wide display time zone, resolved from the `display.timeZone` setting.
 * Memoised per request via React cache, so many components resolve it once.
 */
export const getDisplayTimeZone = cache(async (): Promise<DisplayTimeZone> => {
  return normalizeZone(await getSetting<string>("display.timeZone"));
});
```

- [ ] **Step 4: Add the env var to config**

In `src/platform/config.ts`, add this property inside the `z.object({...})` schema (a clean spot is right after the last existing entry, before the object closes at ~line 134):

```ts
    // IANA display time zone for rendering real timestamps. Deploy-time seed;
    // admins can override live via the display.timeZone setting.
    DISPLAY_TIME_ZONE: z.string().default("America/New_York"),
```

- [ ] **Step 5: Register the setting**

In `src/platform/settings/registry.ts`, add the import at the top (next to the existing imports on lines 1-4):

```ts
import { US_TIME_ZONES, US_TIME_ZONE_IDS } from "@/platform/dates/zone";
```

Then append this to the `SETTINGS` array (before its closing `];` at ~line 291):

```ts
  define<string>({
    key: "display.timeZone",
    category: "Operations",
    label: "Display time zone",
    help: "All dates and times across the app are shown in this time zone. Calendar dates (clinic days, term dates) are unaffected.",
    input: { type: "select", options: US_TIME_ZONES.map((z) => ({ value: z.value, label: z.label })) },
    schema: z.enum(US_TIME_ZONE_IDS),
    envDefault: () => config.DISPLAY_TIME_ZONE,
    secret: false,
  }),
```

- [ ] **Step 6: Add a registry presence test**

Append to `src/platform/dates/zone.test.ts`:

```ts
import { SETTINGS } from "@/platform/settings/registry";

describe("display.timeZone setting", () => {
  it("is registered as a select whose default is Eastern", () => {
    const def = SETTINGS.find((s) => s.key === "display.timeZone");
    expect(def).toBeDefined();
    expect(def!.input.type).toBe("select");
    expect(def!.envDefault()).toBe("America/New_York");
  });
});
```

- [ ] **Step 7: Run tests + typecheck to verify they pass**

Run: `npx vitest run src/platform/dates/zone.test.ts && npx tsc --noEmit`
Expected: PASS; no type errors.

- [ ] **Step 8: Commit**

```bash
git add src/platform/dates/zone.ts src/platform/dates/zone.test.ts src/platform/config.ts src/platform/settings/registry.ts
git commit -m "feat(dates): add display.timeZone setting and zone resolver"
```

---

### Task 2: Pure formatters (`format.ts`) with DST tests

**Files:**
- Create: `src/platform/dates/format.ts`
- Test: `src/platform/dates/format.test.ts`

**Interfaces:**
- Consumes: `DisplayTimeZone` type from `./zone` (type-only import).
- Produces:
  - `formatDateTime(d, zone, opts?, fallback?): string` — instant, "Jun 13, 2026, 9:05 AM EDT"
  - `formatDateOnly(d, zone, opts?, fallback?): string` — instant, "Jun 13, 2026"
  - `formatTimeOnly(d, zone, opts?, fallback?): string` — instant, "9:05 AM EDT"
  - `formatCalendarDate(d, opts?, fallback?): string` — UTC marker, "Jun 13, 2026"
  - `zoneAbbrev(d, zone): string` — "EDT" / "EST"
  - `parseZonedInput(wall, zone): Date | null` — "YYYY-MM-DDTHH:mm" wall clock in `zone` to instant
  - `formatForDateTimeInput(d, zone): string` — instant to "YYYY-MM-DDTHH:mm" wall clock in `zone`
  - `formatForDateInput(d, zone): string` — instant to "YYYY-MM-DD" wall clock in `zone`

- [ ] **Step 1: Write the failing tests**

```ts
// src/platform/dates/format.test.ts
import { describe, it, expect } from "vitest";
import {
  formatDateTime, formatDateOnly, formatTimeOnly, formatCalendarDate,
  zoneAbbrev, parseZonedInput, formatForDateTimeInput,
} from "./format";

const ET = "America/New_York";

describe("formatDateTime (instant, zoned)", () => {
  it("renders EDT in summer", () => {
    // 2026-06-13T13:05Z == 09:05 EDT
    expect(formatDateTime(new Date("2026-06-13T13:05:00Z"), ET)).toBe("Jun 13, 2026, 9:05 AM EDT");
  });
  it("renders EST in winter", () => {
    // 2026-01-05T14:05Z == 09:05 EST
    expect(formatDateTime(new Date("2026-01-05T14:05:00Z"), ET)).toBe("Jan 5, 2026, 9:05 AM EST");
  });
  it("returns the fallback for null", () => {
    expect(formatDateTime(null, ET)).toBe("-");
    expect(formatDateTime(undefined, ET, undefined, "n/a")).toBe("n/a");
  });
});

describe("formatDateOnly / formatTimeOnly (instant, zoned)", () => {
  it("date-only uses the zone's calendar day (late-evening UTC rolls back)", () => {
    // 2026-06-13T01:00Z == 2026-06-12 21:00 EDT -> previous day in ET
    expect(formatDateOnly(new Date("2026-06-13T01:00:00Z"), ET)).toBe("Jun 12, 2026");
  });
  it("time-only carries the abbreviation", () => {
    expect(formatTimeOnly(new Date("2026-06-13T13:05:00Z"), ET)).toBe("9:05 AM EDT");
  });
});

describe("formatCalendarDate (UTC marker)", () => {
  it("noon-UTC anchor renders its stored day", () => {
    expect(formatCalendarDate(new Date("2026-06-13T12:00:00Z"))).toBe("Jun 13, 2026");
  });
  it("midnight-UTC anchor renders its stored day (no ET rollback)", () => {
    expect(formatCalendarDate(new Date("2026-06-13T00:00:00Z"))).toBe("Jun 13, 2026");
  });
  it("honours an opts override", () => {
    expect(formatCalendarDate(new Date("2026-06-13T12:00:00Z"), { weekday: "long", month: "long", day: "numeric" }))
      .toBe("Saturday, June 13");
  });
});

describe("zoneAbbrev", () => {
  it("flips with DST", () => {
    expect(zoneAbbrev(new Date("2026-06-13T13:00:00Z"), ET)).toBe("EDT");
    expect(zoneAbbrev(new Date("2026-01-05T14:00:00Z"), ET)).toBe("EST");
  });
});

describe("parseZonedInput <-> formatForDateTimeInput round-trip", () => {
  it("interprets a summer wall clock as EDT", () => {
    // 09:05 wall in ET (EDT, -4) == 13:05Z
    expect(parseZonedInput("2026-06-13T09:05", ET)!.toISOString()).toBe("2026-06-13T13:05:00.000Z");
  });
  it("interprets a winter wall clock as EST", () => {
    // 09:05 wall in ET (EST, -5) == 14:05Z
    expect(parseZonedInput("2026-01-05T09:05", ET)!.toISOString()).toBe("2026-01-05T14:05:00.000Z");
  });
  it("round-trips an instant through the input formatter", () => {
    const iso = "2026-06-13T13:05:00.000Z";
    const wall = formatForDateTimeInput(new Date(iso), ET); // "2026-06-13T09:05"
    expect(wall).toBe("2026-06-13T09:05");
    expect(parseZonedInput(wall, ET)!.toISOString()).toBe(iso);
  });
  it("handles the spring-forward gap without crashing", () => {
    // 2026-03-08 02:30 ET does not exist (clocks jump 02:00 -> 03:00).
    const r = parseZonedInput("2026-03-08T02:30", ET);
    expect(r).toBeInstanceOf(Date);
    expect(Number.isNaN(r!.getTime())).toBe(false);
  });
  it("returns null for a malformed string", () => {
    expect(parseZonedInput("not-a-date", ET)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/platform/dates/format.test.ts`
Expected: FAIL, "Cannot find module './format'".

- [ ] **Step 3: Implement the formatters**

```ts
// src/platform/dates/format.ts
// Pure, framework-agnostic date formatting. Safe to import from server and
// client. Instant formatters require an explicit zone; calendar formatting is
// always UTC (see the design spec).

type Opts = Intl.DateTimeFormatOptions;

const DATE_TIME: Opts = {
  year: "numeric", month: "short", day: "numeric",
  hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short",
};
const DATE_ONLY: Opts = { year: "numeric", month: "short", day: "numeric" };
const TIME_ONLY: Opts = { hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short" };

/** Instant rendered in `zone` as date + time + zone abbreviation. */
export function formatDateTime(d: Date | null | undefined, zone: string, opts?: Opts, fallback = "-"): string {
  if (!d) return fallback;
  return new Intl.DateTimeFormat("en-US", { timeZone: zone, ...(opts ?? DATE_TIME) }).format(d);
}

/** Instant rendered in `zone` as a calendar day (no time). */
export function formatDateOnly(d: Date | null | undefined, zone: string, opts?: Opts, fallback = "-"): string {
  if (!d) return fallback;
  return new Intl.DateTimeFormat("en-US", { timeZone: zone, ...(opts ?? DATE_ONLY) }).format(d);
}

/** Instant rendered in `zone` as a time (with abbreviation). */
export function formatTimeOnly(d: Date | null | undefined, zone: string, opts?: Opts, fallback = "-"): string {
  if (!d) return fallback;
  return new Intl.DateTimeFormat("en-US", { timeZone: zone, ...(opts ?? TIME_ONLY) }).format(d);
}

/** Calendar-day marker rendered in UTC, stable for noon- and midnight-UTC anchors. */
export function formatCalendarDate(d: Date | null | undefined, opts?: Opts, fallback = "-"): string {
  if (!d) return fallback;
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...(opts ?? DATE_ONLY) }).format(d);
}

/** "EDT" / "EST" for the given instant in the given zone. */
export function zoneAbbrev(d: Date, zone: string): string {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "short" })
    .formatToParts(d)
    .find((p) => p.type === "timeZoneName");
  return part?.value ?? "";
}

/** How far `zone` is ahead of UTC at `instant`, in milliseconds. */
function zoneOffsetMs(instant: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(instant);
  const m: Record<string, number> = {};
  for (const p of parts) if (p.type !== "literal") m[p.type] = Number(p.value);
  const asUTC = Date.UTC(m.year, m.month - 1, m.day, m.hour, m.minute, m.second);
  return asUTC - instant.getTime();
}

/** Interpret a "YYYY-MM-DDTHH:mm" wall clock as being in `zone`; return the instant. */
export function parseZonedInput(wall: string, zone: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(wall);
  if (!m) return null;
  const asUTC = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  const off1 = zoneOffsetMs(new Date(asUTC), zone);
  let instant = new Date(asUTC - off1);
  const off2 = zoneOffsetMs(instant, zone);
  if (off2 !== off1) instant = new Date(asUTC - off2);
  return instant;
}

/** Instant to "YYYY-MM-DDTHH:mm" wall clock in `zone`, for a datetime-local input. */
export function formatForDateTimeInput(d: Date | null | undefined, zone: string): string {
  if (!d) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}`;
}

/** Instant to "YYYY-MM-DD" wall clock in `zone`, for a date input's max/value. */
export function formatForDateInput(d: Date | null | undefined, zone: string): string {
  return formatForDateTimeInput(d, zone).slice(0, 10);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/platform/dates/format.test.ts && npx tsc --noEmit`
Expected: PASS. (If any string assertion differs by a non-breaking space or comma, adjust the expected string to match `Intl` output on Node 24 exactly, then re-run.)

- [ ] **Step 5: Commit**

```bash
git add src/platform/dates/format.ts src/platform/dates/format.test.ts
git commit -m "feat(dates): add pure zoned/calendar formatters and datetime-local parse"
```

---

### Task 3: Relocate `dates.ts` to `dates/` with logic + legacy shims

**Files:**
- Create: `src/platform/dates/logic.ts`
- Create: `src/platform/dates/index.ts`
- Delete: `src/platform/dates.ts`
- Rename: `src/platform/dates.test.ts` to `src/platform/dates/logic.test.ts` (and update it)

**Interfaces:**
- Produces (from `@/platform/dates`, unchanged specifier — resolves to `dates/index.ts`): `isoDateKey`, `businessDaysSince`, plus legacy `fmtDate`/`fmtDateTime` (temporary), and re-exports of everything from `./format` and `./zone`.
- `businessDaysSince(start: Date, now?: Date, zone?: string): number` — gains an optional third `zone` arg; omitting it preserves exact UTC behavior.

- [ ] **Step 1: Create `logic.ts` (UTC utilities + zoned businessDaysSince)**

```ts
// src/platform/dates/logic.ts
// UTC-only calendar utilities. These are NOT display helpers: isoDateKey is a
// comparison key and must never change zone. businessDaysSince gains an optional
// zone so "days pending" can be counted against clinic-local midnights.

/** Returns a UTC YYYY-MM-DD key for a date. */
export function isoDateKey(d: Date): string {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function zonedYMD(d: Date, zone: string): [number, number, number] {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d);
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return [g("year"), g("month"), g("day")];
}

/**
 * Counts Monday to Friday business days elapsed between `start` and `now`,
 * exclusive of the start day and inclusive of `now`. Day boundaries use UTC by
 * default; pass `zone` to count against that zone's calendar days. Returns 0
 * when `now` is on or before `start`.
 */
export function businessDaysSince(start: Date, now: Date = new Date(), zone?: string): number {
  const dayMs = 86_400_000;
  const toDayUTC = (d: Date): number => {
    if (zone) {
      const [y, m, day] = zonedYMD(d, zone);
      return Date.UTC(y, m - 1, day);
    }
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  };
  const startDay = toDayUTC(start);
  const endDay = toDayUTC(now);
  if (endDay <= startDay) return 0;

  let count = 0;
  for (let cursor = startDay + dayMs; cursor <= endDay; cursor += dayMs) {
    const dow = new Date(cursor).getUTCDay(); // 0=Sun, 6=Sat
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}
```

- [ ] **Step 2: Create `index.ts` (public surface + temporary legacy shims)**

```ts
// src/platform/dates/index.ts
export * from "./zone";
export * from "./format";
export { isoDateKey, businessDaysSince } from "./logic";

// --- LEGACY SHIMS (removed in the final migration task) ---
// Preserve the exact old output so call sites keep compiling and rendering
// unchanged until each is migrated to a component or a zoned formatter.

/** @deprecated Use <CalendarDate>/<DateOnly> or formatCalendarDate/formatDateOnly. */
export function fmtDate(d: Date | null | undefined, fallback = "-"): string {
  if (!d) return fallback;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

/** @deprecated Use <DateTime> or formatDateTime. */
export function fmtDateTime(d: Date | null | undefined, fallback = "-"): string {
  if (!d) return fallback;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(
    d.getUTCHours()
  )}:${pad(d.getUTCMinutes())} UTC`;
}
```

Note: the legacy `fmtDate`/`fmtDateTime` bodies here use `toLocaleDateString`; the guard test added in Task 17 allowlists the entire `src/platform/dates/` folder, so this is fine, and these shims are deleted before the guard is added anyway.

- [ ] **Step 3: Delete the old file and move the test**

```bash
git rm src/platform/dates.ts
git mv src/platform/dates.test.ts src/platform/dates/logic.test.ts
```

- [ ] **Step 4: Update `logic.test.ts`**

Replace its import line and add a zoned businessDaysSince case. The file becomes:

```ts
// src/platform/dates/logic.test.ts
import { describe, it, expect } from "vitest";
import { businessDaysSince, isoDateKey } from "./logic";

describe("isoDateKey", () => {
  it("formats a UTC day key", () => {
    expect(isoDateKey(new Date("2026-06-11T12:00:00Z"))).toBe("2026-06-11");
  });
});

describe("businessDaysSince", () => {
  it("returns 0 when now is the same day as start", () => {
    const d = new Date("2026-06-11T12:00:00Z"); // Thursday
    expect(businessDaysSince(d, d)).toBe(0);
  });
  it("returns 0 when now is before start", () => {
    const start = new Date("2026-06-11T12:00:00Z");
    const earlier = new Date("2026-06-09T12:00:00Z");
    expect(businessDaysSince(start, earlier)).toBe(0);
  });
  it("counts weekdays exclusive of start, inclusive of now", () => {
    const start = new Date("2026-06-11T12:00:00Z");
    const now = new Date("2026-06-15T12:00:00Z");
    expect(businessDaysSince(start, now)).toBe(2);
  });
  it("skips weekends entirely", () => {
    const start = new Date("2026-06-12T12:00:00Z");
    const now = new Date("2026-06-14T12:00:00Z");
    expect(businessDaysSince(start, now)).toBe(0);
  });
  it("is UTC-day-stable regardless of wall-clock time (default)", () => {
    const start = new Date("2026-06-11T23:30:00Z"); // Thu
    const now = new Date("2026-06-12T00:30:00Z"); // Fri
    expect(businessDaysSince(start, now)).toBe(1);
  });
  it("counts against clinic-local days when a zone is passed", () => {
    // Both instants are 2026-06-11 in ET (21:30 and 20:30 EDT), so 0 business days.
    const start = new Date("2026-06-12T01:30:00Z"); // 2026-06-11 21:30 EDT
    const now = new Date("2026-06-12T00:30:00Z"); // 2026-06-11 20:30 EDT
    expect(businessDaysSince(start, now, "America/New_York")).toBe(0);
  });
});

describe("fmtDate / fmtDateTime legacy shims", () => {
  it("still produce the original UTC strings", async () => {
    const { fmtDate, fmtDateTime } = await import("./index");
    expect(fmtDate(new Date("2026-06-13T12:00:00Z"))).toBe("Jun 13, 2026");
    expect(fmtDateTime(new Date("2026-06-13T09:05:00Z"))).toBe("2026-06-13 09:05 UTC");
    expect(fmtDate(null)).toBe("-");
  });
});
```

- [ ] **Step 5: Verify the whole app still compiles and every dates consumer resolves**

Run: `npx tsc --noEmit && npx vitest run src/platform/dates src/modules/schedule && npm run lint`
Expected: PASS. `@/platform/dates` now resolves to `dates/index.ts`; `isoDateKey` (direct and via `schedule/engine/map` re-export), `businessDaysSince`, `fmtDate`, `fmtDateTime` all still export. No behavioral change yet.

- [ ] **Step 6: Commit**

```bash
git add -A src/platform/dates src/modules
git commit -m "refactor(dates): split into dates/ folder with logic + legacy shims"
```

---

### Task 4: Server display components (`display.tsx`)

**Files:**
- Create: `src/platform/dates/display.tsx`
- Test: `src/platform/dates/display.test.tsx`

**Interfaces:**
- Consumes: `getDisplayTimeZone` from `./resolve`; formatters from `./format`.
- Produces server components `DateTime`, `DateOnly`, `TimeOnly` (async) and `CalendarDate` (sync), each `{ value: Date | null | undefined; fallback?: string; opts?: Intl.DateTimeFormatOptions }`.

- [ ] **Step 1: Write the failing test (sync CalendarDate is unit-testable)**

```tsx
// src/platform/dates/display.test.tsx
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CalendarDate } from "./display";

describe("CalendarDate", () => {
  it("renders a UTC calendar day inside a <time>", () => {
    const html = renderToStaticMarkup(<CalendarDate value={new Date("2026-06-13T00:00:00Z")} />);
    expect(html).toContain("Jun 13, 2026");
    expect(html).toContain('datetime="2026-06-13"');
  });
  it("renders the fallback for null", () => {
    expect(renderToStaticMarkup(<CalendarDate value={null} fallback="TBD" />)).toBe("TBD");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/platform/dates/display.test.tsx`
Expected: FAIL, "Cannot find module './display'".

- [ ] **Step 3: Implement the components**

```tsx
// src/platform/dates/display.tsx
import { getDisplayTimeZone } from "./resolve";
import { formatDateTime, formatDateOnly, formatTimeOnly, formatCalendarDate } from "./format";

type Props = {
  value: Date | null | undefined;
  fallback?: string;
  opts?: Intl.DateTimeFormatOptions;
};

/** Instant as date + time in the configured zone. */
export async function DateTime({ value, fallback = "-", opts }: Props) {
  if (!value) return <>{fallback}</>;
  const zone = await getDisplayTimeZone();
  return <time dateTime={value.toISOString()}>{formatDateTime(value, zone, opts)}</time>;
}

/** Instant as a calendar day in the configured zone. */
export async function DateOnly({ value, fallback = "-", opts }: Props) {
  if (!value) return <>{fallback}</>;
  const zone = await getDisplayTimeZone();
  return <time dateTime={value.toISOString()}>{formatDateOnly(value, zone, opts)}</time>;
}

/** Instant as a time in the configured zone. */
export async function TimeOnly({ value, fallback = "-", opts }: Props) {
  if (!value) return <>{fallback}</>;
  const zone = await getDisplayTimeZone();
  return <time dateTime={value.toISOString()}>{formatTimeOnly(value, zone, opts)}</time>;
}

/** Calendar-day marker in UTC (never zone-shifted). Sync: no resolve needed. */
export function CalendarDate({ value, fallback = "-", opts }: Props) {
  if (!value) return <>{fallback}</>;
  return <time dateTime={value.toISOString().slice(0, 10)}>{formatCalendarDate(value, opts)}</time>;
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `npx vitest run src/platform/dates/display.test.tsx && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/platform/dates/display.tsx src/platform/dates/display.test.tsx
git commit -m "feat(dates): add server display components for instants and calendar days"
```

---

### Task 5: Client `TimeZoneProvider` + mount in AppShell

**Files:**
- Create: `src/platform/dates/client.tsx`
- Modify: `src/platform/ui/app-shell.tsx` (resolve zone in the `Promise.all` at lines 43-47; wrap the `<BreadcrumbProvider>` block at lines 123-133)
- Test: `src/platform/dates/client.test.tsx`

**Interfaces:**
- Produces: `TimeZoneProvider({ zone, children })` and `useTimeZone(): string`.
- Consumes in AppShell: `getDisplayTimeZone` from `@/platform/dates/resolve`.

- [ ] **Step 1: Write the failing test**

```tsx
// src/platform/dates/client.test.tsx
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TimeZoneProvider, useTimeZone } from "./client";

function Probe() {
  return <span>{useTimeZone()}</span>;
}

describe("TimeZoneProvider / useTimeZone", () => {
  it("provides the zone to consumers", () => {
    const html = renderToStaticMarkup(
      <TimeZoneProvider zone="America/Chicago"><Probe /></TimeZoneProvider>
    );
    expect(html).toContain("America/Chicago");
  });
  it("falls back to the default outside a provider", () => {
    expect(renderToStaticMarkup(<Probe />)).toContain("America/New_York");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/platform/dates/client.test.tsx`
Expected: FAIL, "Cannot find module './client'".

- [ ] **Step 3: Implement the provider**

```tsx
// src/platform/dates/client.tsx
"use client";

import { createContext, useContext, type ReactNode } from "react";
import { DEFAULT_TIME_ZONE } from "./zone";

const Ctx = createContext<string>(DEFAULT_TIME_ZONE);

/** Supplies the server-resolved display zone to client components. */
export function TimeZoneProvider({ zone, children }: { zone: string; children: ReactNode }) {
  return <Ctx.Provider value={zone}>{children}</Ctx.Provider>;
}

/** The configured display zone (IANA id). Defaults to Eastern outside a provider. */
export function useTimeZone(): string {
  return useContext(Ctx);
}
```

Note: importing `DEFAULT_TIME_ZONE` (a string constant, not an array) from the non-client `zone.ts` is safe. Do NOT import `US_TIME_ZONES`/`US_TIME_ZONE_IDS` into any client module.

- [ ] **Step 4: Mount in AppShell**

In `src/platform/ui/app-shell.tsx`, add imports near line 13:

```ts
import { TimeZoneProvider } from "@/platform/dates/client";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
```

Add `getDisplayTimeZone()` to the parallel fetch (lines 43-47) so it becomes:

```ts
  const [navModules, themeDefault, org, displayZone] = await Promise.all([
    getAccessibleModules(personId),
    getSetting<string>("ui.defaultTheme"),
    getOrgIdentity(),
    getDisplayTimeZone(),
  ]);
```

Wrap the existing breadcrumb block (lines 123-133) so the whole page body is a consumer:

```tsx
      <TimeZoneProvider zone={displayZone}>
        <BreadcrumbProvider>
          <Breadcrumbs modules={breadcrumbModules} />
          <main
            id="main-content"
            tabIndex={-1}
            className="mx-auto w-full max-w-6xl px-6 py-10 flex-1 outline-none"
          >
            {children}
          </main>
        </BreadcrumbProvider>
      </TimeZoneProvider>
```

- [ ] **Step 5: Run test + typecheck + lint**

Run: `npx vitest run src/platform/dates/client.test.tsx && npx tsc --noEmit && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/platform/dates/client.tsx src/platform/dates/client.test.tsx src/platform/ui/app-shell.tsx
git commit -m "feat(dates): add TimeZoneProvider and mount it in the app shell"
```

---

## Migration tasks (6-16)

For every task below: apply the **Migration transformation rules**, then run `npx tsc --noEmit && npm run lint` and commit. Import components from `@/platform/dates/display` and pure functions from `@/platform/dates`. When a server component needs a zone in string context, make it `async` and add `const zone = await getDisplayTimeZone();`.

### Task 6: Admin pages (email, notifications, terms, audit)

**Files:** `src/app/(app)/admin/email/campaigns/[id]/page.tsx`, `src/app/(app)/admin/email/page.tsx`, `src/app/(app)/admin/notifications/page.tsx`, `src/app/(app)/admin/terms/page.tsx`, `src/modules/admin/components/audit-table.tsx`.

- [ ] **Step 1: Apply edits**
  - `admin/email/campaigns/[id]/page.tsx` L365 `{campaign.scheduledAt.toLocaleString()}` -> `<DateTime value={campaign.scheduledAt} />` (instant). L372 `{campaign.nextRunAt.toLocaleString()}` -> `<DateTime value={campaign.nextRunAt} />`. L439 `<TD ...>{run.runAt.toLocaleString()}</TD>` -> `<TD ...><DateTime value={run.runAt} /></TD>`.
  - `admin/email/page.tsx` L317 `{fmtDateTime(mailConn.connectedAt)}` -> `<DateTime value={mailConn.connectedAt} />` (JSX child). L506 `{fmtDateTime(row.createdAt)}` -> `<DateTime value={row.createdAt} />`. L509 `{fmtDateTime(row.sentAt)}` -> `<DateTime value={row.sentAt} />`. Remove the now-unused `fmtDateTime` import.
  - `admin/notifications/page.tsx` L310 `{fmtDateTime(row.createdAt)}` -> `<DateTime value={row.createdAt} />`. L313 `{fmtDateTime(row.sentAt)}` -> `<DateTime value={row.sentAt} />`. Remove the `fmtDateTime` import.
  - `admin/terms/page.tsx` reimplement the local `formatUtcDate` (def L10) to delegate: body becomes `return formatCalendarDate(d, { month: "short", day: "numeric", year: "numeric" });`. Add `import { formatCalendarDate } from "@/platform/dates";`. Call sites L59-60 untouched. (These are term start/end calendar dates.)
  - `modules/admin/components/audit-table.tsx` remove the local `formatUtc` (def L7); replace L51 `{formatUtc(row.createdAt)}` -> `<DateTime value={row.createdAt} />`. Add `import { DateTime } from "@/platform/dates/display";`. (AuditTable is a sync server component; an async `<DateTime>` child is allowed.)

- [ ] **Step 2: Verify + commit**

Run: `npx tsc --noEmit && npm run lint`
Expected: PASS.
```bash
git add -A src/app/\(app\)/admin src/modules/admin
git commit -m "feat(dates): render admin timestamps in the display zone"
```

### Task 7: Recruitment display (cycles + interviews pages)

**Files:** `src/app/(app)/recruitment/cycles/[id]/page.tsx`, `src/app/(app)/recruitment/cycles/[id]/interviews/page.tsx`, `src/app/(app)/recruitment/interviews/page.tsx`, `src/app/(app)/recruitment/interviews/[interviewId]/page.tsx`.
(Datetime-local inputs on the cycle and interview pages are handled in Task 14, not here.)

- [ ] **Step 1: Apply edits** (all values are instants)
  - `cycles/[id]/page.tsx` L104 `{cycle.opensAt!.toLocaleString()}` -> `<DateTime value={cycle.opensAt} />`. L107 `{cycle.closesAt!.toLocaleString()}` -> `<DateTime value={cycle.closesAt} />`. L110 `{cycle.closesAt.toLocaleString()}` -> `<DateTime value={cycle.closesAt} />`.
  - `cycles/[id]/interviews/page.tsx` L68 `{iv.scheduledAt ? iv.scheduledAt.toLocaleString() : "TBD"}` -> `<DateTime value={iv.scheduledAt} fallback="TBD" />`.
  - `recruitment/interviews/page.tsx` L38 same pattern -> `<DateTime value={iv.scheduledAt} fallback="TBD" />`.
  - `recruitment/interviews/[interviewId]/page.tsx` L94 `sent {iv.invitedAt.toLocaleString()}` -> `sent <DateTime value={iv.invitedAt} />`. L129 `{iv.scheduledAt ? iv.scheduledAt.toLocaleString() : "To be determined"}` -> `<DateTime value={iv.scheduledAt} fallback="To be determined" />`.
  - Add `import { DateTime } from "@/platform/dates/display";` to each file.

- [ ] **Step 2: Verify + commit**

Run: `npx tsc --noEmit && npm run lint`
```bash
git add -A src/app/\(app\)/recruitment
git commit -m "feat(dates): render recruitment timestamps in the display zone"
```

### Task 8: Incidents pages

**Files:** `src/app/(app)/incidents/[id]/page.tsx`, `src/app/(app)/incidents/mine/page.tsx`, `src/app/(app)/incidents/review/page.tsx`, `src/app/(app)/incidents/strikes/page.tsx`.

- [ ] **Step 1: Apply edits**
  - `incidents/[id]/page.tsx` L178 `{fmtDate(report.occurredAt, "Unknown")}` -> `<CalendarDate value={report.occurredAt} fallback="Unknown" />` (**calendar**, midnight-UTC anchored: UTC is required). L273 `{fmtDate(report.createdAt)}` -> `<DateOnly value={report.createdAt} />` (**instant**).
  - `incidents/mine/page.tsx` L116 `{fmtDate(report.createdAt)}` -> `<DateOnly value={report.createdAt} />`.
  - `incidents/review/page.tsx` L237 `{fmtDate(report.createdAt)}` -> `<DateOnly value={report.createdAt} />`.
  - `incidents/strikes/page.tsx` L476 `{fmtDate(action.occurredAt)}` -> `<CalendarDate value={action.occurredAt} />` (**calendar**).
  - Replace each file's `import { fmtDate } from "@/platform/dates";` with `import { CalendarDate, DateOnly } from "@/platform/dates/display";` (import only what each file uses).

- [ ] **Step 2: Verify + commit**

Run: `npx tsc --noEmit && npm run lint`
```bash
git add -A src/app/\(app\)/incidents
git commit -m "feat(dates): incidents timestamps zoned, occurred-on dates stay UTC"
```

### Task 9: Volunteers + my-info

**Files:** `src/app/(app)/volunteers/master/page.tsx`, `src/app/(app)/volunteers/page.tsx`, `src/app/(app)/volunteers/offboarding/page.tsx`, `src/modules/my-info/components/ehs-panel.tsx`, `src/modules/my-info/components/hipaa-panel.tsx`, `src/modules/admin/components/person-form.tsx`.

- [ ] **Step 1: Apply edits**
  - `volunteers/master/page.tsx` L359 `{fmtDate(row.cert?.completionDate)}` -> `<CalendarDate value={row.cert?.completionDate} />` (**calendar**). L362 `{fmtDate(expiresAt)}` -> `<CalendarDate value={expiresAt} />` (**calendar**). L367 `{fmtDate(row.cert.verifiedAt)}` -> `<DateOnly value={row.cert.verifiedAt} />` (**instant**).
  - `volunteers/page.tsx` L236 `{fmtDate(m.cert?.completionDate)}` -> `<CalendarDate value={m.cert?.completionDate} />`. L239 `{fmtDate(expiresAt)}` -> `<CalendarDate value={expiresAt} />`. L244 `{fmtDate(m.cert.verifiedAt)}` -> `<DateOnly value={m.cert.verifiedAt} />`.
  - `volunteers/offboarding/page.tsx` L216 `{fmtDate(flag.createdAt)}` -> `<DateOnly value={flag.createdAt} />` (**instant**).
  - `ehs-panel.tsx` L30 `completed {fmtDate(item.completedAt)}` -> `completed <DateOnly value={item.completedAt} />` (**instant**).
  - `person-form.tsx` L139 `Verified on {new Date(person.spanishVerifiedAt).toLocaleDateString()}` -> `Verified on <DateOnly value={new Date(person.spanishVerifiedAt)} />` (**instant**; check whether person-form is a client component — see note).
  - `hipaa-panel.tsx`: make the component `async`; add `const zone = await getDisplayTimeZone();` and `import { getDisplayTimeZone } from "@/platform/dates/resolve";` + `import { formatCalendarDate, formatDateOnly } from "@/platform/dates";`. Remove the local `formatDate` (def L28). Then: L62/L65/L68 `formatDate(expiresAt)` -> `formatCalendarDate(expiresAt)` (**calendar**); L103 `formatDate(latest.completionDate)` -> `formatCalendarDate(latest.completionDate)` (**calendar**); L94 `` `Uploaded ${formatDate(latest.uploadedAt)}` `` -> `` `Uploaded ${formatDateOnly(latest.uploadedAt, zone)}` `` (**instant**, string context); L157 `formatDate(cert.uploadedAt)` -> `formatDateOnly(cert.uploadedAt, zone)` (**instant**).
  - Replace the `fmtDate` imports in the volunteers pages / ehs-panel with `import { CalendarDate, DateOnly } from "@/platform/dates/display";` (only what is used).

**Note on `person-form.tsx`:** if the first line is `"use client"`, do NOT use `<DateOnly>`; instead read `const zone = useTimeZone();` (`import { useTimeZone } from "@/platform/dates/client"`) and render `{formatDateOnly(new Date(person.spanishVerifiedAt), zone)}`. Verify before editing.

- [ ] **Step 2: Verify + commit**

Run: `npx tsc --noEmit && npm run lint`
```bash
git add -A src/app/\(app\)/volunteers src/modules/my-info src/modules/admin
git commit -m "feat(dates): volunteers/my-info certs and timestamps zoned"
```

### Task 10: Dashboard + schedule pages

**Files:** `src/app/(app)/page.tsx`, `src/app/(app)/schedule/page.tsx`, `src/app/(app)/schedule/full/page.tsx`, `src/app/(app)/schedule/builder/page.tsx`.

All values here are **calendar** (clinic dates, term months). Reimplement local formatters to delegate; replace inline UTC `toLocaleDateString` with `<CalendarDate>` or `formatCalendarDate`.

- [ ] **Step 1: Apply edits**
  - `page.tsx`: reimplement local `fmtLongDate` (def L65) body -> `return formatCalendarDate(d, { weekday: "long", month: "long", day: "numeric" });` and `fmtMonthYear` (def L75) body -> `return formatCalendarDate(d, { month: "short", year: "numeric" });`. Add `import { formatCalendarDate } from "@/platform/dates";`. Call sites L209, L328 untouched. (`isoDateKey` import at L31 stays.)
  - `schedule/page.tsx` L227 `{fmtDate(shift.clinicDate)}` -> `<CalendarDate value={shift.clinicDate} />`. L347 inline `d.toLocaleDateString("en-US", { month:"long", year:"numeric", timeZone:"UTC" })` (string context, month header) -> `formatCalendarDate(d, { month: "long", year: "numeric" })`. Add `import { CalendarDate } from "@/platform/dates/display"; import { formatCalendarDate } from "@/platform/dates";`. Replace the `fmtDate` import. Keep the `isoDateKey` import from `@/modules/schedule/engine/map`.
  - `schedule/full/page.tsx` L20 inline `selectedDate.toLocaleDateString("en-US", { weekday:"long", month:"long", day:"numeric", year:"numeric", timeZone:"UTC" })` (string context) -> `formatCalendarDate(selectedDate, { weekday: "long", month: "long", day: "numeric", year: "numeric" })`. Add `import { formatCalendarDate } from "@/platform/dates";`.
  - `schedule/builder/page.tsx` L429 inline `new Date(selectedDateKey + "T12:00:00Z").toLocaleDateString("en-US", { ..., timeZone:"UTC" })` (string context) -> `formatCalendarDate(new Date(selectedDateKey + "T12:00:00Z"), { weekday: "long", month: "long", day: "numeric", year: "numeric" })` (match the existing option set at that call). Add `import { formatCalendarDate } from "@/platform/dates";`. Keep `isoDateKey`.

- [ ] **Step 2: Verify + commit**

Run: `npx tsc --noEmit && npm run lint`
```bash
git add -A src/app/\(app\)/page.tsx src/app/\(app\)/schedule
git commit -m "feat(dates): route schedule/dashboard calendar dates through shared UTC formatter"
```

### Task 11: Support + learning display

**Files:** `src/modules/support/components/ticket-detail.tsx`, `src/modules/support/components/comment-thread.tsx`, `src/modules/support/components/request-list.tsx`, `src/app/(app)/learning/dashboard/page.tsx`, `src/app/(app)/learning/manage/[courseId]/page.tsx`, `src/app/(app)/training/page.tsx`, `src/modules/admin/components/clinic-dates-editor.tsx`.

- [ ] **Step 1: Apply edits**
  - `ticket-detail.tsx` L170 `description={`... Submitted ${fmtDate(detail.createdAt)}`}` (**instant**, string prop). Make the component `async`; `const zone = await getDisplayTimeZone();`; replace with `${formatDateOnly(detail.createdAt, zone)}`. Imports: `getDisplayTimeZone` from `@/platform/dates/resolve`, `formatDateOnly` from `@/platform/dates`; drop `fmtDate`. (If `ticket-detail` is a client component, use `useTimeZone()` instead of awaiting.)
  - `comment-thread.tsx` L42 `{fmtDateTime(comment.createdAt)}` -> `<DateTime value={comment.createdAt} />` (**instant**, JSX child). Import `DateTime`; drop `fmtDateTime`. (Confirm server component; the inventory lists it under server call-sites.)
  - `request-list.tsx` L69 `{fmtDate(row.updatedAt)}` -> `<DateOnly value={row.updatedAt} />` (**instant**). Import `DateOnly`; drop `fmtDate`.
  - `learning/dashboard/page.tsx` L87 `{r.completedAt ? r.completedAt.toLocaleDateString() : ""}` -> `<DateOnly value={r.completedAt} fallback="" />` (**instant**; fixes a viewer-local bug). Import `DateOnly`.
  - `learning/manage/[courseId]/page.tsx` L91 template `` ` ${course.scormUploadedAt.toLocaleDateString()}` `` (**instant**, string context). Make page `async` (it likely already is); `const zone = await getDisplayTimeZone();`; replace with `formatDateOnly(course.scormUploadedAt, zone)`. Imports as above.
  - `training/page.tsx`: reimplement the local `fmtDate` (def L32, only consumer is `my.completedAt`, an **instant**). Because it needs a zone, convert its two behaviors: make the page resolve `const zone = await getDisplayTimeZone();` and change L58 `Completed {fmtDate(my.completedAt)}` -> `Completed {formatDateOnly(my.completedAt, zone)}`, then delete the local `fmtDate`. Imports: `getDisplayTimeZone`, `formatDateOnly`.
  - `clinic-dates-editor.tsx`: reimplement local `formatClinicDate` (def L19) body -> delegate to `formatCalendarDate(d, { <same options as current> })` (**calendar**). Add `import { formatCalendarDate } from "@/platform/dates";`. Call site L66 untouched. (If this file is `"use client"`, `formatCalendarDate` is still fine, no zone needed.)

- [ ] **Step 2: Verify + commit**

Run: `npx tsc --noEmit && npm run lint`
```bash
git add -A src/modules/support src/app/\(app\)/learning src/app/\(app\)/training src/modules/admin
git commit -m "feat(dates): support/learning timestamps zoned, clinic-date editor via shared formatter"
```

### Task 12: Teams channel link + compliance email calendar dates

**Files:** `src/platform/teams/channel-link.ts`, `src/platform/email/templates/compliance.ts`.

- [ ] **Step 1: Apply edits** (both **calendar**, no zone needed)
  - `channel-link.ts`: reimplement local `formatClinicDate` (def L61) to delegate to `formatCalendarDate(date, { year: "2-digit", month: "2-digit", day: "2-digit" })` (matching the current numeric output shape). Add `import { formatCalendarDate } from "@/platform/dates";`. Leave `nyDateInt` (L31, a comparison integer, not display) untouched. Call site L170 untouched.
  - `compliance.ts`: reimplement the local `fmtDate` (def L74, manual UTC getters) to delegate to `formatCalendarDate(d, { month: "long", day: "numeric", year: "numeric" })` if that matches the intended wording, else keep the manual UTC version (it is already UTC-correct; migrating is optional-consistency only). Add the import if migrated. Call sites L114/L118 untouched.

- [ ] **Step 2: Verify + commit**

Run: `npx tsc --noEmit && npm run lint`
```bash
git add -A src/platform/teams src/platform/email/templates
git commit -m "feat(dates): route Teams channel + compliance-email dates through shared UTC formatter"
```

### Task 13: `datetime-local` inputs, actions, and copy

**Files:**
- Interview: `src/app/(app)/recruitment/interviews/[interviewId]/page.tsx` (input L78, prefill L46), `src/app/(app)/recruitment/interviews/actions.ts` (parse L25).
- Window: `src/app/(app)/recruitment/cycles/[id]/page.tsx` (inputs L161/L164, helper `toLocalInput` L25-30, copy L155-157), `src/app/(app)/recruitment/actions.ts` (parse L117-118).
- Campaign: `src/app/(app)/admin/email/campaigns/[id]/page.tsx` (input L394-399, action parse L193, copy L393/L404/L418-419).
- Terms copy: `src/app/(app)/admin/terms/[id]/page.tsx` (L201).

**Interfaces:** consumes `getDisplayTimeZone` from `@/platform/dates/resolve`; `formatForDateTimeInput`, `parseZonedInput` from `@/platform/dates`; `US_TIME_ZONES` for a friendly label helper.

- [ ] **Step 1: Add a zone-label helper to `zone.ts`**

Append to `src/platform/dates/zone.ts`:

```ts
/** Friendly picker label for a zone id, e.g. "Eastern (New York)". */
export function zoneLabel(zone: string): string {
  return US_TIME_ZONES.find((z) => z.value === zone)?.label ?? zone;
}
```

- [ ] **Step 2: Interview input + action**
  - `interviews/[interviewId]/page.tsx`: this page is async; add `const zone = await getDisplayTimeZone();`. Replace the L46 prefill:
    `const scheduledValue = formatForDateTimeInput(iv.scheduledAt, zone);`
    Add a hint under the input at L78: `<p className="text-xs text-muted-foreground">Times are in {zoneLabel(zone)}.</p>`. Imports: `getDisplayTimeZone` from `@/platform/dates/resolve`, `zoneLabel` from `@/platform/dates/zone`; `formatForDateTimeInput` from `@/platform/dates`.
  - `interviews/actions.ts` L25: replace `const scheduledAt = rawAt ? new Date(rawAt) : null;` with:
    ```ts
    const scheduledAt = rawAt ? parseZonedInput(rawAt, await getDisplayTimeZone()) : null;
    ```
    Imports: `parseZonedInput` from `@/platform/dates`, `getDisplayTimeZone` from `@/platform/dates/resolve`.

- [ ] **Step 3: Window inputs + action + copy**
  - `cycles/[id]/page.tsx`: page is async; add `const zone = await getDisplayTimeZone();`. Reimplement `toLocalInput` (L25-30) to `formatForDateTimeInput(d, zone)` at each call, i.e. replace `defaultValue={toLocalInput(cycle.opensAt)}` -> `defaultValue={formatForDateTimeInput(cycle.opensAt, zone)}` (and `closesAt`), then delete `toLocalInput`. Replace the L155-157 copy sentence "Times use the server timezone." with "Times are in {zoneLabel(zone)}." Imports as in Step 2.
  - `recruitment/actions.ts` L117-118: replace both `new Date(rawOpens)`/`new Date(rawCloses)` with `parseZonedInput(rawOpens, zone)` / `parseZonedInput(rawCloses, zone)` where `const zone = await getDisplayTimeZone();` is resolved once above them. Imports as in Step 2.

- [ ] **Step 4: Campaign input + action + copy**
  - `admin/email/campaigns/[id]/page.tsx`: the page is async; add `const zone = await getDisplayTimeZone();` where the JSX is built. Change label L393 `<Field label="Send at (UTC)">` -> `<Field label={`Send at (${zoneLabel(zone)})`}>`. Change L404 copy to: "The send time is interpreted in {zoneLabel(zone)}." Change the cron copy L418-419 to keep UTC execution but add an ET note:
    ```tsx
    Cron format: minute hour day month weekday, evaluated in UTC (recurring
    schedules run on UTC, independent of the display zone). Example:{" "}
    <code className="font-mono">0 13 * * 1</code> = Mondays 13:00 UTC (9:00 AM ET in summer).
    ```
    In `scheduleLaterAction` (the page's own action, L193): replace `const scheduledAt = new Date(raw);` with `const scheduledAt = parseZonedInput(raw, await getDisplayTimeZone());` and guard `if (!scheduledAt) { /* existing invalid-input path */ }`. Imports: `parseZonedInput` from `@/platform/dates`, `getDisplayTimeZone` from `@/platform/dates/resolve`, `zoneLabel` from `@/platform/dates/zone`.
  - Leave `src/platform/email/campaigns/cron.ts` (`tz: "UTC"`) unchanged: recurring cron stays UTC, matching the copy.

- [ ] **Step 5: Terms copy**
  - `admin/terms/[id]/page.tsx` L201: replace "All dates are stored and rendered in UTC." with "These are calendar dates with no time of day, so they read the same in every time zone."

- [ ] **Step 6: Verify + commit**

Run: `npx tsc --noEmit && npm run lint`
```bash
git add -A src/app/\(app\)/recruitment src/app/\(app\)/admin src/platform/dates/zone.ts
git commit -m "feat(dates): interpret datetime-local inputs in the display zone; fix UTC copy"
```

### Task 14: Non-JSX emails, PDFs, and cron routes

**Files:** `src/platform/email/shift-reminders.ts`, `src/modules/recruitment/services/interviews.ts`, `src/modules/recruitment/services/portal-status.ts`, `src/modules/schedule/services/requests.ts`, `src/app/api/cron/schedule-reminders/route.ts`, `src/modules/support/services/itcm-pdf.ts`, `src/app/api/support/epic/generate/route.ts`, `src/modules/incidents/services/report.ts`, `src/modules/clinic/avs/build-summary.ts`.

- [ ] **Step 1: Calendar-date email/route fixes (no zone needed)**
  - `shift-reminders.ts` L67: replace the `targetDate.toLocaleDateString("en-US", { ..., timeZone: "America/New_York" })` block with `formatCalendarDate(targetDate, { weekday: "long", month: "long", day: "numeric", year: "numeric" })`. `import { formatCalendarDate } from "@/platform/dates";`. (`buildShiftReminders` stays sync; calendar needs no zone. Leave the `isoDateKey` import.)
  - `schedule/services/requests.ts` L243-245: reimplement `fmtEmailDate` body -> `return formatCalendarDate(d, { month: "long", day: "numeric", year: "numeric" });` (fixes the current server-local bug). Add `import { formatCalendarDate } from "@/platform/dates";`. All 12 call sites untouched. Keep `isoDateKey`.
  - `api/cron/schedule-reminders/route.ts` L84 + L88: replace both `toLocaleDateString("en-US", { ... })` (no timeZone) with `formatCalendarDate(pending.requesterDate, { <same opts> })` and `formatCalendarDate(pending.targetDate, { month: "long", day: "numeric", year: "numeric" })`. Import `formatCalendarDate`.

- [ ] **Step 2: Instant email/PDF fixes (resolve zone; these are async)**
  - `interviews.ts` L181: replace with `const zone = await getDisplayTimeZone(); const interviewTime = formatDateTime(iv.scheduledAt, zone, { dateStyle: "full", timeStyle: "short" });`. Imports: `getDisplayTimeZone` from `@/platform/dates/resolve`, `formatDateTime` from `@/platform/dates`.
  - `portal-status.ts` L85: if the enclosing function is async, `const zone = await getDisplayTimeZone(); const when = formatDateTime(scheduledInterview.scheduledAt, zone, { dateStyle: "long", timeStyle: "short" });`. If it is sync, thread `zone` in from its async caller as a parameter. (Verify async-ness before editing.)
  - `itcm-pdf.ts` L202 (`generatePdf` is async): `const zone = await getDisplayTimeZone(); const today = formatDateOnly(new Date(), zone, { month: "2-digit", day: "2-digit", year: "numeric" });`. Imports as above.
  - `api/support/epic/generate/route.ts` L120 (async): same pattern as itcm-pdf for `today`. L309-310 filename `dateStr`: `const zone = await getDisplayTimeZone(); const dateStr = formatForDateInput(new Date(), zone).replace(/-/g, "").replace(/^(\d{4})(\d{2})(\d{2})$/, "$2$3$1");` OR simpler, build MMDDYYYY from `formatDateOnly(new Date(), zone, { month:"2-digit", day:"2-digit", year:"numeric" })` stripped of "/". Keep it a filename-safe string.
  - `incidents/services/report.ts` L1007: if the function is async, `const zone = await getDisplayTimeZone(); const issuedDate = formatDateOnly(new Date(), zone, { <same opts as current> });`. If sync, thread `zone` from the caller.

- [ ] **Step 3: AVS client-side PDF (calendar-date correctness fix, no setting)**
  - `clinic/avs/build-summary.ts` L19-27: this runs client-side and receives date-only strings, so it must not depend on the server zone. Rewrite `formatDate` to anchor on UTC so a "YYYY-MM-DD" never shifts:
    ```ts
    function formatDate(iso: string, lang: Lang): string {
      if (!iso) return "";
      const [y, m, d] = iso.split("-").map(Number);
      if (!y || !m || !d) return iso;
      return new Intl.DateTimeFormat(lang === "es" ? "es" : "en-US", {
        timeZone: "UTC", year: "numeric", month: "long", day: "numeric",
      }).format(new Date(Date.UTC(y, m - 1, d)));
    }
    ```
    (This keeps the `Intl.DateTimeFormat` local to a leaf module. The Task 17 guard bans only `toLocaleDateString`/`toLocaleTimeString`, so this passes.)

- [ ] **Step 4: Cron route header comments**
  - In `api/cron/shift-reminders/route.ts` (L5) and `api/cron/reminders/route.ts` (L3/L6/L15), leave the "13:00 UTC" schedule facts (crons truly run in UTC) but append ", 9:00 AM ET in summer" to the human-facing comment lines for clarity. Comments only; no logic change.

- [ ] **Step 5: Verify + commit**

Run: `npx tsc --noEmit && npm run lint && npx vitest run src/modules/schedule src/platform/email`
Expected: PASS.
```bash
git add -A src/platform/email src/modules/recruitment src/modules/schedule src/app/api src/modules/support src/modules/incidents src/modules/clinic
git commit -m "feat(dates): zone-aware email/PDF timestamps; stabilize AVS + calendar email dates"
```

### Task 15: Client components (certificate-viewer, epic-request-tabs)

**Files:** `src/modules/my-info/components/certificate-viewer.tsx`, `src/modules/support/components/epic-request-tabs.tsx`.

- [ ] **Step 1: epic-request-tabs (instants + businessDaysSince)**
  - Add `import { useTimeZone } from "@/platform/dates/client"; import { formatDateOnly } from "@/platform/dates";` and keep the `businessDaysSince` import.
  - In `TrackerTable`, near the top of the component body: `const zone = useTimeZone();`.
  - L256: `const days = businessDaysSince(new Date(ticket.submittedAt), new Date(), zone);`
  - L265: `Submitted {formatDateOnly(new Date(ticket.submittedAt), zone)} by {ticket.submittedBy.name}`
  - In `HistoryTable`: `const zone = useTimeZone();` then L329-330 key `const key = formatDateOnly(new Date(row.ticket.closedAt ?? row.ticket.submittedAt), zone, { month: "long", year: "numeric" });`; L350 `Submitted {formatDateOnly(new Date(ticket.submittedAt), zone)} ...`; L351 `Closed {formatDateOnly(new Date(ticket.closedAt), zone)}`.

- [ ] **Step 2: certificate-viewer (date input max in clinic-local today)**
  - Add `import { useTimeZone } from "@/platform/dates/client"; import { formatForDateInput } from "@/platform/dates";`.
  - Add `const zone = useTimeZone();` in the component body.
  - Replace L113-114 `const today = new Date().toLocaleDateString("en-CA");` with `const today = formatForDateInput(new Date(), zone);` (keeps the input `max` at clinic-local today). Leave the `completionDate` input value logic (L79-81, UTC calendar day) as-is: it is a calendar marker and UTC is correct.

- [ ] **Step 3: Verify + commit**

Run: `npx tsc --noEmit && npm run lint`
```bash
git add -A src/modules/support src/modules/my-info
git commit -m "feat(dates): client components read zone from context for timestamps"
```

### Task 16: Remove legacy shims + guard test + full verification

**Files:**
- Modify: `src/platform/dates/index.ts` (delete `fmtDate`/`fmtDateTime`)
- Modify: `src/platform/dates/logic.test.ts` (remove the legacy-shim test block)
- Create: `src/platform/dates/no-raw-locale.guard.test.ts`

- [ ] **Step 1: Confirm no remaining consumers of the shims**

Run: `grep -rn "fmtDate\b\|fmtDateTime\b" src --include=*.ts --include=*.tsx | grep -v "src/platform/dates/"`
Expected: **no output**. If any line appears, migrate it using the transformation rules before continuing.

- [ ] **Step 2: Delete the shims**

Remove the two legacy functions (and their comment banner) from `src/platform/dates/index.ts`, and delete the "fmtDate / fmtDateTime legacy shims" `describe` block from `src/platform/dates/logic.test.ts`.

- [ ] **Step 3: Write the guard test**

```ts
// src/platform/dates/no-raw-locale.guard.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

/**
 * Guards the Eastern Time migration: no display code may call the raw
 * date-only/time-only locale methods. All date rendering goes through
 * src/platform/dates. (Number .toLocaleString() is unaffected and allowed.)
 */
describe("no raw locale date formatting outside src/platform/dates", () => {
  it("has zero toLocaleDateString/toLocaleTimeString calls in app code", () => {
    const files = execSync(
      "git ls-files 'src/**/*.ts' 'src/**/*.tsx'",
      { encoding: "utf8" }
    )
      .split("\n")
      .filter(Boolean)
      .filter((f) => !f.startsWith("src/platform/dates/")) // the one allowed home
      .filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"));

    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (/\.toLocaleDateString\(|\.toLocaleTimeString\(/.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 4: Full local verification**

Run:
```bash
npx tsc --noEmit
npm run lint
npx vitest run
```
Expected: all PASS, including the guard test (empty offenders) and the DST format tests. Fix any offender the guard surfaces by migrating it, then re-run.

- [ ] **Step 5: Commit**

```bash
git add -A src/platform/dates
git commit -m "feat(dates): remove legacy fmtDate/fmtDateTime and add raw-locale guard test"
```

---

### Task 17: End-to-end verification and PR

- [ ] **Step 1: Manual smoke via the run skill**

Start the app and confirm, in the browser, that: an audit-log or admin/email timestamp reads like "Jun 13, 2026, 9:05 AM EDT"; a clinic date still reads "Jun 13, 2026" (unchanged); the `/admin/settings` page shows a "Display time zone" select defaulting to Eastern; changing it to Pacific re-renders timestamps with "PDT/PST"; the interview/campaign datetime-local hint says "Times are in Eastern (New York)".

- [ ] **Step 2: Run the Playwright suite**

Run: `npx playwright test` (workers:1 per repo config).
Expected: PASS. If a spec asserts a literal "UTC" timestamp string, update the assertion to the zoned format (these are expected, intended changes).

- [ ] **Step 3: Open the PR**

```bash
git push -u origin feat/eastern-time-display
gh pr create --title "Display all timestamps in a configurable time zone (default Eastern)" \
  --body "Implements docs/superpowers/specs/2026-07-12-eastern-time-display-design.md. Real timestamps now render in the admin-set display.timeZone (default America/New_York) with DST-correct labels; the 3 datetime-local inputs interpret typed values in that zone; calendar-day markers stay UTC-stable. Adds a guard test against raw locale date formatting."
```

- [ ] **Step 4: Confirm CI is green** on the PR before requesting review.

---

## Self-review

**Spec coverage:**
- Timestamp display in configured zone -> Tasks 4, 6-11, 15 (components) + 14 (non-JSX). Covered.
- `datetime-local` inputs interpret in zone -> Task 13. Covered.
- Calendar markers stay UTC -> `<CalendarDate>`/`formatCalendarDate` (Tasks 2, 4) applied in 6, 8, 9, 10, 12, 14. Covered.
- Global admin setting + env var -> Task 1. Covered.
- Client-context threading (2 components) -> Tasks 5, 15. Covered.
- Emails/PDFs/cron copy -> Tasks 13, 14. Covered.
- `businessDaysSince` zone-aware -> Task 3 (impl) + 15 (call). Covered.
- Remove legacy names + guard test -> Task 16. Covered.
- DST correctness (parse + format) -> Task 2 tests. Covered.

**Placeholder scan:** No TBD/TODO. Every code step shows full code; every migration site names its exact replacement and kind. The two "verify async-ness / verify use-client" notes (person-form, ticket-detail, portal-status, incidents report) are explicit conditional instructions with both branches specified, not placeholders.

**Type consistency:** `getDisplayTimeZone(): Promise<DisplayTimeZone>`, `formatDateTime(d, zone, opts?, fallback?)`, `formatCalendarDate(d, opts?, fallback?)`, `parseZonedInput(wall, zone): Date | null`, `formatForDateTimeInput(d, zone)`, `formatForDateInput(d, zone)`, `businessDaysSince(start, now?, zone?)`, components `{ value, fallback?, opts? }`, `useTimeZone(): string`, `TimeZoneProvider({ zone, children })`, `zoneLabel(zone)` — all referenced consistently across tasks.
