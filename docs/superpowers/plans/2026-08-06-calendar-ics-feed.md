# Calendar ICS Feed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a member subscribe to their own HAVEN shifts from Google Calendar via a personal, revocable ICS URL that keeps itself up to date.

**Architecture:** A pure ICS-building module turns shift rows into an RFC 5545 document. A thin feed module reads the two new clinic-hours settings, calls the existing `mySchedule(personId)` so term selection and publication gating stay in exactly one place, and hands the result to the builder. An unauthenticated `/api/calendar/[token]` route resolves a long-lived plaintext token to a person and serves the document. A card on My Info issues, displays, and rotates the token.

**Tech Stack:** Next.js App Router (Node runtime), Prisma + Postgres, Vitest, Tailwind with the in-repo `Card`/`Button` primitives.

## Global Constraints

- **No em-dashes anywhere**, in code, comments, docs, or UI copy. CI enforces this with the `local/no-em-dash` ESLint rule and the build fails on a violation.
- **Lint with `npx eslint src e2e`**, not `npm run lint`. The bare command walks a gitignored design-system directory and reports noise.
- **Modules go through platform.** Code in `src/modules/**` must not import from another module's internals; shared helpers live in `src/platform/**`.
- **No `Date.now()` or `new Date()` inside render.** Pass an explicit `now` parameter so output is deterministic and testable.
- Dates in this codebase are noon-UTC anchored calendar dates. Compare by UTC day key using `isoDateKey`, never by raw timestamp.
- Prisma `{ not: x }` filters silently drop NULL rows. Use an explicit `OR` with `field: null` when NULL must be included.
- Tests are Vitest. Unit tests run with `npm test`. Tests that touch the database need `npm run test:prepare` first.
- **There is no `@testing-library/react` in this repo.** Component tests render with `renderToStaticMarkup` from `react-dom/server` in the default node environment and assert on the returned HTML string. Do not add a testing-library dependency.
- Server components cannot carry event handlers. Anything using `onClick`, `onFocus`, or a hook belongs in its own `"use client"` file.

---

## Preflight: green baseline

Do this once before Task 1. Do not skip it; a dirty baseline makes every later failure ambiguous.

- [ ] **Step 1: Start the test database**

```bash
npm run db:up
```

- [ ] **Step 2: Prepare the test schema**

```bash
npm run test:prepare
```

- [ ] **Step 3: Run the full suite and confirm it is green**

```bash
npm test
```

Expected: all tests pass. If anything fails before you have written a line of code, stop and report it rather than proceeding.

---

## File Structure

**Create:**
- `prisma/migrations/20260806000000_calendar_feed_token/migration.sql` - the new table
- `src/modules/schedule/calendar/ics.ts` - pure RFC 5545 builder, no database, no settings
- `src/modules/schedule/calendar/ics.test.ts`
- `src/modules/schedule/calendar/feed-token.ts` - issue, resolve, rotate, touch
- `src/modules/schedule/calendar/feed-token.test.ts`
- `src/modules/schedule/calendar/feed.ts` - assembles settings + `mySchedule` + builder
- `src/modules/schedule/calendar/feed.test.ts`
- `src/app/api/calendar/[token]/route.ts`
- `src/app/api/calendar/[token]/route.test.ts`
- `src/modules/my-info/components/calendar-subscribe-card.tsx` - server component
- `src/modules/my-info/components/calendar-feed-url.tsx` - client component for copy and select-on-focus
- `src/modules/my-info/components/calendar-subscribe-card.test.tsx`

**Modify:**
- `prisma/schema.prisma` - add `CalendarFeedToken`, add the back-relation on `Person`
- `src/platform/settings/registry.ts` - two clinic-hours settings
- `src/platform/test/db.ts` - add the new table to the `resetDb` TRUNCATE list
- `src/app/(app)/my-info/page.tsx` - render the card, add two server actions

The split keeps the fiddly RFC correctness (`ics.ts`) free of any database or settings dependency so it is exhaustively testable in isolation, and keeps the credential logic (`feed-token.ts`) separate from the rendering path.

---

## Task 1: Clinic-hours settings

**Files:**
- Modify: `src/platform/settings/registry.ts` (append to the `SETTINGS` array, after the `display.timeZone` entry near line 306)
- Test: `src/platform/settings/registry.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: two setting keys readable with `getSetting<string>("schedule.clinicStartTime")` and `getSetting<string>("schedule.clinicEndTime")`. Both resolve to a `HH:MM` 24-hour string, for example `"08:00"` and `"13:00"`.

Note: `envDefault` does not have to come from env. Literal defaults are an established pattern in this file, for example `envDefault: () => "HAVEN Hub"` on `branding.orgName`. Do not add new env vars for this.

- [ ] **Step 1: Write the failing test**

Append to `src/platform/settings/registry.test.ts`:

```ts
describe("clinic hours settings", () => {
  it("registers a start and end time with HH:MM defaults", () => {
    expect(getSettingDef("schedule.clinicStartTime").envDefault()).toBe("08:00");
    expect(getSettingDef("schedule.clinicEndTime").envDefault()).toBe("13:00");
  });

  it("accepts a valid 24-hour time", () => {
    expect(getSettingDef("schedule.clinicStartTime").schema.safeParse("09:30").success).toBe(true);
    expect(getSettingDef("schedule.clinicEndTime").schema.safeParse("23:59").success).toBe(true);
  });

  it("rejects malformed, 12-hour, and out-of-range times", () => {
    const schema = getSettingDef("schedule.clinicStartTime").schema;
    expect(schema.safeParse("8:00").success).toBe(false);
    expect(schema.safeParse("08:00 AM").success).toBe(false);
    expect(schema.safeParse("24:00").success).toBe(false);
    expect(schema.safeParse("08:60").success).toBe(false);
    expect(schema.safeParse("").success).toBe(false);
  });

  // The admin form saves ONE setting key per POST, so a guard on only one of
  // the pair leaves the other field free to invert the window. Both directions
  // are covered here.
  it("rejects an end time that is not after the start time", async () => {
    const def = getSettingDef("schedule.clinicEndTime");
    const ctx = { config, getSetting: async () => "08:00" };
    expect(await def.validate!("07:00", ctx)).toEqual(expect.any(String));
    expect(await def.validate!("08:00", ctx)).toEqual(expect.any(String));
  });

  it("accepts an end time after the start time", async () => {
    const def = getSettingDef("schedule.clinicEndTime");
    expect(await def.validate!("13:00", { config, getSetting: async () => "08:00" })).toBeNull();
  });

  it("rejects a start time that is not before the end time", async () => {
    const def = getSettingDef("schedule.clinicStartTime");
    const ctx = { config, getSetting: async () => "13:00" };
    expect(await def.validate!("14:00", ctx)).toEqual(expect.any(String));
    expect(await def.validate!("13:00", ctx)).toEqual(expect.any(String));
  });

  it("accepts a start time before the end time", async () => {
    const def = getSettingDef("schedule.clinicStartTime");
    expect(await def.validate!("08:00", { config, getSetting: async () => "13:00" })).toBeNull();
  });
});
```

Import `config` from `@/platform/config` in the test file if it is not already
imported. Build the `SettingValidateCtx` the same shape `setSetting` in
`src/platform/settings/service.ts` builds it, so the test seam matches
production rather than inventing one.

Make sure `getSettingDef` is imported at the top of the test file; add it to the existing import from `./registry` if it is not already there.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/platform/settings/registry.test.ts`
Expected: FAIL with `Unregistered setting key: schedule.clinicStartTime`

