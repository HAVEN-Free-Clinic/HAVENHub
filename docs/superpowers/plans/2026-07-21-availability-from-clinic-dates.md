# Availability From Clinic Dates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Source the recruitment application's availability options live from the term's admin-curated `Term.clinicDates` instead of computing every Saturday in the term window.

**Architecture:** Two pure functions in a new `templates/clinic-dates.ts` module. `clinicDateOptions` turns the term's `DateTime[]` into `MULTI_SELECT` options; `resolveAvailabilityOptions` swaps them into a loaded form's sections (and removes the question entirely when the calendar is empty). Four loaders call the resolver, so the render path and the validation path can never disagree. No Prisma migration, and cycles already seeded with phantom Saturdays are fixed retroactively because their stored `FormField.options` snapshot is ignored.

**Tech Stack:** TypeScript, Next.js App Router (RSC), Prisma, zod, Vitest.

Spec: `docs/superpowers/specs/2026-07-21-availability-from-clinic-dates-design.md`
Branch: `feat/availability-from-clinic-dates` (already created, spec already committed)

## Global Constraints

- **No em-dashes** in code comments, commit messages, or user-facing copy.
- **"HAVEN Hub"** is two words in prose and UI copy; identifiers stay `havenhub`.
- Date rendering goes through `@/platform/dates`. Never call `.toLocaleDateString()` / `.toLocaleTimeString()` outside `src/platform/dates/` (enforced by `src/platform/dates/no-raw-locale.guard.test.ts`).
- Clinic dates are **noon-UTC anchored**; availability values are **UTC day keys** (`YYYY-MM-DD`). Compare by day key, never by raw timestamp.
- Recruitment must import only from `@/platform/*` or within `@/modules/recruitment/*`. Do not import from `@/modules/schedule/*` (eslint module-boundary rule).
- Run `npm run lint` (whole repo) before pushing; `tsc` and tests alone miss the eslint boundary rules.
- Tests use the local throwaway Postgres at `:5434`, never Neon. Set `TEST_DATABASE_URL` per worktree.

---

### Task 1: `clinicDateOptions` helper

**Files:**
- Create: `src/modules/recruitment/templates/clinic-dates.ts`
- Test: `src/modules/recruitment/templates/clinic-dates.test.ts`

**Interfaces:**
- Consumes: `isoDateKey`, `formatCalendarDate` from `@/platform/dates`; `TemplateOption` from `./types`.
- Produces: `clinicDateOptions(clinicDates: Date[]): TemplateOption[]`, used by Task 2 and Task 4.

- [ ] **Step 1: Write the failing test**

Create `src/modules/recruitment/templates/clinic-dates.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { clinicDateOptions } from "./clinic-dates";

/** Term.clinicDates entries are noon-UTC anchored (see prisma/schema.prisma). */
const noonUtc = (iso: string) => new Date(`${iso}T12:00:00.000Z`);

describe("clinicDateOptions", () => {
  it("maps a noon-UTC clinic date to its UTC day key with no off-by-one", () => {
    expect(clinicDateOptions([noonUtc("2026-06-06")])).toEqual([
      { value: "2026-06-06", label: "Sat, Jun 6" },
    ]);
  });

  it("sorts ascending regardless of input order", () => {
    const out = clinicDateOptions([noonUtc("2026-06-20"), noonUtc("2026-06-06")]);
    expect(out.map((o) => o.value)).toEqual(["2026-06-06", "2026-06-20"]);
  });

  it("labels a non-Saturday clinic date with its real weekday", () => {
    expect(clinicDateOptions([noonUtc("2026-06-10")])[0].label).toBe("Wed, Jun 10");
  });

  it("returns an empty list for an empty calendar", () => {
    expect(clinicDateOptions([])).toEqual([]);
  });

  it("does not mutate the caller's array", () => {
    const input = [noonUtc("2026-06-20"), noonUtc("2026-06-06")];
    clinicDateOptions(input);
    expect(input.map((d) => d.toISOString())).toEqual([
      "2026-06-20T12:00:00.000Z",
      "2026-06-06T12:00:00.000Z",
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/recruitment/templates/clinic-dates.test.ts`
Expected: FAIL, cannot resolve `./clinic-dates`.

- [ ] **Step 3: Write minimal implementation**

Create `src/modules/recruitment/templates/clinic-dates.ts`:

```ts
import { isoDateKey, formatCalendarDate } from "@/platform/dates";
import type { TemplateOption } from "./types";

/**
 * The term's admin-curated clinic calendar (Term.clinicDates) as MULTI_SELECT
 * options for the application's availability question.
 *
 * `value` is the UTC day key: it is what parseAvailabilityDates expects and what
 * the scheduler compares baselineAvailability on. The weekday is part of the
 * label because clinic dates are curated, not generated, so they are no longer
 * guaranteed to fall on a Saturday.
 */
export function clinicDateOptions(clinicDates: Date[]): TemplateOption[] {
  return [...clinicDates]
    .sort((a, b) => a.getTime() - b.getTime())
    .map((d) => ({
      value: isoDateKey(d),
      label: formatCalendarDate(d, { weekday: "short", month: "short", day: "numeric" }),
    }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/recruitment/templates/clinic-dates.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/templates/clinic-dates.ts src/modules/recruitment/templates/clinic-dates.test.ts
git commit -m "feat(recruitment): add clinicDateOptions for availability options"
```

---

### Task 2: `resolveAvailabilityOptions` resolver

**Files:**
- Modify: `src/modules/recruitment/templates/clinic-dates.ts`
- Test: `src/modules/recruitment/templates/clinic-dates.test.ts`

**Interfaces:**
- Consumes: `clinicDateOptions` from Task 1.
- Produces: `AVAILABILITY_FIELD_KEY: "availability"` and
  `resolveAvailabilityOptions<F extends { key: string; options: unknown }, S extends { fields: F[] }>(sections: S[], clinicDates: Date[]): S[]`.
  Tasks 3 and 5 call it. The generic is structural so it accepts both Prisma
  `FormSection & { fields: FormField[] }` rows and plain template sections.

- [ ] **Step 1: Write the failing test**

Append to `src/modules/recruitment/templates/clinic-dates.test.ts`:

```ts
import { resolveAvailabilityOptions, AVAILABILITY_FIELD_KEY } from "./clinic-dates";

/** Minimal structural stand-in for a loaded FormSection + FormField rows. */
const field = (key: string, options: unknown = null) => ({ key, options });
const section = (title: string, fields: ReturnType<typeof field>[]) => ({ title, fields });

describe("resolveAvailabilityOptions", () => {
  const dates = [new Date("2026-06-06T12:00:00.000Z"), new Date("2026-06-13T12:00:00.000Z")];

  it("replaces the availability field's stored options with the live calendar", () => {
    const stale = [{ value: "2026-05-30", label: "May 30" }];
    const out = resolveAvailabilityOptions(
      [section("Availability", [field(AVAILABILITY_FIELD_KEY, stale)])],
      dates,
    );
    expect(out[0].fields[0].options).toEqual([
      { value: "2026-06-06", label: "Sat, Jun 6" },
      { value: "2026-06-13", label: "Sat, Jun 13" },
    ]);
  });

  it("leaves sections without an availability field untouched", () => {
    const other = [section("Languages", [field("spanish_proficiency", [{ value: "a", label: "A" }])])];
    expect(resolveAvailabilityOptions(other, dates)).toEqual(other);
  });

  it("is a no-op for a cycle with no availability field", () => {
    const only = [section("Personal details", [field("first_name")])];
    expect(resolveAvailabilityOptions(only, [])).toEqual(only);
  });

  it("drops the availability field when the calendar is empty", () => {
    const out = resolveAvailabilityOptions(
      [section("Availability", [field(AVAILABILITY_FIELD_KEY), field("notes")])],
      [],
    );
    expect(out).toHaveLength(1);
    expect(out[0].fields.map((f) => f.key)).toEqual(["notes"]);
  });

  it("drops the whole section when the empty calendar leaves it with no fields", () => {
    const out = resolveAvailabilityOptions(
      [section("Personal details", [field("first_name")]), section("Availability", [field(AVAILABILITY_FIELD_KEY)])],
      [],
    );
    expect(out.map((s) => s.title)).toEqual(["Personal details"]);
  });

  it("does not mutate the sections it is given", () => {
    const input = [section("Availability", [field(AVAILABILITY_FIELD_KEY, null)])];
    resolveAvailabilityOptions(input, dates);
    expect(input[0].fields[0].options).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/recruitment/templates/clinic-dates.test.ts`
Expected: FAIL, `resolveAvailabilityOptions` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/modules/recruitment/templates/clinic-dates.ts`:

```ts
/**
 * The one application field whose options are owned by the term's clinic
 * calendar rather than by the form builder. This literal is also what
 * promotion.ts reads off Application.answers, so the two must stay in step.
 */
export const AVAILABILITY_FIELD_KEY = "availability";

type ResolvableField = { key: string; options: unknown };
type ResolvableSection<F> = { fields: F[] };

/**
 * Replace the availability field's stored options with the term's live clinic
 * calendar. The stored FormField.options snapshot is deliberately ignored:
 * cycles are created before the calendar is finalized, so the snapshot is stale
 * by design.
 *
 * An empty calendar means the dates are genuinely unknown, so the question is
 * removed rather than rendered with zero options. Leaving it would strand the
 * applicant on a required field with nothing to select. The containing section
 * is removed only if that leaves it empty, so a director who added their own
 * fields to the Availability section does not lose them.
 */
export function resolveAvailabilityOptions<
  F extends ResolvableField,
  S extends ResolvableSection<F>,
