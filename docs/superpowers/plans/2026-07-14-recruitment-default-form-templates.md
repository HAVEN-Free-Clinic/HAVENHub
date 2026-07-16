# Recruitment Default Form Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a new recruitment cycle start from a faithful, track-scoped replica of HAVEN's historical Airtable forms instead of three bare identity fields, so directors tweak rather than rebuild each cycle.

**Architecture:** A new `src/modules/recruitment/templates/` module holds composable, pure field-group builders that assemble one default form template per `Track`. `createCycle` materializes the track's template (application sections + quiz sections) into real `FormSection`/`FormField` rows inside its existing transaction; everything stays editable in DRAFT exactly as today. The onboarding contract's code-level default becomes track-aware on top of its existing override stack. No schema migration — every structure already exists.

**Tech Stack:** TypeScript, Next.js App Router, Prisma (PostgreSQL), Vitest. Tests use `resetDb` from `@/platform/test/db` and `prisma` from `@/platform/db`, against the per-worktree throwaway local Postgres (`TEST_DATABASE_URL`), never Neon.

## Global Constraints

- **No Prisma migration.** Use existing models: `FormSection` (`title`, `order`, `appliesTo ApplicantScope`, `departmentCode?`, `purpose FormPurpose`), `FormField` (`key`, `label`, `helpText?`, `type FieldType`, `required`, `options Json?`, `correctValue?`, `order`; `@@unique([cycleId, key])`).
- **`FieldType` values:** `SHORT_TEXT`, `LONG_TEXT`, `SINGLE_SELECT`, `MULTI_SELECT`, `CHECKBOX`, `EMAIL`, `PHONE`, `NUMBER`, `DATE`, `FILE`, `DEPARTMENT_CHOICE`, `SUBCOMMITTEE_RANK`. `ApplicantScope`: `NEW`, `RENEWAL`, `BOTH`. `FormPurpose`: `APPLICATION`, `QUIZ`. `Track`: `VOLUNTEER`, `DIRECTOR`.
- **Publish guards that the template MUST satisfy** (`services/cycles.ts:91-99`): keys `first_name`, `last_name`, `email` must exist; and any cycle with a `departmentCode` section must have **exactly one** `DEPARTMENT_CHOICE` field.
- **Identity keys are explicit and stable:** `first_name`, `last_name`, `email` (not label-derived). Materialization writes rows with explicit keys — do NOT route through `form-builder.ts addField` (which auto-derives keys via `uniqueKey`).
- **Genericize cycle-specific values** in default content: strip specific dates/deadlines/term names (e.g. "mandatory virtual training on Sunday, May 24th" → "the mandatory virtual training"). Directors fill specifics per cycle.
- **No em-dashes in user-facing copy** (house style).
- **Naming:** `havenhub` in identifiers, "HAVEN Hub" in prose/UI.
- Field/option source data captured in `scratchpad/airtable-form-inventory.md` and the rendered volunteer form.

---

### Task 1: Template types + shared field-group builders

**Files:**
- Create: `src/modules/recruitment/templates/types.ts`
- Create: `src/modules/recruitment/templates/content/options.ts`
- Create: `src/modules/recruitment/templates/content/acknowledgements.ts`
- Create: `src/modules/recruitment/templates/field-groups.ts`
- Test: `src/modules/recruitment/templates/field-groups.test.ts`

**Interfaces:**
- Produces:
  - `type TemplateOption = { label: string; value: string }`
  - `type TemplateField = { key: string; label: string; type: FieldType; required: boolean; helpText?: string; options?: TemplateOption[]; correctValue?: string; order: number }`
  - `type TemplateSection = { title: string; description?: string; order: number; appliesTo: ApplicantScope; departmentCode: string | null; purpose: FormPurpose; fields: TemplateField[] }`
  - Builders in `field-groups.ts` (each returns one `TemplateSection` with `order`/field-`order` set locally to 0-based; a later composition step renumbers globally): `identitySection()`, `eligibilitySection()`, `languagesSection()`, `additionalOpportunitiesSection()`, `availabilitySection(dates: TemplateOption[])`, `volunteerDepartmentSection()`, `acknowledgementsSection(track)`, `additionalInfoSection()`.

- [ ] **Step 1: Write the failing test**

```ts
// src/modules/recruitment/templates/field-groups.test.ts
import { describe, it, expect } from "vitest";
import { identitySection, eligibilitySection, languagesSection, acknowledgementsSection, availabilitySection } from "./field-groups";

describe("field-group builders", () => {
  it("identitySection has the three stable identity keys and is NEW-only", () => {
    const s = identitySection();
    expect(s.appliesTo).toBe("NEW");
    expect(s.departmentCode).toBeNull();
    const keys = s.fields.map((f) => f.key);
    expect(keys).toEqual(expect.arrayContaining(["first_name", "last_name", "email"]));
    const email = s.fields.find((f) => f.key === "email")!;
    expect(email.type).toBe("EMAIL");
    expect(email.required).toBe(true);
  });

  it("eligibilitySection offers the licensed-professional certifications as MULTI_SELECT", () => {
    const s = eligibilitySection();
    const certs = s.fields.find((f) => f.key === "medical_certifications")!;
    expect(certs.type).toBe("MULTI_SELECT");
    expect(certs.options!.map((o) => o.value)).toContain("EMT");
  });

  it("languagesSection Spanish proficiency is a SINGLE_SELECT with the five levels", () => {
    const s = languagesSection();
    const sp = s.fields.find((f) => f.key === "spanish_proficiency")!;
    expect(sp.type).toBe("SINGLE_SELECT");
    expect(sp.options!.map((o) => o.value)).toEqual(["none", "some", "conversational", "fluent_native", "fluent_non_native"]);
  });

  it("acknowledgementsSection(VOLUNTEER) carries the three signed policies with non-empty bodies", () => {
    const s = acknowledgementsSection("VOLUNTEER");
    const keys = s.fields.map((f) => f.key);
    expect(keys).toEqual(["volunteer_agreement", "professionalism_policy", "training_acknowledgement"]);
    expect(s.fields.every((f) => (f.helpText ?? "").length > 0 && f.required)).toBe(true);
  });

  it("availabilitySection uses the supplied dates as MULTI_SELECT options", () => {
    const s = availabilitySection([{ label: "May 30", value: "2026-05-30" }]);
    const a = s.fields.find((f) => f.key === "availability")!;
    expect(a.type).toBe("MULTI_SELECT");
    expect(a.options).toEqual([{ label: "May 30", value: "2026-05-30" }]);
  });

  it("no field label looks like a generic Airtable placeholder", () => {
    for (const s of [identitySection(), eligibilitySection(), languagesSection()]) {
      for (const f of s.fields) expect(f.label).not.toMatch(/supplement #?\d+$/i);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/recruitment/templates/field-groups.test.ts`
Expected: FAIL — module `./field-groups` and `./types` do not exist.

- [ ] **Step 3: Write the types**

```ts
// src/modules/recruitment/templates/types.ts
import type { ApplicantScope, FieldType, FormPurpose } from "@prisma/client";

export type TemplateOption = { label: string; value: string };

export type TemplateField = {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  helpText?: string;
  options?: TemplateOption[];
  correctValue?: string;
  order: number;
};

export type TemplateSection = {
  title: string;
  description?: string;
  order: number;
  appliesTo: ApplicantScope;
  departmentCode: string | null;
  purpose: FormPurpose;
  fields: TemplateField[];
};
```

- [ ] **Step 4: Write the captured option lists**