- [ ] **Step 3: Add the two settings**

In `src/platform/settings/registry.ts`, add near the top with the other module-level constants:

```ts
/** 24-hour HH:MM, 00:00 through 23:59. */
const TIME_OF_DAY = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour HH:MM, for example 08:00");
```

Then append these two entries to the `SETTINGS` array, immediately after the `display.timeZone` definition:

```ts
  define<string>({
    key: "schedule.clinicStartTime",
    category: "Operations",
    label: "Clinic start time",
    help: "When a clinic day begins, in the display time zone. Shifts are date-only in the Hub, so exported calendar events use this window.",
    input: { type: "text" },
    schema: TIME_OF_DAY,
    envDefault: () => "08:00",
    secret: false,
    validate: async (value, ctx) => {
      const end = await ctx.getSetting<string>("schedule.clinicEndTime");
      return value < end ? null : "Start time must be earlier than the clinic end time.";
    },
  }),
  define<string>({
    key: "schedule.clinicEndTime",
    category: "Operations",
    label: "Clinic end time",
    help: "When a clinic day ends, in the display time zone. Must be later than the start time.",
    input: { type: "text" },
    schema: TIME_OF_DAY,
    envDefault: () => "13:00",
    secret: false,
    validate: async (value, ctx) => {
      const start = await ctx.getSetting<string>("schedule.clinicStartTime");
      return value > start ? null : "End time must be later than the clinic start time.";
    },
  }),
```

The guards compare `HH:MM` strings directly, which is safe because `validate`
only runs after `schema.safeParse`, so both operands are already zero-padded
fixed-width 24-hour times, and those sort lexicographically in chronological
order.

Both settings carry a guard on purpose. The admin form submits one setting key
per POST, so a guard on only the end time would let an admin move the start
time past it and persist an inverted window with no error. Events built from an
inverted window would have `DTEND` before `DTSTART`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/platform/settings/registry.test.ts`
Expected: PASS

- [ ] **Step 5: Verify the admin form still renders**

Run: `npm run typecheck`
Expected: no errors. The settings page renders from the registry, so no page change is needed.

- [ ] **Step 6: Commit**

```bash
git add src/platform/settings/registry.ts src/platform/settings/registry.test.ts
git commit -m "feat(settings): add configurable clinic start and end times"
```

---

## Task 2: CalendarFeedToken model and token service

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260806000000_calendar_feed_token/migration.sql`
- Create: `src/modules/schedule/calendar/feed-token.ts`
- Modify: `src/platform/test/db.ts`
- Test: `src/modules/schedule/calendar/feed-token.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `issueFeedToken(personId: string): Promise<string>` returns the raw token, creating or overwriting the person's row.
  - `resolveFeedToken(token: string): Promise<{ personId: string } | null>`
  - `readFeedToken(personId: string): Promise<{ token: string; lastFetchedAt: Date | null } | null>`
  - `touchFeedToken(personId: string, now?: Date): Promise<void>`

- [ ] **Step 1: Add the model to the schema**

In `prisma/schema.prisma`, add the model near the other token models (`ApplicantPortalToken`, `MemberLoginToken`):

```prisma
/// Long-lived, revocable credential for a member's personal calendar feed.
/// Stored in PLAINTEXT on purpose: the member must be able to re-read this URL
/// months later to add the calendar on a second device, and a hash cannot be
/// reversed. Same tradeoff Google Calendar makes with its own secret iCal
/// address. The feed exposes shift dates only and contains no patient data.
model CalendarFeedToken {
  personId      String    @id
  token         String    @unique
  createdAt     DateTime  @default(now())
  /// Last time a calendar client fetched the feed. Written at most hourly so an
  /// unauthenticated endpoint cannot amplify writes.
  lastFetchedAt DateTime?
  /// Cascade: the feed belongs to the person and dies with them.
  person        Person    @relation(fields: [personId], references: [id], onDelete: Cascade)
}
```

Then add the back-relation to the `Person` model, alongside its other relation fields:

```prisma
  calendarFeedToken    CalendarFeedToken?
```

- [ ] **Step 2: Write the migration by hand**

Do not run `prisma migrate dev`. It folds any pre-existing drift in this database into your migration. Create `prisma/migrations/20260806000000_calendar_feed_token/migration.sql` with exactly:

```sql
-- CreateTable
CREATE TABLE "CalendarFeedToken" (
    "personId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastFetchedAt" TIMESTAMP(3),

    CONSTRAINT "CalendarFeedToken_pkey" PRIMARY KEY ("personId")
);

-- CreateIndex
CREATE UNIQUE INDEX "CalendarFeedToken_token_key" ON "CalendarFeedToken"("token");

-- AddForeignKey
ALTER TABLE "CalendarFeedToken" ADD CONSTRAINT "CalendarFeedToken_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 3: Apply the migration and regenerate the client**

```bash
npx prisma migrate deploy
npx prisma generate
npm run test:prepare
```

If `prisma.calendarFeedToken` is still missing from types afterwards, the generated client is stale. Re-run `npx prisma generate` and restart the TS server.

- [ ] **Step 4: Add the new table to the test reset helper**

In `src/platform/test/db.ts`, add `"CalendarFeedToken"` to the TRUNCATE list, next to the other token tables on the last line:

```ts
              "ApplicantPortalToken", "MemberLoginToken", "CalendarFeedToken" CASCADE`
```

The `CASCADE` on `Person` would reach it anyway through the foreign key, but every other table in this helper is named explicitly and a future reader should not have to reason about cascade ordering to know the table is cleaned.

- [ ] **Step 5: Write the failing test**

There is no person factory in this codebase. Tests create rows with `prisma.person.create` directly, which is the convention to follow. Create `src/modules/schedule/calendar/feed-token.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { issueFeedToken, resolveFeedToken, readFeedToken, touchFeedToken } from "./feed-token";

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

function makePerson() {
  return prisma.person.create({ data: { name: "Ada Lovelace", status: "ACTIVE" } });
}