>(sections: S[], clinicDates: Date[]): S[] {
  const options = clinicDateOptions(clinicDates);
  const out: S[] = [];
  for (const section of sections) {
    if (!section.fields.some((f) => f.key === AVAILABILITY_FIELD_KEY)) {
      out.push(section);
      continue;
    }
    // The `as F` / `as S` casts are load-bearing: spreading a generic produces a
    // widened anonymous type that TypeScript will not accept as F or S, even
    // though only `options` changed and the constraint declares it `unknown`.
    if (options.length > 0) {
      out.push({
        ...section,
        fields: section.fields.map((f) => (f.key === AVAILABILITY_FIELD_KEY ? ({ ...f, options } as F) : f)),
      } as S);
      continue;
    }
    const remaining = section.fields.filter((f) => f.key !== AVAILABILITY_FIELD_KEY);
    if (remaining.length > 0) out.push({ ...section, fields: remaining } as S);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/recruitment/templates/clinic-dates.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/templates/clinic-dates.ts src/modules/recruitment/templates/clinic-dates.test.ts
git commit -m "feat(recruitment): add resolveAvailabilityOptions for live clinic dates"
```

---

### Task 3: Wire the four loaders

**Files:**
- Modify: `src/app/apply/[slug]/page.tsx:17-20` (applicant render)
- Modify: `src/modules/recruitment/services/cycles.ts:98-103` (`getCycle`, builder and ApplyPreview)
- Modify: `src/modules/recruitment/services/submissions.ts:93-97` (`submitApplication`) and `:147-151`
- Modify: `src/modules/recruitment/services/submissions.ts:447-449` (`getApplication`, reviewer display)
- Test: `src/modules/recruitment/services/form-loaders.integration.test.ts` (create)

**Interfaces:**
- Consumes: `resolveAvailabilityOptions` from Task 2.
- Produces: no new exports. `getCycle` and `getApplication` keep their current
  return types; only the `options` value on the availability field changes.

`RecruitmentCycle.term` is a required relation (`prisma/schema.prisma:36` within the model), so `cycle.term` is non-nullable and needs no null guard.

- [ ] **Step 1: Write the failing integration test**

This test is the guard against a fifth loader being added later without resolution. Create `src/modules/recruitment/services/form-loaders.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/platform/db";
import { getCycle } from "./cycles";
import { getApplication } from "./submissions";

/** A term whose clinic calendar deliberately disagrees with its Saturdays: one
 *  Saturday is missing (a break) and one weekday is present (a special clinic).
 *  Any loader still deriving options from the term window will fail these. */
const TERM_START = new Date("2026-06-01T12:00:00.000Z");
const TERM_END = new Date("2026-06-30T12:00:00.000Z");
const CLINIC_DATES = [
  new Date("2026-06-06T12:00:00.000Z"), // Saturday
  new Date("2026-06-10T12:00:00.000Z"), // Wednesday, never a "term Saturday"
];
// 2026-06-13, 2026-06-20 and 2026-06-27 are Saturdays the admin removed.

let termId = "";
let cycleId = "";
let applicationId = "";
let personId = "";

beforeAll(async () => {
  const term = await prisma.term.create({
    data: { code: "LOADT1", name: "Loader Test", startDate: TERM_START, endDate: TERM_END, clinicDates: CLINIC_DATES },
  });
  termId = term.id;

  // RecruitmentCycle.createdById is a required relation to Person.
  const person = await prisma.person.create({
    data: { name: "Loader Test Creator", contactEmail: "loader-creator@example.com", status: "ACTIVE" },
  });
  personId = person.id;

  const cycle = await prisma.recruitmentCycle.create({
    data: {
      track: "VOLUNTEER", termId, title: "Loader Test Cycle", publicSlug: "loader-test-cycle",
      departments: [], acceptsRenewals: false, status: "OPEN", createdById: person.id,
      sections: { create: { title: "Availability", order: 0, appliesTo: "BOTH", purpose: "APPLICATION" } },
    },
    include: { sections: true },
  });
  cycleId = cycle.id;

  await prisma.formField.create({
    data: {
      sectionId: cycle.sections[0].id, cycleId, key: "availability", label: "Clinic dates",
      type: "MULTI_SELECT", required: true, order: 0,
      // A deliberately stale snapshot, as a real seeded cycle would carry.
      options: [{ value: "2026-06-27", label: "Jun 27" }],
    },
  });

  // firstName and lastName are required on Applicant; emailLower must equal
  // lower(email) to satisfy the (cycleId, emailLower) dedup unique.
  const applicant = await prisma.applicant.create({
    data: { cycleId, firstName: "Loader", lastName: "Test", email: "loader@example.com", emailLower: "loader@example.com" },
  });
  const application = await prisma.application.create({
    data: {
      applicantId: applicant.id, cycleId, applicantType: "NEW", status: "SUBMITTED",
      answers: { availability: ["2026-06-06"] },
    },
  });
  applicationId = application.id;
});

afterAll(async () => {
  await prisma.application.deleteMany({ where: { cycleId } });
  await prisma.applicant.deleteMany({ where: { cycleId } });
  await prisma.formField.deleteMany({ where: { cycleId } });
  await prisma.formSection.deleteMany({ where: { cycleId } });
  await prisma.recruitmentCycle.deleteMany({ where: { id: cycleId } });
  await prisma.term.deleteMany({ where: { id: termId } });
  await prisma.person.deleteMany({ where: { id: personId } });
});

const availabilityOptions = (sections: { fields: { key: string; options: unknown }[] }[]) =>
  sections.flatMap((s) => s.fields).find((f) => f.key === "availability")?.options;

const EXPECTED = [
  { value: "2026-06-06", label: "Sat, Jun 6" },
  { value: "2026-06-10", label: "Wed, Jun 10" },
];

describe("every cycle-form loader resolves availability from Term.clinicDates", () => {
  it("getCycle (form builder and ApplyPreview)", async () => {
    const cycle = await getCycle(cycleId);
    expect(availabilityOptions(cycle!.sections)).toEqual(EXPECTED);
  });

  it("getApplication (reviewer display)", async () => {
    const app = await getApplication(applicationId);
    expect(availabilityOptions(app!.cycle.sections)).toEqual(EXPECTED);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/recruitment/services/form-loaders.integration.test.ts`
Expected: FAIL. Both assertions receive the stale snapshot `[{ value: "2026-06-27", label: "Jun 27" }]`.

- [ ] **Step 3: Resolve in `getCycle`**

In `src/modules/recruitment/services/cycles.ts`, add the import near the other template imports:

```ts
import { resolveAvailabilityOptions } from "../templates/clinic-dates";
```

Replace `getCycle` (currently at lines 98-103):

```ts
export async function getCycle(id: string) {
  const cycle = await prisma.recruitmentCycle.findUnique({
    where: { id },
    include: {
      term: { select: { clinicDates: true } },
      sections: { include: { fields: { orderBy: { order: "asc" } } }, orderBy: { order: "asc" } },
    },
  });
  if (!cycle) return null;
  // Availability options are owned by the term's clinic calendar, not by the
  // stored snapshot. Resolving here covers the form builder and ApplyPreview.
  return { ...cycle, sections: resolveAvailabilityOptions(cycle.sections, cycle.term.clinicDates) };
}
```

- [ ] **Step 4: Resolve in `getApplication`**

In `src/modules/recruitment/services/submissions.ts`, add the import:

```ts
import { resolveAvailabilityOptions } from "../templates/clinic-dates";
```

Replace `getApplication` (currently at lines 447-449):

```ts
export async function getApplication(id: string) {
  const application = await prisma.application.findUnique({
    where: { id },
    include: {
      applicant: true,
      cycle: {
        include: {
          term: { select: { clinicDates: true } },
          sections: { where: { purpose: "APPLICATION" }, include: { fields: { orderBy: { order: "asc" } } }, orderBy: { order: "asc" } },
        },
      },
    },
  });
  if (!application) return null;
  // The reviewer view resolves option labels off these sections (speed-score.ts
  // labelFor), and falls back to the raw value for an option that is gone, so a
  // date removed after submission degrades to "2026-06-13" rather than breaking.
  return {
    ...application,
    cycle: { ...application.cycle, sections: resolveAvailabilityOptions(application.cycle.sections, application.cycle.term.clinicDates) },
  };
}
```

- [ ] **Step 5: Run the integration test to verify it passes**

Run: `npx vitest run src/modules/recruitment/services/form-loaders.integration.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 6: Resolve in `submitApplication`**

In `src/modules/recruitment/services/submissions.ts`, extend the `submitApplication` query (currently lines 93-97) to load the calendar:

```ts
  const cycle = await prisma.recruitmentCycle.findUnique({
    where: { publicSlug: slug },
    include: {
      term: { select: { clinicDates: true } },
      sections: { where: { purpose: "APPLICATION" }, include: { fields: { orderBy: { order: "asc" } } }, orderBy: { order: "asc" } },
    },
  });
```

Then at line 150, resolve before building the section defs so validation accepts exactly the options the applicant was offered:

```ts
  const resolvedSections = resolveAvailabilityOptions(cycle.sections, cycle.term.clinicDates);
  const sectionDefs = toSectionDefs(resolvedSections, cycle.departments, input.applicantType);
```

Then replace the other two reads of `cycle.sections` in this function so the whole
path agrees. At line 191:

```ts
  const deptChoiceKey = resolvedSections.flatMap((s) => s.fields).find((f) => f.type === DEPT_CHOICE_KEY_TYPE)?.key;
```

- [ ] **Step 7: Resolve in the apply page**

In `src/app/apply/[slug]/page.tsx`, add the import:

```ts
import { resolveAvailabilityOptions } from "@/modules/recruitment/templates/clinic-dates";
```

Extend the query (lines 17-20):

```ts
  const cycle = await prisma.recruitmentCycle.findUnique({
    where: { publicSlug: slug },
    include: {
      term: { select: { clinicDates: true } },
      sections: { where: { purpose: "APPLICATION" }, include: { fields: { orderBy: { order: "asc" } } }, orderBy: { order: "asc" } },
    },
  });
```

After the `if (!cycle) redirect("/apply");` guard on line 29, add:

```ts
  // The availability question's options come from the term's clinic calendar,
  // not from the stored snapshot. Everything below reads `sections`, not
  // `cycle.sections`, so the form and its validation see the same list.
  const sections = resolveAvailabilityOptions(cycle.sections, cycle.term.clinicDates);
```

Then replace both remaining uses of `cycle.sections` in the file with `sections`: the `def.sections` mapping (line 71) and the `prefill` field list (line 93).

- [ ] **Step 8: Run the recruitment suite**

Run: `npx vitest run src/modules/recruitment src/app/apply`
Expected: PASS. No existing test should break: `openVolunteerCycle` in `submissions.test.ts` builds its cycle without `seedDefaultForm`, so those cycles have no `availability` field at all and the resolver is a no-op for them. If something does fail, stop and report it rather than committing red.

- [ ] **Step 9: Commit**

```bash
git add src/app/apply/\[slug\]/page.tsx src/modules/recruitment/services/cycles.ts src/modules/recruitment/services/submissions.ts src/modules/recruitment/services/form-loaders.integration.test.ts
git commit -m "feat(recruitment): resolve availability options from the term's clinic dates"
```

---

### Task 4: Seed from clinic dates and delete `term-dates.ts`

**Files:**
- Modify: `src/modules/recruitment/services/cycles.ts:9` (import) and `:50-51`
- Delete: `src/modules/recruitment/templates/term-dates.ts`
- Test: `src/modules/recruitment/services/cycles.test.ts` (existing seeding tests)

**Interfaces:**
- Consumes: `clinicDateOptions` from Task 1.
- Produces: nothing new. `termSaturdays` ceases to exist; `createCycle` keeps its signature.

`createCycle` is the only caller of `termSaturdays` and `term-dates.ts` has no test file of its own. The admin-side `saturdaysBetween` (`src/modules/admin/services/terms.ts:53`) is a different function, stays, and remains the source for the admin's regenerate-Saturdays control.

- [ ] **Step 1: Write the failing test**

This file uses `resetDb()` in `beforeEach`/`afterEach` and a local `seedTermAndPerson()` helper whose term has **no** `clinicDates`. This test needs a term that does, so it seeds inline rather than reusing that helper.

Add to `src/modules/recruitment/services/cycles.test.ts`, inside the existing `describe("createCycle", ...)` block:

```ts
it("seeds availability options from the term's clinic dates, not its Saturdays", async () => {
  const person = await prisma.person.create({ data: { name: "Lead", status: "ACTIVE" } });
  const term = await prisma.term.create({
    data: {
      code: "SU26", name: "Summer 2026",
      startDate: new Date("2026-06-01"), endDate: new Date("2026-06-30"),
      // One Saturday kept, one weekday added, the other June Saturdays removed.
      clinicDates: [new Date("2026-06-06T12:00:00.000Z"), new Date("2026-06-10T12:00:00.000Z")],
    },
  });
  const cycle = await createCycle({
    track: "VOLUNTEER", termId: term.id, title: "Volunteer SU26",
    publicSlug: "volunteer-su26-dates", departments: [], acceptsRenewals: false,
    createdById: person.id,
  }, true);

  const field = await prisma.formField.findFirstOrThrow({ where: { cycleId: cycle.id, key: "availability" } });
  expect(field.options).toEqual([
    { value: "2026-06-06", label: "Sat, Jun 6" },
    { value: "2026-06-10", label: "Wed, Jun 10" },
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/recruitment/services/cycles.test.ts -t "clinic dates, not its Saturdays"`
Expected: FAIL. The options are every Saturday in June 2026 (`2026-06-06`, `2026-06-13`, `2026-06-20`, `2026-06-27`) with bare `"Jun 6"` labels.

- [ ] **Step 3: Swap the seeding source**

In `src/modules/recruitment/services/cycles.ts`, delete the `termSaturdays` import on line 9 and add:

```ts
import { clinicDateOptions, resolveAvailabilityOptions } from "../templates/clinic-dates";
```

(Task 3 already added `resolveAvailabilityOptions`; combine both into the one import line.)

Replace lines 50-51:

```ts
    const term = await prisma.term.findUniqueOrThrow({ where: { id: input.termId }, select: { clinicDates: true } });
    const dates = clinicDateOptions(term.clinicDates);
```

The seeded snapshot is overridden by live resolution on every read. Seeding it correctly anyway keeps the stored row honest instead of misleading.

- [ ] **Step 4: Delete the dead module**

```bash
git rm src/modules/recruitment/templates/term-dates.ts
```

- [ ] **Step 5: Verify nothing else referenced it**

Run: `grep -rn "termSaturdays\|term-dates" src`
Expected: no output.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/modules/recruitment`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A src/modules/recruitment
git commit -m "feat(recruitment): seed availability options from clinic dates, drop termSaturdays"
```

---

### Task 5: Submit tolerance for dates removed mid-flight

**Files:**
- Modify: `src/modules/recruitment/services/submissions.ts` (just before line 199, `buildApplicationSchema`)
- Test: `src/modules/recruitment/services/submissions.test.ts`

**Interfaces:**
- Consumes: `AVAILABILITY_FIELD_KEY` from Task 2; `resolvedSections` from Task 3 Step 6.
- Produces: no new exports.

`MULTI_SELECT` validates as a strict zod enum over the field's options (`engine/schema-builder.ts:106-108`). With a live option list, an admin editing clinic dates between a saved draft and its submission would hard-reject the submit over a checkbox that is no longer rendered, which the applicant cannot fix.

- [ ] **Step 1: Write the failing tests**

This file uses `resetDb()` in `beforeEach`/`afterEach` and a local `openVolunteerCycle()` helper that publishes a cycle at slug `"apply-v"`. That helper's cycle has **no** availability field and its term has **no** clinic dates, so add a composing helper alongside it. Open-cycle form editing is supported, so adding the section after publish is fine.

Add to `src/modules/recruitment/services/submissions.test.ts`:

```ts
/** openVolunteerCycle plus an availability question and a clinic calendar. The
 *  stored options are deliberately stale: live resolution must ignore them. */
async function openCycleWithAvailability(clinicDates: Date[]) {
  const { person, cycle } = await openVolunteerCycle();
  const { termId } = await prisma.recruitmentCycle.findUniqueOrThrow({
    where: { id: cycle.id }, select: { termId: true },
  });
  await prisma.term.update({ where: { id: termId }, data: { clinicDates } });
  const section = await addSection(cycle.id, { title: "Availability", appliesTo: "BOTH", departmentCode: null });
  await prisma.formField.create({
    data: {
      sectionId: section.id, cycleId: cycle.id, key: "availability", label: "Clinic dates",
      type: "MULTI_SELECT", required: true, order: 0,
      options: [{ value: "2026-06-27", label: "Jun 27" }],
    },
  });
  return { person, cycle, termId };
}

const NEW_ANSWERS = {
  first_name: "Ann", last_name: "Lee", email: "ann@yale.edu",
  "1st_choice_department": "SRHD", srhd_essay: "because",
};

it("discards an availability date removed from the calendar after the draft was saved", async () => {
  // The applicant checked 2026-06-13 while it was still a clinic date; the admin
  // has since removed it. The remaining pick must still submit cleanly.
  await openCycleWithAvailability([new Date("2026-06-06T12:00:00.000Z")]);
  const app = await submitApplication("apply-v", {
    applicantType: "NEW",
    answers: { ...NEW_ANSWERS, availability: ["2026-06-06", "2026-06-13"] },
    files: {},
  });
  expect((app.answers as Record<string, unknown>).availability).toEqual(["2026-06-06"]);
});

it("reports the ordinary required error when every availability pick is gone", async () => {
  await openCycleWithAvailability([new Date("2026-06-06T12:00:00.000Z")]);
  await expect(
    submitApplication("apply-v", {
      applicantType: "NEW",
      answers: { ...NEW_ANSWERS, availability: ["2026-06-13"] },
      files: {},
    }),
  ).rejects.toBeInstanceOf(SubmissionValidationError);
});

it("does not enforce a required availability answer when the term has no clinic dates", async () => {
  // Empty calendar drops the field entirely, so its required-ness cannot block.
  await openCycleWithAvailability([]);
  const app = await submitApplication("apply-v", {
    applicantType: "NEW",
    answers: NEW_ANSWERS,
    files: {},
  });
  expect(app.id).toBeTruthy();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/modules/recruitment/services/submissions.test.ts -t "availability"`
Expected: FAIL. The first test throws `SubmissionValidationError` because `2026-06-13` is not in the live enum.

- [ ] **Step 3: Filter unknown values before validation**

In `src/modules/recruitment/services/submissions.ts`, immediately before `const schema = buildApplicationSchema(sectionDefs, ctx);` (line 199), insert:

```ts
  // The availability options are live (they track Term.clinicDates), so a date
  // the admin removed between a saved draft and this submit is no longer in the
  // enum, and no longer rendered either. Rejecting would strand the applicant on
  // a checkbox they cannot see or clear, so drop unknown values instead. If that
  // empties a required answer they get the normal "required" error against the
  // refreshed list, which they can act on.
  const availabilityField = resolvedSections
    .flatMap((s) => s.fields)
    .find((f) => f.key === AVAILABILITY_FIELD_KEY);
  if (availabilityField) {
    const live = new Set(
      ((availabilityField.options ?? []) as { value: string }[]).map((o) => o.value),
    );
    const answered = (input.answers as Record<string, unknown>)[AVAILABILITY_FIELD_KEY];
    if (answered != null && answered !== "") {
      const list = Array.isArray(answered) ? answered : [answered];
      (input.answers as Record<string, unknown>)[AVAILABILITY_FIELD_KEY] =
        list.filter((v) => typeof v === "string" && live.has(v));
    }
  }
```

Add `AVAILABILITY_FIELD_KEY` to the existing `../templates/clinic-dates` import.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/modules/recruitment/services/submissions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/services/submissions.ts src/modules/recruitment/services/submissions.test.ts
git commit -m "fix(recruitment): discard availability dates removed after a draft was saved"
```

---

### Task 6: Make availability options read-only in the form builder

**Files:**
- Modify: `src/app/(app)/recruitment/cycles/[id]/builder/field-card.tsx:225-226`

**Interfaces:**
- Consumes: `AVAILABILITY_FIELD_KEY` from Task 2. `OptionsEditor` already accepts `disabled?: boolean` (`builder/options-editor.tsx:14`), so no component change is needed.
- Produces: nothing.

Without this, a director can edit options that live resolution silently discards.

- [ ] **Step 1: Disable the editor and explain why**

In `src/app/(app)/recruitment/cycles/[id]/builder/field-card.tsx`, add the import:

```ts
import { AVAILABILITY_FIELD_KEY } from "@/modules/recruitment/templates/clinic-dates";
```

Replace lines 225-226:

```tsx
              <OptionsEditor options={(field.options ?? []) as Choice[]}
                disabled={!editable || field.key === AVAILABILITY_FIELD_KEY}
                onChange={(next) => save({ options: next })} />
              {field.key === AVAILABILITY_FIELD_KEY && (
                <p className="mt-2 text-sm text-muted-foreground">
                  These dates come from the term&rsquo;s clinic calendar and update automatically.
                  Change them in Admin, Terms, Clinic dates.
                </p>
              )}
```

- [ ] **Step 2: Verify the guard is wired, not the pixels**

There is no automated coverage for this component and a browser check is not available in this environment, so verify statically instead:

Run: `grep -n "AVAILABILITY_FIELD_KEY" "src/app/(app)/recruitment/cycles/[id]/builder/field-card.tsx"`
Expected: three hits, the import plus the `disabled` expression plus the explanatory paragraph's guard.

The visual result is left for manual confirmation by the repo owner; flag it in your report as unverified rather than claiming it renders correctly.

- [ ] **Step 3: Run lint and typecheck**

Run: `npm run lint && npx tsc --noEmit`
Expected: clean. If lint fails on an untracked design folder or a stale `.next`, that is a known local false failure, not this change.

- [ ] **Step 4: Commit**

```bash
git add src/app/\(app\)/recruitment/cycles/\[id\]/builder/field-card.tsx
git commit -m "feat(recruitment): make availability options read-only in the form builder"
```

---

### Task 7: Filter phantom dates at promotion

**Files:**
- Modify: `src/modules/recruitment/services/promotion.ts:47-50` (the `contract` include) and `:64-66`
- Modify: `src/modules/recruitment/services/promotion.test.ts:9` (the `seedSubmitted` fixture, required so the existing test at `:162` keeps passing)
- Test: `src/modules/recruitment/services/promotion.test.ts`

**Interfaces:**
- Consumes: `isoDateKey` from `@/platform/dates`. `parseAvailabilityDates` keeps its current signature.
- Produces: nothing new.

Applications submitted before this change carry phantom Saturdays in their stored answers. Without this filter they still reach `TermMembership.baselineAvailability` after the fix ships. It also means a date the admin removes after submission stops lingering in anyone's availability.

- [ ] **Step 1: Write the failing test**

**First, fix the fixture, or this task breaks an existing test.** `seedSubmitted` (`promotion.test.ts:8`) creates its term with **no** `clinicDates`, while the existing test at line 162 asserts that all three availability dates reach `baselineAvailability`. Once promotion filters against the calendar, that test would receive `[]` and fail.

Make the fixture self-consistent by giving the term a calendar matching whatever availability the test asked for. In `seedSubmitted`, replace the `prisma.term.create` call (line 9):

```ts
  const term = await prisma.term.create({ data: {
    code: "FA26", name: "Fall", startDate: new Date(), endDate: new Date(), status: "ACTIVE",
    // Keep the calendar consistent with the availability the test seeded, so
    // promotion's clinic-date filter is exercised rather than tripped over.
    clinicDates: (opts.availability ?? []).map((d) => new Date(`${d}T12:00:00.000Z`)),
  } });
```

The existing tests at lines 162 and 177 then pass unchanged.

**Then add the new test** to `src/modules/recruitment/services/promotion.test.ts`:

```ts
it("drops availability dates that are not on the term's clinic calendar", async () => {
  // A pre-existing application: 2026-06-13 was offered as a "term Saturday" but
  // is not a clinic date, so it must not reach baselineAvailability.
  const { term, srhd, srr, contract } = await seedSubmitted({ availability: ["2026-06-06", "2026-06-13"] });
  await prisma.term.update({
    where: { id: term.id },
    data: { clinicDates: [new Date("2026-06-06T12:00:00.000Z")] },
  });

  await promoteContracts([contract.id], srr.id);

  const person = await prisma.person.findFirstOrThrow({ where: { netId: "al99" } });
  const membership = await prisma.termMembership.findFirstOrThrow({
    where: { personId: person.id, termId: term.id, departmentId: srhd.id, kind: "VOLUNTEER" },
  });
  expect(membership.baselineAvailability.map((d) => d.toISOString())).toEqual([
    "2026-06-06T00:00:00.000Z",
  ]);
});
```

Baseline dates are written at UTC midnight while clinic dates are noon-UTC, which is why the filter compares by day key and this assertion expects `T00:00:00.000Z`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/recruitment/services/promotion.test.ts -t "not on the term's clinic calendar"`
Expected: FAIL. `baselineAvailability` contains both dates.

- [ ] **Step 3: Load the calendar and filter**

In `src/modules/recruitment/services/promotion.ts`, add the import:

```ts
import { isoDateKey } from "@/platform/dates";
```

Extend the `cycle` select inside the `contract` include (line 49) so it carries the calendar:

```ts
      include: { acceptance: { include: { application: { include: { cycle: { select: { termId: true, track: true, term: { select: { clinicDates: true } } } }, acceptances: { select: { departmentCode: true } } } } } } },
```

Replace the `availabilityDates` assignment (lines 64-66):

```ts
    // Applications submitted before availability options were sourced from the
    // clinic calendar can carry dates that are not clinic days at all. Filter by
    // UTC day key: baseline dates are UTC midnight and clinic dates are noon-UTC,
    // so only the day key lines up.
    const clinicDateKeys = new Set(cycle.term.clinicDates.map(isoDateKey));
    const availabilityDates = parseAvailabilityDates(
      (application.answers as Record<string, unknown> | null | undefined)?.["availability"],
    ).filter((d) => clinicDateKeys.has(isoDateKey(d)));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/recruitment/services/promotion.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/services/promotion.ts src/modules/recruitment/services/promotion.test.ts
git commit -m "fix(recruitment): filter promotion availability to the term's clinic dates"
```

---

### Task 8: Full verification

**Files:** none modified.

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: PASS. The suite was 2796 green as of PR #343; expect that plus the tests added here.

- [ ] **Step 2: Run lint and typecheck**

Run: `npm run lint && npx tsc --noEmit`
Expected: clean. Known local false failures: an untracked design folder, a stale `.next`, and storage tests needing `BLOB_READ_WRITE_TOKEN=""` for local disk.

- [ ] **Step 3: Confirm no loader was missed**

Run: `grep -rn "include: { fields:" src --include='*.ts' --include='*.tsx'`

(Quote the globs. Unquoted `--include=*.ts` fails in zsh with "no matches found".)

Cross-check every hit that loads `fields` against the four sites wired in Task 3. A new one would need `resolveAvailabilityOptions` and a case in `form-loaders.integration.test.ts`.

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin feat/availability-from-clinic-dates
```

PR body should state: the application's availability question now reads the admin's clinic calendar instead of computing term Saturdays; options resolve live so a cycle created before the calendar is finalized stays correct; and pre-existing applications carrying phantom Saturdays are filtered at promotion.

---

## Notes for the implementer

**Why the stored snapshot is ignored rather than kept in sync.** Recruitment cycles are created months before the clinic calendar is finalized, and `materializeTemplate` snapshots options at creation. Any sync-on-write scheme leaves a window where the form is wrong. Resolving on read closes it and fixes already-created cycles with no migration.

**Why `cycle.termId` and never `getActiveTerm()`.** Recruitment cycles routinely run against a `PLANNING` term ahead of the manual term flip, so an active-term read would show the *current* term's calendar on a form for the *next* term, which is exactly the case this feature exists to serve.

**The known weak point.** The binding between form and scheduler is the literal key `"availability"` (`promotion.ts:65`, and `AVAILABILITY_FIELD_KEY` here). A director renaming that key in the builder silently breaks both resolution and promotion. Out of scope for this plan; worth a guard later.