```ts
// src/modules/recruitment/templates/content/options.ts
// Verbatim from the live Airtable volunteer application (option lists captured
// this session). Values are stable machine keys; labels are applicant-facing.
import type { TemplateOption } from "../types";

export const YALE_AFFILIATION: TemplateOption[] = [
  { value: "yale_college", label: "Yale College" },
  { value: "divinity", label: "Yale School of Divinity" },
  { value: "gsas", label: "Yale Graduate School of Arts and Sciences (GSAS)" },
  { value: "jackson", label: "Yale Jackson School of Global Affairs" },
  { value: "law", label: "Yale Law School (YLS)" },
  { value: "som", label: "Yale School of Management (SOM)" },
  { value: "ysm_md", label: "Yale School of Medicine (YSM), MD or MD/PhD" },
  { value: "ysm_pa", label: "Yale School of Medicine (YSM), PA" },
  { value: "ysn", label: "Yale School of Nursing (YSN)" },
  { value: "ysph", label: "Yale School of Public Health (YSPH)" },
  { value: "staff", label: "Yale Staff" },
  { value: "other_yale", label: "Other Yale Affiliation" },
  { value: "non_yale", label: "I am NOT a Yale Affiliate" },
];

export const GRAD_YEAR: TemplateOption[] = [
  ...["2026", "2027", "2028", "2029", "2030", "2031", "2032", "2033"].map((y) => ({ value: y, label: y })),
  { value: "other", label: "Other" },
];

export const SPANISH_PROFICIENCY: TemplateOption[] = [
  { value: "none", label: "None" },
  { value: "some", label: "Some" },
  { value: "conversational", label: "Conversational" },
  { value: "fluent_native", label: "Fluent (native)" },
  { value: "fluent_non_native", label: "Fluent (non-native)" },
];

export const MEDICAL_CERTIFICATIONS: TemplateOption[] = [
  { value: "RN", label: "RN (Registered Nurse)" },
  { value: "LPN", label: "LPN (Licensed Practical Nurse)" },
  { value: "APRN", label: "APRN (Advanced Practice Registered Nurse)" },
  { value: "PA", label: "PA (Physician Associate)" },
  { value: "EMT", label: "EMT (Emergency Medical Technician, Basic/Advanced/Paramedic)" },
  { value: "pharmacist", label: "Pharmacist" },
  { value: "pharmacy_tech", label: "Pharmacy Technician" },
  { value: "other", label: "Other" },
];

export const YES_NO: TemplateOption[] = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
];
```

- [ ] **Step 5: Write the acknowledgement bodies (verbatim, dates genericized)**

```ts
// src/modules/recruitment/templates/content/acknowledgements.ts
// Verbatim policy text from the live Airtable volunteer application, with
// cycle-specific dates removed per the genericize rule. Rendered as the helpText
// of a required SHORT_TEXT "type your initials" field, matching Airtable.
export const VOLUNTEER_AGREEMENT = `By submitting this application, I agree to be a volunteer at the HAVEN Free Clinic during my assigned shifts. I understand that HAVEN serves an uninsured patient population for which the clinic functions as their, if not only, source of medical care. Further, I understand that my role as a volunteer is crucial and integral in providing patients with vital health care services, and I am fully committed to fulfilling my responsibilities to this population as a volunteer. If I do not fulfill my volunteer commitments, I understand that the HAVEN directors have the discretion to remove me from my role as a HAVEN volunteer.

Please initial below.`;

export const PROFESSIONALISM_POLICY = `Attendance Policy ("Strike Policy")

Volunteers who are absent from clinic on their scheduled day without securing a replacement through the designated scheduling system will receive one strike. Absences due to extenuating circumstances (e.g., illness or emergencies) will be reviewed on a case-by-case basis at the discretion of Department Directors.

If a volunteer receives two strikes, they may be deemed ineligible to continue in their department for the remainder of the term and/or the following term, at the discretion of Department Directors. Volunteers will be notified of strikes via email, including the reason and date.

Failure to complete required department trainings may result in up to two strikes and equivalent consequences.

Professionalism

Volunteers are expected to meet all onboarding and participation requirements. This includes attending required trainings, scheduling shifts, and responding to Director communications within a reasonable timeframe (typically 24 to 48 hours), particularly when related to patient care. Failure to meet these expectations may result in dismissal from the current semester. HIPAA violations will be handled in accordance with HAVEN policy and may result in required retraining, strikes, or immediate dismissal depending on severity.

Commitment to the Entirety of the Semester

This volunteer commitment applies for the full semester. Volunteers are expected to complete the minimum number of required shifts. Early departure without an extenuating circumstance or prior written agreement may result in ineligibility for future participation.

Please initial below.`;

export const TRAINING_ACKNOWLEDGEMENT = `I attest that I am available and able to attend the mandatory virtual training. I understand that my failure to attend training will result in my ineligibility to participate as a HAVEN volunteer.

Please initial below.`;
```

- [ ] **Step 6: Write the builders**

