# Yale Affiliation Standardization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `Person.yaleAffiliation` a dropdown backed by one canonical 13-option list on every surface that writes it, and make every consumer that reads it agree on that vocabulary.

**Architecture:** A new pure module `src/platform/affiliation.ts` owns the option list, the label lookup, the legacy-to-canonical mapper, and the two classifiers. It lives in `src/platform/` because eslint forbids `modules/my-info` and `modules/admin` from importing `modules/recruitment` (where the list lives today) and forbids `src/platform/**` from importing module code at all. Two re-export shims keep existing importers unchanged. A data-only migration collapses stored legacy strings onto canonical keys without ever nulling a value it cannot map.

**Tech Stack:** Next.js App Router (RSC), TypeScript, Prisma + Postgres, Vitest, Tailwind via `@/platform/ui` primitives.

**Spec:** `docs/superpowers/specs/2026-07-30-yale-affiliation-standardization-design.md`

## Global Constraints

- **No em-dash characters (U+2014) anywhere under `src/`.** CI-enforced by the `local/no-em-dash` eslint rule. Use a comma, colon, parentheses, or hyphen.
- **Never null or drop an affiliation value the code does not recognize.** Every layer preserves unmapped values verbatim. This is the design's primary failure mode.
- **`src/platform/**` must not import from `src/modules/**`.** Enforced by `no-restricted-imports` and `import/no-restricted-paths` in `eslint.config.mjs`.
- **Modules must not import other modules.** `MODULE_IDS` in `eslint.config.mjs` covers `my-info`, `admin`, `recruitment`, and five others.
- **Use `@/platform/ui` primitives, never styled raw `<select>`/`<input>`.** Enforced by the `no-restricted-syntax` rule.
- **Run `npm run lint` (whole repo) before pushing.** `npm run typecheck` and `npm test` do not catch the eslint import-boundary rules this plan depends on.
- Canonical option values and labels are fixed and must be byte-identical everywhere they appear:

```
yale_college  Yale College
divinity      Yale School of Divinity
gsas          Yale Graduate School of Arts and Sciences (GSAS)
jackson       Yale Jackson School of Global Affairs
law           Yale Law School (YLS)
som           Yale School of Management (SOM)
ysm_md        Yale School of Medicine (YSM), MD or MD/PhD
ysm_pa        Yale School of Medicine (YSM), PA
ysn           Yale School of Nursing (YSN)
ysph          Yale School of Public Health (YSPH)
staff         Yale Staff
other_yale    Other Yale Affiliation
non_yale      I am NOT a Yale Affiliate
```

## File Structure

| File | Responsibility |
| --- | --- |
| `src/platform/affiliation.ts` (new) | Sole owner of the vocabulary: options, label lookup, legacy mapper, student/med-school classifiers. Pure, no DB. |
| `src/platform/affiliation.test.ts` (new) | Unit tests for all six exports. |
| `src/modules/recruitment/templates/content/options.ts` | Re-export shim for `YALE_AFFILIATION`. |
| `src/platform/ehs/engine/applicability.ts` | Re-export shim for `isStudentAffiliation`; loses its own copy. |
| `src/modules/recruitment/contract/system-fields.ts` | `systemFieldOptions` delegates the affiliation prepend rule. |
| `src/modules/my-info/components/my-info-form.tsx` | Renders canonical dropdown; loses its 8-string list. |
| `src/modules/admin/components/person-form.tsx` | Free-text input becomes the same dropdown. |
| `src/modules/support/services/itcm-pdf.ts` | YNHH checkbox routing driven by the classifiers, writing labels. |
| `src/platform/email/audience/person-fields.ts` | Affiliation filter becomes an enum picker. |
| `src/platform/airtable/import/transforms.ts` | Normalizes imported values. |
| `prisma/migrations/<ts>_normalize_yale_affiliation/migration.sql` (new) | One-time data backfill. |

---

### Task 1: The canonical affiliation module

**Files:**
- Create: `src/platform/affiliation.ts`
- Test: `src/platform/affiliation.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type AffiliationOption = { value: string; label: string }`, `YALE_AFFILIATIONS: AffiliationOption[]`, `affiliationLabel(value: string | null | undefined): string`, `affiliationOptionsWith(current: string | null | undefined): AffiliationOption[]`, `normalizeAffiliation(raw: string | null | undefined): string | null`, `isStudentAffiliation(value: string | null | undefined): boolean`, `isMedicalSchoolAffiliation(value: string | null | undefined): boolean`. Every later task consumes from here.

- [ ] **Step 1: Write the failing test**

