# Weekly Shift Reminders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send an editable weekly email every Monday to everyone scheduled for the upcoming Saturday clinic day, personalized with their role, department, date, and the leadership on shift.

**Architecture:** Mirror the existing compliance-reminder pattern: a code-defined editable template descriptor (`shift-reminder`), a pure builder that turns a day's `ShiftAssignment` rows into per-person email contexts, an orchestrator (`runShiftReminders`) that queries the schedule and dispatches via `notify()`, and an `authorizeCron`-guarded cron route that only enqueues (the per-minute `/api/cron/email` route drains).

**Tech Stack:** Next.js App Router, Prisma, TypeScript, Vitest. In-house email template engine (`{{ var }}`, `{{{ raw }}}`, `{{#if}}` only). Microsoft Graph for the Teams channel link.

## Global Constraints

- **No em-dashes anywhere** (ESLint `no-em-dash` rule + author preference). Use hyphens, parentheses, colons, or commas in all copy, comments, and strings.
- **"HAVEN Hub" is two words in prose/UI**; code identifiers stay `havenhub`.
- **Clinic dates are anchored at 12:00 UTC and compared by UTC day key** (`isoDateKey`), never by raw timestamp. Select the target date with `selectCurrentClinicDate(term.clinicDates, now)`.
- **Emails enqueue-only.** Never call the queue drainer from this cron route, and never add the route to `vercel.json` (it would double-fire against the external scheduler). Delivery rides the per-minute `/api/cron/email` tick.
- **Every cron route calls `authorizeCron(req)` first** (bearer `CRON_SECRET`, fails closed).
- **One identifier, four places:** the notify `type`, the `EmailLog.template`, the `NOTIFICATION_TYPES` key, and the template descriptor `key` are all the exact string `"shift-reminder"`.
- **Descriptor `variables` is the single source of truth for validation.** Every `{{ var }}`, `{{{ rawVar }}}`, and `{{#if var}}` name in the subject/body must appear in `variables`, or admin edits fail `validateTemplate`; every name must be supplied in the render context.
- **Test commands:** `npm run typecheck`, `npm run lint`, `npm run test` (or `npx vitest run <file>`). Pure tests (no DB) run anywhere. DB-backed tests need a test database (`npm run test:prepare`, or `TEST_DATABASE_URL`); in a worktree they may only run in CI. Where a step below is DB-backed, this is called out.

## File Structure

New files:

- `src/platform/email/templates/shift.ts` - the `shift-reminder` `TemplateDescriptor` (default subject/body + variable allow-list) and the `shiftReminderContext(params)` typed context builder.
- `src/platform/email/templates/shift.test.ts` - pure test: `validateTemplate` on the default body, and `renderTemplate` showing sections render and empty `{{#if}}` blocks hide.
- `src/platform/email/shift-reminders.ts` - the pure `buildShiftReminders(input)` (Task 2) plus the DB orchestrator `runShiftReminders(now)` (Task 3).
- `src/platform/email/shift-reminders.build.test.ts` - pure test for `buildShiftReminders`.
- `src/platform/email/shift-reminders.test.ts` - DB-backed test for `runShiftReminders` (CI-gated).
- `src/app/api/cron/shift-reminders/route.ts` - the weekly cron entry point.

Modified files:

- `src/platform/email/templates/types.ts` - add `"shift"` to the `TemplateGroup` union.
- `src/platform/email/templates/registry.ts` - import and spread `shiftDescriptors` into `ALL`.
- `src/platform/notifications/registry.ts` - add the `shift-reminder` entry to `NOTIFICATION_TYPES` (auto-registers its channel setting).
- `docs/cron-jobs.md` - add the new job row.

---

### Task 1: `shift-reminder` template descriptor + context builder

**Files:**
- Create: `src/platform/email/templates/shift.ts`
- Create: `src/platform/email/templates/shift.test.ts`
- Modify: `src/platform/email/templates/types.ts` (add `"shift"` group)
- Modify: `src/platform/email/templates/registry.ts` (register descriptors)

**Interfaces:**
- Consumes: `TemplateDescriptor` from `./types`; the pure `renderTemplate` (`@/platform/email/render/render`) and `validateTemplate` (`@/platform/email/render/validate`); `getDescriptor` (`./registry`).
- Produces:
  - `export type ShiftReminderParams` - 12 string fields: `firstName`, `roleLabel`, `departmentName`, `clinicDateLabel`, `additionalShifts`, `edsOnShift`, `deptDirectorsOnShift`, `clinicalAdvisorsOnShift`, `teamsChannelUrl`, `hipaaComplianceUrl`, `shiftSwapUrl`, `masterScheduleUrl`.
  - `export function shiftReminderContext(p: ShiftReminderParams): Record<string, unknown>`
  - `export const shiftDescriptors: TemplateDescriptor[]` containing the `"shift-reminder"` descriptor.

- [ ] **Step 1: Write the failing test**