```ts
// src/modules/recruitment/templates/field-groups.ts
import type { Track } from "@prisma/client";
import type { TemplateOption, TemplateSection } from "./types";
import { YALE_AFFILIATION, GRAD_YEAR, SPANISH_PROFICIENCY, MEDICAL_CERTIFICATIONS, YES_NO } from "./content/options";
import { VOLUNTEER_AGREEMENT, PROFESSIONALISM_POLICY, TRAINING_ACKNOWLEDGEMENT } from "./content/acknowledgements";

const sec = (
  title: string,
  appliesTo: TemplateSection["appliesTo"],
  fields: Array<Omit<TemplateSection["fields"][number], "order">>,
  extra: Partial<Pick<TemplateSection, "description" | "departmentCode" | "purpose">> = {},
): TemplateSection => ({
  title,
  order: 0,
  appliesTo,
  departmentCode: extra.departmentCode ?? null,
  purpose: extra.purpose ?? "APPLICATION",
  description: extra.description,
  fields: fields.map((f, i) => ({ ...f, order: i })),
});

export function identitySection(): TemplateSection {
  return sec("Personal details", "NEW", [
    { key: "first_name", label: "First name", type: "SHORT_TEXT", required: true },
    { key: "last_name", label: "Last name", type: "SHORT_TEXT", required: true },
    { key: "pronouns", label: "Pronouns", type: "SHORT_TEXT", required: false },
    { key: "net_id", label: "Yale NetID", type: "SHORT_TEXT", required: true },
    { key: "email", label: "Yale email", type: "EMAIL", required: true },
    { key: "phone", label: "Phone number", type: "PHONE", required: false },
    { key: "yale_affiliation", label: "Yale affiliation", type: "SINGLE_SELECT", required: true, options: YALE_AFFILIATION },
    { key: "yale_affiliation_other", label: "If other or staff, please specify your school/title and department", type: "SHORT_TEXT", required: false },
    { key: "grad_year", label: "Graduation year", type: "SINGLE_SELECT", required: true, options: GRAD_YEAR },
  ], { description: "If you are a returning volunteer, your record is pulled automatically and you can skip this section." });
}

export function eligibilitySection(): TemplateSection {
  return sec("Medical and language experience", "NEW", [
    { key: "licensed_professional", label: "Are you a licensed medical professional? (Including EMT)", type: "SINGLE_SELECT", required: true, options: YES_NO },
    { key: "medical_certifications", label: "If you hold active certifications/licenses, please select all that apply", type: "MULTI_SELECT", required: false, options: MEDICAL_CERTIFICATIONS },
    { key: "medical_details", label: "Medical professional details", type: "SHORT_TEXT", required: false },
  ]);
}

export function languagesSection(): TemplateSection {
  return sec("Languages", "NEW", [
    { key: "spanish_proficiency", label: "Spanish proficiency level", type: "SINGLE_SELECT", required: true, options: SPANISH_PROFICIENCY,
      helpText: "If you wish to speak Spanish at HAVEN (regardless of role) you must pass an assessment with the Department of Interpretation and Diversity. Everyone selecting Conversational or above will be invited to this assessment." },
    { key: "other_languages", label: "Do you speak other languages?", type: "SINGLE_SELECT", required: true, options: YES_NO },
    { key: "other_languages_detail", label: "Which other languages do you speak?", type: "SHORT_TEXT", required: false },
  ]);
}

export function additionalOpportunitiesSection(): TemplateSection {
  return sec("Additional volunteer opportunities", "NEW", [
    { key: "vadm_dual_option", label: "VADM dual option", type: "CHECKBOX", required: false,
      helpText: "If you are a licensed RN in CT (or otherwise hold a valid U.S. license to administer vaccines, or are willing to become CT-licensed) and are willing to administer vaccines on weekends when not scheduled with your department, check this box." },
    { key: "intp_dual_option", label: "INTP dual option", type: "CHECKBOX", required: false,
      helpText: "If you are fluent in a language other than English and would be comfortable serving on-call as an interpreter, check this box and tell us what language you speak. We will contact you to assess your proficiency." },
  ]);
}

export function availabilitySection(dates: TemplateOption[]): TemplateSection {
  return sec("Availability", "BOTH", [
    { key: "availability", label: "Please indicate all clinic dates you are available to volunteer", type: "MULTI_SELECT", required: true, options: dates,
      helpText: "To be eligible you must commit to a minimum of four shifts. If you are applying for a non-patient-facing role, select the weeks you are available to commit to HAVEN." },
  ]);
}

export function volunteerDepartmentSection(): TemplateSection {
  return sec("Department preference", "BOTH", [
    { key: "department_choice", label: "Department / position preference", type: "DEPARTMENT_CHOICE", required: true },
    { key: "switch_departments", label: "Would you be willing to switch departments?", type: "SINGLE_SELECT", required: false, options: YES_NO },
    { key: "department_flexibility", label: "Are you flexible in your department choice?", type: "SINGLE_SELECT", required: false, options: YES_NO },
    { key: "resume", label: "Resume", type: "FILE", required: true, helpText: "Please upload your resume here." },
  ], { description: "See department descriptions at havenfreeclinic.com/apply." });
}

export function acknowledgementsSection(track: Track): TemplateSection {
  // Volunteer bodies are captured verbatim; the director-track bodies are filled
  // during content authoring (Task 8) and default to the volunteer text until then.
  return sec("Volunteer contract", "BOTH", [
    { key: "volunteer_agreement", label: "Volunteer agreement", type: "SHORT_TEXT", required: true, helpText: VOLUNTEER_AGREEMENT },
    { key: "professionalism_policy", label: "Attendance and professionalism policies", type: "SHORT_TEXT", required: true, helpText: PROFESSIONALISM_POLICY },
    { key: "training_acknowledgement", label: "Training acknowledgement", type: "SHORT_TEXT", required: true, helpText: TRAINING_ACKNOWLEDGEMENT },
  ]);
}

export function additionalInfoSection(): TemplateSection {
  return sec("Additional information", "BOTH", [
    { key: "additional_info", label: "Anything else you would like us to know?", type: "LONG_TEXT", required: false },
  ]);
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run src/modules/recruitment/templates/field-groups.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/modules/recruitment/templates/types.ts src/modules/recruitment/templates/content src/modules/recruitment/templates/field-groups.ts src/modules/recruitment/templates/field-groups.test.ts
git commit -m "feat(recruitment): template types + shared field-group builders"
```

---

### Task 2: Track application templates + integrity test

**Files:**
- Create: `src/modules/recruitment/templates/application/volunteer.ts`
- Create: `src/modules/recruitment/templates/application/director.ts`
- Create: `src/modules/recruitment/templates/application/supplements/dept-codes.ts`
- Create: `src/modules/recruitment/templates/index.ts`
- Test: `src/modules/recruitment/templates/index.test.ts`

**Interfaces:**
- Consumes: builders from Task 1.
- Produces:
  - `getApplicationTemplate(track: Track, departments: string[], availabilityDates: TemplateOption[]): TemplateSection[]` — shared sections + one supplement section per selected department (renumbered so `section.order` and each `field.order` are globally sequential, and `first_name`/`last_name`/`email` keys stay exact).
  - `supplementSectionsFor(track, departments): TemplateSection[]` (from `application/<track>.ts`).
  - `dept-codes.ts`: `normalizeDeptCode(code: string): string` (maps `FCLR`→`FCRL`, `SR&R`→`SRR`) and `SUPPLEMENT_DEPARTMENTS: Record<Track, string[]>` (canonical codes that have supplements).

- [ ] **Step 1: Write the failing test**

```ts
// src/modules/recruitment/templates/index.test.ts
import { describe, it, expect } from "vitest";
import { getApplicationTemplate } from "./index";

const dates = [{ label: "May 30", value: "2026-05-30" }];

describe("getApplicationTemplate", () => {
  it("includes the three identity keys for both tracks", () => {
    for (const track of ["VOLUNTEER", "DIRECTOR"] as const) {
      const keys = getApplicationTemplate(track, [], dates).flatMap((s) => s.fields.map((f) => f.key));
      expect(keys).toEqual(expect.arrayContaining(["first_name", "last_name", "email"]));
    }
  });

  it("emits exactly one DEPARTMENT_CHOICE field", () => {
    const fields = getApplicationTemplate("VOLUNTEER", ["MDIC"], dates).flatMap((s) => s.fields);
    expect(fields.filter((f) => f.type === "DEPARTMENT_CHOICE")).toHaveLength(1);
  });

  it("materializes a supplement section only for selected departments", () => {
    const t = getApplicationTemplate("VOLUNTEER", ["MDIC"], dates);
    const suppCodes = t.filter((s) => s.departmentCode !== null).map((s) => s.departmentCode);
    expect(suppCodes).toEqual(["MDIC"]);
  });

  it("has globally unique field keys and monotonic section order", () => {
    const t = getApplicationTemplate("DIRECTOR", ["BVHD", "MDIC"], dates);
    const keys = t.flatMap((s) => s.fields.map((f) => f.key));
    expect(new Set(keys).size).toBe(keys.length);
    expect(t.map((s) => s.order)).toEqual(t.map((_, i) => i));
  });

  it("ships no generic placeholder labels", () => {
    const labels = getApplicationTemplate("DIRECTOR", ["BVHD"], dates).flatMap((s) => s.fields.map((f) => f.label));
    for (const l of labels) expect(l).not.toMatch(/supplement #?\d+$/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/recruitment/templates/index.test.ts`
Expected: FAIL — `./index` does not exist.

- [ ] **Step 3: Write dept-codes normalizer**

```ts
// src/modules/recruitment/templates/application/supplements/dept-codes.ts
import type { Track } from "@prisma/client";

// Airtable used a few codes that differ from the repo Department seed.
const ALIASES: Record<string, string> = { FCLR: "FCRL", "SR&R": "SRR" };

export function normalizeDeptCode(code: string): string {
  const c = code.trim().toUpperCase();
  return ALIASES[c] ?? c;
}

// Canonical (normalized) department codes that carry a supplement section.
// Populated fully in Task 8; the two below let the mechanism land first.
export const SUPPLEMENT_DEPARTMENTS: Record<Track, string[]> = {
  VOLUNTEER: ["MDIC", "SRHD"],
  DIRECTOR: ["BVHD", "MDIC"],
};
```