Create `src/platform/affiliation.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  YALE_AFFILIATIONS,
  affiliationLabel,
  affiliationOptionsWith,
  isMedicalSchoolAffiliation,
  isStudentAffiliation,
  normalizeAffiliation,
} from "./affiliation";

describe("YALE_AFFILIATIONS", () => {
  it("holds the 13 canonical options with unique values", () => {
    expect(YALE_AFFILIATIONS).toHaveLength(13);
    expect(new Set(YALE_AFFILIATIONS.map((o) => o.value)).size).toBe(13);
  });
});

describe("affiliationLabel", () => {
  it("resolves a canonical key to its user-facing label", () => {
    expect(affiliationLabel("ysm_md")).toBe("Yale School of Medicine (YSM), MD or MD/PhD");
    expect(affiliationLabel("staff")).toBe("Yale Staff");
  });

  it("passes an unrecognized value through unchanged rather than blanking it", () => {
    expect(affiliationLabel("Medical Student")).toBe("Medical Student");
  });

  it("returns the empty string for null, undefined, and blank", () => {
    expect(affiliationLabel(null)).toBe("");
    expect(affiliationLabel(undefined)).toBe("");
    expect(affiliationLabel("   ")).toBe("");
  });
});

describe("affiliationOptionsWith", () => {
  it("returns exactly the canonical list for a canonical value", () => {
    expect(affiliationOptionsWith("ysn")).toHaveLength(13);
  });

  it("returns exactly the canonical list for null or blank", () => {
    expect(affiliationOptionsWith(null)).toHaveLength(13);
    expect(affiliationOptionsWith("")).toHaveLength(13);
  });

  it("prepends an unrecognized stored value exactly once so re-saving cannot erase it", () => {
    const options = affiliationOptionsWith("Medical Student");
    expect(options).toHaveLength(14);
    expect(options[0]).toEqual({ value: "Medical Student", label: "Medical Student" });
  });
});

describe("normalizeAffiliation", () => {
  it("maps every option from the retired /my-info dropdown", () => {
    expect(normalizeAffiliation("Yale College")).toBe("yale_college");
    expect(normalizeAffiliation("Yale School of Medicine")).toBe("ysm_md");
    expect(normalizeAffiliation("Yale School of Nursing")).toBe("ysn");
    expect(normalizeAffiliation("Yale School of Public Health")).toBe("ysph");
    expect(normalizeAffiliation("Physician Associate Program")).toBe("ysm_pa");
    expect(normalizeAffiliation("Graduate School")).toBe("gsas");
    expect(normalizeAffiliation("Staff")).toBe("staff");
    expect(normalizeAffiliation("Other")).toBe("other_yale");
  });

  it("maps the canonical labels that Airtable stores", () => {
    expect(normalizeAffiliation("Yale Staff")).toBe("staff");
    expect(normalizeAffiliation("Other Yale Affiliation")).toBe("other_yale");
    expect(normalizeAffiliation("Yale Law School (YLS)")).toBe("law");
    expect(normalizeAffiliation("Yale School of Medicine (YSM), PA")).toBe("ysm_pa");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(normalizeAffiliation("  yale STAFF  ")).toBe("staff");
    expect(normalizeAffiliation("graduate school")).toBe("gsas");
  });

  it("leaves an already-canonical key untouched", () => {
    for (const option of YALE_AFFILIATIONS) {
      expect(normalizeAffiliation(option.value)).toBe(option.value);
    }
  });

  it("returns an unmapped string trimmed but otherwise unchanged", () => {
    expect(normalizeAffiliation("  Medical Student ")).toBe("Medical Student");
  });

  it("returns null for null, undefined, and whitespace-only input", () => {
    expect(normalizeAffiliation(null)).toBeNull();
    expect(normalizeAffiliation(undefined)).toBeNull();
    expect(normalizeAffiliation("   ")).toBeNull();
  });
});

describe("isStudentAffiliation", () => {
  it("returns true for every named Yale school", () => {
    for (const value of ["yale_college", "divinity", "gsas", "jackson", "law", "som", "ysm_md", "ysm_pa", "ysn", "ysph"]) {
      expect(isStudentAffiliation(value)).toBe(true);
    }
  });

  it("returns false for staff, other, and not-a-Yale-affiliate", () => {
    for (const value of ["staff", "other_yale", "non_yale"]) {
      expect(isStudentAffiliation(value)).toBe(false);
    }
  });

  it("returns false for the legacy non-student strings the backfill may not map", () => {
    for (const value of ["Yale Staff", "Staff", "Other Yale Affiliation", "Other", "I am NOT a Yale Affiliate"]) {
      expect(isStudentAffiliation(value)).toBe(false);
    }
  });

  it("returns false for blank, null, and undefined", () => {
    expect(isStudentAffiliation(null)).toBe(false);
    expect(isStudentAffiliation(undefined)).toBe(false);
    expect(isStudentAffiliation("")).toBe(false);
  });

  it("returns true for an unrecognized school-like value rather than assuming staff", () => {
    expect(isStudentAffiliation("Medical Student")).toBe(true);
  });
});

describe("isMedicalSchoolAffiliation", () => {
  it("is true for exactly the two YSM tracks", () => {
    expect(isMedicalSchoolAffiliation("ysm_md")).toBe(true);
    expect(isMedicalSchoolAffiliation("ysm_pa")).toBe(true);
  });

  it("is false for every other canonical option", () => {
    for (const option of YALE_AFFILIATIONS) {
      if (option.value === "ysm_md" || option.value === "ysm_pa") continue;
      expect(isMedicalSchoolAffiliation(option.value)).toBe(false);
    }
  });

  it("is false for null and blank", () => {
    expect(isMedicalSchoolAffiliation(null)).toBe(false);
    expect(isMedicalSchoolAffiliation("")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/platform/affiliation.test.ts`
Expected: FAIL, cannot resolve `./affiliation`.