describe("feed tokens", () => {
  it("issues a token that resolves back to the person", async () => {
    const person = await makePerson();
    const token = await issueFeedToken(person.id);

    expect(token.length).toBeGreaterThan(30);
    expect(await resolveFeedToken(token)).toEqual({ personId: person.id });
  });

  it("keeps exactly one row per person and invalidates the old token on reissue", async () => {
    const person = await makePerson();
    const first = await issueFeedToken(person.id);
    const second = await issueFeedToken(person.id);

    expect(second).not.toBe(first);
    expect(await prisma.calendarFeedToken.count({ where: { personId: person.id } })).toBe(1);
    expect(await resolveFeedToken(first)).toBeNull();
    expect(await resolveFeedToken(second)).toEqual({ personId: person.id });
  });

  it("returns null for an unknown token", async () => {
    expect(await resolveFeedToken("not-a-real-token")).toBeNull();
  });

  it("reads back the stored token for display", async () => {
    const person = await makePerson();
    const token = await issueFeedToken(person.id);

    expect(await readFeedToken(person.id)).toEqual({ token, lastFetchedAt: null });
  });

  it("returns null when the person has never generated a feed", async () => {
    const person = await makePerson();
    expect(await readFeedToken(person.id)).toBeNull();
  });

  // Regression: a never-fetched token has lastFetchedAt NULL. A `{ not: cutoff }`
  // style filter would silently drop that row and the first fetch would never record.
  it("records the first fetch on a never-fetched token", async () => {
    const person = await makePerson();
    await issueFeedToken(person.id);

    const now = new Date("2026-08-06T12:00:00Z");
    await touchFeedToken(person.id, now);

    expect((await readFeedToken(person.id))?.lastFetchedAt).toEqual(now);
  });

  it("does not rewrite lastFetchedAt within the hour", async () => {
    const person = await makePerson();
    await issueFeedToken(person.id);

    const first = new Date("2026-08-06T12:00:00Z");
    await touchFeedToken(person.id, first);
    await touchFeedToken(person.id, new Date("2026-08-06T12:30:00Z"));

    expect((await readFeedToken(person.id))?.lastFetchedAt).toEqual(first);
  });

  it("rewrites lastFetchedAt once an hour has passed", async () => {
    const person = await makePerson();
    await issueFeedToken(person.id);

    await touchFeedToken(person.id, new Date("2026-08-06T12:00:00Z"));
    const later = new Date("2026-08-06T13:30:00Z");
    await touchFeedToken(person.id, later);

    expect((await readFeedToken(person.id))?.lastFetchedAt).toEqual(later);
  });

  it("drops the feed when the person is deleted", async () => {
    const person = await makePerson();
    await issueFeedToken(person.id);

    await prisma.person.delete({ where: { id: person.id } });

    expect(await prisma.calendarFeedToken.count()).toBe(0);
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run src/modules/schedule/calendar/feed-token.test.ts`
Expected: FAIL, cannot resolve `./feed-token`

- [ ] **Step 7: Write the implementation**

Create `src/modules/schedule/calendar/feed-token.ts`:

```ts
/**
 * Personal calendar-feed credentials.
 *
 * The token is stored in plaintext by design. A calendar subscription URL has
 * to stay re-readable so a member can add it on a second device months later,
 * and a hash cannot be reversed. The feed carries shift dates only, no patient
 * data, and rotation is one click.
 */

import { randomBytes } from "node:crypto";
import { prisma } from "@/platform/db";

/** Minimum gap between lastFetchedAt writes. Bounds write volume on a public endpoint. */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

/** Create or replace this person's feed token and return it. */
export async function issueFeedToken(personId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await prisma.calendarFeedToken.upsert({
    where: { personId },
    create: { personId, token },
    // Rotation: overwrite in place and clear the fetch history so the card does
    // not report a fetch that belonged to the previous URL.
    update: { token, lastFetchedAt: null, createdAt: new Date() },
  });
  return token;
}

/** Resolve a raw token to its owner, or null when it does not exist. */
export async function resolveFeedToken(token: string): Promise<{ personId: string } | null> {
  return prisma.calendarFeedToken.findUnique({
    where: { token },
    select: { personId: true },
  });
}

/** The person's current feed token and fetch history, for the My Info card. */
export async function readFeedToken(
  personId: string,
): Promise<{ token: string; lastFetchedAt: Date | null } | null> {
  return prisma.calendarFeedToken.findUnique({
    where: { personId },
    select: { token: true, lastFetchedAt: true },
  });
}

/** Record a fetch, at most once per hour. */
export async function touchFeedToken(personId: string, now: Date = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - TOUCH_INTERVAL_MS);
  await prisma.calendarFeedToken.updateMany({
    // Explicit OR on null: Prisma's `not` filter drops NULL rows, so a
    // never-fetched token would never record its very first fetch.
    where: { personId, OR: [{ lastFetchedAt: null }, { lastFetchedAt: { lt: cutoff } }] },
    data: { lastFetchedAt: now },
  });
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run src/modules/schedule/calendar/feed-token.test.ts`
Expected: PASS, 9 tests

- [ ] **Step 9: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260806000000_calendar_feed_token src/platform/test/db.ts src/modules/schedule/calendar/feed-token.ts src/modules/schedule/calendar/feed-token.test.ts
git commit -m "feat(schedule): add calendar feed token model and service"
```

---

## Task 3: Pure ICS builder

**Files:**
- Create: `src/modules/schedule/calendar/ics.ts`
- Test: `src/modules/schedule/calendar/ics.test.ts`

**Interfaces:**
- Consumes: nothing. This module imports no database, no settings, no Next.js.
- Produces:
  - `type CalendarEvent = { uid: string; start: Date; end: Date; summary: string; description: string }`
  - `type CalendarOptions = { calendarName: string; timeZone: string; now: Date }`
  - `buildCalendar(events: CalendarEvent[], opts: CalendarOptions): string`
  - `escapeText(value: string): string`
  - `foldLine(line: string): string`
  - `formatUtcStamp(d: Date): string`

- [ ] **Step 1: Write the failing test**

Create `src/modules/schedule/calendar/ics.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildCalendar, escapeText, foldLine, formatUtcStamp, type CalendarEvent } from "./ics";

const NOW = new Date("2026-08-06T15:00:00.000Z");

const OPTS = { calendarName: "HAVEN Hub", timeZone: "America/New_York", now: NOW };

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    uid: "shift-abc123@havenhub.test",
    start: new Date("2026-02-08T13:00:00.000Z"),
    end: new Date("2026-02-08T18:00:00.000Z"),
    summary: "HAVEN Hub: Internal Medicine",
    description: "Volunteer",
    ...overrides,
  };
}

describe("formatUtcStamp", () => {
  it("renders an instant as a compact UTC date-time", () => {
    expect(formatUtcStamp(new Date("2026-02-08T13:00:00.000Z"))).toBe("20260208T130000Z");
  });
});

describe("escapeText", () => {
  it("escapes backslash, semicolon, comma, and newline", () => {
    expect(escapeText("a\\b;c,d\ne")).toBe("a\\\\b\\;c\\,d\\ne");
  });

  it("escapes the backslash before anything else, so escapes are not double-escaped", () => {
    expect(escapeText("100\\%")).toBe("100\\\\%");
  });

  it("normalizes CRLF to a single escaped newline", () => {
    expect(escapeText("a\r\nb")).toBe("a\\nb");
  });

  it("leaves ordinary text untouched", () => {
    expect(escapeText("Internal Medicine")).toBe("Internal Medicine");
  });
});

describe("foldLine", () => {
  it("leaves a line of 75 octets or fewer alone", () => {
    const line = "X".repeat(75);
    expect(foldLine(line)).toBe(line);
  });

  it("folds a long line with CRLF plus a leading space", () => {
    const folded = foldLine("X".repeat(80));
    expect(folded).toBe(`${"X".repeat(75)}\r\n ${"X".repeat(5)}`);
  });

  it("counts octets, not characters, so multi-byte text folds early", () => {
    // Each emoji is 4 octets, so 20 of them is 80 octets and must fold.
    expect(foldLine("\u{1F600}".repeat(20))).toContain("\r\n ");
  });

  // U+FFFD written as an escape, never as a literal glyph: a literal is exactly
  // the kind of character an editor or copy step silently mangles into "?",
  // which would turn this guard into a tautology that can never fail.
  it("never splits a multi-byte codepoint across a fold", () => {
    const folded = foldLine("\u{1F600}".repeat(20));
    for (const chunk of folded.split("\r\n ")) {
      expect(chunk).not.toContain("\uFFFD");
      expect(Buffer.from(chunk, "utf8").toString("utf8")).toBe(chunk);
    }
  });
});

describe("buildCalendar", () => {
  it("uses CRLF line endings throughout", () => {
    const ics = buildCalendar([event()], OPTS);
    expect(ics).toContain("\r\n");
    expect(ics.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("wraps events in a well-formed VCALENDAR", () => {
    const ics = buildCalendar([event()], OPTS);
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.trimEnd().endsWith("END:VCALENDAR")).toBe(true);
    expect(ics).toContain("VERSION:2.0");
    expect(ics).toContain("METHOD:PUBLISH");
  });

  it("emits the calendar name and time zone hints", () => {
    const ics = buildCalendar([event()], OPTS);
    expect(ics).toContain("X-WR-CALNAME:HAVEN Hub");
    expect(ics).toContain("X-WR-TIMEZONE:America/New_York");
    expect(ics).toContain("REFRESH-INTERVAL;VALUE=DURATION:PT12H");
  });

  it("emits start and end as UTC instants, so no VTIMEZONE is needed", () => {
    const ics = buildCalendar([event()], OPTS);
    expect(ics).toContain("DTSTART:20260208T130000Z");
    expect(ics).toContain("DTEND:20260208T180000Z");
    expect(ics).not.toContain("BEGIN:VTIMEZONE");
  });

  it("marks the event busy and confirmed", () => {
    const ics = buildCalendar([event()], OPTS);
    expect(ics).toContain("TRANSP:OPAQUE");
    expect(ics).toContain("STATUS:CONFIRMED");
  });

  it("stamps every event with the injected now, never a wall clock", () => {
    const ics = buildCalendar([event()], OPTS);
    expect(ics).toContain("DTSTAMP:20260806T150000Z");
  });

  it("keeps the UID stable across regenerations", () => {
    const a = buildCalendar([event()], OPTS);
    const b = buildCalendar([event()], { ...OPTS, now: new Date("2026-09-01T00:00:00.000Z") });
    expect(a).toContain("UID:shift-abc123@havenhub.test");
    expect(b).toContain("UID:shift-abc123@havenhub.test");
  });

  it("escapes a department name containing a comma", () => {
    const ics = buildCalendar([event({ summary: "HAVEN Hub: Cardiology, Adult" })], OPTS);
    expect(ics).toContain("SUMMARY:HAVEN Hub: Cardiology\\, Adult");
  });

  it("produces a valid empty calendar when there are no events", () => {
    const ics = buildCalendar([], OPTS);
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("END:VCALENDAR");
    expect(ics).not.toContain("BEGIN:VEVENT");
  });

  it("emits one VEVENT per shift", () => {
    const ics = buildCalendar([event({ uid: "a@x" }), event({ uid: "b@x" })], OPTS);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/modules/schedule/calendar/ics.test.ts`
Expected: FAIL, cannot resolve `./ics`

- [ ] **Step 3: Write the implementation**

Create `src/modules/schedule/calendar/ics.ts`:

```ts
/**
 * RFC 5545 (iCalendar) document builder.
 *
 * Pure module: no database, no settings, no Next.js. Every fiddly correctness
 * concern in the format lives here so it can be tested exhaustively in
 * isolation.
 *
 * Times are emitted as absolute UTC instants rather than zoned local times.
 * That deliberately avoids shipping a VTIMEZONE component, which is the most
 * error-prone part of hand-written iCalendar. Callers are responsible for
 * having already converted wall-clock clinic hours into instants.
 */

const CRLF = "\r\n";
const MAX_OCTETS = 75;

export type CalendarEvent = {
  /** Stable across regenerations so clients update in place instead of duplicating. */
  uid: string;
  start: Date;
  end: Date;
  summary: string;
  description: string;
};

export type CalendarOptions = {
  calendarName: string;
  /** Display hint only; the events themselves are absolute instants. */
  timeZone: string;
  /** Injected so output is deterministic and no clock is read during render. */
  now: Date;
};

/** An instant as an RFC 5545 UTC date-time, for example 20260208T130000Z. */
export function formatUtcStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** RFC 5545 TEXT escaping. Backslash goes first or later escapes get doubled. */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\n|\r/g, "\\n");
}

/**
 * Fold a content line to 75 octets, continuation lines prefixed with a space.
 * Folds on octet count rather than character count, and backs off to a
 * codepoint boundary so a multi-byte name is never split into mojibake.
 */
export function foldLine(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= MAX_OCTETS) return line;

  const chunks: string[] = [];
  let start = 0;
  // The first line gets the full budget; continuations spend one octet on the
  // leading space that marks them as a continuation.
  let budget = MAX_OCTETS;

  while (start < bytes.length) {
    let end = Math.min(start + budget, bytes.length);
    // 0b10xxxxxx marks a UTF-8 continuation byte. Walk back off one.
    while (end > start && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    chunks.push(bytes.subarray(start, end).toString("utf8"));
    start = end;
    budget = MAX_OCTETS - 1;
  }

  return chunks.join(`${CRLF} `);
}

/** Render events as a complete iCalendar document. */
export function buildCalendar(events: CalendarEvent[], opts: CalendarOptions): string {
  const stamp = formatUtcStamp(opts.now);

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//HAVEN Hub//Shift Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(opts.calendarName)}`,
    `X-WR-TIMEZONE:${opts.timeZone}`,
    // Honored by Apple Calendar, ignored by Google, free to emit.
    "REFRESH-INTERVAL;VALUE=DURATION:PT12H",
    "X-PUBLISHED-TTL:PT12H",
  ];

  for (const event of events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${event.uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${formatUtcStamp(event.start)}`,
      `DTEND:${formatUtcStamp(event.end)}`,
      `SUMMARY:${escapeText(event.summary)}`,
      `DESCRIPTION:${escapeText(event.description)}`,
      "STATUS:CONFIRMED",
      "TRANSP:OPAQUE",
      "END:VEVENT",
    );
  }

  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join(CRLF) + CRLF;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/modules/schedule/calendar/ics.test.ts`
Expected: PASS, 20 tests

- [ ] **Step 5: Commit**

```bash
git add src/modules/schedule/calendar/ics.ts src/modules/schedule/calendar/ics.test.ts
git commit -m "feat(schedule): add pure RFC 5545 calendar builder"
```

---

## Task 4: Feed assembly

**Files:**
- Create: `src/modules/schedule/calendar/feed.ts`
- Test: `src/modules/schedule/calendar/feed.test.ts`

**Interfaces:**
- Consumes: `buildCalendar`, `CalendarEvent` from Task 3. `getSetting` from `@/platform/settings/service`. `mySchedule` and `MyTermSchedule` from `../services/schedule`. `parseZonedInput` from `@/platform/dates/format`. `isoDateKey` from `@/platform/dates`. `getDisplayTimeZone` from `@/platform/dates/resolve`.
- Produces:
  - `shiftsToEvents(terms: MyTermSchedule[], ctx: FeedContext): CalendarEvent[]` where `FeedContext = { orgName: string; startTime: string; endTime: string; timeZone: string; host: string; baseUrl: string }`
  - `renderFeedForPerson(personId: string, now?: Date): Promise<string>`
  - `renderEmptyFeed(now?: Date): Promise<string>`

The wall-clock to instant conversion uses the existing, already-tested `parseZonedInput(wall, zone)` helper. Do not hand-roll offset math: that helper does a two-pass offset correction which is what makes DST come out right.

- [ ] **Step 1: Write the failing test**

Create `src/modules/schedule/calendar/feed.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { shiftsToEvents } from "./feed";
import type { MyTermSchedule } from "../services/schedule";

const CTX = {
  orgName: "HAVEN Hub",
  startTime: "08:00",
  endTime: "13:00",
  timeZone: "America/New_York",
  host: "hub.example.org",
  baseUrl: "https://hub.example.org",
};

/** Noon-UTC anchored calendar date, matching how the schema stores clinicDate. */
function clinicDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
}

function term(shifts: MyTermSchedule["shifts"]): MyTermSchedule {
  return {
    term: { id: "t1", name: "Spring 2026" },
    shifts,
    // The renderer reads only `term.name` and `shifts`; the rest of
    // MyTermSchedule is irrelevant here and is cast away.
  } as unknown as MyTermSchedule;
}

function shift(overrides: Partial<MyTermSchedule["shifts"][number]> = {}) {
  return {
    clinicDate: clinicDate(2026, 2, 8),
    department: { id: "d1", name: "Internal Medicine", code: "IM" },
    role: "VOLUNTEER",
    tags: { triage: false, walkin: false, cc: false, remote: false },
    ...overrides,
  } as MyTermSchedule["shifts"][number];
}

describe("shiftsToEvents", () => {
  it("places a shift in the configured local window", () => {
    // 08:00 America/New_York on 2026-02-08 is EST (UTC-5), so 13:00Z.
    const [event] = shiftsToEvents([term([shift()])], CTX);
    expect(event!.start.toISOString()).toBe("2026-02-08T13:00:00.000Z");
    expect(event!.end.toISOString()).toBe("2026-02-08T18:00:00.000Z");
  });

  it("shifts by an hour across the DST boundary, from the same configured window", () => {
    // 08:00 America/New_York on 2026-07-11 is EDT (UTC-4), so 12:00Z not 13:00Z.
    const [event] = shiftsToEvents([term([shift({ clinicDate: clinicDate(2026, 7, 11) })])], CTX);
    expect(event!.start.toISOString()).toBe("2026-07-11T12:00:00.000Z");
    expect(event!.end.toISOString()).toBe("2026-07-11T17:00:00.000Z");
  });

  it("names the event with the org name and department", () => {
    const [event] = shiftsToEvents([term([shift()])], CTX);
    expect(event!.summary).toBe("HAVEN Hub: Internal Medicine");
  });

  it("describes the role and the term", () => {
    const [event] = shiftsToEvents([term([shift()])], CTX);
    expect(event!.description).toContain("Volunteer");
    expect(event!.description).toContain("Spring 2026");
  });

  it("lists only the tags that are set", () => {
    const [event] = shiftsToEvents(
      [term([shift({ tags: { triage: true, walkin: false, cc: false, remote: true } })])],
      CTX,
    );
    expect(event!.description).toContain("Triage");
    expect(event!.description).toContain("Remote");
    expect(event!.description).not.toContain("Walk-in");
    expect(event!.description).not.toContain("Care coordinator");
  });

  it("links back to the schedule page", () => {
    const [event] = shiftsToEvents([term([shift()])], CTX);
    expect(event!.description).toContain("https://hub.example.org/schedule");
  });

  it("builds a UID that is stable for the same person, date, and department", () => {
    const a = shiftsToEvents([term([shift()])], CTX);
    const b = shiftsToEvents([term([shift()])], CTX);
    expect(a[0]!.uid).toBe(b[0]!.uid);
    expect(a[0]!.uid).toContain("@hub.example.org");
  });

  it("gives different departments on the same day different UIDs", () => {
    const events = shiftsToEvents(
      [
        term([
          shift(),
          shift({ department: { id: "d2", name: "Pediatrics", code: "PEDS" } }),
        ]),
      ],
      CTX,
    );
    expect(events[0]!.uid).not.toBe(events[1]!.uid);
  });

  it("flattens shifts across multiple terms", () => {
    const events = shiftsToEvents([term([shift()]), term([shift({ clinicDate: clinicDate(2026, 9, 5) })])], CTX);
    expect(events).toHaveLength(2);
  });

  it("returns nothing for a member with no shifts", () => {
    expect(shiftsToEvents([term([])], CTX)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/modules/schedule/calendar/feed.test.ts`
Expected: FAIL, cannot resolve `./feed`

- [ ] **Step 3: Write the implementation**

Create `src/modules/schedule/calendar/feed.ts`:

```ts
/**
 * Assembles a member's calendar feed.
 *
 * Deliberately routes through mySchedule() rather than querying
 * ShiftAssignment directly. Term selection and the publication gating that
 * hides an unpublished next-term schedule already live there and are already
 * tested. A second copy of that rule is a second place for it to drift, and
 * drift in that direction leaks an unpublished schedule.
 */

import type { ShiftRole } from "@prisma/client";
import { getSetting } from "@/platform/settings/service";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { parseZonedInput } from "@/platform/dates/format";
import { isoDateKey } from "@/platform/dates";
import { mySchedule, type MyTermSchedule } from "../services/schedule";
import { buildCalendar, type CalendarEvent } from "./ics";

export type FeedContext = {
  orgName: string;
  /** HH:MM wall clock in `timeZone`. */
  startTime: string;
  /** HH:MM wall clock in `timeZone`. */
  endTime: string;
  timeZone: string;
  /** Host used to namespace event UIDs. */
  host: string;
  baseUrl: string;
};

const ROLE_LABELS: Record<ShiftRole, string> = {
  DIRECTOR: "Director",
  VOLUNTEER: "Volunteer",
  SHADOW: "Shadow",
};

function tagLabels(tags: { triage: boolean; walkin: boolean; cc: boolean; remote: boolean }): string[] {
  const labels: string[] = [];
  if (tags.triage) labels.push("Triage");
  if (tags.walkin) labels.push("Walk-in");
  if (tags.cc) labels.push("Care coordinator");
  if (tags.remote) labels.push("Remote");
  return labels;
}

/**
 * Combine a noon-UTC anchored clinic date with an HH:MM wall clock in `zone`
 * and return the absolute instant. Converting per date, rather than caching one
 * offset, is what makes a February and a July clinic day land on different UTC
 * hours from the same configured window.
 */
function instantFor(clinicDate: Date, wallTime: string, zone: string): Date | null {
  return parseZonedInput(`${isoDateKey(clinicDate)}T${wallTime}`, zone);
}

/** Flatten a member's terms into calendar events. Pure; all inputs are explicit. */
export function shiftsToEvents(terms: MyTermSchedule[], ctx: FeedContext): CalendarEvent[] {
  const events: CalendarEvent[] = [];

  for (const term of terms) {
    for (const shift of term.shifts) {
      const start = instantFor(shift.clinicDate, ctx.startTime, ctx.timeZone);
      const end = instantFor(shift.clinicDate, ctx.endTime, ctx.timeZone);
      // A malformed clinic-hours setting should drop the event, not throw and
      // take the whole feed down for every subscriber.
      if (!start || !end) continue;

      const dateKey = isoDateKey(shift.clinicDate);
      const detail = [ROLE_LABELS[shift.role], ...tagLabels(shift.tags)].join(" · ");

      events.push({
        // Stable for a given person, date, and department, so an edited shift
        // updates in place rather than duplicating in the client.
        uid: `shift-${dateKey}-${shift.department.id}@${ctx.host}`,
        start,
        end,
        summary: `${ctx.orgName}: ${shift.department.name}`,
        description: `${detail}\n${term.term.name}\n\n${ctx.baseUrl}/schedule`,
      });
    }
  }

  return events;
}

async function loadContext(): Promise<FeedContext> {
  const [orgName, startTime, endTime, timeZone, baseUrl] = await Promise.all([
    getSetting<string>("branding.orgName"),
    getSetting<string>("schedule.clinicStartTime"),
    getSetting<string>("schedule.clinicEndTime"),
    getDisplayTimeZone(),
    getSetting<string>("app.baseUrl"),
  ]);

  let host = "havenhub";
  try {
    host = new URL(baseUrl).host;
  } catch {
    // A misconfigured base URL must not break the feed; UIDs just get a
    // constant namespace, which still keeps them stable per person.
  }

  return { orgName, startTime, endTime, timeZone, host, baseUrl };
}

/** The member's shifts as an iCalendar document. */
export async function renderFeedForPerson(personId: string, now: Date = new Date()): Promise<string> {
  const [ctx, schedule] = await Promise.all([loadContext(), mySchedule(personId)]);
  return buildCalendar(shiftsToEvents(schedule.terms, ctx), {
    calendarName: `${ctx.orgName} Shifts`,
    timeZone: ctx.timeZone,
    now,
  });
}

/** A valid but empty calendar, served when the bound member is no longer active. */
export async function renderEmptyFeed(now: Date = new Date()): Promise<string> {
  const ctx = await loadContext();
  return buildCalendar([], {
    calendarName: `${ctx.orgName} Shifts`,
    timeZone: ctx.timeZone,
    now,
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/modules/schedule/calendar/feed.test.ts`
Expected: PASS, 10 tests

If the `MyTermSchedule` cast in the test fails to typecheck, read the real type in `src/modules/schedule/services/schedule.ts:72` and populate the remaining required fields with empty values rather than loosening the cast.

- [ ] **Step 5: Verify types across the whole project**

Run: `npm run typecheck`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/modules/schedule/calendar/feed.ts src/modules/schedule/calendar/feed.test.ts
git commit -m "feat(schedule): assemble the personal calendar feed"
```

---

## Task 5: The feed route

**Files:**
- Create: `src/app/api/calendar/[token]/route.ts`
- Test: `src/app/api/calendar/[token]/route.test.ts`

**Interfaces:**
- Consumes: `resolveFeedToken`, `touchFeedToken` from Task 2. `renderFeedForPerson`, `renderEmptyFeed` from Task 4.
- Produces: `GET(request: Request, context: { params: Promise<{ token: string }> }): Promise<Response>`

Two routing facts already verified, do not re-litigate them: the matcher in `src/proxy.ts` excludes `api`, so the apply-subdomain rewrite will not touch this path, and living outside the `(app)` tree keeps it clear of the onboarding gate. Never allowlist an `(app)` path into that gate.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/calendar/[token]/route.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/modules/schedule/calendar/feed-token", () => ({
  resolveFeedToken: vi.fn(),
  touchFeedToken: vi.fn(),
}));
vi.mock("@/modules/schedule/calendar/feed", () => ({
  renderFeedForPerson: vi.fn(),
  renderEmptyFeed: vi.fn(),
}));
vi.mock("@/platform/db", () => ({
  prisma: { person: { findUnique: vi.fn() } },
}));

import { GET } from "./route";
import { resolveFeedToken, touchFeedToken } from "@/modules/schedule/calendar/feed-token";
import { renderFeedForPerson, renderEmptyFeed } from "@/modules/schedule/calendar/feed";
import { prisma } from "@/platform/db";

function request(token: string) {
  return [
    new Request(`https://hub.example.org/api/calendar/${token}`),
    { params: Promise.resolve({ token }) },
  ] as const;
}

describe("GET /api/calendar/[token]", () => {
  beforeEach(() => {
    vi.mocked(resolveFeedToken).mockReset();
    vi.mocked(touchFeedToken).mockReset();
    vi.mocked(renderFeedForPerson).mockReset().mockResolvedValue("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n");
    vi.mocked(renderEmptyFeed).mockReset().mockResolvedValue("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n");
    vi.mocked(prisma.person.findUnique).mockReset();
  });

  it("404s an unknown token without rendering anything", async () => {
    vi.mocked(resolveFeedToken).mockResolvedValue(null);

    const res = await GET(...request("nope"));

    expect(res.status).toBe(404);
    expect(renderFeedForPerson).not.toHaveBeenCalled();
  });

  it("strips a trailing .ics before resolving, so both URL forms work", async () => {
    vi.mocked(resolveFeedToken).mockResolvedValue({ personId: "p1" });
    vi.mocked(prisma.person.findUnique).mockResolvedValue({ status: "ACTIVE" } as never);

    await GET(...request("abc123.ics"));

    expect(resolveFeedToken).toHaveBeenCalledWith("abc123");
  });

  it("serves the member's feed with calendar headers", async () => {
    vi.mocked(resolveFeedToken).mockResolvedValue({ personId: "p1" });
    vi.mocked(prisma.person.findUnique).mockResolvedValue({ status: "ACTIVE" } as never);

    const res = await GET(...request("abc123"));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/calendar; charset=utf-8");
    expect(renderFeedForPerson).toHaveBeenCalledWith("p1");
  });

  it("never allows a shared cache to hold a per-person secret feed", async () => {
    vi.mocked(resolveFeedToken).mockResolvedValue({ personId: "p1" });
    vi.mocked(prisma.person.findUnique).mockResolvedValue({ status: "ACTIVE" } as never);

    const res = await GET(...request("abc123"));

    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("records the fetch", async () => {
    vi.mocked(resolveFeedToken).mockResolvedValue({ personId: "p1" });
    vi.mocked(prisma.person.findUnique).mockResolvedValue({ status: "ACTIVE" } as never);

    await GET(...request("abc123"));

    expect(touchFeedToken).toHaveBeenCalledWith("p1");
  });

  it("serves an empty calendar, not a 404, once the member is no longer active", async () => {
    vi.mocked(resolveFeedToken).mockResolvedValue({ personId: "p1" });
    vi.mocked(prisma.person.findUnique).mockResolvedValue({ status: "OFFBOARDED" } as never);

    const res = await GET(...request("abc123"));

    expect(res.status).toBe(200);
    expect(renderEmptyFeed).toHaveBeenCalled();
    expect(renderFeedForPerson).not.toHaveBeenCalled();
  });

  it("serves an empty calendar when the person row is gone", async () => {
    vi.mocked(resolveFeedToken).mockResolvedValue({ personId: "p1" });
    vi.mocked(prisma.person.findUnique).mockResolvedValue(null);

    const res = await GET(...request("abc123"));

    expect(res.status).toBe(200);
    expect(renderEmptyFeed).toHaveBeenCalled();
  });
});

describe("rate limiting", () => {
  it("429s a single IP that floods the endpoint, and does not hit the database", async () => {
    vi.mocked(resolveFeedToken).mockResolvedValue(null);

    const flood = () =>
      GET(
        new Request("https://hub.example.org/api/calendar/x", {
          headers: { "x-forwarded-for": "203.0.113.9" },
        }),
        { params: Promise.resolve({ token: "x" }) },
      );

    let last: Response | undefined;
    for (let i = 0; i < 130; i++) last = await flood();

    expect(last!.status).toBe(429);
  });
});
```

Because the limiter holds module-level state, this block must run after the
others in the file. Keep it last, and keep its IP distinct from any other test's.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/app/api/calendar/`
Expected: FAIL, cannot resolve `./route`

- [ ] **Step 3: Write the implementation**

Create `src/app/api/calendar/[token]/route.ts`:

```ts
import { prisma } from "@/platform/db";
import { log, errorAttrs } from "@/platform/logging";
import { resolveFeedToken, touchFeedToken } from "@/modules/schedule/calendar/feed-token";
import { renderFeedForPerson, renderEmptyFeed } from "@/modules/schedule/calendar/feed";

type RouteContext = { params: Promise<{ token: string }> };

export const dynamic = "force-dynamic";

// Coarse per-IP flood backstop, mirroring the in-memory limiter in
// member-magic-link.ts. This is not access control: the token is. Sized loosely
// because Google, Apple, and Outlook all poll from wide, shared address pools,
// so a legitimate burst from one address is normal.
const IP_RATE_WINDOW_MS = 15 * 60 * 1000;
const IP_RATE_MAX = 120;
const ipHits = new Map<string, number[]>();

function ipRateLimited(ip: string | null): boolean {
  if (!ip) return false;
  const now = Date.now();
  // Bound the map so a churn of addresses cannot grow it without limit.
  if (ipHits.size > 5000) ipHits.clear();
  const recent = (ipHits.get(ip) ?? []).filter((t) => t > now - IP_RATE_WINDOW_MS);
  if (recent.length >= IP_RATE_MAX) {
    ipHits.set(ip, recent);
    return true;
  }
  recent.push(now);
  ipHits.set(ip, recent);
  return false;
}

const CALENDAR_HEADERS = {
  "Content-Type": "text/calendar; charset=utf-8",
  "Content-Disposition": 'inline; filename="haven-shifts.ics"',
  // Per-person secret. Must never land in a shared cache.
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

/**
 * GET /api/calendar/[token] -- personal shift feed for calendar clients.
 *
 * Unauthenticated by design: Google and Apple fetch this from their own
 * servers and cannot carry a session. The path token is the credential.
 *
 * A member who is no longer ACTIVE gets a valid but empty calendar rather than
 * a 404, so an offboarded member's calendar goes quiet instead of surfacing a
 * persistent broken-calendar error in a client they may never open again.
 * Access stops either way.
 */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const forwardedFor = request.headers.get("x-forwarded-for");
  const clientIp = forwardedFor ? forwardedFor.split(",")[0]!.trim() : null;
  if (ipRateLimited(clientIp)) {
    return new Response("Too many requests", { status: 429 });
  }

  const { token } = await context.params;
  // Clients are given a .ics-suffixed URL so they sniff the type correctly;
  // accept the bare form too.
  const raw = token.endsWith(".ics") ? token.slice(0, -4) : token;

  const match = await resolveFeedToken(raw);
  if (!match) {
    return new Response("Not found", { status: 404 });
  }

  const person = await prisma.person.findUnique({
    where: { id: match.personId },
    select: { status: true },
  });

  if (person?.status !== "ACTIVE") {
    return new Response(await renderEmptyFeed(), { status: 200, headers: CALENDAR_HEADERS });
  }

  const body = await renderFeedForPerson(match.personId);

  // Best effort, deliberately not awaited into the response path. This runs
  // unattended inside Google, Apple, and Outlook: a transient failure on a
  // "last fetched" bookkeeping write must never cost a member their calendar.
  void touchFeedToken(match.personId).catch((error) => {
    log.warn("[calendar] failed to record feed fetch", errorAttrs(error, { personId: match.personId }));
  });

  return new Response(body, { status: 200, headers: CALENDAR_HEADERS });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/app/api/calendar/`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add src/app/api/calendar
git commit -m "feat(schedule): serve the personal calendar feed"
```

---

## Task 6: My Info subscribe card

**Files:**
- Create: `src/modules/my-info/components/calendar-subscribe-card.tsx`
- Create: `src/modules/my-info/components/calendar-feed-url.tsx`
- Test: `src/modules/my-info/components/calendar-subscribe-card.test.tsx`
- Modify: `src/app/(app)/my-info/page.tsx`

**Interfaces:**
- Consumes: `issueFeedToken`, `readFeedToken` from Task 2. `getSetting` from `@/platform/settings/service`. `recordAudit` from `@/platform/audit`.
- Produces: `<CalendarSubscribeCard feedUrl={string | null} lastFetchedAt={Date | null} timeZone={string} generateAction={() => Promise<void>} resetAction={() => Promise<void>} />` and `googleCalendarUrl(feedUrl: string): string`

Two house conventions this task must follow. There is **no `@testing-library/react`
in this repo**; component tests render with `renderToStaticMarkup` from
`react-dom/server` in the default node environment and assert on the HTML
string. See `src/modules/my-info/components/memberships-card.test.tsx` for the
pattern. And a **server component cannot carry event handlers**, so anything
needing `onClick` or `onFocus` lives in a separate `"use client"` file.

- [ ] **Step 1: Write the failing test**

Create `src/modules/my-info/components/calendar-subscribe-card.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CalendarSubscribeCard, googleCalendarUrl } from "./calendar-subscribe-card";

const noop = async () => {};
const FEED_URL = "https://hub.example.org/api/calendar/abc.ics";

type Props = Parameters<typeof CalendarSubscribeCard>[0];

function html(overrides: Partial<Props> = {}): string {
  return renderToStaticMarkup(
    <CalendarSubscribeCard
      feedUrl={FEED_URL}
      lastFetchedAt={null}
      timeZone="America/New_York"
      generateAction={noop}
      resetAction={noop}
      {...overrides}
    />,
  );
}

describe("googleCalendarUrl", () => {
  it("points Google at the encoded feed URL", () => {
    expect(googleCalendarUrl(FEED_URL)).toBe(
      "https://www.google.com/calendar/render?cid=https%3A%2F%2Fhub.example.org%2Fapi%2Fcalendar%2Fabc.ics",
    );
  });
});

describe("CalendarSubscribeCard", () => {
  it("offers to generate a link when the member has none", () => {
    const markup = html({ feedUrl: null });
    expect(markup).toContain("Generate link");
    expect(markup).not.toContain("Reset link");
  });

  it("does not render any feed address before one exists", () => {
    expect(html({ feedUrl: null })).not.toContain("/api/calendar/");
  });

  it("shows the URL and both actions once a link exists", () => {
    const markup = html();
    expect(markup).toContain(`value="${FEED_URL}"`);
    expect(markup).toContain("Reset link");
    expect(markup).toContain("Add to Google");
  });

  it("links out to Google with the encoded feed URL", () => {
    expect(html()).toContain(googleCalendarUrl(FEED_URL).replace(/&/g, "&amp;"));
  });

  it("always discloses that Google refreshes on its own schedule", () => {
    expect(html()).toContain("its own timing");
  });

  it("reports the last fetch when one has happened", () => {
    expect(html({ lastFetchedAt: new Date("2026-08-06T15:00:00Z") })).toContain("Last checked");
  });

  it("says so when nothing has fetched the feed yet", () => {
    expect(html()).toContain("has not been checked yet");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/modules/my-info/components/calendar-subscribe-card.test.tsx`
Expected: FAIL, cannot resolve `./calendar-subscribe-card`

- [ ] **Step 3: Write the component**

Create `src/modules/my-info/components/calendar-subscribe-card.tsx`:

```tsx
import { CalendarPlus } from "lucide-react";
import { Card } from "@/platform/ui/card";
import { buttonClasses } from "@/platform/ui/button";
import { formatDateTime } from "@/platform/dates/format";
import { FeedUrlField } from "./calendar-feed-url";

type Props = {
  /** Full subscribe URL, or null when the member has not generated one yet. */
  feedUrl: string | null;
  lastFetchedAt: Date | null;
  timeZone: string;
  generateAction: () => Promise<void>;
  resetAction: () => Promise<void>;
};

/** Deep link that opens Google Calendar's add-by-URL flow. */
export function googleCalendarUrl(feedUrl: string): string {
  return `https://www.google.com/calendar/render?cid=${encodeURIComponent(feedUrl)}`;
}

export function CalendarSubscribeCard({ feedUrl, lastFetchedAt, timeZone, generateAction, resetAction }: Props) {
  return (
    <Card>
      <div className="flex items-start gap-3">
        <CalendarPlus aria-hidden className="mt-0.5 h-5 w-5 shrink-0 text-brand" />
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold text-foreground">Your shifts in your calendar</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Subscribe from Google Calendar, Apple Calendar, or Outlook and your shifts appear
            alongside everything else you have scheduled.
          </p>

          {!feedUrl ? (
            <form action={generateAction} className="mt-4">
              <button type="submit" className={buttonClasses("primary")}>
                Generate link
              </button>
            </form>
          ) : (
            <>
              <div className="mt-4 flex flex-wrap items-end gap-2">
                <FeedUrlField value={feedUrl} />
                <a
                  href={googleCalendarUrl(feedUrl)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={buttonClasses("primary", "sm")}
                >
                  Add to Google
                </a>
              </div>

              <p className="mt-3 text-xs text-muted-foreground">
                Google refreshes subscribed calendars on its own timing, usually within a day.
                Check the Hub for the latest.
              </p>
              <p className="mt-1 text-xs text-subtle-foreground">
                {lastFetchedAt
                  ? `Last checked by a calendar app on ${formatDateTime(lastFetchedAt, timeZone)}.`
                  : "This link has not been checked yet by any calendar app."}
              </p>

              <form action={resetAction} className="mt-4">
                <button type="submit" className={buttonClasses("outline", "sm")}>
                  Reset link
                </button>
                <span className="ml-2 text-xs text-subtle-foreground">
                  Creates a new address and stops the old one working everywhere.
                </span>
              </form>
            </>
          )}
        </div>
      </div>
    </Card>
  );
}
```

- [ ] **Step 4: Write the client-side URL field**

The card is a server component and cannot carry event handlers, so the
select-on-focus and clipboard behavior lives in its own client file. Create
`src/modules/my-info/components/calendar-feed-url.tsx`:

```tsx
"use client";

import { useState } from "react";
import { buttonClasses } from "@/platform/ui/button";

/** Read-only feed address with select-on-focus and a copy button. */
export function FeedUrlField({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="min-w-0 flex-1">
      <label htmlFor="calendar-feed-url" className="block text-xs font-medium text-subtle-foreground">
        Calendar feed address
      </label>
      <div className="mt-1 flex items-center gap-2">
        <input
          id="calendar-feed-url"
          readOnly
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          className="min-w-0 flex-1 rounded-lg border border-border bg-muted px-3 py-2 font-mono text-xs text-foreground-soft"
        />
        <button
          type="button"
          className={buttonClasses("outline", "sm")}
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2000);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/modules/my-info/components/calendar-subscribe-card.test.tsx`
Expected: PASS, 8 tests

- [ ] **Step 6: Wire the card into My Info**

In `src/app/(app)/my-info/page.tsx`, add these imports alongside the existing ones:

```ts
import { CalendarSubscribeCard } from "@/modules/my-info/components/calendar-subscribe-card";
import { issueFeedToken, readFeedToken } from "@/modules/schedule/calendar/feed-token";
import { getSetting } from "@/platform/settings/service";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { recordAudit } from "@/platform/audit";
import { revalidatePath } from "next/cache";
```

Add the two loads to the existing `Promise.all`, so the feed state and base URL come along with everything else:

```ts
  const [myInfo, certificates, ehsItems, feedToken, baseUrl, timeZone] = await Promise.all([
    getMyInfo(person.personId),
    listMyCertificates(person.personId),
    getMyEhsStatus(person.personId),
    readFeedToken(person.personId),
    getSetting<string>("app.baseUrl"),
    getDisplayTimeZone(),
  ]);
```

Add the two server actions next to the existing `updateAction`:

```ts
  async function generateFeedAction() {
    "use server";
    const session = await requireModuleAccess("my-info");
    await issueFeedToken(session.personId);
    await recordAudit({
      actorPersonId: session.personId,
      action: "calendar_feed.issue",
      entityType: "CalendarFeedToken",
      entityId: session.personId,
    });
    revalidatePath("/my-info");
  }

  async function resetFeedAction() {
    "use server";
    const session = await requireModuleAccess("my-info");
    await issueFeedToken(session.personId);
    await recordAudit({
      actorPersonId: session.personId,
      action: "calendar_feed.reset",
      entityType: "CalendarFeedToken",
      entityId: session.personId,
    });
    revalidatePath("/my-info");
  }
```

Render the card after `<ClearanceCard ... />` in the page body:

```tsx
      <CalendarSubscribeCard
        feedUrl={feedToken ? `${baseUrl}/api/calendar/${feedToken.token}.ics` : null}
        lastFetchedAt={feedToken?.lastFetchedAt ?? null}
        timeZone={timeZone}
        generateAction={generateFeedAction}
        resetAction={resetFeedAction}
      />
```

- [ ] **Step 7: Verify the whole project typechecks**

Run: `npm run typecheck`
Expected: no errors

- [ ] **Step 8: Commit**

```bash
git add src/modules/my-info/components/calendar-subscribe-card.tsx src/modules/my-info/components/calendar-feed-url.tsx src/modules/my-info/components/calendar-subscribe-card.test.tsx "src/app/(app)/my-info/page.tsx"
git commit -m "feat(my-info): add the calendar subscribe card"
```

---

## Task 7: Full verification

**Files:** none created or modified unless a check fails.

- [ ] **Step 1: Run the full test suite**

```bash
npm test
```

Expected: all tests pass, including the ones that existed before this work.

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Lint**

```bash
npx eslint src e2e
```

Expected: no errors. Typecheck and tests do not catch the ESLint boundary rules or the no-em-dash rule, so this step is not optional.

- [ ] **Step 4: Build**

```bash
npm run build
```

Expected: build succeeds.

- [ ] **Step 5: Manual smoke test**

Start the app with `npm run dev`, sign in, and:

1. Go to My Info. The card should offer Generate link.
2. Click it. A URL should appear.
3. Open that URL in a browser tab. It should download or display an iCalendar document containing a `VEVENT` for each of your shifts, with `DTSTART` values that match your real clinic days.
4. Paste the URL into `https://icalendar.org/validator.html` or an equivalent validator and confirm it parses clean.
5. Click Reset link, then reload the old URL. It should now 404.

- [ ] **Step 6: Report**

Report the actual output of steps 1 through 4. If any check fails, fix it and re-run rather than reporting partial success.

---

## Self-Review Notes

Spec coverage check, section by section:

- Clinic hours as configuration: Task 1
- Data model, plaintext token, no expiry, lazy creation, hourly touch: Task 2
- ICS generation, folding, escaping, UTC instants, UID stability, removal semantics: Task 3
- Feed assembly, `mySchedule` reuse, DST handling, publication gating inherited: Task 4
- Route, 404, empty calendar for non-ACTIVE, headers, `.ics` suffix, per-IP rate limit: Task 5
- UI, generate, copy, add to Google, reset, refresh disclosure, audit: Task 6
- Testing section: distributed across Tasks 1 through 6, with the integration check in Task 7 step 5

Every section of the spec maps to a task. No spec requirement was dropped.

Two gaps the spec did not anticipate, both now folded into Task 2:

- `resetDb` truncates an explicit table list. The new table has to join it, or
  feed rows leak between test files.
- The spec's testing section describes proving that plaintext never reaches the
  database. That test no longer applies now that the token is stored in
  plaintext by design, and has been replaced with a cascade-delete test proving
  the credential dies with the person.