- [ ] **Step 4: Write the track templates**

```ts
// src/modules/recruitment/templates/application/volunteer.ts
import type { TemplateSection } from "../types";
import { supplementQuestions } from "./supplements/volunteer"; // Task 8 provides content; empty map until then
import { normalizeDeptCode } from "./supplements/dept-codes";

export function volunteerSupplementSections(departments: string[]): TemplateSection[] {
  return departments.map((code) => {
    const norm = normalizeDeptCode(code);
    return {
      title: `${norm} department questions`,
      order: 0,
      appliesTo: "NEW",
      departmentCode: norm,
      purpose: "APPLICATION",
      description: "Please limit each response to 250 words or less.",
      fields: (supplementQuestions[norm] ?? []).map((f, i) => ({ ...f, order: i })),
    };
  });
}
```

```ts
// src/modules/recruitment/templates/application/director.ts
import type { TemplateSection } from "../types";
import { supplementQuestions } from "./supplements/director";
import { normalizeDeptCode } from "./supplements/dept-codes";

export function directorSupplementSections(departments: string[]): TemplateSection[] {
  return departments.map((code) => {
    const norm = normalizeDeptCode(code);
    return {
      title: `${norm} department questions`,
      order: 0,
      appliesTo: "NEW",
      departmentCode: norm,
      purpose: "APPLICATION",
      fields: (supplementQuestions[norm] ?? []).map((f, i) => ({ ...f, order: i })),
    };
  });
}
```

Create the two supplement content stubs so imports resolve (Task 8 fills them):

```ts
// src/modules/recruitment/templates/application/supplements/volunteer.ts
import type { TemplateField } from "../../types";
export const supplementQuestions: Record<string, Omit<TemplateField, "order">[]> = {};
```
```ts
// src/modules/recruitment/templates/application/supplements/director.ts
import type { TemplateField } from "../../types";
export const supplementQuestions: Record<string, Omit<TemplateField, "order">[]> = {};
```

- [ ] **Step 5: Write the composer**

```ts
// src/modules/recruitment/templates/index.ts
import type { Track } from "@prisma/client";
import type { TemplateOption, TemplateSection } from "./types";
import {
  identitySection, eligibilitySection, languagesSection, additionalOpportunitiesSection,
  availabilitySection, volunteerDepartmentSection, acknowledgementsSection, additionalInfoSection,
} from "./field-groups";
import { volunteerSupplementSections } from "./application/volunteer";
import { directorSupplementSections } from "./application/director";

export type { TemplateOption, TemplateSection } from "./types";

/** Renumber section.order and every field.order to be globally sequential. */
function renumber(sections: TemplateSection[]): TemplateSection[] {
  return sections.map((s, i) => ({ ...s, order: i, fields: s.fields.map((f, j) => ({ ...f, order: j })) }));
}

export function getApplicationTemplate(track: Track, departments: string[], availabilityDates: TemplateOption[]): TemplateSection[] {
  const shared: TemplateSection[] = track === "VOLUNTEER"
    ? [identitySection(), eligibilitySection(), languagesSection(), additionalOpportunitiesSection(),
       volunteerDepartmentSection(), availabilitySection(availabilityDates), acknowledgementsSection(track), additionalInfoSection()]
    : [identitySection(), languagesSection(), volunteerDepartmentSection(),
       availabilitySection(availabilityDates), acknowledgementsSection(track), additionalInfoSection()];
  const supplements = track === "VOLUNTEER" ? volunteerSupplementSections(departments) : directorSupplementSections(departments);
  return renumber([...shared, ...supplements]);
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/modules/recruitment/templates/index.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/modules/recruitment/templates/application src/modules/recruitment/templates/index.ts src/modules/recruitment/templates/index.test.ts
git commit -m "feat(recruitment): compose track application templates"
```

---

### Task 3: Quiz template

**Files:**
- Create: `src/modules/recruitment/templates/quiz.ts`
- Test: `src/modules/recruitment/templates/quiz.test.ts`

**Interfaces:**
- Produces: `getQuizTemplate(track: Track): TemplateSection[]` — one `purpose: "QUIZ"` section of `SINGLE_SELECT` questions, each with `options` but **no `correctValue`** (directors set answers per cycle).

- [ ] **Step 1: Write the failing test**

```ts
// src/modules/recruitment/templates/quiz.test.ts
import { describe, it, expect } from "vitest";
import { getQuizTemplate } from "./quiz";

describe("getQuizTemplate", () => {
  it("returns QUIZ-purpose single-select questions with options and no answer key", () => {
    const sections = getQuizTemplate("VOLUNTEER");
    expect(sections.length).toBeGreaterThan(0);
    expect(sections.every((s) => s.purpose === "QUIZ")).toBe(true);
    const fields = sections.flatMap((s) => s.fields);
    expect(fields.length).toBeGreaterThanOrEqual(1);
    expect(fields.every((f) => f.type === "SINGLE_SELECT")).toBe(true);
    expect(fields.every((f) => (f.options ?? []).length >= 2)).toBe(true);
    expect(fields.every((f) => f.correctValue === undefined)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/recruitment/templates/quiz.test.ts`
Expected: FAIL — `./quiz` does not exist.

- [ ] **Step 3: Write the quiz template**

Question stems are captured (they are the Airtable makeup-training field names); the option lists are filled during content authoring (Task 8) from the live makeup form. Ship the stems now with the exhaustive answer options gathered in Task 8. Until then, encode each question with its captured options.