- [ ] **Step 3: Write the implementation**

Create `src/platform/affiliation.ts`:

```ts
/**
 * Canonical Yale affiliation vocabulary (platform-level).
 *
 * Person.yaleAffiliation is written by four surfaces (the /apply recruitment
 * form, the onboarding contract, /my-info, and the admin person editor) and
 * read by four more (EHS training applicability, the YNHH Epic access PDF,
 * email campaign audiences, and the Airtable import). Before this module each
 * side kept its own hand-written list, so the column accumulated three
 * vocabularies and every reader pattern-matched the mixture by hand.
 *
 * This lives in platform, not in modules/recruitment where the list started,
 * because eslint forbids modules from importing each other (my-info and admin
 * may not reach into recruitment) and forbids platform from importing module
 * code at all. src/platform/people.ts sits here for the same reason.
 *
 * Values are stable machine keys; labels are user-facing.
 */

export type AffiliationOption = { value: string; label: string };

export const YALE_AFFILIATIONS: AffiliationOption[] = [
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

const LABEL_BY_VALUE = new Map(YALE_AFFILIATIONS.map((o) => [o.value, o.label]));

/**
 * Legacy strings to canonical keys, keyed by lower(trim(...)).
 *
 * Covers every vocabulary that has reached the column: the canonical labels
 * themselves (what Airtable stores and what every form displays), and the eight
 * human strings the retired /my-info dropdown wrote. Keep in sync with the
 * mapping in prisma/migrations/*_normalize_yale_affiliation.
 *
 * "Yale School of Medicine" is deliberately mapped to ysm_md: in the /my-info
 * vocabulary it meant MD, because that list carried "Physician Associate
 * Program" as a separate option.
 */
const LEGACY_TO_CANONICAL = new Map<string, string>([
  ["yale college", "yale_college"],
  ["yale school of medicine", "ysm_md"],
  ["yale school of nursing", "ysn"],
  ["yale school of public health", "ysph"],
  ["physician associate program", "ysm_pa"],
  ["graduate school", "gsas"],
  ["staff", "staff"],
  ["other", "other_yale"],
  ...YALE_AFFILIATIONS.map((o) => [o.label.toLowerCase(), o.value] as [string, string]),
]);

/** Canonical label, the raw string when unrecognized, "" when blank or null. */
export function affiliationLabel(value: string | null | undefined): string {
  const raw = (value ?? "").trim();
  if (raw === "") return "";
  return LABEL_BY_VALUE.get(raw) ?? raw;
}

/**
 * The canonical options, prepending an unrecognized stored value as its own
 * option so that re-saving a form can never silently erase it. The backfill
 * deliberately leaves values it cannot map, and this is what keeps them
 * selectable instead of snapping to the first option in the list.
 */
export function affiliationOptionsWith(current: string | null | undefined): AffiliationOption[] {
  const raw = (current ?? "").trim();
  if (raw === "" || LABEL_BY_VALUE.has(raw)) return YALE_AFFILIATIONS;
  return [{ value: raw, label: raw }, ...YALE_AFFILIATIONS];
}

/**
 * Legacy string to canonical key. Null, undefined, and whitespace-only inputs
 * return null. Any other string with no mapping is returned trimmed but
 * otherwise unchanged, never nulled.
 */
export function normalizeAffiliation(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return null;
  if (LABEL_BY_VALUE.has(trimmed)) return trimmed;
  return LEGACY_TO_CANONICAL.get(trimmed.toLowerCase()) ?? trimmed;
}

/**
 * Non-students: Yale staff, an unspecified "other" Yale affiliation, people who
 * are not Yale-affiliated at all, and blank. Every named Yale school is a
 * student.
 *
 * Matched case-insensitively against the canonical keys AND the legacy lowercase
 * forms, because the backfill deliberately leaves values it cannot map and
 * misclassifying one assigns the wrong bloodborne-pathogen training.
 */
const NON_STUDENT_AFFILIATIONS = new Set([
  "staff",
  "other_yale",
  "non_yale",
  "yale staff",
  "other yale affiliation",
  "other",
  "i am not a yale affiliate",
]);

export function isStudentAffiliation(value: string | null | undefined): boolean {
  const a = (value ?? "").trim().toLowerCase();
  return a !== "" && !NON_STUDENT_AFFILIATIONS.has(a);
}

const MEDICAL_SCHOOL_AFFILIATIONS = new Set(["ysm_md", "ysm_pa"]);

/** Both YSM tracks. Used by the YNHH Epic PDF to check its "Med Student" box. */
export function isMedicalSchoolAffiliation(value: string | null | undefined): boolean {
  return MEDICAL_SCHOOL_AFFILIATIONS.has((value ?? "").trim().toLowerCase());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/platform/affiliation.test.ts`
Expected: PASS, all suites green.

- [ ] **Step 5: Commit**

```bash
git add src/platform/affiliation.ts src/platform/affiliation.test.ts
git commit -m "feat(affiliation): add canonical Yale affiliation module in platform"
```

---

### Task 2: Point the two existing owners at the canonical module

Removes the duplicate definitions. The EHS behavior change (`non_yale` becomes a non-student) lands here because it is what the shim swap causes.