Create `src/platform/email/templates/shift.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { validateTemplate } from "@/platform/email/render/validate";
import { renderTemplate } from "@/platform/email/render/render";
import { getDescriptor } from "@/platform/email/templates/registry";
import { shiftReminderContext } from "@/platform/email/templates/shift";

function fullContext(over: Partial<Parameters<typeof shiftReminderContext>[0]> = {}) {
  return shiftReminderContext({
    firstName: "Sam",
    roleLabel: "Volunteer",
    departmentName: "Senior Primary Care",
    clinicDateLabel: "Saturday, July 11, 2026",
    additionalShifts: "",
    edsOnShift: "Jordan Blake",
    deptDirectorsOnShift: "Alex Rivera",
    clinicalAdvisorsOnShift: "Dr. Pat Lee",
    teamsChannelUrl: "https://teams.example/x",
    hipaaComplianceUrl: "https://hub.example/my-info",
    shiftSwapUrl: "https://hub.example/schedule",
    masterScheduleUrl: "https://hub.example/schedule/full",
    ...over,
  });
}

describe("shift-reminder template", () => {
  it("is registered under the shift group", () => {
    const d = getDescriptor("shift-reminder");
    expect(d).toBeDefined();
    expect(d!.group).toBe("shift");
  });

  it("default subject + body only reference declared variables", () => {
    const d = getDescriptor("shift-reminder")!;
    const allowed = d.variables.map((v) => v.name);
    expect(validateTemplate(d.defaultSubject, allowed).ok).toBe(true);
    const bodyResult = validateTemplate(d.defaultBody, allowed);
    expect(bodyResult.unknownVariables).toEqual([]);
    expect(bodyResult.ok).toBe(true);
  });

  it("renders leadership + Teams sections when values are present", () => {
    const d = getDescriptor("shift-reminder")!;
    const html = renderTemplate(d.defaultBody, fullContext());
    expect(html).toContain("Jordan Blake");
    expect(html).toContain("Alex Rivera");
    expect(html).toContain("Dr. Pat Lee");
    expect(html).toContain("https://teams.example/x");
    expect(html).toContain("Saturday, July 11, 2026");
  });

  it("hides leadership + Teams sections when values are empty", () => {
    const d = getDescriptor("shift-reminder")!;
    const html = renderTemplate(
      d.defaultBody,
      fullContext({ edsOnShift: "", deptDirectorsOnShift: "", clinicalAdvisorsOnShift: "", teamsChannelUrl: "" }),
    );
    expect(html).not.toContain("Clinical Advisor(s) on shift");
    expect(html).not.toContain("Teams channel");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/platform/email/templates/shift.test.ts`
Expected: FAIL (cannot resolve `@/platform/email/templates/shift`).

- [ ] **Step 3: Add the `"shift"` group to the `TemplateGroup` union**

In `src/platform/email/templates/types.ts`, change the `TemplateGroup` line to:

```ts
export type TemplateGroup = "recruitment" | "compliance" | "epic" | "campaign" | "layout" | "shift";
```

- [ ] **Step 4: Create the descriptor + context builder**

Create `src/platform/email/templates/shift.ts`:

```ts
import type { TemplateDescriptor } from "./types";

/**
 * Weekly shift-reminder email. Sent Monday mornings to everyone scheduled for
 * the upcoming Saturday clinic day (see src/platform/email/shift-reminders.ts).
 * Registered here so admins can edit the global default in /admin/email/templates.
 *
 * additionalShifts is rendered raw ({{{ }}}) because its builder emits either an
 * HTML paragraph or an empty string. The on-shift name lists (edsOnShift,
 * deptDirectorsOnShift, clinicalAdvisorsOnShift) and teamsChannelUrl are guarded
 * with {{#if}} so an empty value hides its section. Static links (Epic help desk,
 * Resource Guide) and the shift time and location live inline in the body so an
 * admin can edit them without a deploy. All other values use escaped {{ }}.
 */

export type ShiftReminderParams = {
  firstName: string;
  roleLabel: string;
  departmentName: string;
  clinicDateLabel: string;
  /** Pre-rendered HTML for extra same-day shifts, or "" (raw). */
  additionalShifts: string;
  edsOnShift: string;
  deptDirectorsOnShift: string;
  clinicalAdvisorsOnShift: string;
  teamsChannelUrl: string;
  hipaaComplianceUrl: string;
  shiftSwapUrl: string;
  masterScheduleUrl: string;
};

export function shiftReminderContext(p: ShiftReminderParams): Record<string, unknown> {
  return { ...p };
}

const DEFAULT_BODY = `<p>Hello {{ firstName }},</p>
<p>This is a friendly reminder that you are scheduled for a <strong>{{ roleLabel }}</strong> Shift in the <strong>{{ departmentName }}</strong> department at HAVEN Free Clinic this {{ clinicDateLabel }}.</p>
{{{ additionalShifts }}}
<p>As we move into the summer, we are piloting a more centralized process for clinic-day reminders and volunteer communication. We appreciate your patience as we refine this process through trial and error. Our goal is to improve consistency, accountability, and communication across the clinic.</p>
<h2>Shift Details</h2>
<p><strong>Date:</strong> {{ clinicDateLabel }}<br/>
<strong>Time:</strong> 8:00 AM to 2:00 PM<br/>
<strong>Location:</strong> Yale Physicians Building, 800 Howard Avenue, Floor 1, New Haven, CT 06519 (there is free parking on Saturdays)</p>
<h2>Before Your Shift</h2>
<ul>
<li>Please verify your Epic access by Wednesday before your shift. If you are experiencing issues, submit a Help Desk ticket <a href="https://airtable.com/appkxTQ19GmaHgW1O/pag0u41BHqicULzXQ/form">here</a> as soon as possible. We are unable to accommodate Epic-related requests submitted after Wednesday, so please plan ahead.</li>
<li>Review the HAVEN Resource Guide <a href="https://yaleedu.sharepoint.com/:w:/s/HAVENFreeClinic/IQD9rSYTQa15QYspDXCXzDqEAaf9R-gN8Yr43oy6sxuLK5o?e=1Qk44n">here</a>.</li>
<li>Confirm your HIPAA and compliance requirements are up to date <a href="{{ hipaaComplianceUrl }}">here</a>.</li>
</ul>
<h2>Attendance &amp; Scheduling</h2>
<ul>
<li>If you cannot attend, request coverage as soon as possible.</li>
<li>Shift swaps must be arranged in advance and submitted <a href="{{ shiftSwapUrl }}">here</a>.</li>
<li>Absences are only excused in emergency situations and are reviewed on a case-by-case basis.</li>
<li>Unexcused absences may result in a strike under HAVEN policy.</li>
</ul>
<h2>During Your Shift</h2>
<ul>
<li><strong>Attendance at Morning Meeting is required for all volunteers.</strong> Clinical team members should join by <strong>7:50 AM</strong>, while all other volunteers should join by <strong>8:00 AM</strong>.{{#if teamsChannelUrl}} The Zoom link can be found in this week's Teams channel <a href="{{ teamsChannelUrl }}">here</a>.{{/if}}</li>
<li>Arrive on time and dress professionally (closed-toe shoes required; no jeans).</li>
<li>Maintain professionalism with patients, volunteers, faculty, and staff at all times.</li>
</ul>
<h2>Questions?</h2>
<p>For urgent clinic-day concerns, please contact{{#if edsOnShift}} the Executive Director(s) on shift, <strong>{{ edsOnShift }}</strong>,{{/if}}{{#if deptDirectorsOnShift}} or your department director(s) on shift, <strong>{{ deptDirectorsOnShift }}</strong>{{/if}}.</p>
{{#if clinicalAdvisorsOnShift}}<p>Clinical Advisor(s) on shift: <strong>{{ clinicalAdvisorsOnShift }}</strong></p>{{/if}}
<p>The master schedule can be found <a href="{{ masterScheduleUrl }}">here</a>.</p>
<p>Thank you for your commitment to our patients and to HAVEN. We look forward to seeing you on Saturday!</p>`;

export const shiftDescriptors: TemplateDescriptor[] = [
  {
    key: "shift-reminder",
    name: "Shift: weekly reminder",
    category: "transactional",
    group: "shift",
    variables: [
      { name: "firstName", label: "Recipient first name", sampleValue: "Sam" },
      { name: "roleLabel", label: "Shift role (Director / Volunteer / Shadow)", sampleValue: "Volunteer" },
      { name: "departmentName", label: "Department name", sampleValue: "Senior Primary Care Clinical Team Member" },
      { name: "clinicDateLabel", label: "Clinic date", sampleValue: "Saturday, July 11, 2026" },
      { name: "additionalShifts", label: "Additional same-day shifts (HTML, usually empty)", sampleValue: "" },
      { name: "edsOnShift", label: "Executive Directors on shift (names)", sampleValue: "Jordan Blake, Riley Chen" },
      { name: "deptDirectorsOnShift", label: "Department directors on shift (names)", sampleValue: "Alex Rivera" },
      { name: "clinicalAdvisorsOnShift", label: "Clinical Advisors on shift (names)", sampleValue: "Dr. Pat Lee" },
      { name: "teamsChannelUrl", label: "This week's Teams channel link", sampleValue: "https://teams.microsoft.com/l/channel/example" },
      { name: "hipaaComplianceUrl", label: "HIPAA / compliance page link", sampleValue: "https://hub.example.org/my-info" },
      { name: "shiftSwapUrl", label: "Shift swap / coverage request link", sampleValue: "https://hub.example.org/schedule" },
      { name: "masterScheduleUrl", label: "Master schedule link", sampleValue: "https://hub.example.org/schedule/full" },
    ],
    defaultSubject: "Reminder: your HAVEN shift on {{ clinicDateLabel }}",
    defaultBody: DEFAULT_BODY,
  },
];
```

- [ ] **Step 5: Register the descriptors**

In `src/platform/email/templates/registry.ts`, add the import and spread:

```ts
import { shiftDescriptors } from "./shift";
```

and update the `ALL` array (add `...shiftDescriptors`):

```ts
const ALL: TemplateDescriptor[] = [layoutDescriptor, ...complianceDescriptors, ...epicDescriptors, ...recruitmentDescriptors, ...shiftDescriptors];
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run src/platform/email/templates/shift.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors. (If tsc flags a non-exhaustive use of `TemplateGroup`, handle the new `"shift"` case there; none is expected because `SENDER_CATEGORIES` is a plain list and `groupForTemplate` just returns the group.)

- [ ] **Step 8: Commit**

```bash
git add src/platform/email/templates/shift.ts src/platform/email/templates/shift.test.ts src/platform/email/templates/types.ts src/platform/email/templates/registry.ts
git commit -m "feat(shift-reminders): add editable shift-reminder email template"
```

---

### Task 2: Pure `buildShiftReminders` logic

**Files:**
- Create: `src/platform/email/shift-reminders.ts`
- Create: `src/platform/email/shift-reminders.build.test.ts`

**Interfaces:**
- Consumes: `shiftReminderContext` and `ShiftReminderParams` from `./templates/shift` (Task 1); `ShiftRole` from `@prisma/client`.
- Produces:
  - `export type ReminderAssignment = { personId: string; role: ShiftRole; department: { code: string; name: string }; person: { id: string; name: string; contactEmail: string | null; entraObjectId: string | null } }`
  - `export type PreparedReminder = { person: ReminderAssignment["person"]; context: Record<string, unknown>; teamsSummary: string }`
  - `export type BuildShiftRemindersInput = { assignments: ReminderAssignment[]; targetDate: Date; teamsChannelUrl: string; baseUrl: string }`
  - `export function buildShiftReminders(input: BuildShiftRemindersInput): PreparedReminder[]`
  - `export const ROLE_LABEL: Record<ShiftRole, string>`

- [ ] **Step 1: Write the failing test**

Create `src/platform/email/shift-reminders.build.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildShiftReminders, type ReminderAssignment } from "@/platform/email/shift-reminders";

const TARGET = new Date("2026-07-11T12:00:00.000Z"); // a Saturday, noon UTC
const BASE = "https://hub.example.org";

function person(id: string, name: string, email: string | null = `${id}@x.org`): ReminderAssignment["person"] {
  return { id, name, contactEmail: email, entraObjectId: null };
}
function row(p: ReminderAssignment["person"], code: string, deptName: string, role: ReminderAssignment["role"]): ReminderAssignment {
  return { personId: p.id, role, department: { code, name: deptName }, person: p };
}

describe("buildShiftReminders", () => {
  it("produces one reminder per scheduled person with role, department, date, links", () => {
    const vol = person("v", "Val Volunteer");
    const out = buildShiftReminders({
      assignments: [row(vol, "SCTP", "Senior Primary Care", "VOLUNTEER")],
      targetDate: TARGET,
      teamsChannelUrl: "",
      baseUrl: BASE,
    });
    expect(out).toHaveLength(1);
    expect(out[0].context.firstName).toBe("Val");
    expect(out[0].context.roleLabel).toBe("Volunteer");
    expect(out[0].context.departmentName).toBe("Senior Primary Care");
    expect(out[0].context.clinicDateLabel).toBe("Saturday, July 11, 2026");
    expect(out[0].context.hipaaComplianceUrl).toBe(`${BASE}/my-info`);
    expect(out[0].context.shiftSwapUrl).toBe(`${BASE}/schedule`);
    expect(out[0].context.masterScheduleUrl).toBe(`${BASE}/schedule/full`);
  });

  it("derives EDs (EXEC), CAs (PCAR), and department directors on shift", () => {
    const vol = person("v", "Val Volunteer");
    const dir = person("d", "Dana Director");
    const ed = person("e", "Ed Exec");
    const ca = person("c", "Cara Advisor");
    const out = buildShiftReminders({
      assignments: [
        row(vol, "SCTP", "Senior Primary Care", "VOLUNTEER"),
        row(dir, "SCTP", "Senior Primary Care", "DIRECTOR"),
        row(ed, "EXEC", "Executive Directors", "DIRECTOR"),
        row(ca, "PCAR", "Primary Care Clinical Advisors", "DIRECTOR"),
      ],
      targetDate: TARGET,
      teamsChannelUrl: "",
      baseUrl: BASE,
    });
    expect(out).toHaveLength(4);
    const volReminder = out.find((r) => r.person.id === "v")!;
    expect(volReminder.context.edsOnShift).toBe("Ed Exec");
    expect(volReminder.context.clinicalAdvisorsOnShift).toBe("Cara Advisor");
    expect(volReminder.context.deptDirectorsOnShift).toBe("Dana Director");
  });

  it("excludes a director from their own department-directors list", () => {
    const dir = person("d", "Dana Director");
    const out = buildShiftReminders({
      assignments: [row(dir, "SCTP", "Senior Primary Care", "DIRECTOR")],
      targetDate: TARGET,
      teamsChannelUrl: "",
      baseUrl: BASE,
    });
    expect(out[0].context.deptDirectorsOnShift).toBe("");
  });

  it("passes through the Teams channel URL and skips nothing when it is empty", () => {
    const vol = person("v", "Val Volunteer");
    const out = buildShiftReminders({
      assignments: [row(vol, "SCTP", "Senior Primary Care", "VOLUNTEER")],
      targetDate: TARGET,
      teamsChannelUrl: "https://teams/x",
      baseUrl: BASE,
    });
    expect(out[0].context.teamsChannelUrl).toBe("https://teams/x");
  });

  it("renders an additionalShifts block for a person with two same-day shifts", () => {
    const both = person("b", "Bo Both");
    const out = buildShiftReminders({
      assignments: [
        row(both, "SCTP", "Senior Primary Care", "VOLUNTEER"),
        row(both, "PHAM", "Pharmacy", "SHADOW"),
      ],
      targetDate: TARGET,
      teamsChannelUrl: "",
      baseUrl: BASE,
    });
    expect(out).toHaveLength(1);
    expect(String(out[0].context.additionalShifts)).toContain("Pharmacy");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/platform/email/shift-reminders.build.test.ts`
Expected: FAIL (cannot resolve `@/platform/email/shift-reminders`).

- [ ] **Step 3: Implement the pure builder**

Create `src/platform/email/shift-reminders.ts`:

```ts
import type { ShiftRole } from "@prisma/client";
import { shiftReminderContext } from "./templates/shift";

export const ROLE_LABEL: Record<ShiftRole, string> = {
  DIRECTOR: "Director",
  VOLUNTEER: "Volunteer",
  SHADOW: "Shadow",
};

export type ReminderAssignment = {
  personId: string;
  role: ShiftRole;
  department: { code: string; name: string };
  person: { id: string; name: string; contactEmail: string | null; entraObjectId: string | null };
};

export type PreparedReminder = {
  person: ReminderAssignment["person"];
  context: Record<string, unknown>;
  teamsSummary: string;
};

export type BuildShiftRemindersInput = {
  /** ShiftAssignment rows already filtered to the target clinic date. */
  assignments: ReminderAssignment[];
  targetDate: Date;
  teamsChannelUrl: string;
  baseUrl: string;
};

function firstNameOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts[0] || name;
}

function uniqueInOrder(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Pure: turn one clinic day's assignments into one prepared reminder per
 * scheduled person. Leadership lists (EDs from EXEC, Clinical Advisors from
 * PCAR, department directors) are derived from the same assignment rows. A
 * person with multiple same-day shifts gets one reminder: the first shift (by
 * department code) drives the headline, the rest render in additionalShifts.
 */
export function buildShiftReminders(input: BuildShiftRemindersInput): PreparedReminder[] {
  const { assignments, targetDate, teamsChannelUrl, baseUrl } = input;

  const clinicDateLabel = targetDate.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

  const hipaaComplianceUrl = `${baseUrl}/my-info`;
  const shiftSwapUrl = `${baseUrl}/schedule`;
  const masterScheduleUrl = `${baseUrl}/schedule/full`;

  const edsOnShift = uniqueInOrder(
    assignments.filter((a) => a.department.code === "EXEC").map((a) => a.person.name),
  );
  const clinicalAdvisorsOnShift = uniqueInOrder(
    assignments.filter((a) => a.department.code === "PCAR").map((a) => a.person.name),
  );

  const directorsByDeptCode = new Map<string, string[]>();
  for (const a of assignments) {
    if (a.role !== "DIRECTOR") continue;
    const list = directorsByDeptCode.get(a.department.code) ?? [];
    list.push(a.person.name);
    directorsByDeptCode.set(a.department.code, list);
  }

  const byPerson = new Map<string, ReminderAssignment[]>();
  for (const a of assignments) {
    const list = byPerson.get(a.personId) ?? [];
    list.push(a);
    byPerson.set(a.personId, list);
  }

  const prepared: PreparedReminder[] = [];
  for (const personAssignments of byPerson.values()) {
    const sorted = [...personAssignments].sort((a, b) =>
      a.department.code < b.department.code ? -1 : a.department.code > b.department.code ? 1 : 0,
    );
    const primary = sorted[0];
    const person = primary.person;
    const extras = sorted.slice(1);

    const additionalShifts = extras.length
      ? `<p>You are also scheduled for ${extras
          .map((a) => `a <strong>${ROLE_LABEL[a.role]}</strong> Shift in the <strong>${a.department.name}</strong> department`)
          .join(", and ")}.</p>`
      : "";

    const deptDirectorsOnShift = uniqueInOrder(
      sorted
        .flatMap((a) => directorsByDeptCode.get(a.department.code) ?? [])
        .filter((n) => n !== person.name),
    );

    prepared.push({
      person,
      teamsSummary: `You are scheduled for a ${ROLE_LABEL[primary.role]} shift in ${primary.department.name} this ${clinicDateLabel}.`,
      context: shiftReminderContext({
        firstName: firstNameOf(person.name),
        roleLabel: ROLE_LABEL[primary.role],
        departmentName: primary.department.name,
        clinicDateLabel,
        additionalShifts,
        edsOnShift: edsOnShift.join(", "),
        deptDirectorsOnShift: deptDirectorsOnShift.join(", "),
        clinicalAdvisorsOnShift: clinicalAdvisorsOnShift.join(", "),
        teamsChannelUrl,
        hipaaComplianceUrl,
        shiftSwapUrl,
        masterScheduleUrl,
      }),
    });
  }

  prepared.sort((a, b) => a.person.name.localeCompare(b.person.name));
  return prepared;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/platform/email/shift-reminders.build.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/platform/email/shift-reminders.ts src/platform/email/shift-reminders.build.test.ts
git commit -m "feat(shift-reminders): pure builder for per-person reminder contexts"
```

---

### Task 3: `runShiftReminders` orchestrator + notification type

**Files:**
- Modify: `src/platform/email/shift-reminders.ts` (append the orchestrator)
- Modify: `src/platform/notifications/registry.ts` (register the type)
- Create: `src/platform/email/shift-reminders.test.ts` (DB-backed, CI-gated)

**Interfaces:**
- Consumes: `buildShiftReminders`, `ReminderAssignment` (Task 2); `getActiveTerm` (`@/platform/terms/active-term`); `selectCurrentClinicDate`, `getCurrentClinicChannelLink` (`@/platform/teams/channel-link`); `isoDateKey` (`@/platform/dates`); `getSetting` (`@/platform/settings/service`); `renderEmail` (`./templates/renderEmail`); `notify` (`@/platform/notifications/notify`); `prisma` (`@/platform/db`).
- Produces:
  - `export type ShiftReminderRunResult = { remindersSent: number; skipped: number }`
  - `export async function runShiftReminders(now?: Date): Promise<ShiftReminderRunResult>`
  - A new `NOTIFICATION_TYPES` entry `{ key: "shift-reminder", label: "Shift reminder", defaultChannel: "email" }`.

- [ ] **Step 1: Register the notification type**

In `src/platform/notifications/registry.ts`, append to the `NOTIFICATION_TYPES` array (this auto-registers the `notifications.shift-reminder.channel` setting via `src/platform/settings/registry.ts`):

```ts
  { key: "shift-reminder", label: "Shift reminder", defaultChannel: "email" },
```

- [ ] **Step 2: Write the failing test**

Create `src/platform/email/shift-reminders.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { runShiftReminders } from "./shift-reminders";
import { __resetChannelCache } from "@/platform/teams/channel-link";

// Use the real clock so EmailLog.createdAt lands inside the 6-day dedup window.
const NOW = new Date();

/** A clinic date `daysAhead` in the future, anchored at 12:00 UTC. */
function futureClinicDate(daysAhead: number): Date {
  const d = new Date(NOW);
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + daysAhead);
  return d;
}

beforeEach(async () => {
  await resetDb();
  __resetChannelCache();
});

async function createTerm(clinicDates: Date[]) {
  return prisma.term.create({
    data: {
      code: "SU26",
      name: "Summer 2026",
      startDate: new Date("2026-05-01T00:00:00.000Z"),
      endDate: new Date("2026-08-31T00:00:00.000Z"),
      status: "ACTIVE",
      clinicDates,
    },
  });
}
async function createDepartment(code: string, name: string) {
  return prisma.department.upsert({ where: { code }, update: { name }, create: { code, name } });
}
async function createPerson(name: string, contactEmail: string | null) {
  return prisma.person.create({ data: { name, contactEmail, status: "ACTIVE" } });
}
async function schedule(
  termId: string,
  departmentId: string,
  personId: string,
  clinicDate: Date,
  role: "DIRECTOR" | "VOLUNTEER" | "SHADOW",
) {
  return prisma.shiftAssignment.create({ data: { termId, departmentId, personId, clinicDate, role } });
}
async function shiftEmailCount() {
  return prisma.emailLog.count({ where: { template: "shift-reminder" } });
}

describe("runShiftReminders", () => {
  it("sends one reminder per scheduled person and embeds on-shift leadership", async () => {
    const target = futureClinicDate(5);
    const term = await createTerm([target]);
    const sctp = await createDepartment("SCTP", "Senior Primary Care");
    const exec = await createDepartment("EXEC", "Executive Directors");
    const pcar = await createDepartment("PCAR", "Primary Care Clinical Advisors");

    const vol = await createPerson("Val Volunteer", "val@x.org");
    const dir = await createPerson("Dana Director", "dana@x.org");
    const ed = await createPerson("Ed Exec", "ed@x.org");
    const ca = await createPerson("Cara Advisor", "cara@x.org");

    await schedule(term.id, sctp.id, vol.id, target, "VOLUNTEER");
    await schedule(term.id, sctp.id, dir.id, target, "DIRECTOR");
    await schedule(term.id, exec.id, ed.id, target, "DIRECTOR");
    await schedule(term.id, pcar.id, ca.id, target, "DIRECTOR");

    const result = await runShiftReminders(NOW);

    expect(result.remindersSent).toBe(4);
    expect(await shiftEmailCount()).toBe(4);

    const volEmail = await prisma.emailLog.findFirst({ where: { template: "shift-reminder", personId: vol.id } });
    expect(volEmail).not.toBeNull();
    expect(volEmail!.html).toContain("Ed Exec");
    expect(volEmail!.html).toContain("Dana Director");
    expect(volEmail!.html).toContain("Cara Advisor");
  });

  it("is idempotent within the week (a re-run sends nothing)", async () => {
    const target = futureClinicDate(5);
    const term = await createTerm([target]);
    const sctp = await createDepartment("SCTP", "Senior Primary Care");
    const vol = await createPerson("Val Volunteer", "val@x.org");
    await schedule(term.id, sctp.id, vol.id, target, "VOLUNTEER");

    expect((await runShiftReminders(NOW)).remindersSent).toBe(1);
    const second = await runShiftReminders(NOW);
    expect(second.remindersSent).toBe(0);
    expect(second.skipped).toBe(1);
    expect(await shiftEmailCount()).toBe(1);
  });

  it("skips people with no contact email", async () => {
    const target = futureClinicDate(5);
    const term = await createTerm([target]);
    const sctp = await createDepartment("SCTP", "Senior Primary Care");
    const vol = await createPerson("No Email", null);
    await schedule(term.id, sctp.id, vol.id, target, "VOLUNTEER");

    const result = await runShiftReminders(NOW);
    expect(result.remindersSent).toBe(0);
    expect(result.skipped).toBe(1);
    expect(await shiftEmailCount()).toBe(0);
  });

  it("does nothing when there is no upcoming clinic date", async () => {
    await createTerm([new Date("2020-01-04T12:00:00.000Z")]);
    const result = await runShiftReminders(NOW);
    expect(result.remindersSent).toBe(0);
    expect(await shiftEmailCount()).toBe(0);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/platform/email/shift-reminders.test.ts`
Expected: FAIL (`runShiftReminders` is not exported).
Note: this test is DB-backed. If the worktree has no test database, it cannot run here and is validated in CI; in that case verify local correctness with `npm run typecheck` after Step 4 and rely on CI for this test. Do NOT claim the test passed without seeing green output.

- [ ] **Step 4: Implement the orchestrator**

Append to `src/platform/email/shift-reminders.ts`. First add these imports at the top of the file (next to the existing `shiftReminderContext` import):

```ts
import { prisma } from "@/platform/db";
import { getActiveTerm } from "@/platform/terms/active-term";
import { getSetting } from "@/platform/settings/service";
import { isoDateKey } from "@/platform/dates";
import { selectCurrentClinicDate, getCurrentClinicChannelLink } from "@/platform/teams/channel-link";
import { notify } from "@/platform/notifications/notify";
import { renderEmail } from "./templates/renderEmail";
```

Then append this function to the end of the file:

```ts
export type ShiftReminderRunResult = { remindersSent: number; skipped: number };

/**
 * Weekly shift reminders. Sent Monday mornings to everyone scheduled for the
 * upcoming Saturday clinic day. Enqueue-only: notify() writes the EmailLog /
 * Teams / inbox rows and the per-minute /api/cron/email tick delivers them.
 */
export async function runShiftReminders(now: Date = new Date()): Promise<ShiftReminderRunResult> {
  const result: ShiftReminderRunResult = { remindersSent: 0, skipped: 0 };

  const term = await getActiveTerm();
  if (!term) return result;

  // Same date selection as the Teams channel link, so the email date and the
  // linked channel always agree.
  const targetDate = selectCurrentClinicDate(term.clinicDates, now);
  if (!targetDate) return result;
  const targetKey = isoDateKey(targetDate);

  // Load the term's assignments and filter to the target clinic date by UTC day
  // key (never compare clinicDate by raw timestamp).
  const rows = await prisma.shiftAssignment.findMany({
    where: { termId: term.id },
    select: {
      personId: true,
      clinicDate: true,
      role: true,
      department: { select: { code: true, name: true } },
      person: { select: { id: true, name: true, contactEmail: true, entraObjectId: true } },
    },
  });
  const assignments: ReminderAssignment[] = rows
    .filter((r) => isoDateKey(r.clinicDate) === targetKey)
    .map((r) => ({ personId: r.personId, role: r.role, department: r.department, person: r.person }));
  if (assignments.length === 0) return result;

  const channelLink = await getCurrentClinicChannelLink({ now });
  const teamsChannelUrl = channelLink?.webUrl ?? "";
  const baseUrl = await getSetting<string>("app.baseUrl");

  const prepared = buildShiftReminders({ assignments, targetDate, teamsChannelUrl, baseUrl });

  // Idempotency: skip anyone already sent a shift-reminder within the last 6
  // days, which scopes to the current clinic week so a re-fired Monday cron
  // cannot double-send. Relies on the default email channel writing an EmailLog
  // row (the shipping config). An admin who switches this type to Teams-only
  // would weaken this guard; revisit with a dedicated marker if that is done.
  const cutoff = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);

  for (const item of prepared) {
    if (!item.person.contactEmail) {
      result.skipped++;
      continue;
    }

    const already = await prisma.emailLog.findFirst({
      where: { personId: item.person.id, template: "shift-reminder", createdAt: { gte: cutoff } },
      select: { id: true },
    });
    if (already) {
      result.skipped++;
      continue;
    }

    const rendered = await renderEmail("shift-reminder", item.context);
    await notify(prisma, {
      type: "shift-reminder",
      person: {
        id: item.person.id,
        entraObjectId: item.person.entraObjectId,
        contactEmail: item.person.contactEmail,
      },
      email: { subject: rendered.subject, html: rendered.html },
      teams: { title: "Shift reminder", summary: item.teamsSummary, link: `${baseUrl}/schedule` },
    });

    result.remindersSent++;
  }

  return result;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/platform/email/shift-reminders.test.ts src/platform/email/shift-reminders.build.test.ts`
Expected: PASS. (DB test requires a test database, see Step 3 note. The pure build test must pass regardless.)

- [ ] **Step 6: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/platform/email/shift-reminders.ts src/platform/email/shift-reminders.test.ts src/platform/notifications/registry.ts
git commit -m "feat(shift-reminders): weekly runShiftReminders job + notification type"
```

---

### Task 4: Cron route + manifest

**Files:**
- Create: `src/app/api/cron/shift-reminders/route.ts`
- Create: `src/app/api/cron/shift-reminders/route.test.ts`
- Modify: `docs/cron-jobs.md`

**Interfaces:**
- Consumes: `authorizeCron` (`@/platform/cron`); `runShiftReminders` (`@/platform/email/shift-reminders`, Task 3).
- Produces: a `GET(req: Request): Promise<Response>` route handler.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/cron/shift-reminders/route.test.ts`:

```ts
import { describe, expect, it, vi, afterEach } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET /api/cron/shift-reminders", () => {
  it("rejects an unauthorized request with 401 and does not run the job", async () => {
    vi.stubEnv("CRON_SECRET", "sekret");
    const job = await import("@/platform/email/shift-reminders");
    const spy = vi.spyOn(job, "runShiftReminders").mockResolvedValue({ remindersSent: 0, skipped: 0 });
    const { GET } = await import("./route");

    const res = await GET(new Request("https://x/api/cron/shift-reminders")); // no Authorization header
    expect(res.status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });

  it("runs the job when the bearer token matches", async () => {
    vi.stubEnv("CRON_SECRET", "sekret");
    const job = await import("@/platform/email/shift-reminders");
    const spy = vi.spyOn(job, "runShiftReminders").mockResolvedValue({ remindersSent: 3, skipped: 1 });
    const { GET } = await import("./route");

    const res = await GET(
      new Request("https://x/api/cron/shift-reminders", { headers: { Authorization: "Bearer sekret" } }),
    );
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledOnce();
    expect(await res.json()).toEqual({ ok: true, remindersSent: 3, skipped: 1 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/cron/shift-reminders/route.test.ts`
Expected: FAIL (cannot resolve `./route`).

- [ ] **Step 3: Implement the route**

Create `src/app/api/cron/shift-reminders/route.ts`:

```ts
/**
 * Weekly shift reminders. Sent Monday mornings to everyone scheduled for the
 * upcoming Saturday clinic day.
 *
 * Triggered WEEKLY on Mondays at 13:00 UTC by an EXTERNAL scheduler
 * (cron-job.org) hitting this path with `Authorization: Bearer $CRON_SECRET`,
 * not by Vercel Cron; this route is intentionally absent from vercel.json (see
 * docs/cron-jobs.md). This route only ENQUEUES; delivery is handled by the
 * per-minute /api/cron/email drainer within ~60s. Draining here would run
 * concurrently with that route and double-send.
 */
import { authorizeCron } from "@/platform/cron";
import { runShiftReminders } from "@/platform/email/shift-reminders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request): Promise<Response> {
  if (!authorizeCron(req)) return new Response("Unauthorized", { status: 401 });

  const r = await runShiftReminders();

  return Response.json({ ok: true, ...r });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/app/api/cron/shift-reminders/route.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Document the job in the manifest**

In `docs/cron-jobs.md`, add this row to the jobs table (after the `/api/cron/reminders` row):

```md
| `/api/cron/shift-reminders` | External (cron-job.org) | weekly (Mon) | `0 13 * * 1` | Enqueues weekly shift reminders to everyone scheduled for the upcoming Saturday clinic day (delivery happens on the email tick). | Volunteers stop receiving their Saturday shift reminders. |
```

- [ ] **Step 6: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/cron/shift-reminders/route.ts src/app/api/cron/shift-reminders/route.test.ts docs/cron-jobs.md
git commit -m "feat(shift-reminders): weekly Monday cron route + manifest entry"
```

---

## Post-Implementation (manual, outside code)

These are deployment steps, not code, and are done by the maintainer after merge:

1. Register a cron-job.org job hitting `GET /api/cron/shift-reminders` on schedule `0 13 * * 1` (Mondays 13:00 UTC, about 9 AM ET) with header `Authorization: Bearer <CRON_SECRET>`.
2. Optionally review/edit the template copy at `/admin/email/templates/shift-reminder`.
3. Confirm `teams.clinicGroupId` is set (`/admin/email` / settings) so the Teams channel link resolves; if unset, the reminder still sends with that line hidden.

---

## Self-Review

**Spec coverage** (against `docs/superpowers/specs/2026-07-09-shift-reminders-design.md`):
- Editable template with the listed variables and static-in-body links: Task 1. ✓
- Per-person context from `ShiftAssignment`; EDs=EXEC, CAs=PCAR, directors=DIRECTOR role, on the target date: Task 2 (logic) + Task 3 (query). ✓
- Upcoming-Saturday selection, no-clinic no-op: Task 3 (`selectCurrentClinicDate`, early returns) + test. ✓
- Teams channel link via `getCurrentClinicChannelLink`, hidden when empty: Task 3 + Task 1 `{{#if}}` + tests. ✓
- `notify()` dispatch honoring channel + inbox; `shift-reminder` type: Task 3. ✓
- Idempotency (no double-send on re-fire): Task 3 (EmailLog 6-day window) + test. ✓
- Enqueue-only cron on Monday, `authorizeCron`, documented, not in `vercel.json`: Task 4. ✓
- Recipients = all roles scheduled that Saturday: Task 2/3 (no role filter on recipients). ✓
- Tests (recipients, on-shift lists, empty-section hiding, idempotency, no-clinic, unauthorized cron): Tasks 1-4. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; every run step shows the command and expected result. The DB-test caveat is explicit, not a placeholder.

**Type consistency:** `ReminderAssignment` / `PreparedReminder` / `BuildShiftRemindersInput` defined in Task 2 are consumed unchanged in Task 3. `ShiftReminderParams` / `shiftReminderContext` from Task 1 are used with exactly matching keys in Task 2. `runShiftReminders(now?) => ShiftReminderRunResult` is the same shape mocked in Task 4's route test (`{ remindersSent, skipped }`). The string `"shift-reminder"` is identical across the descriptor key (Task 1), notify `type` / `EmailLog.template` / dedup query (Task 3), and `NOTIFICATION_TYPES` key (Task 3).
