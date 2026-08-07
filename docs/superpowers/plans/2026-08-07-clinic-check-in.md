# Clinic Check-in Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record whether an assigned person actually showed up to clinic, via geofenced self check-in with a director override.

**Architecture:** One `ClinicAttendance` row per person per clinic day. The client reports a position; the **server** owns the fence rule, the verdict, and the write. A pure engine module holds the distance math and pass rule so it is exhaustively unit-testable without a database. Absence is never stored: no-show is derived by left-joining assignments against attendance for dates strictly before today.

**Tech Stack:** Next.js App Router (server components + server actions), Prisma/Postgres, Vitest, Playwright, PostHog, the existing `notify()` + email-drainer pipeline.

**Spec:** `docs/superpowers/specs/2026-08-07-clinic-check-in-design.md`

## Global Constraints

- **No em-dashes anywhere.** CI-enforced by the `local/no-em-dash` eslint rule. Use "to" for ranges and commas or parentheses for asides.
- **"HAVEN Hub" is two words** in prose and UI. Identifiers stay `havenhub`.
- **Clinic dates are noon-UTC anchored.** Compare by UTC day key via `isoDateKey`, never by raw timestamp.
- **"Today" is the display timezone**, resolved with `displayTodayKey()`. A raw `isoDateKey(new Date())` rolls over at UTC midnight (about 8pm ET) and would be wrong for the last hours of every day.
- **`new Date()`, never `Date.now()`** in anything reachable from render. The `react-hooks/purity` lint rule rejects `Date.now()`.
- **Run the full lint before pushing:** `npx eslint src e2e`. Plain `npm run lint` walks a gitignored design-system directory and produces false failures.
- **Test database:** run vitest with a per-worktree `TEST_DATABASE_URL`. This worktree uses `postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_clinic_checkin`.
- **Never run `prisma generate`** to fix a "column does not exist" vitest error; that is the stale shared-`node_modules` client symptom and regenerating makes it worse for other worktrees.
- **Commit after every task.**

---

### Task 1: Schema, migration, and test-harness wiring

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260807120000_clinic_attendance/migration.sql`
- Modify: `src/platform/test/db.ts:14-24` (the TRUNCATE list)
- Test: `src/modules/schedule/services/attendance-schema.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: the `ClinicAttendance` Prisma model and `CheckInMethod` enum used by every later task. Field names exactly as written below.

- [ ] **Step 1: Add the enum and model to the schema**

Add near the other scheduling models in `prisma/schema.prisma`:

```prisma
/// How an attendance record came to exist. SELF_GEO passed the geofence;
/// SELF_REMOTE is a telehealth volunteer for whom the fence does not apply;
/// STAFF was recorded by a director when self check-in was not possible.
enum CheckInMethod {
  SELF_GEO
  SELF_REMOTE
  STAFF
}

/// One row per person per clinic day. Its existence IS the attendance fact;
/// absence is derived (an assignment with no row, on a past clinic date), never
/// stored. Keyed per person rather than per assignment because a person may hold
/// assignments in two departments on one clinic date and still arrives once.
model ClinicAttendance {
  id             String        @id @default(cuid())
  termId         String
  /// Noon-UTC anchored calendar date, matching Term.clinicDates and
  /// ShiftAssignment.clinicDate. Compare by UTC day key, never raw timestamp.
  clinicDate     DateTime
  personId       String
  /// True arrival instant, NOT date-anchored. Kept so punctuality and hours can
  /// be derived later over data collected from day one.
  checkedInAt    DateTime      @default(now())
  method         CheckInMethod
  /// Rounded metres from the configured fence centre. Null for SELF_REMOTE and
  /// STAFF. Raw coordinates are deliberately never persisted (privacy).
  distanceMeters Int?
  /// The fix's reported accuracy in metres, kept for tuning the thresholds.
  accuracyMeters Int?
  /// The staff member who recorded it. Null for self check-in.
  recordedById   String?
  note           String?
  createdAt      DateTime      @default(now())
  updatedAt      DateTime      @updatedAt

  /// Restrict: term deletion is blocked while attendance history references it.
  term       Term    @relation(fields: [termId], references: [id], onDelete: Restrict)
  /// Cascade: attendance belongs to the person and dies with them.
  person     Person  @relation("clinicAttendancePerson", fields: [personId], references: [id], onDelete: Cascade)
  /// SetNull: the record survives the recorder being deleted.
  recordedBy Person? @relation("clinicAttendanceRecordedBy", fields: [recordedById], references: [id], onDelete: SetNull)

  @@unique([termId, clinicDate, personId])
  @@index([termId, clinicDate])
  @@index([personId, termId])
}
```

Add the three back-references. On `model Person`, beside the other relation lists:

```prisma
  /// Clinic attendance rows for this person.
  clinicAttendances         ClinicAttendance[] @relation("clinicAttendancePerson")
  /// Clinic attendance rows this person recorded on someone else's behalf.
  clinicAttendancesRecorded ClinicAttendance[] @relation("clinicAttendanceRecordedBy")
```

On `model Term`, beside `shiftAssignments`:

```prisma
  clinicAttendances    ClinicAttendance[]
```

- [ ] **Step 2: Generate the migration, then trim it**

```bash
DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_clinic_checkin" \
DATABASE_URL_UNPOOLED="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_clinic_checkin" \
npx prisma migrate dev --create-only --name clinic_attendance
```

**Then open the generated `migration.sql` and delete anything that is not the enum, the table, its indexes, and its three foreign keys.** `prisma migrate dev` folds pre-existing drift between the schema and the local database into whatever migration you happen to be creating. A migration that silently drops an unrelated index will pass locally and break production. The file should contain only:

```sql
-- CreateEnum
CREATE TYPE "CheckInMethod" AS ENUM ('SELF_GEO', 'SELF_REMOTE', 'STAFF');

-- CreateTable
CREATE TABLE "ClinicAttendance" (
    "id" TEXT NOT NULL,
    "termId" TEXT NOT NULL,
    "clinicDate" TIMESTAMP(3) NOT NULL,
    "personId" TEXT NOT NULL,
    "checkedInAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "method" "CheckInMethod" NOT NULL,
    "distanceMeters" INTEGER,
    "accuracyMeters" INTEGER,
    "recordedById" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClinicAttendance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClinicAttendance_termId_clinicDate_idx" ON "ClinicAttendance"("termId", "clinicDate");

-- CreateIndex
CREATE INDEX "ClinicAttendance_personId_termId_idx" ON "ClinicAttendance"("personId", "termId");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicAttendance_termId_clinicDate_personId_key" ON "ClinicAttendance"("termId", "clinicDate", "personId");

-- AddForeignKey
ALTER TABLE "ClinicAttendance" ADD CONSTRAINT "ClinicAttendance_termId_fkey" FOREIGN KEY ("termId") REFERENCES "Term"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicAttendance" ADD CONSTRAINT "ClinicAttendance_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicAttendance" ADD CONSTRAINT "ClinicAttendance_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

- [ ] **Step 3: Apply the migration**

```bash
DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_clinic_checkin" \
DATABASE_URL_UNPOOLED="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_clinic_checkin" \
npx prisma migrate deploy
```

Expected: `All migrations have been successfully applied.`

- [ ] **Step 4: Add the table to the test reset list**

In `src/platform/test/db.ts`, add `"ClinicAttendance"` to the TRUNCATE list, immediately before `"ShiftAssignment"`:

```
              "ShiftRequest", "SchedulePublication", "ScheduleDay", "RhdClinic", "RhdAttending",
              "ClinicAttendance", "ShiftAssignment", "HipaaCertificate", "RoleAssignment", ...
```

`TRUNCATE "Person" CASCADE` would reach it anyway, but this file names every table explicitly on purpose (see its comment about the `Historical*` tables): relying on an incidental cascade breaks silently the day the relation changes.

- [ ] **Step 5: Write the schema guard test**

Create `src/modules/schedule/services/attendance-schema.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";

async function seed() {
  const term = await prisma.term.create({
    data: {
      code: "TS26",
      name: "Test 2026",
      startDate: new Date("2026-01-01T00:00:00Z"),
      endDate: new Date("2026-06-01T00:00:00Z"),
      status: "ACTIVE",
      clinicDates: [new Date("2026-03-07T12:00:00Z")],
    },
  });
  const person = await prisma.person.create({ data: { name: "Ada Lovelace" } });
  return { term, person };
}

describe("ClinicAttendance schema", () => {
  beforeEach(resetDb);

  it("stores one row per person per clinic day", async () => {
    const { term, person } = await seed();
    const row = await prisma.clinicAttendance.create({
      data: {
        termId: term.id,
        clinicDate: new Date("2026-03-07T12:00:00Z"),
        personId: person.id,
        method: "SELF_GEO",
        distanceMeters: 42,
        accuracyMeters: 15,
      },
    });
    expect(row.method).toBe("SELF_GEO");
    expect(row.recordedById).toBeNull();
  });

  it("rejects a second row for the same person and clinic day", async () => {
    const { term, person } = await seed();
    const data = {
      termId: term.id,
      clinicDate: new Date("2026-03-07T12:00:00Z"),
      personId: person.id,
      method: "SELF_GEO" as const,
    };
    await prisma.clinicAttendance.create({ data });
    await expect(prisma.clinicAttendance.create({ data })).rejects.toThrow();
  });

  it("keeps the row when the recorder is deleted, and drops it when the subject is", async () => {
    const { term, person } = await seed();
    const recorder = await prisma.person.create({ data: { name: "Grace Hopper" } });
    const row = await prisma.clinicAttendance.create({
      data: {
        termId: term.id,
        clinicDate: new Date("2026-03-07T12:00:00Z"),
        personId: person.id,
        method: "STAFF",
        recordedById: recorder.id,
      },
    });

    await prisma.person.delete({ where: { id: recorder.id } });
    const afterRecorderGone = await prisma.clinicAttendance.findUnique({ where: { id: row.id } });
    expect(afterRecorderGone?.recordedById).toBeNull();

    await prisma.person.delete({ where: { id: person.id } });
    expect(await prisma.clinicAttendance.findUnique({ where: { id: row.id } })).toBeNull();
  });
});
```

- [ ] **Step 6: Run the test**

```bash
TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_clinic_checkin" \
npx vitest run src/modules/schedule/services/attendance-schema.test.ts
```

Expected: 3 passed.

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/platform/test/db.ts src/modules/schedule/services/attendance-schema.test.ts
git commit -m "feat(schedule): add ClinicAttendance model for clinic check-in"
```

---

### Task 2: The fence rule and its configuration

**Files:**
- Create: `src/modules/schedule/engine/geofence.ts`
- Create: `src/modules/schedule/engine/geofence.test.ts`
- Modify: `src/platform/config.ts`
- Modify: `src/platform/settings/registry.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `haversineMeters(a: Coords, b: Coords): number`
  - `type Coords = { latitude: number; longitude: number }`
  - `type FenceVerdict = { ok: true; distanceMeters: number } | { ok: false; reason: "OUT_OF_RANGE" | "TOO_IMPRECISE"; distanceMeters: number }`
  - `evaluateFence(input: FenceInput): FenceVerdict`
  - `type FenceInput = { position: Coords; accuracyMeters: number; centre: Coords; radiusMeters: number; maxAccuracyMeters: number }`
  - Settings keys `clinic.checkInLatitude`, `clinic.checkInLongitude`, `clinic.checkInRadiusMeters`, `clinic.checkInMaxAccuracyMeters`.

- [ ] **Step 1: Write the failing engine test**

Create `src/modules/schedule/engine/geofence.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { haversineMeters, evaluateFence } from "./geofence";