**Files:**
- Modify: `src/platform/ehs/engine/applicability.ts:14-30`
- Modify: `src/modules/recruitment/templates/content/options.ts:1-19`
- Test: `src/platform/ehs/engine/applicability.test.ts` (the `isStudentAffiliation` describe block)

**Interfaces:**
- Consumes: `YALE_AFFILIATIONS`, `isStudentAffiliation` from Task 1.
- Produces: `YALE_AFFILIATION: TemplateOption[]` still exported from `recruitment/templates/content/options.ts`; `isStudentAffiliation` still exported from `ehs/engine/applicability.ts`. No caller of either changes.

- [ ] **Step 1: Update the failing test**

In `src/platform/ehs/engine/applicability.test.ts`, replace the whole `describe("isStudentAffiliation", ...)` block with:

```ts
describe("isStudentAffiliation", () => {
  it("returns true for Yale school affiliations", () => {
    expect(isStudentAffiliation("Yale College")).toBe(true);
    expect(isStudentAffiliation("Yale School of Nursing (YSN)")).toBe(true);
    expect(isStudentAffiliation("ysm_md")).toBe(true);
  });

  it("returns false for every non-student affiliation vocabulary the forms produce", () => {
    // Canonical option values, the human labels, and the retired /my-info
    // dropdown values, all case-insensitive.
    for (const a of ["Yale Staff", "staff", "Staff", "Other Yale Affiliation", "other_yale", "Other"]) {
      expect(isStudentAffiliation(a)).toBe(false);
    }
  });

  it("treats a self-declared non-Yale-affiliate as a non-student (clinical BBP, not student BBP)", () => {
    expect(isStudentAffiliation("non_yale")).toBe(false);
    expect(isStudentAffiliation("I am NOT a Yale Affiliate")).toBe(false);
  });

  it("returns false for blank or null affiliation", () => {
    expect(isStudentAffiliation(null)).toBe(false);
    expect(isStudentAffiliation("")).toBe(false);
    expect(isStudentAffiliation(undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/platform/ehs/engine/applicability.test.ts`
Expected: FAIL on the new non-Yale-affiliate case, `expected true to be false`, because the current local `NON_STUDENT_AFFILIATIONS` set does not contain `non_yale`.

- [ ] **Step 3: Replace both definitions with re-exports**

In `src/platform/ehs/engine/applicability.ts`, delete the doc comment at lines 14-21, the `NON_STUDENT_AFFILIATIONS` const at lines 22-25, and the `isStudentAffiliation` function at lines 27-30. Replace all of it with:

```ts
// isStudentAffiliation moved to @/platform/affiliation: student-ness is a
// property of the affiliation, not of EHS, and /my-info, the admin person
// editor, and the YNHH Epic PDF all need the same answer. Re-exported here so
// the callers in ehs/services keep their existing import.
export { isStudentAffiliation } from "@/platform/affiliation";
```

In `src/modules/recruitment/templates/content/options.ts`, replace the `YALE_AFFILIATION` const at lines 5-19 with:

```ts
// The canonical list moved to @/platform/affiliation so that /my-info and the
// admin person editor can render the same options: eslint forbids one module
// from importing another, which is exactly why /my-info grew a parallel
// hand-written copy. Re-exported here, typed as TemplateOption[] (structurally
// identical to AffiliationOption), so recruitment's importers are unchanged.
export const YALE_AFFILIATION: TemplateOption[] = YALE_AFFILIATIONS;
```

and add to the imports at the top of that file:

```ts
import { YALE_AFFILIATIONS } from "@/platform/affiliation";
```

- [ ] **Step 4: Run the full suite plus typecheck and lint**

Run: `npx vitest run && npm run typecheck && npx eslint src e2e`
Expected: PASS on all three. The full suite matters here: this is the step where a missed importer of either symbol surfaces. Lint must be clean because this is the task that could introduce a boundary violation.

- [ ] **Step 5: Commit**

```bash
git add src/platform/ehs/engine/applicability.ts src/platform/ehs/engine/applicability.test.ts src/modules/recruitment/templates/content/options.ts
git commit -m "refactor(affiliation): single-source the option list and student check

Non-Yale affiliates now classify as non-students, so they are assigned
clinical BBP rather than student BBP."
```

---

### Task 3: Every form renders the same dropdown

**Files:**
- Modify: `src/modules/my-info/components/my-info-form.tsx:19-28,53-56,106-118`
- Modify: `src/modules/admin/components/person-form.tsx:96-102`
- Modify: `src/modules/recruitment/contract/system-fields.ts:56-64`

**Interfaces:**
- Consumes: `affiliationOptionsWith` from Task 1.
- Produces: nothing new. `/my-info`, `/get-started/profile`, `/admin/people/new`, and `/admin/people/[id]` all submit a canonical key under the form field name `yaleAffiliation`. Their server actions already coerce `(formData.get("yaleAffiliation") as string) || null` and are unchanged.

- [ ] **Step 1: Update MyInfoForm**

In `src/modules/my-info/components/my-info-form.tsx`:

Delete the `YALE_AFFILIATIONS` const at lines 19-28. Add to the imports:

```ts
import { affiliationOptionsWith } from "@/platform/affiliation";
```

Replace the `currentAffiliation` / `isKnownAffiliation` pair at lines 53-56 with:

```ts
  const currentAffiliation = person.yaleAffiliation ?? "";
  const affiliationOptions = affiliationOptionsWith(currentAffiliation);
```

Replace the `<Field label="Yale Affiliation">` block at lines 106-118 with:

```tsx
          <Field label="Yale Affiliation">
            <Select name="yaleAffiliation" defaultValue={currentAffiliation}>
              <option value="">Not set</option>
              {affiliationOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </Field>
```

The inline "prepend the stored value if we do not recognize it" conditional that used to sit at lines 114-116 is gone: `affiliationOptionsWith` does it, so all four forms share one implementation of that rule.

- [ ] **Step 2: Update PersonForm**

In `src/modules/admin/components/person-form.tsx`, add to the imports:

```ts
import { Select } from "@/platform/ui/select";
import { affiliationOptionsWith } from "@/platform/affiliation";
```

Replace the free-text field at lines 96-102 with:

```tsx
          <Field label="Yale Affiliation">
            <Select name="yaleAffiliation" defaultValue={person?.yaleAffiliation ?? ""}>
              <option value="">Not set</option>
              {affiliationOptionsWith(person?.yaleAffiliation).map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </Field>
```

- [ ] **Step 3: Delegate the contract's prepend rule**

In `src/modules/recruitment/contract/system-fields.ts`, add to the imports:

```ts
import { affiliationOptionsWith } from "@/platform/affiliation";
```

and insert this branch into `systemFieldOptions` immediately after the `if (!options) return [];` line:

```ts
  // yaleAffiliation's prepend rule lives in @/platform/affiliation, which
  // /my-info and the admin person editor also render from. Delegate so the four
  // forms cannot diverge on how an unrecognized stored value is preserved.
  if (key === "yaleAffiliation") return affiliationOptionsWith(currentValue);
```

- [ ] **Step 4: Verify**

Run: `npx vitest run && npm run typecheck && npx eslint src e2e`
Expected: PASS. `system-fields.test.ts` and `review.test.ts` exercise `systemFieldOptions`; they should stay green because `affiliationOptionsWith` reproduces the same behavior for affiliation.

- [ ] **Step 5: Commit**

```bash
git add src/modules/my-info/components/my-info-form.tsx src/modules/admin/components/person-form.tsx src/modules/recruitment/contract/system-fields.ts
git commit -m "feat(affiliation): render the canonical dropdown on my-info and admin

The admin person editor was a free-text box and /my-info had its own
eight-option list; both now render the same 13 canonical options."
```

---

### Task 4: YNHH Epic PDF routing

Fixes the live bug where a canonical key matches neither the `"Yale Staff"` literal nor `includes("med")`, so a med student is stamped Student > Other with the literal text `ysm_md`.

**Files:**
- Modify: `src/modules/support/services/itcm-pdf.ts:258-275`
- Test: `src/modules/support/services/itcm-pdf.test.ts`

**Interfaces:**
- Consumes: `isMedicalSchoolAffiliation`, `isStudentAffiliation`, `affiliationLabel` from Task 1.
- Produces: nothing new. `generatePdf` keeps its existing signature.

- [ ] **Step 1: Write the failing test**

Add to `src/modules/support/services/itcm-pdf.test.ts`. The file already has module-level `person`, `authorizer`, and `templateBytes` consts plus `loadOutput()`; this adds a parameterized sibling of `loadOutput()` and asserts with the same `getCheckBox(...).isChecked()` / `getTextField(...).getText()` calls the existing tests use:

```ts
describe("Section IV affiliation routing", () => {
  async function loadWithAffiliation(yaleAffiliation: string) {
    const bytes = await generatePdf({
      requestType: "new_individual",
      authorizer,
      person: { ...person, yaleAffiliation },
      endDate: "10/15/2026",
      mirrorPerson: { name: "Mirror Person", epicId: "MIR456" },
      templateBytes,
    });
    return (await PDFDocument.load(bytes)).getForm();
  }

  it("checks Med Student for both YSM tracks", async () => {
    for (const value of ["ysm_md", "ysm_pa"]) {
      const form = await loadWithAffiliation(value);
      expect(form.getCheckBox("Check Box45").isChecked(), value).toBe(true);
      expect(form.getCheckBox("Check Box48").isChecked(), value).toBe(false);
      expect(form.getCheckBox("Check Box21").isChecked(), value).toBe(false);
    }
  });

  it("checks the Student Other row for a non-medical Yale school and writes the label", async () => {
    const form = await loadWithAffiliation("ysn");
    expect(form.getCheckBox("Check Box48").isChecked()).toBe(true);
    expect(form.getCheckBox("Check Box45").isChecked()).toBe(false);
    expect(form.getTextField("Text30").getText()).toBe("Yale School of Nursing (YSN)");
  });

  it("checks the Job Title Other row for staff and non-affiliates and writes the label", async () => {
    for (const [value, label] of [
      ["staff", "Yale Staff"],
      ["other_yale", "Other Yale Affiliation"],
      ["non_yale", "I am NOT a Yale Affiliate"],
    ]) {
      const form = await loadWithAffiliation(value);
      expect(form.getCheckBox("Check Box21").isChecked(), value).toBe(true);
      expect(form.getCheckBox("Check Box48").isChecked(), value).toBe(false);
      expect(form.getTextField("Text29").getText()).toBe(label);
    }
  });

  it("writes an unmapped legacy value through verbatim rather than blanking the row", async () => {
    const form = await loadWithAffiliation("Medical Student");
    expect(form.getCheckBox("Check Box48").isChecked()).toBe(true);
    expect(form.getTextField("Text30").getText()).toBe("Medical Student");
  });

  it("checks no affiliation row when the affiliation is blank", async () => {
    const form = await loadWithAffiliation("");
    for (const box of ["Check Box45", "Check Box48", "Check Box21"]) {
      expect(form.getCheckBox(box).isChecked(), box).toBe(false);
    }
  });
});
```