```ts
// src/modules/recruitment/templates/quiz.ts
import type { Track } from "@prisma/client";
import type { TemplateSection } from "./types";

// Question stems verbatim from the Airtable makeup-training form. Options are
// authored in Task 8 (from the live form); no correctValue by decision.
const QUESTIONS: Array<{ key: string; label: string; options: string[] }> = [
  { key: "quiz_population", label: "What population does HAVEN primarily serve?", options: ["Uninsured patients", "Insured patients", "Yale students only", "Hospital inpatients"] },
  { key: "quiz_mission", label: "Which of the following is part of HAVEN's mission?", options: ["Free, student-run care for the uninsured", "For-profit specialty care", "Inpatient surgery", "Insurance sales"] },
  { key: "quiz_volunteers", label: "Why are volunteers important to HAVEN's mission?", options: ["They deliver the clinic's care", "They fund the clinic", "They own the building", "They are not important"] },
  { key: "quiz_language_record", label: "Why is language in the medical record important?", options: ["It affects patient care and dignity", "It has no effect", "Only for billing", "Only for research"] },
  { key: "quiz_epic_phrase", label: "Which phrase should NOT be used in Epic documentation?", options: ["Objective clinical language", "Judgmental or stigmatizing language", "Standard abbreviations", "Vital signs"] },
  { key: "quiz_sensitive_note", label: "What should volunteers do if unsure whether to include sensitive information in a note?", options: ["Ask a director or supervising provider", "Include everything", "Guess", "Leave the note blank"] },
  { key: "quiz_identifier", label: "Which of the following is a patient identifier that should not be shared publicly?", options: ["Full name or MRN", "The weather", "Clinic hours", "The building address"] },
  { key: "quiz_also_ask", label: "Even if information is HIPAA-compliant, volunteers should also ask:", options: ["Is sharing this necessary and respectful?", "Can I post it online?", "Who else wants to know?", "Nothing further"] },
  { key: "quiz_avoid_action", label: "Which action should volunteers avoid?", options: ["Sharing patient details outside of care", "Documenting accurately", "Asking for help", "Following up on referrals"] },
  { key: "quiz_location", label: "Where is HAVEN clinic located?", options: ["Fair Haven, New Haven", "New York", "Hartford", "Boston"] },
  { key: "quiz_contact_scheduling", label: "Who should volunteers contact for scheduling, training, or roster updates?", options: ["Student Recruitment and Relations (SR&R)", "The hospital CEO", "No one", "A patient"] },
  { key: "quiz_contact_it", label: "Who should volunteers contact for Microsoft Teams, Epic access, or technical issues?", options: ["IT & Compliance Management (ITCM)", "The pharmacy", "A patient", "No one"] },
  { key: "quiz_ipv", label: "During a visit, a patient discloses she does not feel safe in her relationship. What is the best next step?", options: ["Follow HAVEN's safety protocol and involve a supervising provider", "Ignore it", "Post about it", "End the visit immediately"] },
  { key: "quiz_access_check", label: "When should you check your Epic/Teams access before your shift?", options: ["Well before the shift, not the day of", "During the shift", "After the shift", "Never"] },
];

export function getQuizTemplate(_track: Track): TemplateSection[] {
  return [{
    title: "Training knowledge check",
    order: 0,
    appliesTo: "BOTH",
    departmentCode: null,
    purpose: "QUIZ",
    fields: QUESTIONS.map((q, i) => ({
      key: q.key, label: q.label, type: "SINGLE_SELECT", required: true,
      options: q.options.map((o) => ({ label: o, value: o })), order: i,
    })),
  }];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/recruitment/templates/quiz.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/templates/quiz.ts src/modules/recruitment/templates/quiz.test.ts
git commit -m "feat(recruitment): default training-quiz template (no answer key)"
```

---

### Task 4: `materializeTemplate` DB writer

**Files:**
- Create: `src/modules/recruitment/templates/materialize.ts`
- Test: `src/modules/recruitment/templates/materialize.test.ts`

**Interfaces:**
- Consumes: `TemplateSection[]`.
- Produces: `materializeTemplate(tx: Prisma.TransactionClient, cycleId: string, sections: TemplateSection[]): Promise<void>` — writes `FormSection` rows then their `FormField` rows with **explicit keys** and `options` serialized to JSON. Field `cycleId` set directly (required column).

- [ ] **Step 1: Write the failing test**

```ts
// src/modules/recruitment/templates/materialize.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { materializeTemplate } from "./materialize";
import type { TemplateSection } from "./types";

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

async function bareCycle() {
  const person = await prisma.person.create({ data: { name: "L", status: "ACTIVE" } });
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall 2026", startDate: new Date("2026-09-01"), endDate: new Date("2026-12-15") } });
  return prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "T", publicSlug: "t", departments: [], acceptsRenewals: false, createdById: person.id } });
}

describe("materializeTemplate", () => {
  it("writes sections and fields with explicit keys, order, and JSON options", async () => {
    const cycle = await bareCycle();
    const sections: TemplateSection[] = [
      { title: "Personal details", order: 0, appliesTo: "NEW", departmentCode: null, purpose: "APPLICATION",
        fields: [
          { key: "email", label: "Yale email", type: "EMAIL", required: true, order: 0 },
          { key: "spanish_proficiency", label: "Spanish", type: "SINGLE_SELECT", required: true, order: 1, options: [{ label: "None", value: "none" }] },
        ] },
      { title: "MDIC department questions", order: 1, appliesTo: "NEW", departmentCode: "MDIC", purpose: "APPLICATION", fields: [] },
    ];
    await prisma.$transaction((tx) => materializeTemplate(tx, cycle.id, sections));

    const dbSections = await prisma.formSection.findMany({ where: { cycleId: cycle.id }, orderBy: { order: "asc" }, include: { fields: { orderBy: { order: "asc" } } } });
    expect(dbSections.map((s) => s.title)).toEqual(["Personal details", "MDIC department questions"]);
    expect(dbSections[1].departmentCode).toBe("MDIC");
    expect(dbSections[0].fields.map((f) => f.key)).toEqual(["email", "spanish_proficiency"]);
    expect(dbSections[0].fields[1].options).toEqual([{ label: "None", value: "none" }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/recruitment/templates/materialize.test.ts`
Expected: FAIL — `./materialize` does not exist.

- [ ] **Step 3: Write the writer**

```ts
// src/modules/recruitment/templates/materialize.ts
import type { Prisma } from "@prisma/client";
import type { TemplateSection } from "./types";

export async function materializeTemplate(tx: Prisma.TransactionClient, cycleId: string, sections: TemplateSection[]): Promise<void> {
  for (const s of sections) {
    const section = await tx.formSection.create({
      data: { cycleId, title: s.title, description: s.description ?? null, order: s.order, appliesTo: s.appliesTo, departmentCode: s.departmentCode, purpose: s.purpose },
    });
    if (s.fields.length === 0) continue;
    await tx.formField.createMany({
      data: s.fields.map((f) => ({
        sectionId: section.id, cycleId, key: f.key, label: f.label, type: f.type,
        required: f.required, helpText: f.helpText ?? null, order: f.order,
        options: (f.options ?? undefined) as Prisma.InputJsonValue | undefined,
        correctValue: f.correctValue ?? null,
      })),
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/recruitment/templates/materialize.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/templates/materialize.ts src/modules/recruitment/templates/materialize.test.ts
git commit -m "feat(recruitment): materializeTemplate writes template rows"
```

---

### Task 5: Materialize the default template at cycle creation (flag on `createCycle` + UI action)

**Files:**
- Modify: `src/modules/recruitment/services/cycles.ts` (`createCycle` gains a `seedDefaultForm = false` param; the default path is UNCHANGED)
- Create: `src/modules/recruitment/templates/term-dates.ts`
- Modify: `src/app/(app)/recruitment/actions.ts:35` (`createCycleAction` passes `true`)
- Test: `src/modules/recruitment/services/cycles.test.ts` (ADD flag-path tests; do NOT change existing tests)

**Interfaces:**
- Consumes: `getApplicationTemplate`, `getQuizTemplate`, `materializeTemplate`, `termSaturdays`.
- Produces: `termSaturdays(start: Date, end: Date): TemplateOption[]` (each Saturday, `value` = `YYYY-MM-DD`, `label` = friendly); `createCycle(input, seedDefaultForm?: boolean)`.

**Design note (why a flag, not always-on):** ~9 test files AND the real code use `createCycle` as a minimal, controllable primitive; `submissions.test.ts` in particular calls `createCycle` then adds its own `DEPARTMENT_CHOICE` and depends on specific answer keys. If `createCycle` unconditionally materialized the template, those cycles would have two `DEPARTMENT_CHOICE` fields (publish throws) and duplicate identity keys. So the primitive keeps its 3-identity-field seed by default; only the real create-cycle UI action (`createCycleAction`) opts into the full default template via `seedDefaultForm: true`. Same user-facing behavior (new cycles created in the app start from the default). The existing `cycles.test.ts:20-30` "3 identity fields" test stays valid unchanged.

- [ ] **Step 1: Write the failing tests** (append to `cycles.test.ts`; do NOT modify existing tests)