// Yale Physicians Building, 800 Howard Avenue, New Haven CT.
const CLINIC = { latitude: 41.3025, longitude: -72.937 };

describe("haversineMeters", () => {
  it("is zero for identical points", () => {
    expect(haversineMeters(CLINIC, CLINIC)).toBe(0);
  });

  it("is symmetric", () => {
    const other = { latitude: 41.31, longitude: -72.93 };
    expect(haversineMeters(CLINIC, other)).toBeCloseTo(haversineMeters(other, CLINIC), 6);
  });

  it("matches a known one-degree-of-latitude separation to within 0.5 percent", () => {
    // One degree of latitude is about 111,195 m anywhere on the sphere.
    const oneDegreeNorth = { latitude: CLINIC.latitude + 1, longitude: CLINIC.longitude };
    const d = haversineMeters(CLINIC, oneDegreeNorth);
    expect(d).toBeGreaterThan(111195 * 0.995);
    expect(d).toBeLessThan(111195 * 1.005);
  });

  it("measures a short local hop in the right ballpark", () => {
    // ~0.001 degrees of latitude is about 111 m.
    const d = haversineMeters(CLINIC, { latitude: CLINIC.latitude + 0.001, longitude: CLINIC.longitude });
    expect(d).toBeGreaterThan(105);
    expect(d).toBeLessThan(118);
  });
});