The module-level `person` fixture uses `yaleAffiliation: "Yale College"`, which routes to `Check Box48` with `Text30` set to `"Yale College"` both before and after this change, so no existing test in the file changes. The `CHECKED` array around line 163 is a positive subset check that does not list any affiliation box, so it is unaffected too.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/support/services/itcm-pdf.test.ts`
Expected: FAIL. `ysm_md` currently falls through both branches to `Check Box48` with `Text30` set to the raw key `ysm_md`.

- [ ] **Step 3: Rewrite the routing**

In `src/modules/support/services/itcm-pdf.ts`, add to the imports:

```ts
import { affiliationLabel, isMedicalSchoolAffiliation, isStudentAffiliation } from "@/platform/affiliation";
```

Replace the whole `if (!isBulk) { ... }` block at lines 258-275 with:

```ts
  if (!isBulk) {
    // Routed off the canonical vocabulary rather than by matching label text.
    // Text fields get the user-facing label, never the machine key, so YNHH
    // reads "Yale School of Nursing (YSN)" and not "ysn". A value the canonical
    // list does not know is written through verbatim by affiliationLabel.
    const affiliation = person?.yaleAffiliation ?? "";
    if (isMedicalSchoolAffiliation(affiliation)) {
      // Student row: Med Student. Covers both YSM tracks (MD/MD-PhD and PA).
      checkBox(form, "Check Box45");
    } else if (isStudentAffiliation(affiliation)) {
      // Student row: "Other", with the affiliation label.
      checkBox(form, "Check Box48");
      fillText(form, "Text30", affiliationLabel(affiliation));
    } else if (affiliation) {
      // Not a student: Job Title row "Other", with the affiliation label.
      checkBox(form, "Check Box21");
      fillText(form, "Text29", affiliationLabel(affiliation));
    }
  }
```

Note the branch order flipped: staff and non-affiliates are no longer tested first, they fall through to the final `else if (affiliation)` because `isStudentAffiliation` returns false for them. A blank affiliation still checks nothing.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/support/services/itcm-pdf.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/support/services/itcm-pdf.ts src/modules/support/services/itcm-pdf.test.ts
git commit -m "fix(epic-pdf): route Section IV off canonical affiliation keys

A person stored as ysm_md matched neither the \"Yale Staff\" literal nor the
includes(\"med\") fallback, so the YNHH form was stamped Student > Other with
the raw key as its text."
```

---

### Task 5: Email audience becomes an enum picker

**Files:**
- Modify: `src/platform/email/audience/person-fields.ts:143`
- Test: `src/platform/email/audience/person-fields.test.ts`

**Interfaces:**
- Consumes: `YALE_AFFILIATIONS` from Task 1.
- Produces: the `yaleAffiliation` entry in `PERSON_FIELDS` changes `kind` from `"text"` to `"enum"` and its `operators` from the seven `TEXT_OPERATORS` to `["eq"]`. The campaign builder reads `kind` and `options` off `PersonFieldView` to pick its editor, so no UI change is needed.

- [ ] **Step 1: Write the failing test**

Add to `src/platform/email/audience/person-fields.test.ts`. The file already imports `PERSON_FIELDS`, `PERSON_FIELD_VIEWS`, and `personFieldWhere`, and defines `const ctx = { activeTermId: "term1" }` at the top; reuse all of them rather than calling `field.compile` directly, since every existing test goes through `personFieldWhere`:

```ts
describe("yaleAffiliation audience field", () => {
  it("offers the 13 canonical options as an enum", () => {
    const view = PERSON_FIELD_VIEWS.find((f) => f.key === "yaleAffiliation")!;
    expect(view.kind).toBe("enum");
    expect(view.options).toHaveLength(13);
    expect(view.options?.map((o) => o.value)).toContain("ysm_md");
  });

  it("yaleAffiliation -> direct equality on the canonical key", () => {
    expect(personFieldWhere({ field: "yaleAffiliation", op: "eq", value: "ysm_md" }, ctx))
      .toEqual({ yaleAffiliation: "ysm_md" });
  });

  it("yaleAffiliation -> an empty value matches nobody (never everyone)", () => {
    expect(personFieldWhere({ field: "yaleAffiliation", op: "eq", value: "" }, ctx)).toEqual({ id: { in: [] } });
    expect(personFieldWhere({ field: "yaleAffiliation", op: "eq", value: "   " }, ctx)).toEqual({ id: { in: [] } });
    expect(personFieldWhere({ field: "yaleAffiliation", op: "eq" }, ctx)).toEqual({ id: { in: [] } });
  });
});
```