```ts
describe("createCycle seedDefaultForm", () => {
  it("default (no flag) keeps only the minimal 3 identity fields", async () => {
    const { person, term } = await seedTermAndPerson();
    const cycle = await createCycle({ track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "v-min", departments: ["MDIC"], acceptsRenewals: false, createdById: person.id });
    const keys = (await prisma.formField.findMany({ where: { cycleId: cycle.id } })).map((f) => f.key).sort();
    expect(keys).toEqual(["email", "first_name", "last_name"]);
  });

  it("with the flag materializes the full track template + quiz + dept supplement", async () => {
    const { person, term } = await seedTermAndPerson();
    const cycle = await createCycle({ track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "v-tmpl", departments: ["MDIC"], acceptsRenewals: false, createdById: person.id }, true);
    const sections = await prisma.formSection.findMany({ where: { cycleId: cycle.id }, include: { fields: true } });
    const keys = sections.flatMap((s) => s.fields.map((f) => f.key));
    expect(keys).toEqual(expect.arrayContaining(["first_name", "last_name", "email", "spanish_proficiency", "volunteer_agreement"]));
    expect(sections.some((s) => s.purpose === "QUIZ")).toBe(true);
    expect(sections.some((s) => s.departmentCode === "MDIC")).toBe(true);
    expect(sections.filter((s) => s.fields.some((f) => f.type === "DEPARTMENT_CHOICE"))).toHaveLength(1);
  });

  it("publishes a flag-seeded default cycle with no manual edits", async () => {
    const { person, term } = await seedTermAndPerson();
    const cycle = await createCycle({ track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "v-pub", departments: ["MDIC"], acceptsRenewals: false, createdById: person.id }, true);
    expect((await publishCycle(cycle.id, person.id)).status).toBe("OPEN");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/recruitment/services/cycles.test.ts`
Expected: FAIL — `createCycle` takes no second arg yet, so the flag test sees only the 3 default fields (no `spanish_proficiency`/quiz/`MDIC` section).

- [ ] **Step 3: Write `termSaturdays`**

```ts
// src/modules/recruitment/templates/term-dates.ts
import type { TemplateOption } from "./types";

/** Every Saturday in [start, end], value = YYYY-MM-DD, label = "Mon D". */
export function termSaturdays(start: Date, end: Date): TemplateOption[] {
  const out: TemplateOption[] = [];
  const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  while (d.getUTCDay() !== 6) d.setUTCDate(d.getUTCDate() + 1);
  const fmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  for (; d <= end; d.setUTCDate(d.getUTCDate() + 7)) {
    out.push({ value: d.toISOString().slice(0, 10), label: fmt.format(d) });
  }
  return out;
}
```

- [ ] **Step 4: Add the flag to `createCycle`** (`services/cycles.ts`) — keep the default (minimal) path byte-for-byte as it is today; add the template path under the flag.

```ts
import type { TemplateSection } from "../templates/types";
import { getApplicationTemplate } from "../templates";
import { getQuizTemplate } from "../templates/quiz";
import { materializeTemplate } from "../templates/materialize";
import { termSaturdays } from "../templates/term-dates";

export async function createCycle(input: CreateCycleInput, seedDefaultForm = false): Promise<RecruitmentCycle> {
  let templateSections: TemplateSection[] | null = null;
  if (seedDefaultForm) {
    const term = await prisma.term.findUniqueOrThrow({ where: { id: input.termId }, select: { startDate: true, endDate: true } });
    const dates = termSaturdays(term.startDate, term.endDate);
    templateSections = [
      ...getApplicationTemplate(input.track, input.departments, dates),
      ...getQuizTemplate(input.track),
    ];
  }

  const cycle = await prisma.$transaction(async (tx) => {
    if (templateSections) {
      const created = await tx.recruitmentCycle.create({
        data: {
          track: input.track, termId: input.termId, title: input.title, publicSlug: input.publicSlug,
          departments: input.departments, acceptsRenewals: input.acceptsRenewals, createdById: input.createdById,
        },
      });
      await materializeTemplate(tx, created.id, templateSections);
      return created;
    }
    // Default: the minimal identity seed (unchanged behavior).
    const created = await tx.recruitmentCycle.create({
      data: {
        track: input.track, termId: input.termId, title: input.title, publicSlug: input.publicSlug,
        departments: input.departments, acceptsRenewals: input.acceptsRenewals, createdById: input.createdById,
        sections: { create: { title: "Your information", order: 0, appliesTo: "BOTH" } },
      },
      include: { sections: true },
    });
    const identity = created.sections[0];
    await tx.formField.createMany({
      data: [
        { sectionId: identity.id, cycleId: created.id, key: "first_name", label: "First name", type: "SHORT_TEXT", required: true, order: 0 },
        { sectionId: identity.id, cycleId: created.id, key: "last_name", label: "Last name", type: "SHORT_TEXT", required: true, order: 1 },
        { sectionId: identity.id, cycleId: created.id, key: "email", label: "Yale email", type: "EMAIL", required: true, order: 2 },
      ],
    });
    return created;
  });

  await recordAudit({ actorPersonId: input.createdById, action: "recruitment.cycle_create", entityType: "RecruitmentCycle", entityId: cycle.id });
  return cycle;
}
```

- [ ] **Step 5: Opt the UI action into the default form** — in `src/app/(app)/recruitment/actions.ts:35`, change the `createCycle({ ... })` call to pass `true` as the second argument:

```ts
    cycle = await createCycle({ track, termId, title, publicSlug: slug, departments, acceptsRenewals: false, createdById: person.personId }, true);
```

- [ ] **Step 6: Run tests to verify pass + no regressions**

Run each and expect PASS:
- `npx vitest run src/modules/recruitment/services/cycles.test.ts` (new flag tests + all pre-existing tests unchanged)
- `npx vitest run "src/app/(app)/recruitment/actions.test.ts"` (createCycleAction error-path tests still green)
- `npx vitest run src/modules/recruitment` (submissions/drafts/subcommittees/etc. call `createCycle` WITHOUT the flag, so their minimal-form setups are unaffected)

If any pre-existing test regresses, STOP and report — do not rewrite unrelated tests.

- [ ] **Step 7: Commit**

```bash
git add src/modules/recruitment/services/cycles.ts src/modules/recruitment/templates/term-dates.ts src/modules/recruitment/services/cycles.test.ts "src/app/(app)/recruitment/actions.ts"
git commit -m "feat(recruitment): seed default template on cycle creation via flag"
```

---

### Task 6: Track-aware default contract layout

**Files:**
- Modify: `src/modules/recruitment/contract/system-fields.ts:38-57`
- Modify: `src/modules/recruitment/contract/resolve.ts:13-23`
- Modify: `src/modules/recruitment/contract/system-fields.test.ts`, `contract/resolve.test.ts`

**Interfaces:**
- Produces: `defaultContractLayout(track: Track): ContractLayout`. `resolveLayoutSources(cycleOverride, globalDefault, track)` and `resolveContractLayout(cycleId)` (reads `cycle.track`) fall back to the track default.

- [ ] **Step 1: Write the failing test** (append to `system-fields.test.ts`)

```ts
import { defaultContractLayout } from "./system-fields";
import type { AgreementBlock } from "./layout";

describe("defaultContractLayout(track)", () => {
  it("volunteer default keeps the three agreements", () => {
    const ids = defaultContractLayout("VOLUNTEER").blocks.filter((b): b is AgreementBlock => b.kind === "agreement").map((b) => b.id);
    expect(ids).toEqual(["agreement", "professionalism", "training"]);
  });
  it("director default includes a data-privacy agreement the volunteer default lacks", () => {
    const dirIds = defaultContractLayout("DIRECTOR").blocks.filter((b) => b.kind === "agreement").map((b) => (b as AgreementBlock).id);
    const volIds = defaultContractLayout("VOLUNTEER").blocks.filter((b) => b.kind === "agreement").map((b) => (b as AgreementBlock).id);
    expect(dirIds).toContain("data_privacy");
    expect(volIds).not.toContain("data_privacy");
  });
});
```