describe("evaluateFence", () => {
  const base = { centre: CLINIC, radiusMeters: 250, maxAccuracyMeters: 200 };

  it("passes a precise fix at the centre", () => {
    const v = evaluateFence({ ...base, position: CLINIC, accuracyMeters: 10 });
    expect(v).toEqual({ ok: true, distanceMeters: 0 });
  });

  it("rejects a precise fix beyond the radius", () => {
    const far = { latitude: CLINIC.latitude + 0.01, longitude: CLINIC.longitude }; // ~1.1 km
    const v = evaluateFence({ ...base, position: far, accuracyMeters: 10 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("OUT_OF_RANGE");
  });

  it("rejects an imprecise fix even when it is nominally inside the radius", () => {
    const v = evaluateFence({ ...base, position: CLINIC, accuracyMeters: 900 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("TOO_IMPRECISE");
  });

  it("reports TOO_IMPRECISE ahead of OUT_OF_RANGE when both apply", () => {
    // A useless fix is a useless fix; telling the volunteer they are far away
    // would be asserting something the data cannot support.
    const far = { latitude: CLINIC.latitude + 0.01, longitude: CLINIC.longitude };
    const v = evaluateFence({ ...base, position: far, accuracyMeters: 900 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("TOO_IMPRECISE");
  });

  it("treats both thresholds as inclusive", () => {
    const atAccuracyLimit = evaluateFence({ ...base, position: CLINIC, accuracyMeters: 200 });
    expect(atAccuracyLimit.ok).toBe(true);

    const justOver = evaluateFence({ ...base, position: CLINIC, accuracyMeters: 201 });
    expect(justOver.ok).toBe(false);
  });

  it("rounds the reported distance to whole metres", () => {
    const v = evaluateFence({
      ...base,
      position: { latitude: CLINIC.latitude + 0.0005, longitude: CLINIC.longitude },
      accuracyMeters: 10,
    });
    expect(Number.isInteger(v.distanceMeters)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
npx vitest run src/modules/schedule/engine/geofence.test.ts
```

Expected: FAIL, cannot resolve `./geofence`.

- [ ] **Step 3: Implement the engine**

Create `src/modules/schedule/engine/geofence.ts`:

```ts
/**
 * Pure geofence math and pass rule for clinic check-in.
 *
 * Deliberately free of Prisma, settings, and request context so every boundary
 * can be exercised in unit tests. The caller resolves the configured centre and
 * thresholds and hands them in.
 *
 * This is a DETERRENT, not enforcement: a browser position is self-reported and
 * spoofable. The value is that the rule and the verdict live on the server, so a
 * client can lie about where it is but cannot move the fence or forge a pass.
 */

export type Coords = { latitude: number; longitude: number };

export type FenceInput = {
  position: Coords;
  /** The fix's reported accuracy radius, in metres (coords.accuracy). */
  accuracyMeters: number;
  centre: Coords;
  radiusMeters: number;
  maxAccuracyMeters: number;
};

export type FenceVerdict =
  | { ok: true; distanceMeters: number }
  | { ok: false; reason: "OUT_OF_RANGE" | "TOO_IMPRECISE"; distanceMeters: number };

const EARTH_RADIUS_M = 6371008.8; // IUGG mean radius

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Great-circle distance in metres between two points. */
export function haversineMeters(a: Coords, b: Coords): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);

  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Apply the pass rule: near enough AND precise enough.
 *
 * The precision half is load-bearing. Indoors, coords.accuracy is routinely in
 * the hundreds of metres, and a fix meaning "somewhere in this half-kilometre"
 * is not evidence of presence OR of absence. Rather than silently passing or
 * silently failing it, we return TOO_IMPRECISE and let the caller route the
 * person to the director override.
 *
 * TOO_IMPRECISE is checked FIRST: when a fix is useless, reporting OUT_OF_RANGE
 * would assert a distance the data cannot support.
 */
export function evaluateFence(input: FenceInput): FenceVerdict {
  const distanceMeters = Math.round(haversineMeters(input.position, input.centre));

  if (input.accuracyMeters > input.maxAccuracyMeters) {
    return { ok: false, reason: "TOO_IMPRECISE", distanceMeters };
  }
  if (distanceMeters > input.radiusMeters) {
    return { ok: false, reason: "OUT_OF_RANGE", distanceMeters };
  }
  return { ok: true, distanceMeters };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run src/modules/schedule/engine/geofence.test.ts
```

Expected: 10 passed.

- [ ] **Step 5: Add the env config entries**

In `src/platform/config.ts`, beside `RHD_MAX_PROCEDURES`, add four entries following the existing string-then-transform pattern:

```ts
    // Clinic check-in geofence centre latitude. MUST be confirmed against the
    // actual clinic entrance before production use: a centre fifty metres off is
    // a fence that fails people at the door.
    CLINIC_CHECKIN_LATITUDE: z
      .string()
      .default("41.3025")
      .transform(Number)
      .superRefine((v, ctx) => {
        if (!Number.isFinite(v) || v < -90 || v > 90) {
          ctx.addIssue({ code: "custom", path: [], message: "CLINIC_CHECKIN_LATITUDE must be between -90 and 90" });
        }
      }),
    CLINIC_CHECKIN_LONGITUDE: z
      .string()
      .default("-72.937")
      .transform(Number)
      .superRefine((v, ctx) => {
        if (!Number.isFinite(v) || v < -180 || v > 180) {
          ctx.addIssue({ code: "custom", path: [], message: "CLINIC_CHECKIN_LONGITUDE must be between -180 and 180" });
        }
      }),
    CLINIC_CHECKIN_RADIUS_METERS: z
      .string()
      .default("250")
      .transform(Number)
      .superRefine((v, ctx) => {
        if (!Number.isFinite(v) || v <= 0) {
          ctx.addIssue({ code: "custom", path: [], message: "CLINIC_CHECKIN_RADIUS_METERS must be a positive number" });
        }
      }),
    CLINIC_CHECKIN_MAX_ACCURACY_METERS: z
      .string()
      .default("200")
      .transform(Number)
      .superRefine((v, ctx) => {
        if (!Number.isFinite(v) || v <= 0) {
          ctx.addIssue({ code: "custom", path: [], message: "CLINIC_CHECKIN_MAX_ACCURACY_METERS must be a positive number" });
        }
      }),
```

- [ ] **Step 6: Add the settings registry entries**

In `src/platform/settings/registry.ts`, inside the `SETTINGS` array beside the other Operations entries:

```ts
  define<number>({
    key: "clinic.checkInLatitude",
    category: "Operations",
    label: "Clinic check-in latitude",
    help: "Latitude of the clinic check-in geofence centre. Confirm this against the actual entrance: a centre even fifty metres off will fail volunteers standing at the door.",
    input: { type: "number" },
    schema: z.number().min(-90).max(90),
    envDefault: () => config.CLINIC_CHECKIN_LATITUDE,
    secret: false,
  }),
  define<number>({
    key: "clinic.checkInLongitude",
    category: "Operations",
    label: "Clinic check-in longitude",
    help: "Longitude of the clinic check-in geofence centre.",
    input: { type: "number" },
    schema: z.number().min(-180).max(180),
    envDefault: () => config.CLINIC_CHECKIN_LONGITUDE,
    secret: false,
  }),
  define<number>({
    key: "clinic.checkInRadiusMeters",
    category: "Operations",
    label: "Clinic check-in radius (metres)",
    help: "How near the clinic a volunteer must be to check themselves in. Location accuracy indoors is poor, so this is a deterrent rather than proof of presence; a director can always check someone in manually.",
    input: { type: "number", min: 10 },
    schema: z.number().int().min(10),
    envDefault: () => config.CLINIC_CHECKIN_RADIUS_METERS,
    secret: false,
  }),
  define<number>({
    key: "clinic.checkInMaxAccuracyMeters",
    category: "Operations",
    label: "Clinic check-in accuracy limit (metres)",
    help: "Location fixes less precise than this are rejected as unusable rather than guessed at, and the volunteer is asked to see a director. Raise it if too many on-site volunteers are being turned away.",
    input: { type: "number", min: 10 },
    schema: z.number().int().min(10),
    envDefault: () => config.CLINIC_CHECKIN_MAX_ACCURACY_METERS,
    secret: false,
  }),
```

- [ ] **Step 7: Run the config and settings tests**

```bash
TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_clinic_checkin" \
npx vitest run src/platform/config.test.ts src/platform/settings/registry.test.ts
```

Expected: PASS. If `registry.test.ts` asserts an exact setting count, update that number.

- [ ] **Step 8: Commit**

```bash
git add src/modules/schedule/engine/geofence.ts src/modules/schedule/engine/geofence.test.ts src/platform/config.ts src/platform/settings/registry.ts
git commit -m "feat(schedule): add geofence rule and its configuration"
```

---

### Task 3: Self check-in service

**Files:**
- Create: `src/modules/schedule/services/attendance.ts`
- Create: `src/modules/schedule/services/attendance.test.ts`

**Interfaces:**
- Consumes: `evaluateFence`, `Coords` from `@/modules/schedule/engine/geofence`; the four `clinic.checkIn*` settings; the `ClinicAttendance` model.
- Produces:
  - `type CheckInFailureReason = "PERMISSION_DENIED" | "POSITION_UNAVAILABLE" | "TIMEOUT" | "TOO_IMPRECISE" | "OUT_OF_RANGE" | "NOT_ASSIGNED" | "NOT_A_CLINIC_DAY" | "NOT_ELIGIBLE" | "FENCE_UNCONFIGURED"`
  - `type CheckInResult = { ok: true; alreadyCheckedIn: boolean; checkedInAt: Date; method: CheckInMethod } | { ok: false; reason: CheckInFailureReason }`
  - `checkInSelf(personId: string, position: { coords: Coords; accuracyMeters: number } | null, now?: Date): Promise<CheckInResult>`
  - `getCheckInState(personId: string, now?: Date): Promise<CheckInState>`
  - `type CheckInState = { clinicDate: Date | null; termId: string | null; assignmentCount: number; allRemote: boolean; existing: { checkedInAt: Date; method: CheckInMethod } | null }`

- [ ] **Step 1: Write the failing test**

Create `src/modules/schedule/services/attendance.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { setSetting } from "@/platform/settings/service";
import { checkInSelf, getCheckInState } from "./attendance";

const CLINIC_DATE = new Date("2026-03-07T12:00:00Z");
// A Saturday morning instant that falls on CLINIC_DATE in Eastern Time.
const SATURDAY_MORNING = new Date("2026-03-07T13:30:00Z");
const CLINIC = { latitude: 41.3025, longitude: -72.937 };
const FAR_AWAY = { latitude: 42.3601, longitude: -71.0589 }; // Boston

// setSetting takes THREE arguments: (key, rawValue, actorPersonId).
async function configureFence() {
  await setSetting("clinic.checkInLatitude", CLINIC.latitude, null);
  await setSetting("clinic.checkInLongitude", CLINIC.longitude, null);
  await setSetting("clinic.checkInRadiusMeters", 250, null);
  await setSetting("clinic.checkInMaxAccuracyMeters", 200, null);
}

async function seed(opts: { remote?: boolean; assigned?: boolean } = {}) {
  const { remote = false, assigned = true } = opts;
  const term = await prisma.term.create({
    data: {
      code: "TS26",
      name: "Test 2026",
      startDate: new Date("2026-01-01T00:00:00Z"),
      endDate: new Date("2026-06-01T00:00:00Z"),
      status: "ACTIVE",
      clinicDates: [CLINIC_DATE],
    },
  });
  const dept = await prisma.department.create({ data: { code: "SCTP", name: "Screening" } });
  const person = await prisma.person.create({ data: { name: "Ada Lovelace" } });
  await prisma.termMembership.create({
    data: { termId: term.id, departmentId: dept.id, personId: person.id, status: "ACTIVE" },
  });
  if (assigned) {
    await prisma.shiftAssignment.create({
      data: {
        termId: term.id,
        departmentId: dept.id,
        personId: person.id,
        clinicDate: CLINIC_DATE,
        role: "VOLUNTEER",
        remote,
      },
    });
  }
  return { term, dept, person };
}

describe("checkInSelf", () => {
  beforeEach(async () => {
    await resetDb();
    await configureFence();
  });

  it("writes a SELF_GEO row for an assigned person inside the fence", async () => {
    const { person, term } = await seed();
    const res = await checkInSelf(
      person.id,
      { coords: CLINIC, accuracyMeters: 20 },
      SATURDAY_MORNING,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.method).toBe("SELF_GEO");

    const row = await prisma.clinicAttendance.findFirst({ where: { personId: person.id } });
    expect(row?.method).toBe("SELF_GEO");
    expect(row?.termId).toBe(term.id);
    expect(row?.distanceMeters).toBe(0);
    expect(row?.accuracyMeters).toBe(20);
    expect(row?.recordedById).toBeNull();
  });

  it("never persists raw coordinates", async () => {
    const { person } = await seed();
    await checkInSelf(person.id, { coords: CLINIC, accuracyMeters: 20 }, SATURDAY_MORNING);
    const row = await prisma.clinicAttendance.findFirstOrThrow({ where: { personId: person.id } });
    expect(Object.keys(row)).not.toContain("latitude");
    expect(Object.keys(row)).not.toContain("longitude");
    expect(JSON.stringify(row)).not.toContain("-72.937");
  });

  it("rejects a fix outside the radius and writes nothing", async () => {
    const { person } = await seed();
    const res = await checkInSelf(person.id, { coords: FAR_AWAY, accuracyMeters: 20 }, SATURDAY_MORNING);
    expect(res).toEqual({ ok: false, reason: "OUT_OF_RANGE" });
    expect(await prisma.clinicAttendance.count()).toBe(0);
  });

  it("rejects an imprecise fix and writes nothing", async () => {
    const { person } = await seed();
    const res = await checkInSelf(person.id, { coords: CLINIC, accuracyMeters: 900 }, SATURDAY_MORNING);
    expect(res).toEqual({ ok: false, reason: "TOO_IMPRECISE" });
    expect(await prisma.clinicAttendance.count()).toBe(0);
  });

  it("treats a null position as POSITION_UNAVAILABLE", async () => {
    const { person } = await seed();
    const res = await checkInSelf(person.id, null, SATURDAY_MORNING);
    expect(res).toEqual({ ok: false, reason: "POSITION_UNAVAILABLE" });
  });

  it("waives the fence when every assignment that day is remote", async () => {
    const { person } = await seed({ remote: true });
    const res = await checkInSelf(person.id, null, SATURDAY_MORNING);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.method).toBe("SELF_REMOTE");

    const row = await prisma.clinicAttendance.findFirstOrThrow({ where: { personId: person.id } });
    expect(row.distanceMeters).toBeNull();
    expect(row.accuracyMeters).toBeNull();
  });

  it("does NOT waive the fence when only some assignments are remote", async () => {
    const { person, term } = await seed({ remote: true });
    const other = await prisma.department.create({ data: { code: "JCTP", name: "Joint Clinic" } });
    await prisma.termMembership.create({
      data: { termId: term.id, departmentId: other.id, personId: person.id, status: "ACTIVE" },
    });
    await prisma.shiftAssignment.create({
      data: {
        termId: term.id,
        departmentId: other.id,
        personId: person.id,
        clinicDate: CLINIC_DATE,
        role: "VOLUNTEER",
        remote: false,
      },
    });

    const res = await checkInSelf(person.id, null, SATURDAY_MORNING);
    expect(res).toEqual({ ok: false, reason: "POSITION_UNAVAILABLE" });
  });

  it("blocks an unassigned person rather than treating them as vacuously all-remote", async () => {
    const { person } = await seed({ assigned: false });
    const res = await checkInSelf(person.id, null, SATURDAY_MORNING);
    expect(res).toEqual({ ok: false, reason: "NOT_ASSIGNED" });
    expect(await prisma.clinicAttendance.count()).toBe(0);
  });

  it("rejects a non-clinic day", async () => {
    const { person } = await seed();
    const wednesday = new Date("2026-03-04T13:30:00Z");
    const res = await checkInSelf(person.id, { coords: CLINIC, accuracyMeters: 20 }, wednesday);
    expect(res).toEqual({ ok: false, reason: "NOT_A_CLINIC_DAY" });
  });

  it("is idempotent: a second tap returns the original arrival time", async () => {
    const { person } = await seed();
    const first = await checkInSelf(person.id, { coords: CLINIC, accuracyMeters: 20 }, SATURDAY_MORNING);
    const second = await checkInSelf(person.id, { coords: CLINIC, accuracyMeters: 20 }, SATURDAY_MORNING);

    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.alreadyCheckedIn).toBe(true);
      expect(second.checkedInAt.getTime()).toBe(first.checkedInAt.getTime());
    }
    expect(await prisma.clinicAttendance.count()).toBe(1);
  });

  it("fails closed when the resolved fence centre is not a finite number", async () => {
    // Env defaults always supply a value, so the guard cannot be provoked by
    // deleting settings. Simulate a corrupt stored override instead.
    const { person } = await seed();
    await prisma.setting.upsert({
      where: { key: "clinic.checkInLatitude" },
      create: { key: "clinic.checkInLatitude", value: "null" },
      update: { value: "null" },
    });
    const { _resetSettingsCache } = await import("@/platform/settings/service");
    _resetSettingsCache();

    const res = await checkInSelf(person.id, { coords: CLINIC, accuracyMeters: 20 }, SATURDAY_MORNING);
    expect(res).toEqual({ ok: false, reason: "FENCE_UNCONFIGURED" });
    // Failing OPEN would be worse than having no fence at all, because a fence
    // that silently passes everyone would still be trusted.
    expect(await prisma.clinicAttendance.count()).toBe(0);
  });

  it("rejects an offboarded person", async () => {
    const { person } = await seed();
    await prisma.person.update({ where: { id: person.id }, data: { status: "OFFBOARDED" } });
    const res = await checkInSelf(person.id, { coords: CLINIC, accuracyMeters: 20 }, SATURDAY_MORNING);
    expect(res).toEqual({ ok: false, reason: "NOT_ELIGIBLE" });
    expect(await prisma.clinicAttendance.count()).toBe(0);
  });

  it("rejects when there is no active term", async () => {
    const { person, term } = await seed();
    await prisma.term.update({ where: { id: term.id }, data: { status: "ARCHIVED" } });
    const res = await checkInSelf(person.id, { coords: CLINIC, accuracyMeters: 20 }, SATURDAY_MORNING);
    expect(res).toEqual({ ok: false, reason: "NOT_A_CLINIC_DAY" });
  });
});

describe("getCheckInState", () => {
  beforeEach(async () => {
    await resetDb();
    await configureFence();
  });

  it("reports an existing check-in", async () => {
    const { person } = await seed();
    await checkInSelf(person.id, { coords: CLINIC, accuracyMeters: 20 }, SATURDAY_MORNING);
    const state = await getCheckInState(person.id, SATURDAY_MORNING);
    expect(state.existing?.method).toBe("SELF_GEO");
    expect(state.assignmentCount).toBe(1);
    expect(state.allRemote).toBe(false);
  });

  it("reports no clinic date on a non-clinic day", async () => {
    const { person } = await seed();
    const state = await getCheckInState(person.id, new Date("2026-03-04T13:30:00Z"));
    expect(state.clinicDate).toBeNull();
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

```bash
TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_clinic_checkin" \
npx vitest run src/modules/schedule/services/attendance.test.ts
```

Expected: FAIL, cannot resolve `./attendance`.

- [ ] **Step 3: Implement the service**

Create `src/modules/schedule/services/attendance.ts`:

```ts
import type { CheckInMethod } from "@prisma/client";
import { prisma } from "@/platform/db";
import { getActiveTerm } from "@/platform/terms/active-term";
import { getSetting } from "@/platform/settings/service";
import { isoDateKey } from "@/platform/dates";
import { displayTodayKey } from "@/platform/dates/today";
import { evaluateFence, type Coords } from "@/modules/schedule/engine/geofence";

export type CheckInFailureReason =
  | "PERMISSION_DENIED"
  | "POSITION_UNAVAILABLE"
  | "TIMEOUT"
  | "TOO_IMPRECISE"
  | "OUT_OF_RANGE"
  | "NOT_ASSIGNED"
  | "NOT_A_CLINIC_DAY"
  | "NOT_ELIGIBLE"
  | "FENCE_UNCONFIGURED";

export type CheckInResult =
  | { ok: true; alreadyCheckedIn: boolean; checkedInAt: Date; method: CheckInMethod }
  | { ok: false; reason: CheckInFailureReason };

export type CheckInState = {
  clinicDate: Date | null;
  termId: string | null;
  assignmentCount: number;
  allRemote: boolean;
  existing: { checkedInAt: Date; method: CheckInMethod } | null;
};

/**
 * Resolve today's clinic date for the live term, as the display-zone calendar
 * day. Returns null when there is no active term or today is not a clinic date.
 */
async function todaysClinicDate(now: Date): Promise<{ termId: string; clinicDate: Date } | null> {
  const term = await getActiveTerm();
  if (!term) return null;
  const todayKey = await displayTodayKey(now);
  const match = term.clinicDates.find((d) => isoDateKey(d) === todayKey);
  return match ? { termId: term.id, clinicDate: match } : null;
}

/** Everything the check-in page needs to render, in one call. */
export async function getCheckInState(personId: string, now: Date = new Date()): Promise<CheckInState> {
  const today = await todaysClinicDate(now);
  if (!today) {
    return { clinicDate: null, termId: null, assignmentCount: 0, allRemote: false, existing: null };
  }

  const [assignments, existing] = await Promise.all([
    prisma.shiftAssignment.findMany({
      where: { termId: today.termId, clinicDate: today.clinicDate, personId },
      select: { remote: true },
    }),
    prisma.clinicAttendance.findUnique({
      where: {
        termId_clinicDate_personId: {
          termId: today.termId,
          clinicDate: today.clinicDate,
          personId,
        },
      },
      select: { checkedInAt: true, method: true },
    }),
  ]);

  return {
    clinicDate: today.clinicDate,
    termId: today.termId,
    assignmentCount: assignments.length,
    // Conjunctive over a NON-EMPTY set. "every assignment is remote" is
    // vacuously true for a person with none, which would hand a fence-free
    // check-in to exactly the unscheduled people NOT_ASSIGNED exists to stop.
    allRemote: assignments.length > 0 && assignments.every((a) => a.remote),
    existing,
  };
}

/**
 * Self check-in. `position` is null when the client could not obtain a fix; the
 * caller maps the browser's own error codes to a more specific reason before
 * showing the user anything.
 *
 * The client never decides. It reports a position; this function owns the rule,
 * the verdict, and the write.
 */
export async function checkInSelf(
  personId: string,
  position: { coords: Coords; accuracyMeters: number } | null,
  now: Date = new Date(),
): Promise<CheckInResult> {
  // Re-validate the person at write time rather than trusting the session or a
  // previously-issued assignment, mirroring magic-link verification.
  const person = await prisma.person.findUnique({
    where: { id: personId },
    select: { status: true },
  });
  if (!person || person.status !== "ACTIVE") return { ok: false, reason: "NOT_ELIGIBLE" };

  const state = await getCheckInState(personId, now);
  if (!state.clinicDate || !state.termId) return { ok: false, reason: "NOT_A_CLINIC_DAY" };

  if (state.existing) {
    return {
      ok: true,
      alreadyCheckedIn: true,
      checkedInAt: state.existing.checkedInAt,
      method: state.existing.method,
    };
  }

  // Order matters: NOT_ASSIGNED before the remote waiver.
  if (state.assignmentCount === 0) return { ok: false, reason: "NOT_ASSIGNED" };

  let method: CheckInMethod;
  let distanceMeters: number | null = null;
  let accuracyMeters: number | null = null;

  if (state.allRemote) {
    method = "SELF_REMOTE";
  } else {
    if (!position) return { ok: false, reason: "POSITION_UNAVAILABLE" };

    const fence = await resolveFence();
    if (!fence) return { ok: false, reason: "FENCE_UNCONFIGURED" };

    const verdict = evaluateFence({
      position: position.coords,
      accuracyMeters: position.accuracyMeters,
      centre: fence.centre,
      radiusMeters: fence.radiusMeters,
      maxAccuracyMeters: fence.maxAccuracyMeters,
    });
    if (!verdict.ok) return { ok: false, reason: verdict.reason };

    method = "SELF_GEO";
    distanceMeters = verdict.distanceMeters;
    accuracyMeters = Math.round(position.accuracyMeters);
  }

  return writeAttendance({
    termId: state.termId,
    clinicDate: state.clinicDate,
    personId,
    method,
    distanceMeters,
    accuracyMeters,
    recordedById: null,
    note: null,
  });
}

/**
 * Resolve the configured fence. Returns null when any value is missing or not a
 * finite number, which makes self check-in FAIL CLOSED. Failing open would mean
 * a geofence that silently passes everyone, which is worse than having none
 * because it would be trusted.
 */
async function resolveFence(): Promise<{
  centre: Coords;
  radiusMeters: number;
  maxAccuracyMeters: number;
} | null> {
  const [latitude, longitude, radiusMeters, maxAccuracyMeters] = await Promise.all([
    getSetting<number>("clinic.checkInLatitude"),
    getSetting<number>("clinic.checkInLongitude"),
    getSetting<number>("clinic.checkInRadiusMeters"),
    getSetting<number>("clinic.checkInMaxAccuracyMeters"),
  ]);

  const values = [latitude, longitude, radiusMeters, maxAccuracyMeters];
  if (values.some((v) => typeof v !== "number" || !Number.isFinite(v))) return null;
  if (radiusMeters <= 0 || maxAccuracyMeters <= 0) return null;

  return { centre: { latitude, longitude }, radiusMeters, maxAccuracyMeters };
}

/**
 * Insert the row, tolerating the race where two taps land at once. The unique
 * constraint is the real guard; on collision we return the winning row so both
 * callers see the same arrival time.
 */
export async function writeAttendance(input: {
  termId: string;
  clinicDate: Date;
  personId: string;
  method: CheckInMethod;
  distanceMeters: number | null;
  accuracyMeters: number | null;
  recordedById: string | null;
  note: string | null;
}): Promise<CheckInResult> {
  const key = {
    termId_clinicDate_personId: {
      termId: input.termId,
      clinicDate: input.clinicDate,
      personId: input.personId,
    },
  };

  const existing = await prisma.clinicAttendance.findUnique({
    where: key,
    select: { checkedInAt: true, method: true },
  });
  if (existing) {
    return { ok: true, alreadyCheckedIn: true, checkedInAt: existing.checkedInAt, method: existing.method };
  }

  try {
    const row = await prisma.clinicAttendance.create({
      data: {
        termId: input.termId,
        clinicDate: input.clinicDate,
        personId: input.personId,
        method: input.method,
        distanceMeters: input.distanceMeters,
        accuracyMeters: input.accuracyMeters,
        recordedById: input.recordedById,
        note: input.note,
      },
      select: { checkedInAt: true, method: true },
    });
    return { ok: true, alreadyCheckedIn: false, checkedInAt: row.checkedInAt, method: row.method };
  } catch {
    // Lost the race. Re-read and report the winner.
    const winner = await prisma.clinicAttendance.findUnique({
      where: key,
      select: { checkedInAt: true, method: true },
    });
    if (!winner) throw new Error("clinic attendance write failed and no row exists");
    return { ok: true, alreadyCheckedIn: true, checkedInAt: winner.checkedInAt, method: winner.method };
  }
}
```

- [ ] **Step 4: Run the tests**

```bash
TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_clinic_checkin" \
npx vitest run src/modules/schedule/services/attendance.test.ts
```

Expected: all pass. If `setSetting` is not exported from `@/platform/settings/service`, check its actual export name and adjust the test helper.

- [ ] **Step 5: Commit**

```bash
git add src/modules/schedule/services/attendance.ts src/modules/schedule/services/attendance.test.ts
git commit -m "feat(schedule): add self check-in service with server-side geofence"
```

---

### Task 4: Staff override, roster query, and the new permission

**Files:**
- Modify: `src/modules/schedule/services/attendance.ts`
- Modify: `src/modules/schedule/services/attendance.test.ts`
- Modify: `src/platform/modules/registry.ts` (schedule module `permissions` array)
- Test: same file as above

**Interfaces:**
- Consumes: `writeAttendance`, `CheckInResult` from Task 3.
- Produces:
  - `markPresent(actorId: string, personId: string, opts?: { note?: string }, now?: Date): Promise<CheckInResult>`
  - `undoAttendance(personId: string, now?: Date): Promise<void>`
  - `attendanceForDate(termId: string, clinicDate: Date): Promise<Map<string, AttendanceRow>>`
  - `type AttendanceRow = { checkedInAt: Date; method: CheckInMethod; recordedById: string | null }`
  - Permission string `schedule.manage_attendance`.

- [ ] **Step 1: Write the failing tests**

Append to `src/modules/schedule/services/attendance.test.ts`:

```ts
import { markPresent, undoAttendance, attendanceForDate } from "./attendance";

describe("markPresent", () => {
  beforeEach(async () => {
    await resetDb();
    await configureFence();
  });

  it("records a STAFF row with the recorder attributed", async () => {
    const { person } = await seed();
    const director = await prisma.person.create({ data: { name: "Grace Hopper" } });

    const res = await markPresent(director.id, person.id, { note: "Phone had no signal" }, SATURDAY_MORNING);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.method).toBe("STAFF");

    const row = await prisma.clinicAttendance.findFirstOrThrow({ where: { personId: person.id } });
    expect(row.recordedById).toBe(director.id);
    expect(row.note).toBe("Phone had no signal");
    expect(row.distanceMeters).toBeNull();
  });

  it("records an UNASSIGNED person, so who-is-here stays honest", async () => {
    const { term } = await seed();
    const director = await prisma.person.create({ data: { name: "Grace Hopper" } });
    const walkOn = await prisma.person.create({ data: { name: "Katherine Johnson" } });

    const res = await markPresent(director.id, walkOn.id, {}, SATURDAY_MORNING);
    expect(res.ok).toBe(true);

    const row = await prisma.clinicAttendance.findFirstOrThrow({ where: { personId: walkOn.id } });
    expect(row.termId).toBe(term.id);
    // No assignment exists, so this person is present but not in the no-show denominator.
    const assignments = await prisma.shiftAssignment.count({ where: { personId: walkOn.id } });
    expect(assignments).toBe(0);
  });

  it("rejects an offboarded subject", async () => {
    const { person } = await seed();
    const director = await prisma.person.create({ data: { name: "Grace Hopper" } });
    await prisma.person.update({ where: { id: person.id }, data: { status: "OFFBOARDED" } });

    const res = await markPresent(director.id, person.id, {}, SATURDAY_MORNING);
    expect(res).toEqual({ ok: false, reason: "NOT_ELIGIBLE" });
  });

  it("rejects a non-clinic day", async () => {
    const { person } = await seed();
    const director = await prisma.person.create({ data: { name: "Grace Hopper" } });
    const res = await markPresent(director.id, person.id, {}, new Date("2026-03-04T13:30:00Z"));
    expect(res).toEqual({ ok: false, reason: "NOT_A_CLINIC_DAY" });
  });

  it("is idempotent against an existing self check-in", async () => {
    const { person } = await seed();
    const director = await prisma.person.create({ data: { name: "Grace Hopper" } });
    await checkInSelf(person.id, { coords: CLINIC, accuracyMeters: 20 }, SATURDAY_MORNING);

    const res = await markPresent(director.id, person.id, {}, SATURDAY_MORNING);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.alreadyCheckedIn).toBe(true);
      // The original SELF_GEO record is NOT overwritten by a STAFF one.
      expect(res.method).toBe("SELF_GEO");
    }
    expect(await prisma.clinicAttendance.count()).toBe(1);
  });
});

describe("undoAttendance", () => {
  beforeEach(async () => {
    await resetDb();
    await configureFence();
  });

  it("removes the row so a misclick can be corrected", async () => {
    const { person } = await seed();
    await checkInSelf(person.id, { coords: CLINIC, accuracyMeters: 20 }, SATURDAY_MORNING);
    expect(await prisma.clinicAttendance.count()).toBe(1);

    await undoAttendance(person.id, SATURDAY_MORNING);
    expect(await prisma.clinicAttendance.count()).toBe(0);
  });

  it("is a no-op when there is nothing to undo", async () => {
    const { person } = await seed();
    await expect(undoAttendance(person.id, SATURDAY_MORNING)).resolves.toBeUndefined();
  });
});

describe("attendanceForDate", () => {
  beforeEach(async () => {
    await resetDb();
    await configureFence();
  });

  it("returns a map keyed by personId", async () => {
    const { person, term } = await seed();
    await checkInSelf(person.id, { coords: CLINIC, accuracyMeters: 20 }, SATURDAY_MORNING);

    const map = await attendanceForDate(term.id, CLINIC_DATE);
    expect(map.get(person.id)?.method).toBe("SELF_GEO");
    expect(map.size).toBe(1);
  });

  it("is empty for a date with no attendance", async () => {
    const { term } = await seed();
    const map = await attendanceForDate(term.id, CLINIC_DATE);
    expect(map.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

```bash
TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_clinic_checkin" \
npx vitest run src/modules/schedule/services/attendance.test.ts
```

Expected: FAIL, `markPresent` is not exported.

- [ ] **Step 3: Implement**

Append to `src/modules/schedule/services/attendance.ts`:

```ts
export type AttendanceRow = {
  checkedInAt: Date;
  method: CheckInMethod;
  recordedById: string | null;
};

/**
 * Director override: record that someone is here when self check-in could not
 * happen (denied permission, no usable fix, or simply no assignment).
 *
 * Deliberately allows an UNASSIGNED subject. Informal covers happen, and a board
 * that cannot show them is visibly wrong. The row carries no assignment, so it
 * never enters the no-show denominator, which stays measured against
 * ShiftAssignment.
 *
 * Caller must have already enforced `schedule.manage_attendance`.
 */
export async function markPresent(
  actorId: string,
  personId: string,
  opts: { note?: string } = {},
  now: Date = new Date(),
): Promise<CheckInResult> {
  const person = await prisma.person.findUnique({
    where: { id: personId },
    select: { status: true },
  });
  if (!person || person.status !== "ACTIVE") return { ok: false, reason: "NOT_ELIGIBLE" };

  const today = await todaysClinicDate(now);
  if (!today) return { ok: false, reason: "NOT_A_CLINIC_DAY" };

  return writeAttendance({
    termId: today.termId,
    clinicDate: today.clinicDate,
    personId,
    method: "STAFF",
    distanceMeters: null,
    accuracyMeters: null,
    recordedById: actorId,
    note: opts.note?.trim() || null,
  });
}

/**
 * Remove today's attendance row for a person, so a misclick can be corrected.
 * No-op when there is nothing to remove.
 *
 * Caller must have already enforced `schedule.manage_attendance`.
 */
export async function undoAttendance(personId: string, now: Date = new Date()): Promise<void> {
  const today = await todaysClinicDate(now);
  if (!today) return;

  await prisma.clinicAttendance.deleteMany({
    where: { termId: today.termId, clinicDate: today.clinicDate, personId },
  });
}

/** Attendance for one clinic date, keyed by personId, for roster overlays. */
export async function attendanceForDate(
  termId: string,
  clinicDate: Date,
): Promise<Map<string, AttendanceRow>> {
  const rows = await prisma.clinicAttendance.findMany({
    where: { termId, clinicDate },
    select: { personId: true, checkedInAt: true, method: true, recordedById: true },
  });
  return new Map(
    rows.map((r) => [r.personId, { checkedInAt: r.checkedInAt, method: r.method, recordedById: r.recordedById }]),
  );
}
```

- [ ] **Step 4: Register the permission**

In `src/platform/modules/registry.ts`, add to the schedule module's `permissions` array (after `"schedule.manage_requests"`):

```ts
      "schedule.manage_attendance",
```

Do **not** add a nav entry for it: the override lives on `/schedule/full`, which is already in the nav.

- [ ] **Step 5: Run the tests**

```bash
TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_clinic_checkin" \
npx vitest run src/modules/schedule/services/attendance.test.ts src/platform/modules
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/modules/schedule/services/attendance.ts src/modules/schedule/services/attendance.test.ts src/platform/modules/registry.ts
git commit -m "feat(schedule): add staff attendance override and roster query"
```

---

### Task 5: No-show derivation

**Files:**
- Create: `src/modules/schedule/engine/attendance-stats.ts`
- Create: `src/modules/schedule/engine/attendance-stats.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `type AttendanceOutcome = "PRESENT" | "NO_SHOW" | "PENDING"`
  - `classifyAssignment(input: { clinicDateKey: string; todayKey: string; hasAttendance: boolean }): AttendanceOutcome`
  - `summarize(rows: Array<{ clinicDateKey: string; hasAttendance: boolean }>, todayKey: string): { present: number; noShow: number; pending: number; noShowRate: number | null }`

- [ ] **Step 1: Write the failing test**

Create `src/modules/schedule/engine/attendance-stats.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { classifyAssignment, summarize } from "./attendance-stats";

const TODAY = "2026-03-07";

describe("classifyAssignment", () => {
  it("is PRESENT when an attendance row exists, whatever the date", () => {
    expect(classifyAssignment({ clinicDateKey: "2026-02-28", todayKey: TODAY, hasAttendance: true })).toBe("PRESENT");
    expect(classifyAssignment({ clinicDateKey: TODAY, todayKey: TODAY, hasAttendance: true })).toBe("PRESENT");
    expect(classifyAssignment({ clinicDateKey: "2026-03-14", todayKey: TODAY, hasAttendance: true })).toBe("PRESENT");
  });

  it("is NO_SHOW only for a PAST date with no attendance", () => {
    expect(classifyAssignment({ clinicDateKey: "2026-02-28", todayKey: TODAY, hasAttendance: false })).toBe("NO_SHOW");
  });

  it("is PENDING for today with no attendance, so a 9am clinic is not scored as absences", () => {
    expect(classifyAssignment({ clinicDateKey: TODAY, todayKey: TODAY, hasAttendance: false })).toBe("PENDING");
  });

  it("is PENDING for a future date", () => {
    expect(classifyAssignment({ clinicDateKey: "2026-03-14", todayKey: TODAY, hasAttendance: false })).toBe("PENDING");
  });
});

describe("summarize", () => {
  it("counts each bucket and rates no-shows over decided assignments only", () => {
    const result = summarize(
      [
        { clinicDateKey: "2026-02-21", hasAttendance: true },
        { clinicDateKey: "2026-02-28", hasAttendance: false },
        { clinicDateKey: TODAY, hasAttendance: false },
        { clinicDateKey: "2026-03-14", hasAttendance: false },
      ],
      TODAY,
    );
    expect(result.present).toBe(1);
    expect(result.noShow).toBe(1);
    expect(result.pending).toBe(2);
    // 1 no-show out of 2 decided (present + noShow), NOT out of 4.
    expect(result.noShowRate).toBe(0.5);
  });

  it("returns a null rate when nothing has been decided yet", () => {
    const result = summarize([{ clinicDateKey: "2026-03-14", hasAttendance: false }], TODAY);
    expect(result.noShowRate).toBeNull();
  });

  it("handles an empty input", () => {
    expect(summarize([], TODAY)).toEqual({ present: 0, noShow: 0, pending: 0, noShowRate: null });
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

```bash
npx vitest run src/modules/schedule/engine/attendance-stats.test.ts
```

Expected: FAIL, cannot resolve `./attendance-stats`.

- [ ] **Step 3: Implement**

Create `src/modules/schedule/engine/attendance-stats.ts`:

```ts
/**
 * Pure derivation of attendance outcomes from assignments plus attendance rows.
 *
 * Absence is NEVER stored. An assignment with no attendance row on a clinic date
 * strictly BEFORE today is a no-show; on today or later it is simply pending.
 * That boundary is why today's clinic is not scored as a wall of absences at
 * 9am, and why nothing has to be backfilled when a clinic day ends.
 *
 * Keys are YYYY-MM-DD display-zone day keys, which compare correctly as strings.
 */

export type AttendanceOutcome = "PRESENT" | "NO_SHOW" | "PENDING";

export function classifyAssignment(input: {
  clinicDateKey: string;
  todayKey: string;
  hasAttendance: boolean;
}): AttendanceOutcome {
  if (input.hasAttendance) return "PRESENT";
  return input.clinicDateKey < input.todayKey ? "NO_SHOW" : "PENDING";
}

export function summarize(
  rows: Array<{ clinicDateKey: string; hasAttendance: boolean }>,
  todayKey: string,
): { present: number; noShow: number; pending: number; noShowRate: number | null } {
  let present = 0;
  let noShow = 0;
  let pending = 0;

  for (const row of rows) {
    switch (classifyAssignment({ ...row, todayKey })) {
      case "PRESENT":
        present += 1;
        break;
      case "NO_SHOW":
        noShow += 1;
        break;
      default:
        pending += 1;
    }
  }

  // Rate is over DECIDED assignments only. Including pending ones would make a
  // volunteer's record improve simply because more future shifts were scheduled.
  const decided = present + noShow;
  return { present, noShow, pending, noShowRate: decided === 0 ? null : noShow / decided };
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
npx vitest run src/modules/schedule/engine/attendance-stats.test.ts
```

Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add src/modules/schedule/engine/attendance-stats.ts src/modules/schedule/engine/attendance-stats.test.ts
git commit -m "feat(schedule): derive attendance outcomes and no-show rate"
```

---

### Task 6: Check-in page and server action

**Files:**
- Create: `src/app/(app)/schedule/check-in/page.tsx`
- Create: `src/modules/schedule/components/check-in-panel.tsx`
- Modify: `src/platform/modules/registry.ts` (schedule nav)

**Interfaces:**
- Consumes: `getCheckInState`, `checkInSelf`, `CheckInFailureReason` from Task 3.
- Produces: the route `/schedule/check-in` and a client component `<CheckInPanel />` taking `{ mode: "geo" | "remote"; action: (payload: GeoPayload | null) => Promise<CheckInActionResult> }`.

- [ ] **Step 1: Write the client panel**

Create `src/modules/schedule/components/check-in-panel.tsx`:

```tsx
"use client";

import { useState, useTransition } from "react";
import { Button } from "@/platform/ui/button";
import { Alert } from "@/platform/ui/alert";

export type GeoPayload = { latitude: number; longitude: number; accuracyMeters: number };

export type CheckInActionResult =
  | { ok: true; checkedInAt: string; alreadyCheckedIn: boolean }
  | { ok: false; reason: string };

/**
 * Copy for every failure the volunteer can see. Every message except the
 * not-a-clinic-day one ends by pointing at a director, INCLUDING out-of-range:
 * wifi-derived geolocation puts genuinely present people hundreds of metres away
 * often enough that treating distance as proof of absence would be wrong.
 */
const FAILURE_COPY: Record<string, string> = {
  PERMISSION_DENIED:
    "Your device would not share its location. Turn on location for this site and try again, or ask a director to check you in.",
  POSITION_UNAVAILABLE:
    "Your device could not work out where it is. Try again near a window, or ask a director to check you in.",
  TIMEOUT: "Finding your location took too long. Try again, or ask a director to check you in.",
  TOO_IMPRECISE:
    "Your location was too imprecise to confirm you are at the clinic. This is common indoors. Ask a director to check you in.",
  OUT_OF_RANGE:
    "You do not appear to be at the clinic. If you are here, your device's location may be off; ask a director to check you in.",
  NOT_ASSIGNED:
    "You are not on the schedule for today. If you are covering a shift, ask a director to check you in.",
  NOT_A_CLINIC_DAY: "There is no clinic today, so there is nothing to check in to.",
  NOT_ELIGIBLE: "Your membership is not active, so check-in is unavailable.",
  FENCE_UNCONFIGURED:
    "Check-in is not configured yet. Ask a director to check you in and let an admin know.",
  UNAVAILABLE: "Check-in could not be recorded right now. Ask a director to check you in.",
};

export function CheckInPanel({
  mode,
  action,
}: {
  mode: "geo" | "remote";
  action: (payload: GeoPayload | null) => Promise<CheckInActionResult>;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);

  function submit(payload: GeoPayload | null) {
    startTransition(async () => {
      const result = await action(payload);
      if (!result.ok) setError(FAILURE_COPY[result.reason] ?? FAILURE_COPY.UNAVAILABLE);
    });
  }

  function onClick() {
    setError(null);

    if (mode === "remote") {
      submit(null);
      return;
    }

    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setError(FAILURE_COPY.POSITION_UNAVAILABLE);
      return;
    }

    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        submit({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracyMeters: pos.coords.accuracy,
        });
      },
      (err) => {
        setLocating(false);
        // Map the browser's own codes so the message is specific.
        const reason =
          err.code === err.PERMISSION_DENIED
            ? "PERMISSION_DENIED"
            : err.code === err.TIMEOUT
              ? "TIMEOUT"
              : "POSITION_UNAVAILABLE";
        setError(FAILURE_COPY[reason]);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  }

  const busy = pending || locating;

  return (
    <div className="flex flex-col gap-4">
      {error && <Alert tone="warning">{error}</Alert>}
      <Button onClick={onClick} disabled={busy}>
        {locating
          ? "Finding your location..."
          : pending
            ? "Checking you in..."
            : mode === "remote"
              ? "Check in (telehealth)"
              : "Check in"}
      </Button>
      {mode === "geo" && (
        <p className="text-sm text-subtle-foreground">
          Check-in confirms you are at the clinic, so your device will ask to share your location.
          Only your rounded distance from the clinic is stored, never your coordinates.
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Write the page and server action**

Create `src/app/(app)/schedule/check-in/page.tsx`:

```tsx
import { requireModuleAccess } from "@/platform/auth/session";
import { Card } from "@/platform/ui/card";
import { revalidatePath } from "next/cache";
import { formatCalendarDate } from "@/platform/dates";
import { getCheckInState, checkInSelf } from "@/modules/schedule/services/attendance";
import {
  CheckInPanel,
  type GeoPayload,
  type CheckInActionResult,
} from "@/modules/schedule/components/check-in-panel";
import { captureEvent, GROUP_TERM } from "@/platform/posthog/capture";
import { buildPageMetadata } from "@/platform/branding/metadata";

// buildPageMetadata is async, so it goes through generateMetadata, not a static
// `export const metadata`. This matches src/app/(app)/page.tsx.
export function generateMetadata() {
  return buildPageMetadata({
    title: "Clinic check-in",
    description: "Check in for today's clinic shift.",
  });
}

export default async function CheckInPage() {
  const session = await requireModuleAccess("schedule");
  const state = await getCheckInState(session.personId);

  async function checkInAction(payload: GeoPayload | null): Promise<CheckInActionResult> {
    "use server";
    const actor = await requireModuleAccess("schedule");

    const result = await checkInSelf(
      actor.personId,
      payload
        ? {
            coords: { latitude: payload.latitude, longitude: payload.longitude },
            accuracyMeters: payload.accuracyMeters,
          }
        : null,
    );

    // Capture EVERY outcome. This is how the radius and accuracy thresholds get
    // tuned from data instead of anecdote.
    await captureEvent({
      distinctId: actor.personId,
      event: result.ok ? "clinic_check_in_succeeded" : "clinic_check_in_failed",
      properties: result.ok
        ? { method: result.method, alreadyCheckedIn: result.alreadyCheckedIn }
        : { reason: result.reason },
      groups: state.termId ? { [GROUP_TERM]: state.termId } : undefined,
    });

    if (!result.ok) return { ok: false, reason: result.reason };

    revalidatePath("/schedule/check-in");
    revalidatePath("/schedule");
    return {
      ok: true,
      checkedInAt: result.checkedInAt.toISOString(),
      alreadyCheckedIn: result.alreadyCheckedIn,
    };
  }

  if (!state.clinicDate) {
    return (
      <Card>
        <h1 className="text-xl font-bold text-foreground">No clinic today</h1>
        <p className="mt-2 text-sm text-subtle-foreground">
          There is no clinic scheduled for today, so there is nothing to check in to.
        </p>
      </Card>
    );
  }

  const dateLabel = formatCalendarDate(state.clinicDate, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  if (state.existing) {
    return (
      <Card>
        <h1 className="text-xl font-bold text-foreground">You are checked in</h1>
        <p className="mt-2 text-sm text-subtle-foreground">
          {dateLabel}, at{" "}
          {state.existing.checkedInAt.toLocaleTimeString("en-US", {
            hour: "numeric",
            minute: "2-digit",
          })}
          .
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <h1 className="text-xl font-bold text-foreground">Check in for {dateLabel}</h1>
      <div className="mt-4">
        <CheckInPanel mode={state.allRemote ? "remote" : "geo"} action={checkInAction} />
      </div>
    </Card>
  );
}
```

- [ ] **Step 3: Add the nav entry**

In `src/platform/modules/registry.ts`, in the schedule module's `nav` array, after `{ label: "My schedule", href: "/schedule" }`:

```ts
      // Data-driven: only meaningful on a clinic date, and schedule/layout.tsx
      // drops it otherwise. dynamicGate keeps it out of the global dropdown,
      // which cannot resolve "is today a clinic day".
      { label: "Check in", href: "/schedule/check-in", dynamicGate: true },
```

- [ ] **Step 4: Gate the tab in the schedule layout**

In `src/app/(app)/schedule/layout.tsx`, follow the existing pattern used for Builder/Approvals/Attendings: resolve whether today is a clinic date for the active term and drop the "Check in" tab when it is not. Read the file first and mirror how the neighbouring tabs are filtered rather than inventing a new mechanism.

- [ ] **Step 5: Typecheck and lint**

```bash
npm run typecheck
npx eslint src e2e
```

Expected: clean. If `buildPageMetadata` or `Alert`'s `tone` prop differ from the above, read the real signatures and adjust; do not add new UI primitives.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/schedule/check-in" src/modules/schedule/components/check-in-panel.tsx src/platform/modules/registry.ts "src/app/(app)/schedule/layout.tsx"
git commit -m "feat(schedule): add clinic check-in page"
```

---

### Task 7: Attendance overlay on the full schedule

**Files:**
- Modify: `src/modules/schedule/services/schedule.ts` (`fullSchedule` return shape)
- Modify: `src/app/(app)/schedule/full/page.tsx`
- Test: `src/modules/schedule/services/schedule.test.ts`

**Interfaces:**
- Consumes: `attendanceForDate`, `markPresent`, `undoAttendance` from Task 4; `schedule.manage_attendance`.
- Produces: `fullSchedule` additionally returns `attendance: Map<string, AttendanceRow>` for the selected date.

- [ ] **Step 1: Write the failing service test**

Append to `src/modules/schedule/services/schedule.test.ts` (match the file's existing seeding helpers rather than the ones below if they differ):

```ts
  it("returns attendance for the selected date alongside the roster", async () => {
    // Reuse whatever seed helper this file already defines for fullSchedule.
    const { term, person, clinicDateKey } = await seedFullSchedule();
    await prisma.clinicAttendance.create({
      data: {
        termId: term.id,
        clinicDate: new Date(`${clinicDateKey}T12:00:00Z`),
        personId: person.id,
        method: "STAFF",
      },
    });

    const result = await fullSchedule(clinicDateKey);
    expect(result.attendance.get(person.id)?.method).toBe("STAFF");
  });

  it("returns an empty attendance map when nobody has checked in", async () => {
    const { clinicDateKey } = await seedFullSchedule();
    const result = await fullSchedule(clinicDateKey);
    expect(result.attendance.size).toBe(0);
  });
```

- [ ] **Step 2: Run to confirm it fails**

```bash
TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_clinic_checkin" \
npx vitest run src/modules/schedule/services/schedule.test.ts
```

Expected: FAIL, `attendance` is undefined.

- [ ] **Step 3: Extend `fullSchedule`**

In `src/modules/schedule/services/schedule.ts`:

1. Import `attendanceForDate` and its `AttendanceRow` type from `./attendance`.
2. Add `attendance: Map<string, AttendanceRow>` to the declared return type.
3. Return an empty `new Map()` from both early-return branches (no active term, no clinic dates).
4. After `selectedDate` is resolved, fetch and include it:

```ts
  const attendance = await attendanceForDate(term.id, selectedDate);
```

5. Add `attendance` to the final returned object.

- [ ] **Step 4: Render the overlay, gated on the permission**

In `src/app/(app)/schedule/full/page.tsx`:

1. Replace `await requireModuleAccess("schedule")` with a form that keeps the session, and resolve the permission:

```tsx
import { can } from "@/platform/rbac/engine";
import { markPresent, undoAttendance } from "@/modules/schedule/services/attendance";
import { requireModuleAccess, requirePermission } from "@/platform/auth/session";

  const session = await requireModuleAccess("schedule");
  const canMarkAttendance = await can(session.personId, "schedule.manage_attendance");
  const { term, clinicDates, selectedDate, departments, attendance } = await fullSchedule(sp.date);
```

2. Add the two server actions, each re-enforcing the permission on its own (a server action is a public endpoint; the page-level check does not protect it):

```tsx
  async function markPresentAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("schedule.manage_attendance");
    const personId = (formData.get("personId") as string | null) ?? "";
    if (personId) await markPresent(actor.personId, personId);
    revalidatePath("/schedule/full");
  }

  async function undoAttendanceAction(formData: FormData) {
    "use server";
    await requirePermission("schedule.manage_attendance");
    const personId = (formData.get("personId") as string | null) ?? "";
    if (personId) await undoAttendance(personId);
    revalidatePath("/schedule/full");
  }
```

3. In each person list item, when `canMarkAttendance` is true, render either a "Here" badge (when `attendance.has(p.id)`) with an undo control, or a "Mark present" submit button. Members without the permission see the list exactly as it is today: **do not render an absence indicator for anyone**, since a peer-visible absent marker broadcasts who did not show up.

Follow the file's existing `Badge` and `NavForm` usage rather than introducing new primitives.

- [ ] **Step 5: Run tests, typecheck, lint**

```bash
TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_clinic_checkin" \
npx vitest run src/modules/schedule
npm run typecheck
npx eslint src e2e
```

Expected: all pass, clean.

- [ ] **Step 6: Commit**

```bash
git add src/modules/schedule "src/app/(app)/schedule/full/page.tsx"
git commit -m "feat(schedule): show and record attendance on the full schedule"
```

---

### Task 8: Morning-of check-in email and its cron

**Files:**
- Create: `src/platform/email/checkin-invites.ts`
- Create: `src/platform/email/checkin-invites.test.ts`
- Create: `src/app/api/cron/clinic-checkin-invites/route.ts`
- Modify: `src/platform/email/templates/schedule.ts`
- Modify: `src/platform/notifications/registry.ts`
- Modify: `docs/cron-jobs.md`

**Interfaces:**
- Consumes: `getActiveTerm`, `notify`, `renderEmail`, `displayTodayKey`, `isoDateKey`.
- Produces: `runCheckInInvites(now?: Date): Promise<{ skipped: boolean; queued: number }>`; template key `clinic-checkin-invite`.

- [ ] **Step 1: Add the template descriptor**

In `src/platform/email/templates/schedule.ts`, add a descriptor to the exported `scheduleDescriptors` array. Read the file first and match the shape of its existing entries exactly. The new one:

- `key`: `"clinic-checkin-invite"`
- `name`: `"Clinic day: check-in link"`
- `category`: `"transactional"`
- `group`: `"shift"`
- `variables`: `firstName`, `clinicDateLabel`, `checkInUrl` (each with a `label` and a `sampleValue`)
- `defaultSubject`: `"Check in for clinic today"`
- `defaultBody`:

```html
<p>Hello {{ firstName }},</p>
<p>You are scheduled for clinic today, {{ clinicDateLabel }}. Please check in when you arrive.</p>
<p><a href="{{ checkInUrl }}">Check in</a></p>
<p>Check-in confirms you are at the clinic, so your device will ask to share your location. Only your rounded distance from the clinic is stored, never your coordinates. If you are volunteering remotely today, you can check in from anywhere.</p>
<p>If check-in does not work for any reason, ask a director to check you in. Do not let it hold you up.</p>
```

- [ ] **Step 2: Register the notification type**

In `src/platform/notifications/registry.ts`, add to `NOTIFICATION_TYPES` after the `shift-reminder` entry:

```ts
  { key: "clinic-checkin-invite", label: "Clinic day: check-in link", defaultChannel: "email" },
```

- [ ] **Step 3: Write the failing runner test**

Create `src/platform/email/checkin-invites.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { runCheckInInvites } from "./checkin-invites";

const CLINIC_DATE = new Date("2026-03-07T12:00:00Z");
const SATURDAY_MORNING = new Date("2026-03-07T11:00:00Z");
const WEDNESDAY = new Date("2026-03-04T11:00:00Z");

async function seed() {
  const term = await prisma.term.create({
    data: {
      code: "TS26",
      name: "Test 2026",
      startDate: new Date("2026-01-01T00:00:00Z"),
      endDate: new Date("2026-06-01T00:00:00Z"),
      status: "ACTIVE",
      clinicDates: [CLINIC_DATE],
    },
  });
  const dept = await prisma.department.create({ data: { code: "SCTP", name: "Screening" } });
  const scheduled = await prisma.person.create({
    data: { name: "Ada Lovelace", contactEmail: "ada@example.com" },
  });
  const unscheduled = await prisma.person.create({
    data: { name: "Katherine Johnson", contactEmail: "kj@example.com" },
  });
  await prisma.termMembership.createMany({
    data: [
      { termId: term.id, departmentId: dept.id, personId: scheduled.id, status: "ACTIVE" },
      { termId: term.id, departmentId: dept.id, personId: unscheduled.id, status: "ACTIVE" },
    ],
  });
  await prisma.shiftAssignment.create({
    data: {
      termId: term.id,
      departmentId: dept.id,
      personId: scheduled.id,
      clinicDate: CLINIC_DATE,
      role: "VOLUNTEER",
    },
  });
  return { term, scheduled, unscheduled };
}

describe("runCheckInInvites", () => {
  beforeEach(resetDb);

  it("no-ops when today is not a clinic date", async () => {
    await seed();
    const result = await runCheckInInvites(WEDNESDAY);
    expect(result).toEqual({ skipped: true, queued: 0 });
    expect(await prisma.emailLog.count()).toBe(0);
  });

  it("queues exactly the people assigned that clinic date", async () => {
    const { scheduled, unscheduled } = await seed();
    const result = await runCheckInInvites(SATURDAY_MORNING);

    expect(result.skipped).toBe(false);
    expect(result.queued).toBe(1);

    const logs = await prisma.emailLog.findMany({ select: { personId: true } });
    expect(logs.map((l) => l.personId)).toEqual([scheduled.id]);
    expect(logs.map((l) => l.personId)).not.toContain(unscheduled.id);
  });

  it("queues one email for a person assigned to two departments", async () => {
    const { term, scheduled } = await seed();
    const second = await prisma.department.create({ data: { code: "JCTP", name: "Joint Clinic" } });
    await prisma.termMembership.create({
      data: { termId: term.id, departmentId: second.id, personId: scheduled.id, status: "ACTIVE" },
    });
    await prisma.shiftAssignment.create({
      data: {
        termId: term.id,
        departmentId: second.id,
        personId: scheduled.id,
        clinicDate: CLINIC_DATE,
        role: "VOLUNTEER",
      },
    });

    const result = await runCheckInInvites(SATURDAY_MORNING);
    expect(result.queued).toBe(1);
    expect(await prisma.emailLog.count()).toBe(1);
  });

  it("no-ops when there is no active term", async () => {
    const { term } = await seed();
    await prisma.term.update({ where: { id: term.id }, data: { status: "ARCHIVED" } });
    expect(await runCheckInInvites(SATURDAY_MORNING)).toEqual({ skipped: true, queued: 0 });
  });

  it("does not send: it only enqueues", async () => {
    await seed();
    await runCheckInInvites(SATURDAY_MORNING);
    const logs = await prisma.emailLog.findMany({ select: { status: true } });
    expect(logs.every((l) => l.status === "PENDING")).toBe(true);
  });
});
```

- [ ] **Step 4: Run to confirm it fails**

```bash
TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_clinic_checkin" \
npx vitest run src/platform/email/checkin-invites.test.ts
```

Expected: FAIL, cannot resolve `./checkin-invites`.

- [ ] **Step 5: Implement the runner**

Create `src/platform/email/checkin-invites.ts`. Read `src/platform/email/shift-reminders.ts` first and mirror its structure (it is the closest sibling: same audience query, same `notify()` usage, same `renderEmail` call).

```ts
import { prisma } from "@/platform/db";
import { getActiveTerm } from "@/platform/terms/active-term";
import { getSetting } from "@/platform/settings/service";
import { formatCalendarDate, isoDateKey } from "@/platform/dates";
import { displayTodayKey } from "@/platform/dates/today";
import { notify } from "@/platform/notifications/notify";
import { renderEmail } from "./templates/renderEmail";
import { log, errorAttrs } from "@/platform/logging";

const TEMPLATE_KEY = "clinic-checkin-invite";

function firstNameOf(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

/**
 * Morning-of check-in invitations.
 *
 * Runs DAILY and no-ops unless today is a clinic date for the live term, rather
 * than assuming Saturday: a rescheduled or midweek clinic still gets its email.
 *
 * ENQUEUES ONLY. Delivery is /api/cron/email's job; draining here would run
 * concurrently with that route and double-send.
 */
export async function runCheckInInvites(
  now: Date = new Date(),
): Promise<{ skipped: boolean; queued: number }> {
  const term = await getActiveTerm();
  if (!term) return { skipped: true, queued: 0 };

  const todayKey = await displayTodayKey(now);
  const clinicDate = term.clinicDates.find((d) => isoDateKey(d) === todayKey);
  if (!clinicDate) return { skipped: true, queued: 0 };

  const assignments = await prisma.shiftAssignment.findMany({
    where: { termId: term.id, clinicDate },
    select: {
      person: {
        select: { id: true, name: true, contactEmail: true, entraObjectId: true, status: true },
      },
    },
  });

  // One email per PERSON, not per assignment: someone on two departments'
  // schedules arrives once and should be asked once.
  const byPerson = new Map<string, (typeof assignments)[number]["person"]>();
  for (const a of assignments) {
    if (a.person.status !== "ACTIVE") continue;
    byPerson.set(a.person.id, a.person);
  }

  const baseUrl = await getSetting<string>("app.baseUrl");
  const clinicDateLabel = formatCalendarDate(clinicDate, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  const checkInUrl = `${baseUrl}/schedule/check-in`;

  let queued = 0;
  for (const person of byPerson.values()) {
    try {
      const rendered = await renderEmail(TEMPLATE_KEY, {
        firstName: firstNameOf(person.name),
        clinicDateLabel,
        checkInUrl,
      });

      await notify(prisma, {
        type: TEMPLATE_KEY,
        person,
        email: { subject: rendered.subject, html: rendered.html },
        teams: {
          title: "Clinic check-in",
          summary: `You are scheduled for clinic today, ${clinicDateLabel}. Check in when you arrive.`,
          link: checkInUrl,
        },
      });
      queued += 1;
    } catch (err) {
      // One bad recipient must not abort the whole run.
      log.error("[checkin-invites] failed to queue", {
        personId: person.id,
        ...errorAttrs(err),
      });
    }
  }

  return { skipped: false, queued };
}
```

- [ ] **Step 6: Run the tests**

```bash
TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_clinic_checkin" \
npx vitest run src/platform/email/checkin-invites.test.ts
```

Expected: 5 passed. If `renderEmail`'s signature differs, read it and adjust the call.

- [ ] **Step 7: Add the cron route**

Create `src/app/api/cron/clinic-checkin-invites/route.ts`:

```ts
/**
 * Morning-of clinic check-in invitations.
 *
 * Triggered DAILY at 11:00 UTC (7:00 AM ET in summer) by an EXTERNAL scheduler
 * (cron-job.org) hitting this path with `Authorization: Bearer $CRON_SECRET`,
 * not by Vercel Cron; this route is intentionally absent from vercel.json (see
 * docs/cron-jobs.md). Daily rather than weekly so a rescheduled or midweek
 * clinic still gets its email; the runner no-ops on non-clinic days.
 *
 * This route only ENQUEUES; delivery is handled by the per-minute
 * /api/cron/email drainer within ~60s. Draining here would run concurrently
 * with that route and double-send.
 */
import { authorizeCron } from "@/platform/cron";
import { recordCronHeartbeat } from "@/platform/cron-heartbeat";
import { log, flushLogs } from "@/platform/logging";
import { runCheckInInvites } from "@/platform/email/checkin-invites";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request): Promise<Response> {
  if (!authorizeCron(req)) return new Response("Unauthorized", { status: 401 });

  const r = await runCheckInInvites();

  log.info("[cron/clinic-checkin-invites] complete", { ...r });
  await recordCronHeartbeat("clinic-checkin-invites");
  await flushLogs();
  return Response.json({ ok: true, ...r });
}
```

- [ ] **Step 8: Document the schedule**

Add a row to `docs/cron-jobs.md` matching the existing table's columns: path `/api/cron/clinic-checkin-invites`, cadence daily at 11:00 UTC, purpose "Queues the morning-of check-in link to everyone assigned to today's clinic; no-ops on non-clinic days." Note it must be provisioned in cron-job.org.

- [ ] **Step 9: Typecheck and lint**

```bash
npm run typecheck
npx eslint src e2e
```

- [ ] **Step 10: Commit**

```bash
git add src/platform/email/checkin-invites.ts src/platform/email/checkin-invites.test.ts src/platform/email/templates/schedule.ts src/platform/notifications/registry.ts src/app/api/cron/clinic-checkin-invites docs/cron-jobs.md
git commit -m "feat(schedule): email a check-in link on clinic mornings"
```

---

### Task 9: Dashboard card and permission grant

**Files:**
- Modify: `src/app/(app)/action-cards.ts`
- Modify: `src/app/(app)/action-cards.test.ts`
- Modify: `src/app/(app)/page.tsx` (populate the new input)
- Create: `prisma/migrations/20260807130000_schedule_manage_attendance_grant/migration.sql`

**Interfaces:**
- Consumes: `getCheckInState` from Task 3.
- Produces: an `ActionCard` with `key: "check-in"`; the `schedule.manage_attendance` grant in production.

- [ ] **Step 1: Write the failing action-card test**

Append to `src/app/(app)/action-cards.test.ts` (match the file's existing input helper):

```ts
  it("surfaces check-in above everything else on a clinic day when not yet checked in", () => {
    const cards = buildActionCards(baseInput({
      hasScheduleAccess: true,
      clinicToday: true,
      checkedInToday: false,
    }));
    expect(cards[0].key).toBe("check-in");
  });

  it("drops the check-in card once the person has checked in", () => {
    const cards = buildActionCards(baseInput({
      hasScheduleAccess: true,
      clinicToday: true,
      checkedInToday: true,
    }));
    expect(cards.find((c) => c.key === "check-in")).toBeUndefined();
  });

  it("shows no check-in card when there is no clinic today", () => {
    const cards = buildActionCards(baseInput({
      hasScheduleAccess: true,
      clinicToday: false,
      checkedInToday: false,
    }));
    expect(cards.find((c) => c.key === "check-in")).toBeUndefined();
  });
```

- [ ] **Step 2: Run to confirm it fails**

```bash
npx vitest run "src/app/(app)/action-cards.test.ts"
```

Expected: FAIL, `clinicToday` is not a valid input property.

- [ ] **Step 3: Implement the card**

In `src/app/(app)/action-cards.ts`:

1. Add to `ActionCardInput`:

```ts
  clinicToday: boolean;      // today is a clinic date for the live term
  checkedInToday: boolean;   // this person already has an attendance row
```

2. Add the builder, using `ClipboardCheck` (already imported in this file):

```ts
/**
 * Only appears on a clinic day, and only until the person checks in. Priority
 * 100 puts it above every other card: on a Saturday morning it is the single
 * most time-sensitive thing the person can do.
 */
function checkInCard(input: ActionCardInput): ActionCard | null {
  if (!input.hasScheduleAccess || !input.clinicToday || input.checkedInToday) return null;
  return {
    key: "check-in",
    href: "/schedule/check-in",
    icon: ClipboardCheck,
    hue: "schedule",
    label: "Clinic check-in",
    sub: "Check in for today",
    priority: 100,
  };
}
```

3. Include it in the assembled list wherever the other cards are collected, filtering out the null.

- [ ] **Step 4: Populate the input on the dashboard**

In `src/app/(app)/page.tsx`, resolve the two new fields with `getCheckInState(session.personId)` and pass them into the `buildActionCards` input:

```tsx
  const checkIn = await getCheckInState(session.personId);
  // ...
    clinicToday: checkIn.clinicDate !== null && checkIn.assignmentCount > 0,
    checkedInToday: checkIn.existing !== null,
```

- [ ] **Step 5: Run the tests**

```bash
npx vitest run "src/app/(app)/action-cards.test.ts"
npm run typecheck
```

Expected: pass.

- [ ] **Step 6: Write the permission backfill migration**

A new permission string does nothing in production until it is granted. Create `prisma/migrations/20260807130000_schedule_manage_attendance_grant/migration.sql`:

```sql
-- Grant schedule.manage_attendance to the roles that run clinic day.
-- New permission strings are inert in production until granted: the settings
-- registry and SYSTEM_ROLES only seed fresh databases, so an existing
-- deployment needs this backfill.
--
-- Platform Admin already holds "*" and needs no row.
INSERT INTO "RoleGrant" ("id", "roleId", "permission")
SELECT gen_random_uuid()::text, r."id", 'schedule.manage_attendance'
FROM "Role" r
WHERE r."name" = 'Director'
  AND NOT EXISTS (
    SELECT 1 FROM "RoleGrant" g
    WHERE g."roleId" = r."id" AND g."permission" = 'schedule.manage_attendance'
  );
```

Before writing this, **read an existing grant-backfill migration** in `prisma/migrations/` and copy its exact column names and id-generation approach. If `RoleGrant.id` is a cuid generated in application code rather than by the database, that migration will show how prior backfills handled it.

- [ ] **Step 7: Add the grant to SYSTEM_ROLES**

In `src/platform/rbac/system-roles.ts`, add `"schedule.manage_attendance"` to the `Director` role's `grants` array so fresh databases and the dev seed match production after the backfill.

- [ ] **Step 8: Apply and verify**

```bash
DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_clinic_checkin" \
DATABASE_URL_UNPOOLED="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_clinic_checkin" \
npx prisma migrate deploy

TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_clinic_checkin" \
npx vitest run src/platform/rbac
```

Expected: migration applies; RBAC tests pass. If `system-roles.test.ts` asserts exact grant lists, update it.

- [ ] **Step 9: Commit**

```bash
git add "src/app/(app)/action-cards.ts" "src/app/(app)/action-cards.test.ts" "src/app/(app)/page.tsx" prisma/migrations src/platform/rbac/system-roles.ts
git commit -m "feat(schedule): surface check-in on the dashboard and grant the attendance permission"
```

---

### Task 10: End-to-end coverage

**Files:**
- Create: `e2e/clinic-check-in.spec.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: no application code.

- [ ] **Step 1: Read the existing e2e setup**

Read two existing specs in `e2e/` plus `playwright.config.ts` before writing anything. You need this project's actual login helper, seeding approach, and base URL convention. Do not invent a new harness.

- [ ] **Step 2: Write the spec**

Create `e2e/clinic-check-in.spec.ts`. Playwright grants geolocation per browser context, which is what makes the fence genuinely testable:

```ts
import { test, expect } from "@playwright/test";

// Coordinates must match the seeded clinic.checkIn* settings.
const CLINIC = { latitude: 41.3025, longitude: -72.937 };
const BOSTON = { latitude: 42.3601, longitude: -71.0589 };

test.describe("clinic check-in", () => {
  test.use({ permissions: ["geolocation"] });

  test("an assigned volunteer at the clinic can check in", async ({ page, context }) => {
    await context.setGeolocation(CLINIC);
    // Sign in using this project's existing helper, as a person seeded with an
    // assignment on today's clinic date.
    await page.goto("/schedule/check-in");

    await page.getByRole("button", { name: /^Check in$/ }).click();
    await expect(page.getByText(/You are checked in/i)).toBeVisible();
  });

  test("a volunteer far away is refused and pointed at a director", async ({ page, context }) => {
    await context.setGeolocation(BOSTON);
    await page.goto("/schedule/check-in");

    await page.getByRole("button", { name: /^Check in$/ }).click();
    await expect(page.getByText(/ask a director to check you in/i)).toBeVisible();
    await expect(page.getByText(/You are checked in/i)).not.toBeVisible();
  });

  test("a director can mark someone present from the full schedule", async ({ page }) => {
    // Sign in as a person holding schedule.manage_attendance.
    await page.goto("/schedule/full");

    await page.getByRole("button", { name: /Mark present/i }).first().click();
    await expect(page.getByText(/Here/i).first()).toBeVisible();
  });
});
```

Anchor any status text with an exact-match regex (`/^OPEN$/`-style) rather than a substring: this suite has been bitten before by a badge substring matching unrelated copy.

- [ ] **Step 3: Run the e2e suite**

```bash
npx playwright test e2e/clinic-check-in.spec.ts
```

**Before running, confirm your environment does not point at the production database.** The repo `.env` points every database URL at production Neon, and Playwright reads `.env`. Override `DATABASE_URL` to the local test database for the run.

- [ ] **Step 4: Commit**

```bash
git add e2e/clinic-check-in.spec.ts
git commit -m "test(schedule): cover clinic check-in end to end"
```

---

### Task 11: Full verification

- [ ] **Step 1: Full unit suite**

```bash
TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_clinic_checkin" \
BLOB_READ_WRITE_TOKEN="" npm test
```

Compare against the baseline recorded before this work started. Only new failures matter.

- [ ] **Step 2: Typecheck and full lint**

```bash
npm run typecheck
npx eslint src e2e
```

Both must be clean. `npx eslint src e2e` rather than `npm run lint`, which walks a gitignored design-system directory and reports false failures.

- [ ] **Step 3: Confirm the fence coordinates**

**This is a release blocker, not a nicety.** The seeded latitude and longitude are a geocode of 800 Howard Avenue and have not been verified against the building entrance. Confirm them (stand at the door with a phone, or check a satellite view) and update `clinic.checkInLatitude` / `clinic.checkInLongitude` in `/admin/settings` before announcing the feature. A centre even fifty metres off turns the fence into something that fails people at the door.

- [ ] **Step 4: Provision the cron schedule**

Add the daily 11:00 UTC job for `/api/cron/clinic-checkin-invites` in cron-job.org with the `Authorization: Bearer $CRON_SECRET` header. Nothing in the repo schedules it.

---

## Self-Review

**Spec coverage.** Every section of the spec maps to a task: data model and privacy (Task 1), configuration and the rule (Task 2), the flow and failure taxonomy (Tasks 3 and 6), the remote waiver and its non-empty guard (Task 3), staff override and the unscoped permission (Tasks 4 and 9), no-show derivation (Task 5), the `/schedule/full` overlay and its peer-visibility restraint (Task 7), the morning email and its daily-no-op cron (Task 8), observability (Task 6), error handling including fail-closed (Task 3), testing (throughout, plus Tasks 10 and 11), and migration/rollout (Tasks 1, 9, 11).

**Two gaps closed while reviewing.** The spec never said a new permission string is inert in production without a backfill, so Task 9 adds the grant migration. And the spec's `resetDb` implications were unstated, so Task 1 wires the new table into the truncate list.

**Type consistency.** `CheckInResult`, `CheckInFailureReason`, `CheckInState`, `AttendanceRow`, `Coords`, `FenceVerdict`, and `GeoPayload` are each defined once and referred to with the same names and shapes in every later task. `writeAttendance` is defined in Task 3 and reused by Task 4. `FENCE_UNCONFIGURED` and `NOT_ELIGIBLE` appear in the failure union, the service, and the client copy map.

**One honest caveat carried into the tasks.** Several steps say to read the neighbouring file and match its real signatures (`renderEmail`, `Alert`'s props, `buildPageMetadata`, the e2e login helper, the existing grant-backfill migration) rather than trusting the illustrative code here. Those are the places where this plan is working from a pattern rather than a verified signature, and they are marked as such instead of being presented as certain.