The existing `"exposes a whitelist with options"` test asserts the full ordered key list and already contains `"yaleAffiliation"` in position 6. Keep the replacement entry in that same position in `PERSON_FIELDS` so that test stays green.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/platform/email/audience/person-fields.test.ts`
Expected: FAIL, `expected 'text' to be 'enum'`.

- [ ] **Step 3: Replace the text field with an enum field**

In `src/platform/email/audience/person-fields.ts`, add to the imports:

```ts
import { YALE_AFFILIATIONS } from "@/platform/affiliation";
```

Replace line 143, `textField("yaleAffiliation", "Yale affiliation", "yaleAffiliation"),`, with:

```ts
  {
    key: "yaleAffiliation",
    label: "Yale affiliation",
    group: "Identity",
    kind: "enum",
    operators: ["eq"],
    options: YALE_AFFILIATIONS,
    // The column now holds stable machine keys, so free-text matching would mean
    // ops typing "ysm_md" blind. An empty value must never compile to
    // `{ yaleAffiliation: undefined }`, which Prisma drops, matching EVERYONE:
    // same match-nobody safety the status field uses.
    compile: (cond) => {
      const value = typeof cond.value === "string" ? cond.value.trim() : "";
      if (value === "") return MATCH_NOBODY;
      return { yaleAffiliation: value };
    },
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/platform/email/audience/person-fields.test.ts && npm run typecheck`
Expected: PASS both.

- [ ] **Step 5: Commit**

```bash
git add src/platform/email/audience/person-fields.ts src/platform/email/audience/person-fields.test.ts
git commit -m "feat(email): make the Yale affiliation audience filter an enum picker"
```

---

### Task 6: Normalize Airtable imports

Without this the backfill is undone by the next import run.

**Files:**
- Modify: `src/platform/airtable/import/transforms.ts:70`
- Test: `src/platform/airtable/import/transforms.test.ts`

**Interfaces:**
- Consumes: `normalizeAffiliation` from Task 1.
- Produces: nothing new. `PersonImport.yaleAffiliation` keeps its `string | null` type.

- [ ] **Step 1: Write the failing test**

**First, fix the existing assertion this change breaks.** The `"maps fields, trims, and lowercases netId and contactEmail"` test at the top of `src/platform/airtable/import/transforms.test.ts` feeds `[F.yaleAffiliation]: "Yale College"` and asserts the whole returned object with `toEqual`, including `yaleAffiliation: "Yale College"`. Normalizing turns that into `"yale_college"`. Change that one line in the expected object to:

```ts
      yaleAffiliation: "yale_college",
```

The file has no record-building helper: tests construct raw objects against `const F = ALL_PEOPLE_FIELDS`. Follow that. Add:

```ts
describe("transformPeople yaleAffiliation", () => {
  it("normalizes an Airtable label to its canonical key", () => {
    const { people } = transformPeople([
      { id: "recAff1", fields: { [F.name]: "Ada Lovelace", [F.yaleAffiliation]: "Yale Staff" } },
    ]);
    expect(people[0].yaleAffiliation).toBe("staff");
  });

  it("passes an unrecognized value through verbatim rather than dropping it", () => {
    const { people } = transformPeople([
      { id: "recAff2", fields: { [F.name]: "Grace Hopper", [F.yaleAffiliation]: "Visiting Scholar" } },
    ]);
    expect(people[0].yaleAffiliation).toBe("Visiting Scholar");
  });

  it("keeps a missing affiliation null", () => {
    const { people } = transformPeople([{ id: "recAff3", fields: { [F.name]: "Alan Turing" } }]);
    expect(people[0].yaleAffiliation).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/platform/airtable/import/transforms.test.ts`
Expected: FAIL on two tests, the new `expected 'Yale Staff' to be 'staff'` and the edited existing one now expecting `yale_college`.

- [ ] **Step 3: Apply the normalizer**

In `src/platform/airtable/import/transforms.ts`, add to the imports:

```ts
import { normalizeAffiliation } from "@/platform/affiliation";
```

and change line 70 from:

```ts
      yaleAffiliation: str(f[ALL_PEOPLE_FIELDS.yaleAffiliation]),
```

to:

```ts
      // Normalized on the way in so an import cannot re-pollute the column with a
      // fourth vocabulary after the backfill. Unrecognized values pass through.
      yaleAffiliation: normalizeAffiliation(str(f[ALL_PEOPLE_FIELDS.yaleAffiliation])),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/platform/airtable/import/transforms.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/platform/airtable/import/transforms.ts src/platform/airtable/import/transforms.test.ts
git commit -m "fix(import): normalize imported Yale affiliations to canonical keys"
```

---

### Task 7: Backfill migration

**BLOCKED until the prod distinct-value query has been run and its output is in hand.** The four vocabularies found in code are a floor, not a ceiling: admins have had a free-text box on `/admin/people/*`, so only the real distribution shows what the mapping must cover. Do not guess this task.

**Files:**
- Create: `prisma/migrations/<timestamp>_normalize_yale_affiliation/migration.sql`
- Modify (only if the query reveals legacy strings not already covered): `src/platform/affiliation.ts` (`LEGACY_TO_CANONICAL`) and `src/platform/affiliation.test.ts`

**Interfaces:**
- Consumes: the mapping in `LEGACY_TO_CANONICAL` from Task 1, which the SQL must mirror exactly.
- Produces: a `Person.yaleAffiliation` column holding canonical keys wherever a mapping existed.

- [ ] **Step 1: Get the real distribution**

Run against prod, read-only:

```sql
SELECT "yaleAffiliation", count(*)
FROM "Person"
WHERE "yaleAffiliation" IS NOT NULL
GROUP BY 1
ORDER BY 2 DESC;
```

For each returned value: it is either already canonical (no action), covered by `LEGACY_TO_CANONICAL` (no action), mappable but missing from that map (add it to both the map and the SQL below, plus a case in `affiliation.test.ts`), or genuinely unmappable (leave it, it survives via `affiliationOptionsWith`). Write the resulting decision list into the commit message so the choices are recoverable.

- [ ] **Step 2: Scaffold the migration**

Run: `npx prisma migrate dev --create-only --name normalize_yale_affiliation`

**Then open the generated `migration.sql` and delete everything Prisma put in it.** This is a data-only migration with no schema change, so the file must end up containing only the `UPDATE` below. `prisma migrate dev` folds any pre-existing schema drift into a newly created migration, and shipping that drift would apply unrelated schema changes to prod.

- [ ] **Step 3: Write the SQL**

Replace the contents of the generated `migration.sql` with:

```sql
-- Collapse Person.yaleAffiliation onto the canonical vocabulary.
--
-- The column was written by four surfaces that did not agree: the recruitment
-- form and onboarding contract wrote machine keys, the old /my-info dropdown
-- wrote eight human strings, Airtable imports wrote the canonical labels, and
-- the admin person editor was a free-text box. Readers (EHS training
-- applicability, the YNHH Epic PDF, email audiences) each pattern-matched the
-- mixture by hand.
--
-- Mirrors LEGACY_TO_CANONICAL in src/platform/affiliation.ts. Keep the two in
-- sync. Idempotent: values already canonical are not listed and are untouched,
-- and the IS DISTINCT FROM guard makes a re-run a no-op.
--
-- Deliberately partial. A value with no mapping here is LEFT ALONE, never
-- nulled: affiliationOptionsWith prepends it as its own option so the forms
-- keep it selectable, affiliationLabel renders it verbatim, and
-- isStudentAffiliation still classifies the legacy non-student strings.
--
-- "Yale School of Medicine" maps to ysm_md because in the /my-info vocabulary
-- it meant MD: that list carried "Physician Associate Program" separately.

UPDATE "Person" SET "yaleAffiliation" = m.canonical
FROM (VALUES
  -- The retired /my-info dropdown's eight options.
  ('yale college',                 'yale_college'),
  ('yale school of medicine',      'ysm_md'),
  ('yale school of nursing',       'ysn'),
  ('yale school of public health', 'ysph'),
  ('physician associate program',  'ysm_pa'),
  ('graduate school',              'gsas'),
  ('staff',                        'staff'),
  ('other',                        'other_yale'),
  -- The canonical labels, as stored by Airtable and displayed by every form.
  ('yale school of divinity',                          'divinity'),
  ('yale graduate school of arts and sciences (gsas)', 'gsas'),
  ('yale jackson school of global affairs',            'jackson'),
  ('yale law school (yls)',                            'law'),
  ('yale school of management (som)',                  'som'),
  ('yale school of medicine (ysm), md or md/phd',      'ysm_md'),
  ('yale school of medicine (ysm), pa',                'ysm_pa'),
  ('yale school of nursing (ysn)',                     'ysn'),
  ('yale school of public health (ysph)',              'ysph'),
  ('yale staff',                                       'staff'),
  ('other yale affiliation',                           'other_yale'),
  ('i am not a yale affiliate',                        'non_yale')
) AS m(legacy, canonical)
WHERE lower(btrim("Person"."yaleAffiliation")) = m.legacy
  AND "Person"."yaleAffiliation" IS DISTINCT FROM m.canonical;
```

Add any rows Step 1 turned up, to both this list and `LEGACY_TO_CANONICAL`.

- [ ] **Step 4: Apply and verify against the local test database**

Run:

```bash
npm run db:up
npm run test:prepare
```

Expected: `prisma migrate deploy` applies the new migration with no error.

Then confirm idempotence by running `npm run test:prepare` a second time and checking it reports no pending migrations. Never point any of this at Neon.

- [ ] **Step 5: Run the full suite, typecheck, and whole-repo lint**

Run: `npx vitest run && npm run typecheck && npm run lint`
Expected: PASS on all three. This is the last task, so `npm run lint` runs over the whole repo here rather than the narrower `npx eslint src e2e`.

- [ ] **Step 6: Commit**

```bash
git add prisma/migrations src/platform/affiliation.ts src/platform/affiliation.test.ts
git commit -m "feat(affiliation): backfill stored affiliations onto canonical keys"
```

---

## Deployment note

Per `docs/DEPLOY.md` conventions and the Neon preview-branch behavior: preview deploys share the production database, so a branch that is behind a migration crashes with P2021. Run `npx prisma migrate status` against the target before deploying, and merge `main` into this branch before opening the PR so the migration ordering is correct.