And in `resolve.test.ts`, add a case asserting a director cycle with no overrides resolves to the director default (contains `data_privacy`). Follow that file's existing `resetDb` + cycle-creation pattern.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/recruitment/contract/system-fields.test.ts`
Expected: FAIL — `defaultContractLayout` not exported.

- [ ] **Step 3: Implement** — in `system-fields.ts`, keep `DEFAULT_CONTRACT_LAYOUT` as the volunteer baseline and add:

```ts
import type { Track } from "@prisma/client";

export function defaultContractLayout(track: Track): ContractLayout {
  if (track === "VOLUNTEER") return DEFAULT_CONTRACT_LAYOUT;
  // Director: same fields plus a data-privacy agreement, before the training block.
  const blocks = [...DEFAULT_CONTRACT_LAYOUT.blocks];
  const trainingIdx = blocks.findIndex((b) => b.kind === "agreement" && b.id === "training");
  blocks.splice(trainingIdx, 0, { kind: "agreement", id: "data_privacy", title: "Data privacy acknowledgement", body: "", signatureLabel: "type your full name" });
  return { blocks };
}
```

Then thread `track` through `resolve.ts`:

```ts
export function resolveLayoutSources(cycleOverride: unknown, globalDefault: unknown, track: Track): ContractLayout {
  return safe(cycleOverride) ?? safe(globalDefault) ?? defaultContractLayout(track);
}

export async function resolveContractLayout(cycleId: string): Promise<ContractLayout> {
  const [row, globalDefault, cycle] = await Promise.all([
    prisma.recruitmentCycleContract.findUnique({ where: { cycleId } }),
    getSetting<unknown>("onboarding.contractTemplate"),
    prisma.recruitmentCycle.findUniqueOrThrow({ where: { id: cycleId }, select: { track: true } }),
  ]);
  return resolveLayoutSources(row?.layout ?? null, globalDefault, cycle.track);
}
```

(Update the import in `resolve.ts` to pull `defaultContractLayout` alongside `DEFAULT_CONTRACT_LAYOUT`, and any other `resolveLayoutSources` callers to pass a track.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/recruitment/contract`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/contract
git commit -m "feat(recruitment): track-aware default contract layout"
```

---

### Task 7: Department-code reconciliation + missing seed departments

**Files:**
- Modify: `prisma/seed.ts:11-43` (`DEPARTMENTS`)
- Modify: `src/modules/recruitment/templates/application/supplements/dept-codes.ts`
- Test: `src/modules/recruitment/templates/application/supplements/dept-codes.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// dept-codes.test.ts
import { describe, it, expect } from "vitest";
import { normalizeDeptCode, SUPPLEMENT_DEPARTMENTS } from "./dept-codes";

// Repo Department seed codes (source of truth) after Task 7 additions.
const SEED_CODES = new Set([
  "BVHD","CCRH","CRAD","EDUC","EXEC","FCRL","FIND","FOOD","ICDD","INTP","ITCM","JCTP","JCTS","JONES","LABR","LCCN","MDIC","MDLP","ORHI","PATS","PBRL","PCAR","PHAM","PNLC","PNTC","QAQI","REFF","SCTL","SCTP","SCTS","SOSE","SRHD","SRR","TBAD","VADC","VADM",
]);

describe("dept-codes", () => {
  it("normalizes Airtable aliases to seed codes", () => {
    expect(normalizeDeptCode("FCLR")).toBe("FCRL");
    expect(normalizeDeptCode("SR&R")).toBe("SRR");
    expect(normalizeDeptCode(" mdic ")).toBe("MDIC");
  });
  it("every supplement department resolves to a seeded Department code", () => {
    for (const track of ["VOLUNTEER", "DIRECTOR"] as const) {
      for (const code of SUPPLEMENT_DEPARTMENTS[track]) expect(SEED_CODES.has(code)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/recruitment/templates/application/supplements/dept-codes.test.ts`
Expected: FAIL if any `SUPPLEMENT_DEPARTMENTS` code is not in `SEED_CODES` (e.g. before adding `JONES`).

- [ ] **Step 3: Add the missing real departments** to `prisma/seed.ts` `DEPARTMENTS` (alphabetical, matching the file's `{ code, name }` shape):

```ts
  { code: "JONES", name: "Jones Fellows" },
  { code: "LCCN", name: "Longitudinal Care Coordination" },
  { code: "SCTL", name: "Senior Longitudinal Care Team Member" },
  { code: "PNTC", name: "Patient Navigation: Transfer of Care" },
  { code: "TBAD", name: "Translational Bridge and Advocacy" },
```

(Confirm each canonical name with HAVEN before running the seed against a shared DB. Seed upserts are idempotent, so re-running is safe. If a name is uncertain at authoring time, use the department's known full name from `scratchpad/airtable-form-inventory.md`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/recruitment/templates/application/supplements/dept-codes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add prisma/seed.ts src/modules/recruitment/templates/application/supplements/dept-codes.ts src/modules/recruitment/templates/application/supplements/dept-codes.test.ts
git commit -m "feat(recruitment): reconcile supplement department codes with seed"
```

---

### Task 8: Per-department supplement content + director essays + quiz options (content authoring)

This is the faithful-content pass. It gathers real applicant-facing wording from the live Airtable forms (the mechanism from Tasks 1-7 already renders whatever content lands here). Content is data, so the "how" is the extraction procedure + the data format + a worked example + completeness tests.

**Files:**
- Modify: `src/modules/recruitment/templates/application/supplements/volunteer.ts` (fill `supplementQuestions`)
- Modify: `src/modules/recruitment/templates/application/supplements/director.ts` (fill `supplementQuestions`)
- Modify: `src/modules/recruitment/templates/application/supplements/dept-codes.ts` (complete `SUPPLEMENT_DEPARTMENTS` for both tracks)
- Modify: `src/modules/recruitment/templates/field-groups.ts` (director-track acknowledgement + director essay/info-session fields, from the live director form)
- Modify: `src/modules/recruitment/templates/quiz.ts` (replace the interim options with the live makeup-form options)
- Test: `src/modules/recruitment/templates/application/supplements/coverage.test.ts`

**Extraction procedure (per form):**
1. In the browser, open the form URL (password-gated; the site owner enters the password). The six URLs and their base passwords are in the session; the two Director-base forms may use a different password than the four Volunteer-base forms.
2. `get_page_text(tabId)` to capture the shared, always-visible questions verbatim.
3. For each department in that form's department selector: select it (Airtable lazy-renders the supplement), then `get_page_text` and read the revealed "Department Specific Questions" block. Record each question's label, whether it is required (a `*`), help text, and type (long text unless it visibly renders as a select/checkbox).
4. Map the Airtable question to a `TemplateField` (see format below). Key = `<deptcode_lower>_<slug>` (e.g. `mdic_priorities`). Type: multilineText→`LONG_TEXT`, singleSelect→`SINGLE_SELECT` (+`options`), checkbox→`CHECKBOX`.
5. Add the normalized department code to `SUPPLEMENT_DEPARTMENTS[track]`.

**Data format (worked example — MDIC volunteer supplement):**

```ts
// in supplements/volunteer.ts
export const supplementQuestions: Record<string, Omit<TemplateField, "order">[]> = {
  MDIC: [
    { key: "mdic_supplement_1", label: "<verbatim MDIC question 1 from the live form>", type: "LONG_TEXT", required: true },
    // ...one entry per revealed MDIC question, in form order
  ],
  // ...one entry per department in SUPPLEMENT_DEPARTMENTS.VOLUNTEER
};
```

(The worked example shows the exact shape; the implementer replaces the angle-bracket text with the verbatim question read from the form. No angle-bracket text may remain — the coverage test's placeholder guard fails on it.)

**Director shared essays + info session** (extract from the director form, then add to `field-groups.ts` as a `directorEssaysSection()` used by the director branch of `getApplicationTemplate`): the "HAVEN Experience" prompt and the three "HAVEN Supplement" prompts become real question labels; the info-session confirmation becomes a required `CHECKBOX`. Wire `directorEssaysSection()` into the director branch in `index.ts` and add the EXEC-only subcommittee ranking (`SUBCOMMITTEE_RANK`) section.

- [ ] **Step 1: Write the coverage + placeholder-guard test**

```ts
// supplements/coverage.test.ts
import { describe, it, expect } from "vitest";
import { getApplicationTemplate } from "../../index";
import { SUPPLEMENT_DEPARTMENTS } from "./dept-codes";

const dates = [{ label: "May 30", value: "2026-05-30" }];

describe("supplement coverage", () => {
  it("every SUPPLEMENT_DEPARTMENTS entry produces a non-empty supplement section", () => {
    for (const track of ["VOLUNTEER", "DIRECTOR"] as const) {
      const codes = SUPPLEMENT_DEPARTMENTS[track];
      const t = getApplicationTemplate(track, codes, dates);
      for (const code of codes) {
        const section = t.find((s) => s.departmentCode === code);
        expect(section, `${track} ${code} supplement section`).toBeDefined();
        expect(section!.fields.length, `${track} ${code} has questions`).toBeGreaterThan(0);
      }
    }
  });

  it("no field label or option is a leftover placeholder", () => {
    for (const track of ["VOLUNTEER", "DIRECTOR"] as const) {
      const t = getApplicationTemplate(track, SUPPLEMENT_DEPARTMENTS[track], dates);
      for (const f of t.flatMap((s) => s.fields)) {
        expect(f.label).not.toMatch(/<.*>|supplement #?\d+$|TODO|TBD/i);
        for (const o of f.options ?? []) expect(o.label).not.toMatch(/<.*>|TODO|TBD/i);
      }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/recruitment/templates/application/supplements/coverage.test.ts`
Expected: FAIL — supplement maps are empty / interim quiz options unverified.

- [ ] **Step 3: Extract and fill content** following the procedure above: populate `supplementQuestions` for both tracks, complete `SUPPLEMENT_DEPARTMENTS`, add the director essays/info-session/subcommittee sections, and replace quiz options with the live makeup-form options. Commit incrementally per form if helpful.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/recruitment/templates`
Expected: PASS (coverage + placeholder guard green).

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/templates prisma/seed.ts
git commit -m "feat(recruitment): faithful Airtable-modeled default content"
```

---

### Task 9: End-to-end visibility integration test

**Files:**
- Test: `src/modules/recruitment/templates/visibility.integration.test.ts`

Validates the materialized template plays correctly with the existing visibility engine.

- [ ] **Step 1: Write the test**

```ts
// visibility.integration.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { createCycle } from "../services/cycles";
import { isSectionVisible } from "../engine/visibility";

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

async function seed() {
  const person = await prisma.person.create({ data: { name: "L", status: "ACTIVE" } });
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall 2026", startDate: new Date("2026-09-01"), endDate: new Date("2026-12-15") } });
  return { person, term };
}

describe("default template + visibility engine", () => {
  it("hides the NEW-only personal-details section for a renewal, shows it for a new applicant", async () => {
    const { person, term } = await seed();
    const cycle = await createCycle({ track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "vis-1", departments: ["MDIC"], acceptsRenewals: true, createdById: person.id }, true);
    const sections = await prisma.formSection.findMany({ where: { cycleId: cycle.id } });
    const personal = sections.find((s) => s.title === "Personal details")!;
    expect(isSectionVisible(personal, { applicantType: "RENEWAL", selectedDepartmentCodes: [] })).toBe(false);
    expect(isSectionVisible(personal, { applicantType: "NEW", selectedDepartmentCodes: [] })).toBe(true);
  });

  it("hides a department supplement unless that department is chosen", async () => {
    const { person, term } = await seed();
    const cycle = await createCycle({ track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "vis-2", departments: ["MDIC"], acceptsRenewals: false, createdById: person.id }, true);
    const supp = (await prisma.formSection.findMany({ where: { cycleId: cycle.id } })).find((s) => s.departmentCode === "MDIC")!;
    expect(isSectionVisible(supp, { applicantType: "NEW", selectedDepartmentCodes: [] })).toBe(false);
    expect(isSectionVisible(supp, { applicantType: "NEW", selectedDepartmentCodes: ["MDIC"] })).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run src/modules/recruitment/templates/visibility.integration.test.ts`
Expected: PASS.

- [ ] **Step 3: Full module gate**

Run: `npx vitest run src/modules/recruitment` then `npm run lint`
Expected: PASS, EXCEPT one known pre-existing environmental failure in `services/promotion.test.ts` (`EpicRequest.techRequestId`) caused by shared-`havenhub_test` schema drift — it fails identically with this branch's changes stashed out, so it is NOT a regression from this work. Every other recruitment test (incl. `submissions`/`drafts`, which use `createCycle` without the flag) must pass. If any OTHER test fails, STOP and report.

- [ ] **Step 4: Commit**

```bash
git add src/modules/recruitment/templates/visibility.integration.test.ts
git commit -m "test(recruitment): default template respects visibility engine"
```

---

## Self-Review

**Spec coverage:**
- Composable code template (spec Component 1) → Tasks 1-3.
- Materialize at `createCycle`, selected-departments-only, one `DEPARTMENT_CHOICE`, `appliesTo: NEW` personal details (Component 2) → Tasks 4-5, 9.
- Contract track-variants (Component 3) → Task 6.
- Quiz at every createCycle, no answer key (Component 4) → Tasks 3, 5.
- Department-code reconciliation + missing seed codes → Task 7.
- Full faithful content (content workstream) → Task 8.
- Testing section (unit integrity, integration createCycle/publish, visibility, contract) → Tasks 1-9.
- No schema migration → honored (no `prisma/schema.prisma` edit).

**Placeholder scan:** The only intentional angle-bracket content is inside Task 8's *worked example*, where it explicitly denotes "replace with verbatim extracted text," and Task 8 ships a placeholder-guard test that fails on any leftover. Interim quiz options in Task 3 are real, plausible options replaced with verbatim ones in Task 8; the quiz test does not assert an answer key. No `TODO`/`TBD` in shipped code.

**Type consistency:** `TemplateSection`/`TemplateField`/`TemplateOption` are defined once (Task 1) and consumed unchanged in Tasks 2-9. `materializeTemplate(tx, cycleId, sections)`, `getApplicationTemplate(track, departments, dates)`, `getQuizTemplate(track)`, `defaultContractLayout(track)`, `resolveLayoutSources(cycleOverride, globalDefault, track)`, `termSaturdays(start, end)`, `normalizeDeptCode(code)`, `SUPPLEMENT_DEPARTMENTS[track]` are referenced with identical signatures everywhere.
