# Apply Portal + Application Wizard Revamp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the public application portal and the application form into a polished, guided "application portal": a one-section-per-step wizard with progress rail, per-step validation, and a review step, plus a signed-in home with a discreet per-application status tracker, all in an elevated-institutional visual style.

**Architecture:** A client wizard shell wraps the existing uncontrolled `<form>`: all currently visible section steps stay mounted (so autosave, file upload, prefill, and the final `FormData` submit are untouched) and only the current step is shown. Pure helpers (`deriveSteps`, `missingRequiredKeys`, `trackerStageFor`, `formatFieldValue`) carry the logic and are unit-tested; components and the orchestrator are verified by typecheck, lint, and the existing Playwright e2e flow. Server actions, the visibility engine, and the status data source are unchanged.

**Tech Stack:** Next.js 16.2.7 (App Router), React 19, TypeScript, Tailwind v4 (design tokens), Vitest (node env), Playwright.

## Global Constraints

- Tokens only (`brand`, `brand-fg`, `brand-faint`, `surface`, `canvas`, `foreground`, `muted-foreground`, `border`, `border-subtle`, `border-strong`, `critical`, `success`); style light and dark; no hardcoded colors.
- No `tailwind-merge`; do not override primitive base classes by passing conflicting utilities.
- ESLint `no-restricted-syntax` bans styled raw `<button|input|select|textarea className>`: use a `@/platform/ui` primitive, or if a raw element is genuinely required for custom layout, add `// eslint-disable-next-line no-restricted-syntax -- <reason>` on the line directly above, keeping `className` on the same line as the tag. `<a>`/`<div>`/`<span>` are not restricted.
- No new dependencies. Motion is CSS transitions only and must respect `prefers-reduced-motion`.
- Copy contains no em-dashes (use commas, periods, or parentheses). This is ESLint-enforced.
- Do not change server actions (`submitPublicApplication`, `saveDraftAction`, `uploadDraftFileAction`), the visibility engine, draft/renewal services, auth, or `getApplicantStatus`.
- Unit tests live in `src/**/*.test.ts`, run under Vitest's `node` environment, and must be pure (no Prisma, no DB). There is no React testing environment; components are verified by `npm run typecheck` + `npm run lint` + the Playwright e2e flow.
- After every task: `npm run typecheck` and `npm run lint` must pass before committing.

---

## File Structure

New:
- `src/modules/recruitment/services/portal-tracker.ts` — pure `trackerStageFor(state)` mapping. Owns: how a status maps to tracker nodes.
- `src/modules/recruitment/services/portal-tracker.test.ts` — its tests.
- `src/app/apply/[slug]/wizard-steps.ts` — pure `deriveSteps`, `stepIndexForKeys`, and the shared `WizardField`/`WizardSection`/`WizardStep` types. Owns: step derivation.
- `src/app/apply/[slug]/wizard-steps.test.ts` — its tests.
- `src/app/apply/[slug]/wizard-validation.ts` — pure `missingRequiredKeys`, `isValuePresent`. Owns: per-step required-field checks.
- `src/app/apply/[slug]/wizard-validation.test.ts` — its tests.
- `src/app/apply/[slug]/wizard-progress.tsx` — presentational step rail (desktop) + compact header (mobile).
- `src/app/apply/[slug]/wizard-review.tsx` — presentational review summary + pure `formatFieldValue` + `ReviewGroup` type.
- `src/app/apply/[slug]/wizard-review.test.ts` — tests for `formatFieldValue`.
- `src/app/apply/[slug]/apply-wizard.tsx` — the client orchestrator (replaces `apply-form.tsx`).
- `src/app/apply/application-tracker.tsx` — presentational discreet tracker.
- `src/app/apply/status-card.tsx` — one application's card (tracker or draft variant).

Modified:
- `src/app/apply/portal-shell.tsx` — add `width?: "prose" | "wide"`.
- `src/app/apply/[slug]/page.tsx` — render `ApplyWizard` inside `PortalShell width="wide"`.
- `src/app/apply/page.tsx` — signed-in home refactor (hero + status cards + open list).
- `e2e/recruitment.spec.ts` — walk the wizard (Continue, Review, Submit).

Deleted:
- `src/app/apply/[slug]/apply-form.tsx`.

---

## Task 1: Tracker stage mapping (pure)

**Files:**
- Create: `src/modules/recruitment/services/portal-tracker.ts`
- Test: `src/modules/recruitment/services/portal-tracker.test.ts`

**Interfaces:**
- Consumes: `ApplicantStatusView["state"]` from `./portal-status`.
- Produces:
  - `type TrackerNodeStatus = "done" | "current" | "upcoming"`
  - `type TrackerNodeKey = "submitted" | "in_review" | "interview" | "decision"`
  - `type TrackerNode = { key: TrackerNodeKey; label: string; status: TrackerNodeStatus }`
  - `type TrackerStage = { showTracker: boolean; nodes: TrackerNode[]; terminal: "accepted" | "waitlisted" | "not_selected" | null }`
  - `function trackerStageFor(state: ApplicantStatusView["state"]): TrackerStage`

- [ ] **Step 1: Write the failing test**

Create `src/modules/recruitment/services/portal-tracker.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { trackerStageFor } from "./portal-tracker";

const statusOf = (nodeStatuses: string[]) => nodeStatuses.join(",");

describe("trackerStageFor", () => {
  it("DRAFT hides the tracker", () => {
    const s = trackerStageFor("DRAFT");
    expect(s.showTracker).toBe(false);
    expect(s.terminal).toBeNull();
  });

  it("SUBMITTED marks Submitted done and In review current", () => {
    const s = trackerStageFor("SUBMITTED");
    expect(s.showTracker).toBe(true);
    expect(s.nodes.map((n) => n.key)).toEqual(["submitted", "in_review", "interview", "decision"]);
    expect(statusOf(s.nodes.map((n) => n.status))).toBe("done,current,upcoming,upcoming");
    expect(s.terminal).toBeNull();
  });

  it("INTERVIEW marks Interview current", () => {
    const s = trackerStageFor("INTERVIEW");
    expect(statusOf(s.nodes.map((n) => n.status))).toBe("done,done,current,upcoming");
  });

  it("ACCEPTED completes all nodes and flags accepted", () => {
    const s = trackerStageFor("ACCEPTED");
    expect(statusOf(s.nodes.map((n) => n.status))).toBe("done,done,done,done");
    expect(s.terminal).toBe("accepted");
  });

  it("ONBOARDING completes all nodes and flags accepted", () => {
    const s = trackerStageFor("ONBOARDING");
    expect(statusOf(s.nodes.map((n) => n.status))).toBe("done,done,done,done");
    expect(s.terminal).toBe("accepted");
  });

  it("WAITLISTED completes through Interview, Decision current, flagged waitlisted", () => {
    const s = trackerStageFor("WAITLISTED");
    expect(statusOf(s.nodes.map((n) => n.status))).toBe("done,done,done,current");
    expect(s.terminal).toBe("waitlisted");
  });

  it("NOT_SELECTED marks Decision done and flags not_selected", () => {
    const s = trackerStageFor("NOT_SELECTED");
    expect(statusOf(s.nodes.map((n) => n.status))).toBe("done,done,done,done");
    expect(s.terminal).toBe("not_selected");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/recruitment/services/portal-tracker.test.ts`
Expected: FAIL, "Cannot find module './portal-tracker'".

- [ ] **Step 3: Write minimal implementation**

Create `src/modules/recruitment/services/portal-tracker.ts`:

```ts
import type { ApplicantStatusView } from "./portal-status";

export type TrackerNodeStatus = "done" | "current" | "upcoming";
export type TrackerNodeKey = "submitted" | "in_review" | "interview" | "decision";
export type TrackerNode = { key: TrackerNodeKey; label: string; status: TrackerNodeStatus };
export type TrackerStage = {
  showTracker: boolean;
  nodes: TrackerNode[];
  terminal: "accepted" | "waitlisted" | "not_selected" | null;
};

const LABELS: Record<TrackerNodeKey, string> = {
  submitted: "Submitted",
  in_review: "In review",
  interview: "Interview",
  decision: "Decision",
};
const ORDER: TrackerNodeKey[] = ["submitted", "in_review", "interview", "decision"];

// currentIndex = which node is highlighted; every earlier node is done. A null
// currentIndex with allDone marks a terminal all-complete state.
function build(statuses: TrackerNodeStatus[], terminal: TrackerStage["terminal"]): TrackerStage {
  return {
    showTracker: true,
    nodes: ORDER.map((key, i) => ({ key, label: LABELS[key], status: statuses[i] })),
    terminal,
  };
}

export function trackerStageFor(state: ApplicantStatusView["state"]): TrackerStage {
  switch (state) {
    case "DRAFT":
      return { showTracker: false, nodes: [], terminal: null };
    case "SUBMITTED":
      return build(["done", "current", "upcoming", "upcoming"], null);
    case "INTERVIEW":
      return build(["done", "done", "current", "upcoming"], null);
    case "WAITLISTED":
      return build(["done", "done", "done", "current"], "waitlisted");
    case "NOT_SELECTED":
      return build(["done", "done", "done", "done"], "not_selected");
    case "ACCEPTED":
    case "ONBOARDING":
      return build(["done", "done", "done", "done"], "accepted");
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/recruitment/services/portal-tracker.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npm run typecheck && npm run lint
git add src/modules/recruitment/services/portal-tracker.ts src/modules/recruitment/services/portal-tracker.test.ts
git commit -m "feat(apply): pure tracker-stage mapping for portal status"
```

---

## Task 2: Wizard step derivation (pure)

**Files:**
- Create: `src/app/apply/[slug]/wizard-steps.ts`
- Test: `src/app/apply/[slug]/wizard-steps.test.ts`

**Interfaces:**
- Consumes: `isSectionVisible`, `ApplicantType` from `@/modules/recruitment/engine/visibility`.
- Produces:
  - `type WizardField = { key: string; label: string; helpText: string | null; type: string; required: boolean; options: { value: string; label: string }[] | null; validation: Record<string, unknown> | null }`
  - `type WizardSection = { id: string; title: string; description: string | null; appliesTo: "NEW" | "RENEWAL" | "BOTH"; departmentCode: string | null; fields: WizardField[] }`
  - `type WizardStep = { kind: "intro"; id: "intro"; title: string } | { kind: "section"; id: string; title: string; section: WizardSection } | { kind: "review"; id: "review"; title: string }`
  - `function deriveSteps(input: { sections: WizardSection[]; acceptsRenewals: boolean; applicantType: ApplicantType; selectedDepartmentCodes: string[] }): WizardStep[]`
  - `function stepIndexForKeys(steps: WizardStep[], keys: string[]): number | null`

- [ ] **Step 1: Write the failing test**

Create `src/app/apply/[slug]/wizard-steps.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { deriveSteps, stepIndexForKeys, type WizardSection } from "./wizard-steps";

function section(overrides: Partial<WizardSection> & { id: string; title: string }): WizardSection {
  return {
    description: null,
    appliesTo: "BOTH",
    departmentCode: null,
    fields: [],
    ...overrides,
  };
}

const base = section({ id: "s-about", title: "About you" });
const renewalOnly = section({ id: "s-ren", title: "Renewal", appliesTo: "RENEWAL" });
const deptSupp = section({ id: "s-srhd", title: "SRHD questions", departmentCode: "SRHD" });

describe("deriveSteps", () => {
  it("prepends an intro step only when renewals are accepted", () => {
    const withIntro = deriveSteps({ sections: [base], acceptsRenewals: true, applicantType: "NEW", selectedDepartmentCodes: [] });
    expect(withIntro.map((s) => s.kind)).toEqual(["intro", "section", "review"]);

    const noIntro = deriveSteps({ sections: [base], acceptsRenewals: false, applicantType: "NEW", selectedDepartmentCodes: [] });
    expect(noIntro.map((s) => s.kind)).toEqual(["section", "review"]);
  });

  it("hides RENEWAL-only sections for a NEW applicant", () => {
    const steps = deriveSteps({ sections: [base, renewalOnly], acceptsRenewals: false, applicantType: "NEW", selectedDepartmentCodes: [] });
    expect(steps.filter((s) => s.kind === "section").map((s) => s.id)).toEqual(["s-about"]);
  });

  it("shows a department supplement only when its department is selected", () => {
    const without = deriveSteps({ sections: [base, deptSupp], acceptsRenewals: false, applicantType: "NEW", selectedDepartmentCodes: [] });
    expect(without.filter((s) => s.kind === "section").map((s) => s.id)).toEqual(["s-about"]);

    const withDept = deriveSteps({ sections: [base, deptSupp], acceptsRenewals: false, applicantType: "NEW", selectedDepartmentCodes: ["SRHD"] });
    expect(withDept.filter((s) => s.kind === "section").map((s) => s.id)).toEqual(["s-about", "s-srhd"]);
  });

  it("always ends with review", () => {
    const steps = deriveSteps({ sections: [], acceptsRenewals: false, applicantType: "NEW", selectedDepartmentCodes: [] });
    expect(steps[steps.length - 1].kind).toBe("review");
  });
});

describe("stepIndexForKeys", () => {
  it("returns the earliest section step containing any key", () => {
    const steps = deriveSteps({
      sections: [
        section({ id: "a", title: "A", fields: [{ key: "first_name", label: "First", helpText: null, type: "TEXT", required: true, options: null, validation: null }] }),
        section({ id: "b", title: "B", fields: [{ key: "why", label: "Why", helpText: null, type: "LONG_TEXT", required: true, options: null, validation: null }] }),
      ],
      acceptsRenewals: false,
      applicantType: "NEW",
      selectedDepartmentCodes: [],
    });
    // steps: [section a (0), section b (1), review (2)]
    expect(stepIndexForKeys(steps, ["why"])).toBe(1);
    expect(stepIndexForKeys(steps, ["first_name", "why"])).toBe(0);
    expect(stepIndexForKeys(steps, ["nope"])).toBeNull();
    expect(stepIndexForKeys(steps, [])).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/apply/\[slug\]/wizard-steps.test.ts`
Expected: FAIL, "Cannot find module './wizard-steps'".

- [ ] **Step 3: Write minimal implementation**

Create `src/app/apply/[slug]/wizard-steps.ts`:

```ts
import { isSectionVisible, type ApplicantType } from "@/modules/recruitment/engine/visibility";

export type WizardField = {
  key: string;
  label: string;
  helpText: string | null;
  type: string;
  required: boolean;
  options: { value: string; label: string }[] | null;
  validation: Record<string, unknown> | null;
};

export type WizardSection = {
  id: string;
  title: string;
  description: string | null;
  appliesTo: "NEW" | "RENEWAL" | "BOTH";
  departmentCode: string | null;
  fields: WizardField[];
};

export type WizardStep =
  | { kind: "intro"; id: "intro"; title: string }
  | { kind: "section"; id: string; title: string; section: WizardSection }
  | { kind: "review"; id: "review"; title: string };

export function deriveSteps(input: {
  sections: WizardSection[];
  acceptsRenewals: boolean;
  applicantType: ApplicantType;
  selectedDepartmentCodes: string[];
}): WizardStep[] {
  const steps: WizardStep[] = [];
  if (input.acceptsRenewals) steps.push({ kind: "intro", id: "intro", title: "Getting started" });
  for (const s of input.sections) {
    const visible = isSectionVisible(
      { id: s.id, appliesTo: s.appliesTo, departmentCode: s.departmentCode },
      { applicantType: input.applicantType, selectedDepartmentCodes: input.selectedDepartmentCodes },
    );
    if (visible) steps.push({ kind: "section", id: s.id, title: s.title, section: s });
  }
  steps.push({ kind: "review", id: "review", title: "Review & submit" });
  return steps;
}

export function stepIndexForKeys(steps: WizardStep[], keys: string[]): number | null {
  if (keys.length === 0) return null;
  const set = new Set(keys);
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i];
    if (st.kind === "section" && st.section.fields.some((f) => set.has(f.key))) return i;
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/apply/\[slug\]/wizard-steps.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npm run typecheck && npm run lint
git add "src/app/apply/[slug]/wizard-steps.ts" "src/app/apply/[slug]/wizard-steps.test.ts"
git commit -m "feat(apply): pure wizard step derivation"
```

---

## Task 3: Per-step required-field validation (pure)

**Files:**
- Create: `src/app/apply/[slug]/wizard-validation.ts`
- Test: `src/app/apply/[slug]/wizard-validation.test.ts`

**Interfaces:**
- Consumes: `WizardField` from `./wizard-steps`.
- Produces:
  - `function isValuePresent(value: unknown): boolean`
  - `function missingRequiredKeys(fields: Pick<WizardField, "key" | "required" | "type">[], values: Record<string, unknown>): string[]`
- Note: the orchestrator builds `values` from `FormData` (string or string[]), and pre-sets a truthy string for a FILE key when a file is attached.

- [ ] **Step 1: Write the failing test**

Create `src/app/apply/[slug]/wizard-validation.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isValuePresent, missingRequiredKeys } from "./wizard-validation";

describe("isValuePresent", () => {
  it("treats non-empty strings as present and blank/whitespace as absent", () => {
    expect(isValuePresent("Ann")).toBe(true);
    expect(isValuePresent("")).toBe(false);
    expect(isValuePresent("   ")).toBe(false);
  });
  it("treats an array with any non-empty entry as present", () => {
    expect(isValuePresent(["", "b"])).toBe(true);
    expect(isValuePresent(["", ""])).toBe(false);
    expect(isValuePresent([])).toBe(false);
  });
  it("treats undefined as absent and a checked checkbox ('on') as present", () => {
    expect(isValuePresent(undefined)).toBe(false);
    expect(isValuePresent("on")).toBe(true);
  });
});

describe("missingRequiredKeys", () => {
  const fields = [
    { key: "first_name", required: true, type: "TEXT" },
    { key: "middle", required: false, type: "TEXT" },
    { key: "resume", required: true, type: "FILE" },
  ];
  it("returns only required keys whose value is absent", () => {
    expect(missingRequiredKeys(fields, { first_name: "Ann" })).toEqual(["resume"]);
  });
  it("counts an attached file (truthy string) as present", () => {
    expect(missingRequiredKeys(fields, { first_name: "Ann", resume: "attached" })).toEqual([]);
  });
  it("returns [] when there are no required fields", () => {
    expect(missingRequiredKeys([{ key: "x", required: false, type: "TEXT" }], {})).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/apply/\[slug\]/wizard-validation.test.ts`
Expected: FAIL, "Cannot find module './wizard-validation'".

- [ ] **Step 3: Write minimal implementation**

Create `src/app/apply/[slug]/wizard-validation.ts`:

```ts
import type { WizardField } from "./wizard-steps";

/** A form value counts as present if it is a non-blank string, an array with at
 *  least one non-blank string, or boolean true. Used for required-field checks. */
export function isValuePresent(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.some((v) => typeof v === "string" && v.trim() !== "");
  return false;
}

export function missingRequiredKeys(
  fields: Pick<WizardField, "key" | "required" | "type">[],
  values: Record<string, unknown>,
): string[] {
  return fields.filter((f) => f.required && !isValuePresent(values[f.key])).map((f) => f.key);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/apply/\[slug\]/wizard-validation.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npm run typecheck && npm run lint
git add "src/app/apply/[slug]/wizard-validation.ts" "src/app/apply/[slug]/wizard-validation.test.ts"
git commit -m "feat(apply): pure per-step required-field validation"
```

---

## Task 4: Review value formatter (pure) + review component

**Files:**
- Create: `src/app/apply/[slug]/wizard-review.tsx`
- Test: `src/app/apply/[slug]/wizard-review.test.ts`

**Interfaces:**
- Consumes: `WizardField` from `./wizard-steps`; `Card`, `Alert` primitives.
- Produces:
  - `type ReviewRow = { label: string; value: string }`
  - `type ReviewGroup = { stepIndex: number; title: string; rows: ReviewRow[] }`
  - `function formatFieldValue(f: WizardField, values: Record<string, unknown>, subcommittees: { id: string; name: string }[]): string`
  - `function WizardReview({ groups, onEdit }: { groups: ReviewGroup[]; onEdit: (stepIndex: number) => void }): JSX.Element`

Note: the test imports only `formatFieldValue` (a pure function). The component is not unit-tested (no React env); it is verified by typecheck/lint and the e2e flow. Importing a `.tsx` module from a `.test.ts` is fine because the test references only the pure export and Vitest transpiles JSX.

- [ ] **Step 1: Write the failing test**

Create `src/app/apply/[slug]/wizard-review.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatFieldValue } from "./wizard-review";
import type { WizardField } from "./wizard-steps";

const field = (o: Partial<WizardField> & { key: string; type: string }): WizardField => ({
  label: o.key, helpText: null, required: false, options: null, validation: null, ...o,
});

describe("formatFieldValue", () => {
  it("returns text values as-is and empty for missing", () => {
    expect(formatFieldValue(field({ key: "a", type: "TEXT" }), { a: "Ann" }, [])).toBe("Ann");
    expect(formatFieldValue(field({ key: "a", type: "TEXT" }), {}, [])).toBe("");
  });
  it("maps a single-select value to its option label", () => {
    const f = field({ key: "role", type: "SINGLE_SELECT", options: [{ value: "cv", label: "Clinical volunteer" }] });
    expect(formatFieldValue(f, { role: "cv" }, [])).toBe("Clinical volunteer");
  });
  it("joins multi-select labels with commas", () => {
    const f = field({ key: "days", type: "MULTI_SELECT", options: [{ value: "a", label: "Feb 7" }, { value: "b", label: "Feb 21" }] });
    expect(formatFieldValue(f, { days: ["a", "b"] }, [])).toBe("Feb 7, Feb 21");
  });
  it("renders a checkbox as Yes/No", () => {
    expect(formatFieldValue(field({ key: "ok", type: "CHECKBOX" }), { ok: "on" }, [])).toBe("Yes");
    expect(formatFieldValue(field({ key: "ok", type: "CHECKBOX" }), {}, [])).toBe("No");
  });
  it("resolves subcommittee ranks to names in order", () => {
    const f = field({ key: "rank", type: "SUBCOMMITTEE_RANK" });
    const subs = [{ id: "s1", name: "Outreach" }, { id: "s2", name: "Labs" }];
    expect(formatFieldValue(f, { rank: ["s2", "", "s1"] }, subs)).toBe("Labs › Outreach");
  });
  it("shows the file name or Not attached for FILE", () => {
    expect(formatFieldValue(field({ key: "cv", type: "FILE" }), { cv: "cv.pdf" }, [])).toBe("cv.pdf");
    expect(formatFieldValue(field({ key: "cv", type: "FILE" }), {}, [])).toBe("Not attached");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/apply/\[slug\]/wizard-review.test.ts`
Expected: FAIL, "Cannot find module './wizard-review'".

- [ ] **Step 3: Write minimal implementation**

Create `src/app/apply/[slug]/wizard-review.tsx`:

```tsx
import { Card } from "@/platform/ui/card";
import { Alert } from "@/platform/ui/alert";
import type { WizardField } from "./wizard-steps";

export type ReviewRow = { label: string; value: string };
export type ReviewGroup = { stepIndex: number; title: string; rows: ReviewRow[] };

/** Human-readable display of a submitted answer, by field type. Values come from
 *  the form's FormData (string or string[]); FILE values are a pre-resolved file
 *  name string. Empty answers return "" (the component shows "Not provided"). */
export function formatFieldValue(
  f: WizardField,
  values: Record<string, unknown>,
  subcommittees: { id: string; name: string }[],
): string {
  const raw = values[f.key];
  const list = Array.isArray(raw)
    ? raw.filter((v): v is string => typeof v === "string")
    : typeof raw === "string"
      ? [raw]
      : [];
  const one = typeof raw === "string" ? raw : "";
  switch (f.type) {
    case "CHECKBOX":
      return raw === "on" || raw === true ? "Yes" : "No";
    case "SINGLE_SELECT":
    case "DEPARTMENT_CHOICE":
      return f.options?.find((o) => o.value === one)?.label ?? one;
    case "MULTI_SELECT":
      return list.map((v) => f.options?.find((o) => o.value === v)?.label ?? v).join(", ");
    case "SUBCOMMITTEE_RANK":
      return list
        .filter((v) => v !== "")
        .map((id) => subcommittees.find((s) => s.id === id)?.name ?? id)
        .join(" › ");
    case "FILE":
      return one || "Not attached";
    default:
      return one;
  }
}

export function WizardReview({
  groups,
  onEdit,
}: {
  groups: ReviewGroup[];
  onEdit: (stepIndex: number) => void;
}) {
  return (
    <div className="space-y-3">
      {groups.map((g) => (
        <Card key={g.title} className="space-y-3">
          <div className="flex items-center justify-between gap-3 border-b border-border-subtle pb-3">
            <h3 className="text-sm font-semibold text-foreground">{g.title}</h3>
            <button
              type="button"
              onClick={() => onEdit(g.stepIndex)}
              className="rounded-md px-2 py-1 text-xs font-medium text-brand-fg hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
            >
              Edit
            </button>
          </div>
          <dl className="space-y-2">
            {g.rows.map((r) => (
              <div key={r.label} className="grid gap-1 sm:grid-cols-[180px_1fr] sm:gap-4">
                <dt className="text-xs text-muted-foreground">{r.label}</dt>
                <dd className="text-sm text-foreground">
                  {r.value || <span className="italic text-subtle-foreground">Not provided</span>}
                </dd>
              </div>
            ))}
          </dl>
        </Card>
      ))}
      <Alert tone="info">
        Please confirm the information above is accurate. After you submit, you will get a confirmation
        email and can track your application here in the portal.
      </Alert>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/apply/\[slug\]/wizard-review.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npm run typecheck && npm run lint
git add "src/app/apply/[slug]/wizard-review.tsx" "src/app/apply/[slug]/wizard-review.test.ts"
git commit -m "feat(apply): review value formatter and review summary component"
```

---

## Task 5: Wizard progress rail component

**Files:**
- Create: `src/app/apply/[slug]/wizard-progress.tsx`

**Interfaces:**
- Produces: `function WizardProgress({ steps, current, onJump }: { steps: { id: string; title: string }[]; current: number; onJump: (index: number) => void }): JSX.Element`
- Behavior: renders a desktop vertical rail (`hidden md:block`) and a mobile compact header (`md:hidden`). Steps before `current` are completed and clickable (`onJump`); `current` is highlighted; later steps are inert.

- [ ] **Step 1: Create the component**

Create `src/app/apply/[slug]/wizard-progress.tsx`:

```tsx
import { Check } from "lucide-react";
import { cx } from "@/platform/ui/cx";

export function WizardProgress({
  steps,
  current,
  onJump,
}: {
  steps: { id: string; title: string }[];
  current: number;
  onJump: (index: number) => void;
}) {
  const total = steps.length;
  return (
    <>
      {/* Mobile: compact header */}
      <div className="md:hidden">
        <p className="text-xs font-semibold uppercase tracking-wider text-brand-fg">
          Step {current + 1} of {total}
        </p>
        <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-border">
          <div
            className="h-full rounded-full bg-brand transition-[width] duration-300 motion-reduce:transition-none"
            style={{ width: `${((current + 1) / total) * 100}%` }}
          />
        </div>
      </div>

      {/* Desktop: vertical rail */}
      <nav aria-label="Application progress" className="hidden md:block">
        <ol className="relative space-y-1">
          {steps.map((s, i) => {
            const done = i < current;
            const isCurrent = i === current;
            const label = (
              <span className="flex items-center gap-3 py-1.5">
                <span
                  className={cx(
                    "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 text-xs font-semibold",
                    done && "border-brand bg-brand text-white",
                    isCurrent && "border-brand bg-surface text-brand-fg ring-4 ring-brand-faint",
                    !done && !isCurrent && "border-border bg-surface text-muted-foreground",
                  )}
                >
                  {done ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : i + 1}
                </span>
                <span
                  className={cx(
                    "text-sm",
                    isCurrent ? "font-semibold text-foreground" : done ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {s.title}
                </span>
              </span>
            );
            return (
              <li key={s.id}>
                {done ? (
                  // A full-width rail step needs custom layout, so it is a raw button, not
                  // the Button primitive. The repo's no-restricted-syntax rule flags styled
                  // raw controls; keep className on the button line and disable it there.
                  // eslint-disable-next-line no-restricted-syntax -- rail step needs custom full-width layout, not a Button primitive
                  <button type="button" onClick={() => onJump(i)} className="w-full rounded-lg text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">
                    {label}
                  </button>
                ) : (
                  <div aria-current={isCurrent ? "step" : undefined}>{label}</div>
                )}
              </li>
            );
          })}
        </ol>
      </nav>
    </>
  );
}
```

- [ ] **Step 2: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS (no unused imports; `Check` is used).

- [ ] **Step 3: Commit**

```bash
git add "src/app/apply/[slug]/wizard-progress.tsx"
git commit -m "feat(apply): wizard progress rail and mobile header"
```

---

## Task 6: PortalShell width variant

**Files:**
- Modify: `src/app/apply/portal-shell.tsx`

**Interfaces:**
- Produces: `PortalShell` now accepts `width?: "prose" | "wide"` (default `"prose"`). `prose` = `max-w-2xl`; `wide` = `max-w-4xl`.

- [ ] **Step 1: Add the prop**

In `src/app/apply/portal-shell.tsx`, change the component signature and the `<main>` line.

Replace the props destructure:

```tsx
export async function PortalShell({
  children,
  action,
  className,
  width = "prose",
}: {
  children: ReactNode;
  /** Optional trailing masthead control (e.g. a sign-out button). */
  action?: ReactNode;
  className?: string;
  /** Content column width. `prose` (default) is the reading column; `wide` fits the two-column wizard. */
  width?: "prose" | "wide";
}) {
```

Replace the `<main>` element:

```tsx
      <main
        className={cx(
          "mx-auto w-full grow px-6 py-10",
          width === "wide" ? "max-w-4xl" : "max-w-2xl",
          className,
        )}
      >
        {children}
      </main>
```

- [ ] **Step 2: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/app/apply/portal-shell.tsx
git commit -m "feat(apply): PortalShell width variant for the wizard layout"
```

---

## Task 7: Application orchestrator (`apply-wizard.tsx`) + page wiring

**Files:**
- Create: `src/app/apply/[slug]/apply-wizard.tsx`
- Modify: `src/app/apply/[slug]/page.tsx`
- Delete: `src/app/apply/[slug]/apply-form.tsx`

**Interfaces:**
- Consumes: `deriveSteps`, `stepIndexForKeys`, `WizardSection`, `WizardStep` from `./wizard-steps`; `missingRequiredKeys` from `./wizard-validation`; `WizardReview`, `formatFieldValue`, `ReviewGroup` from `./wizard-review`; `WizardProgress` from `./wizard-progress`; server actions from `./actions` and `./draft-actions`; `FieldPreview`, `prefillString`, `isSectionVisible`, `ApplicantType`, `applicantTypeLabel`; primitives `Alert`, `Button`, `buttonClasses`, `Select`, `Field`, `ReadonlyField`, `Card`, `FormSection`, `RadioGroup`, `Radio`.
- Produces: `function ApplyWizard(props: ApplyWizardProps): JSX.Element` with the SAME prop shape the current `ApplyForm` receives, except `def.sections` is typed as `WizardSection[]`.

- [ ] **Step 1: Create the orchestrator**

Create `src/app/apply/[slug]/apply-wizard.tsx`:

```tsx
"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { submitPublicApplication, type SubmitResult } from "./actions";
import { saveDraftAction, uploadDraftFileAction } from "./draft-actions";
import { deriveSteps, stepIndexForKeys, type WizardSection, type WizardStep } from "./wizard-steps";
import { missingRequiredKeys } from "./wizard-validation";
import { WizardProgress } from "./wizard-progress";
import { WizardReview, formatFieldValue, type ReviewGroup } from "./wizard-review";
import { applicantTypeLabel, type ApplicantType } from "@/modules/recruitment/engine/visibility";
import { Alert } from "@/platform/ui/alert";
import { Button, buttonClasses } from "@/platform/ui/button";
import { Select } from "@/platform/ui/select";
import { Field, ReadonlyField } from "@/platform/ui/input";
import { Card } from "@/platform/ui/card";
import { FormSection } from "@/platform/ui/form";
import { RadioGroup, Radio } from "@/platform/ui/radio";
import { FieldPreview } from "@/modules/recruitment/components/field-preview";
import { prefillString } from "@/modules/recruitment/components/field-prefill";
import { cx } from "@/platform/ui/cx";
import { PortalNotice } from "../portal-notice";

type Def = {
  slug: string;
  title: string;
  track: "VOLUNTEER" | "DIRECTOR";
  acceptsRenewals: boolean;
  departments: string[];
  subcommittees: { id: string; name: string }[];
  sections: WizardSection[];
};
type Prefill = { values: Record<string, string>; lockedKeys: string[] };

export type ApplyWizardProps = {
  def: Def;
  signedIn?: boolean;
  signedInName?: string | null;
  eligible?: boolean;
  isReturning?: boolean;
  prefill?: Prefill;
  currentDepartments?: string[];
  initialApplicantType?: ApplicantType;
  initialAnswers?: Record<string, unknown>;
  initialApplicantTypeFromDraft?: ApplicantType;
  initialRenewalDepartment?: string | null;
};

export function ApplyWizard({
  def,
  signedIn = false,
  signedInName = null,
  eligible = false,
  isReturning = false,
  prefill,
  currentDepartments = [],
  initialApplicantType = "NEW",
  initialAnswers = {},
  initialApplicantTypeFromDraft,
  initialRenewalDepartment = null,
}: ApplyWizardProps) {
  const seedType = initialApplicantTypeFromDraft ?? initialApplicantType;
  const renewalUnavailable = seedType === "RENEWAL" && signedIn && !eligible;
  const transferUnavailable = seedType === "TRANSFER" && (!signedIn || !isReturning);
  const autoIneligible = renewalUnavailable || transferUnavailable;

  const [applicantType, setApplicantType] = useState<ApplicantType>(autoIneligible ? "NEW" : seedType);
  const [ineligibleNote, setIneligibleNote] = useState(autoIneligible);
  const [renewalDept, setRenewalDept] = useState<string>(() =>
    initialRenewalDepartment && currentDepartments.includes(initialRenewalDepartment)
      ? initialRenewalDepartment
      : currentDepartments[0] ?? "",
  );
  const [deptChoice, setDeptChoice] = useState<string>(() => {
    const key = def.sections.flatMap((s) => s.fields).find((f) => f.type === "DEPARTMENT_CHOICE")?.key;
    return key ? prefillString(prefill?.values[key] ?? initialAnswers[key]) : "";
  });

  const [result, setResult] = useState<SubmitResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [stepIndex, setStepIndex] = useState(0);
  const [editingReturn, setEditingReturn] = useState(false);
  const [reviewGroups, setReviewGroups] = useState<ReviewGroup[]>([]);

  const formRef = useRef<HTMLFormElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");

  const [fileStatus, setFileStatus] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(initialAnswers)) {
      if (v && typeof v === "object" && "fileName" in (v as object)) {
        out[k] = `Attached: ${(v as { fileName: string }).fileName}`;
      }
    }
    return out;
  });

  const lockedKeys = useMemo(() => new Set(prefill?.lockedKeys ?? []), [prefill]);
  const loginHref = `/login?callbackUrl=${encodeURIComponent(`/apply/${def.slug}?type=renewal`)}`;
  const renewalGate = applicantType === "RENEWAL" && !signedIn;
  const roleNoun = def.track === "DIRECTOR" ? "director" : "volunteer";

  const applicantOptions = [
    { value: "NEW" as const, label: "New applicant", desc: "First time applying", show: true },
    { value: "RENEWAL" as const, label: "Renewing in my current department", desc: `Continue as a ${roleNoun} in a department you are already in`, show: !signedIn || eligible },
    { value: "TRANSFER" as const, label: "Transferring to a new department", desc: `Return as a ${roleNoun} in a different department`, show: signedIn && isReturning },
  ].filter((o) => o.show);

  const selectedDepartmentCodes = useMemo(
    () => (applicantType === "RENEWAL" ? (renewalDept ? [renewalDept] : []) : deptChoice ? [deptChoice] : []),
    [applicantType, renewalDept, deptChoice],
  );

  const steps = useMemo<WizardStep[]>(
    () => deriveSteps({ sections: def.sections, acceptsRenewals: def.acceptsRenewals, applicantType, selectedDepartmentCodes }),
    [def.sections, def.acceptsRenewals, applicantType, selectedDepartmentCodes],
  );
  const reviewIndex = steps.length - 1;

  // Clamp the pointer if the visible-step set shrinks below the current index.
  useEffect(() => {
    if (stepIndex > reviewIndex) setStepIndex(reviewIndex);
  }, [stepIndex, reviewIndex]);

  const transferIntoCurrent =
    applicantType === "TRANSFER" && deptChoice !== "" && currentDepartments.includes(deptChoice);

  function chooseType(v: ApplicantType) {
    if (v === "RENEWAL" && signedIn && !eligible) { setApplicantType("NEW"); setIneligibleNote(true); return; }
    if (v === "TRANSFER" && signedIn && !isReturning) { setApplicantType("NEW"); setIneligibleNote(true); return; }
    setIneligibleNote(false);
    setApplicantType(v);
  }

  function scheduleSave() {
    if (renewalGate) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaveState("saving");
    saveTimer.current = setTimeout(async () => {
      const form = formRef.current;
      if (!form) return;
      const fd = new FormData(form);
      const answers: Record<string, unknown> = {};
      for (const [k, v] of fd.entries()) {
        if (k.startsWith("__") || v instanceof File) continue;
        answers[k] = answers[k] === undefined ? v : ([] as unknown[]).concat(answers[k], v);
      }
      const res = await saveDraftAction(def.slug, {
        answers,
        applicantType,
        renewalDepartment: applicantType === "RENEWAL" ? renewalDept : null,
      });
      setSaveState(res.ok ? "saved" : "idle");
    }, 800);
  }

  async function handleFileChange(fieldKey: string, e: React.ChangeEvent<HTMLInputElement> | React.SyntheticEvent) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    setFileStatus((prev) => ({ ...prev, [fieldKey]: "Uploading..." }));
    const fd = new FormData();
    fd.set("file", file);
    const res = await uploadDraftFileAction(def.slug, fieldKey, fd);
    setFileStatus((prev) => ({ ...prev, [fieldKey]: res.ok && res.fileName ? `Attached: ${res.fileName}` : res.error ?? "Upload failed." }));
  }

  // Serialize the form to a { key: string | string[] } map, marking attached
  // files with their file name so validation and review can see them.
  function collectValues(): Record<string, unknown> {
    const values: Record<string, unknown> = {};
    const form = formRef.current;
    if (form) {
      for (const [k, v] of new FormData(form).entries()) {
        if (k.startsWith("__") || v instanceof File) continue;
        values[k] = k in values ? ([] as unknown[]).concat(values[k], v) : v;
      }
    }
    for (const [k, label] of Object.entries(fileStatus)) {
      if (label.startsWith("Attached:")) values[k] = label.slice("Attached:".length).trim();
    }
    return values;
  }

  function buildGroups(values: Record<string, unknown>): ReviewGroup[] {
    const groups: ReviewGroup[] = [];
    steps.forEach((st, i) => {
      if (st.kind === "intro") {
        groups.push({
          stepIndex: i,
          title: "Getting started",
          rows: [
            { label: "Applying as", value: applicantTypeLabel(applicantType) },
            ...(applicantType === "RENEWAL" ? [{ label: "Department", value: renewalDept }] : []),
          ],
        });
      } else if (st.kind === "section") {
        groups.push({
          stepIndex: i,
          title: st.title,
          rows: st.section.fields.map((f) => ({ label: f.label, value: formatFieldValue(f, values, def.subcommittees) })),
        });
      }
    });
    return groups;
  }

  function focusHeading() {
    requestAnimationFrame(() => headingRef.current?.focus());
  }
  function goTo(index: number) {
    setStepIndex(index);
    focusHeading();
  }

  function handleNext() {
    const cur = steps[stepIndex];
    if (cur.kind === "intro" && renewalGate) return;
    if (cur.kind === "section") {
      if (transferIntoCurrent) return; // blocked; the alert is shown in-step
      const values = collectValues();
      const missing = missingRequiredKeys(cur.section.fields, values);
      if (missing.length) {
        setFieldErrors((p) => ({ ...p, ...Object.fromEntries(missing.map((k) => [k, "This field is required."])) }));
        requestAnimationFrame(() => (formRef.current?.elements.namedItem(missing[0]) as HTMLElement | null)?.focus?.());
        return;
      }
      setFieldErrors((p) => {
        const next = { ...p };
        for (const f of cur.section.fields) delete next[f.key];
        return next;
      });
    }
    const target = editingReturn ? reviewIndex : stepIndex + 1;
    setEditingReturn(false);
    if (target === reviewIndex) setReviewGroups(buildGroups(collectValues()));
    goTo(target);
  }

  function editStep(index: number) {
    setEditingReturn(true);
    goTo(index);
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (steps[stepIndex].kind !== "review") { handleNext(); return; }
    if (transferIntoCurrent) return;
    setSubmitting(true);
    const fd = new FormData(e.currentTarget);
    fd.set("__applicantType", applicantType);
    if (applicantType === "RENEWAL") fd.set("__renewalDepartment", renewalDept);
    const res = await submitPublicApplication(def.slug, fd);
    setSubmitting(false);
    if (!res.ok && res.fieldErrors) {
      setFieldErrors(res.fieldErrors);
      const idx = stepIndexForKeys(steps, Object.keys(res.fieldErrors));
      if (idx != null) goTo(idx);
    }
    setResult(res);
  }

  if (result?.ok) {
    return (
      <PortalNotice tone="success" titleAs="h2" title="Application received" className="mt-4">
        <p>Thanks, your application was received. Check your email for a confirmation.</p>
      </PortalNotice>
    );
  }

  const current = steps[stepIndex];
  const showContinue = !(current.kind === "intro" && renewalGate) && current.kind !== "review";

  return (
    <form ref={formRef} onSubmit={onSubmit} onChange={scheduleSave} className="grid gap-8 md:grid-cols-[220px_1fr]">
      <WizardProgress steps={steps.map((s) => ({ id: s.id, title: s.title }))} current={stepIndex} onJump={goTo} />

      <div className="min-w-0 space-y-5">
        <div>
          <p className="hidden text-xs font-semibold uppercase tracking-wider text-brand-fg md:block">Step {stepIndex + 1} of {steps.length}</p>
          <h2 ref={headingRef} tabIndex={-1} className="mt-1 text-xl font-bold tracking-tight text-foreground outline-none">
            {current.kind === "intro" ? "Getting started" : current.kind === "review" ? "Review your application" : current.title}
          </h2>
        </div>

        {result && !result.ok && <Alert tone="error">{result.message}</Alert>}
        {saveState !== "idle" && (
          <p className="text-xs text-muted-foreground" aria-live="polite">{saveState === "saving" ? "Saving…" : "Saved"}</p>
        )}

        {current.kind === "intro" && (
          <>
            <Card className="space-y-4">
              <FormSection title={`Are you a new or returning ${roleNoun}?`}>
                <RadioGroup>
                  {applicantOptions.map((opt) => (
                    <Radio
                      key={opt.value}
                      name="__type_ui"
                      value={opt.value}
                      checked={applicantType === opt.value}
                      onChange={() => chooseType(opt.value)}
                      label={
                        <>
                          <span className="font-medium">{opt.label}</span>
                          <span className="block text-xs text-muted-foreground">{opt.desc}</span>
                        </>
                      }
                    />
                  ))}
                </RadioGroup>

                {ineligibleNote && (
                  <Alert tone="warning">We do not see a current {roleNoun} membership for your account, so we have set you up as a new applicant. Your name and email are filled in below.</Alert>
                )}

                {applicantType === "RENEWAL" && signedIn && eligible && (
                  currentDepartments.length > 1 ? (
                    <Field label="Current department">
                      <Select value={renewalDept} onChange={(e) => setRenewalDept(e.target.value)} className="sm:max-w-xs">
                        {currentDepartments.map((d) => <option key={d} value={d}>{d}</option>)}
                      </Select>
                    </Field>
                  ) : (
                    <ReadonlyField label="Current department" value={renewalDept} hint="You are renewing in your current department. Contact us if this needs to change." />
                  )
                )}
              </FormSection>
            </Card>

            {renewalGate && (
              <Card className="space-y-3">
                <p className="text-sm text-foreground">Returning {roleNoun}s sign in with Yale so we can verify your renewal and fill in your information.</p>
                <a href={loginHref} className={buttonClasses("primary", "lg", "w-full sm:w-auto")}>Sign in with Yale</a>
              </Card>
            )}
          </>
        )}

        {current.kind === "section" && signedIn && (applicantType === "RENEWAL" ? eligible : applicantType === "TRANSFER" ? isReturning : false) && signedInName && (
          <p className="text-sm text-muted-foreground">Signed in as {signedInName}.</p>
        )}

        {/* All visible section steps stay mounted so their uncontrolled fields
            remain in the form (and in the final FormData); only the current one
            is shown. Intro/review controls are React state, so they render
            conditionally. */}
        {steps.map((st, i) =>
          st.kind === "section" ? (
            <div key={st.id} className={cx("space-y-4", i === stepIndex ? "block" : "hidden")}>
              <Card className="space-y-4">
                <FormSection description={st.section.description ?? undefined}>
                  {st.section.fields.map((f) =>
                    f.type === "FILE" ? (
                      <div key={f.key} onChange={(e) => { e.stopPropagation(); handleFileChange(f.key, e as unknown as React.ChangeEvent<HTMLInputElement>); }}>
                        <FieldPreview f={f} departments={def.departments} subcommittees={def.subcommittees}
                          fieldError={fieldErrors[f.key]} onDeptChoice={undefined}
                          prefill={prefill?.values[f.key] ?? initialAnswers[f.key]} locked={lockedKeys.has(f.key)} />
                        {fileStatus[f.key] && <p className="mt-1 text-xs text-muted-foreground" role="status" aria-live="polite">{fileStatus[f.key]}</p>}
                      </div>
                    ) : (
                      <FieldPreview key={f.key} f={f} departments={def.departments} subcommittees={def.subcommittees}
                        fieldError={fieldErrors[f.key]}
                        onDeptChoice={f.type === "DEPARTMENT_CHOICE" ? setDeptChoice : undefined}
                        prefill={prefill?.values[f.key] ?? initialAnswers[f.key]} locked={lockedKeys.has(f.key)} />
                    ),
                  )}
                </FormSection>
              </Card>
            </div>
          ) : null,
        )}

        {current.kind === "section" && transferIntoCurrent && (
          <Alert tone="warning">
            You are already a {roleNoun} in {deptChoice}. Choose &ldquo;Renewing in my current department&rdquo; to come back to it.
          </Alert>
        )}

        {current.kind === "review" && <WizardReview groups={reviewGroups} onEdit={editStep} />}

        <div className="flex items-center justify-between gap-3 border-t border-border-subtle pt-5">
          {stepIndex > 0 ? (
            <Button type="button" variant="outline" onClick={() => goTo(stepIndex - 1)}>Back</Button>
          ) : <span />}
          {showContinue && (
            <Button type="button" size="lg" onClick={handleNext} disabled={transferIntoCurrent}>Continue</Button>
          )}
          {current.kind === "review" && (
            <Button type="submit" size="lg" disabled={submitting || transferIntoCurrent}>{submitting ? "Submitting…" : "Submit application"}</Button>
          )}
        </div>
      </div>
    </form>
  );
}
```

- [ ] **Step 2: Wire the page to the wizard and delete the old form**

In `src/app/apply/[slug]/page.tsx`, replace the `ApplyForm` import and the render.

Change the import line:

```tsx
import { ApplyWizard } from "./apply-wizard";
```

Replace the final `return` block (the signed-in render) so the shell is wide and the wizard owns its header (remove the standalone `<h1>`):

```tsx
  return (
    <PortalShell width="wide">
      <ApplyWizard def={def} signedIn={signedIn} signedInName={signedInName} eligible={eligible} isReturning={isReturning} prefill={prefill} currentDepartments={currentDepartments} initialApplicantType={initialApplicantType} initialAnswers={draft?.answers ?? {}} initialApplicantTypeFromDraft={draft?.applicantType} initialRenewalDepartment={draft?.renewalDepartment ?? null} />
    </PortalShell>
  );
```

Then delete the old form:

```bash
git rm "src/app/apply/[slug]/apply-form.tsx"
```

- [ ] **Step 3: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS. If typecheck flags the `def.sections` type in `page.tsx`, the existing `def` object literal already matches `WizardSection[]` structurally (id, title, description, appliesTo, departmentCode, fields), so no cast is needed; fix any drift by aligning field names.

- [ ] **Step 4: Commit**

```bash
git add "src/app/apply/[slug]/apply-wizard.tsx" "src/app/apply/[slug]/page.tsx"
git commit -m "feat(apply): guided multi-step application wizard"
```

---

## Task 8: Discreet application tracker component

**Files:**
- Create: `src/app/apply/application-tracker.tsx`

**Interfaces:**
- Consumes: `trackerStageFor` from `@/modules/recruitment/services/portal-tracker`; `ApplicantStatusView` from `@/modules/recruitment/services/portal-status`.
- Produces: `function ApplicationTracker({ state }: { state: ApplicantStatusView["state"] }): JSX.Element | null` (returns `null` when the stage hides the tracker).

- [ ] **Step 1: Create the component**

Create `src/app/apply/application-tracker.tsx`:

```tsx
import { Check } from "lucide-react";
import { trackerStageFor } from "@/modules/recruitment/services/portal-tracker";
import type { ApplicantStatusView } from "@/modules/recruitment/services/portal-status";
import { cx } from "@/platform/ui/cx";

export function ApplicationTracker({ state }: { state: ApplicantStatusView["state"] }) {
  const stage = trackerStageFor(state);
  if (!stage.showTracker) return null;
  return (
    <ol className="mt-4 flex items-start">
      {stage.nodes.map((node, i) => (
        <li key={node.key} className="flex flex-1 flex-col items-center gap-2 text-center">
          <div className="flex w-full items-center">
            <span className={cx("h-0.5 flex-1", i === 0 ? "bg-transparent" : node.status === "upcoming" ? "bg-border" : "bg-brand")} />
            <span
              className={cx(
                "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2",
                node.status === "done" && "border-brand bg-brand text-white",
                node.status === "current" && "border-brand bg-surface ring-4 ring-brand-faint",
                node.status === "upcoming" && "border-border bg-surface",
              )}
            >
              {node.status === "done" && <Check className="h-3 w-3" aria-hidden="true" />}
              {node.status === "current" && <span className="h-2 w-2 rounded-full bg-brand" />}
            </span>
            <span className={cx("h-0.5 flex-1", i === stage.nodes.length - 1 ? "bg-transparent" : node.status === "done" ? "bg-brand" : "bg-border")} />
          </div>
          <span className={cx("text-[11px] leading-tight", node.status === "current" ? "font-semibold text-foreground" : "text-muted-foreground")}>
            {node.label}
          </span>
        </li>
      ))}
    </ol>
  );
}
```

- [ ] **Step 2: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/app/apply/application-tracker.tsx
git commit -m "feat(apply): discreet application status tracker"
```

---

## Task 9: Status card + landing refactor

**Files:**
- Create: `src/app/apply/status-card.tsx`
- Modify: `src/app/apply/page.tsx`

**Interfaces:**
- Consumes: `ApplicationTracker`; `ApplicantStatusView` type; `Card`, `cardClasses`, `Link`, `ArrowRight`, `cx`.
- Produces: `function StatusCard({ app }: { app: ApplicantStatusView }): JSX.Element`.

- [ ] **Step 1: Create the status card**

Create `src/app/apply/status-card.tsx`:

```tsx
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Card, cardClasses } from "@/platform/ui/card";
import { cx } from "@/platform/ui/cx";
import type { ApplicantStatusView } from "@/modules/recruitment/services/portal-status";
import { ApplicationTracker } from "./application-tracker";

export function StatusCard({ app }: { app: ApplicantStatusView }) {
  // Drafts get a compact "continue" row rather than a tracker.
  if (app.state === "DRAFT" && app.canContinue) {
    return (
      <Link
        href={`/apply/${app.slug}`}
        className={cx(cardClasses({ interactive: true }), "group flex items-center justify-between gap-4")}
      >
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold text-foreground">{app.cycleTitle}</span>
          <span className="block truncate text-xs text-muted-foreground">{app.detail ?? "Continue your application"}</span>
        </span>
        <span className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-brand-fg">
          Continue
          <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
        </span>
      </Link>
    );
  }

  return (
    <Card className="space-y-1">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-foreground">{app.cycleTitle}</p>
          {app.detail && <p className="mt-0.5 text-xs text-muted-foreground">{app.detail}</p>}
        </div>
        <span className="shrink-0 rounded-full bg-brand-faint px-3 py-1 text-xs font-semibold text-brand-fg">{app.headline}</span>
      </div>
      <ApplicationTracker state={app.state} />
    </Card>
  );
}
```

- [ ] **Step 2: Refactor the signed-in landing**

In `src/app/apply/page.tsx`, update the signed-in branch (the part after `const myApps = await getApplicantStatus(identity);`).

Add the import near the top:

```tsx
import { StatusCard } from "./status-card";
```

Replace the whole signed-in `return (<PortalShell ...>...</PortalShell>)` block with:

```tsx
  const actionRow = cx(cardClasses({ interactive: true, pad: false }), "group flex items-center justify-between gap-4 px-4 py-3.5");
  const actionCue = "inline-flex shrink-0 items-center gap-1 text-sm font-medium text-brand-fg";
  const arrow = <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />;
  const firstName = identity.email.split("@")[0].split(".")[0];

  return (
    <PortalShell
      action={
        <form action={applicantSignOutAction}>
          <Button type="submit" variant="ghost" size="sm">Sign out</Button>
        </form>
      }
    >
      <div className="mb-8">
        <h1 className="text-2xl font-bold capitalize tracking-tight text-foreground">Welcome back, {firstName}</h1>
        <p className="mt-1 text-sm text-muted-foreground">Track your applications, pick up a draft, or start something new.</p>
      </div>

      {myApps.length > 0 && (
        <section className="mb-10 space-y-3">
          <SectionHeader>Your applications</SectionHeader>
          <div className="space-y-3">
            {myApps.map((a) => <StatusCard key={a.slug} app={a} />)}
          </div>
        </section>
      )}

      <section className="space-y-3">
        <SectionHeader>Open applications</SectionHeader>
        {openCycles.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border px-5 py-8 text-center">
            <p className="text-sm font-medium text-foreground">No applications are open right now</p>
            <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">Recruitment opens each term. Check back soon for the next cycle.</p>
          </div>
        ) : (
          <ul className="space-y-2">
            {openCycles.map((c) => (
              <li key={c.publicSlug}>
                <Link href={`/apply/${c.publicSlug}`} className={actionRow}>
                  <span className="truncate text-sm font-medium text-foreground">{c.title}</span>
                  <span className={actionCue}>Start application{arrow}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </PortalShell>
  );
```

Note: keep the existing imports for `Card`/`cardClasses` only if still referenced. After this change, `Card` is no longer used directly in `page.tsx` (StatusCard owns it), so remove `Card` from the import if lint flags it as unused; keep `cardClasses`, `SectionHeader`, `ArrowRight`, `Button`, `Link`.

- [ ] **Step 3: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS. Resolve any unused-import lint errors by trimming the import list in `page.tsx`.

- [ ] **Step 4: Commit**

```bash
git add src/app/apply/status-card.tsx src/app/apply/page.tsx
git commit -m "feat(apply): portal landing with status tracker cards"
```

---

## Task 10: Update the e2e apply flow to walk the wizard

**Files:**
- Modify: `e2e/recruitment.spec.ts`

**Interfaces:**
- The apply portion must: fill the first section's fields, click Continue until the Review step, then click Submit application. The created cycle's default section is "Your information" with `first_name`, `last_name`, `email` fields; `acceptsRenewals` defaults such that filling those three and advancing reaches Review.

- [ ] **Step 1: Replace the public-apply block**

In `e2e/recruitment.spec.ts`, replace the lines that fill the form and submit (currently the `apply.fill(...)` calls through the `Submit application` click) with a wizard walk:

```ts
  await apply.goto(`/apply/${slug}`);

  // Walk the wizard. Only the current step is shown, so fill the identity fields
  // when their section is the visible step, advance with Continue, and submit on
  // the final Review step (Submit application shows only there).
  const submit = apply.getByRole("button", { name: "Submit application" });
  const firstName = apply.locator('input[name="first_name"]');
  for (let i = 0; i < 8; i++) {
    if (await submit.isVisible().catch(() => false)) break;
    if (await firstName.isVisible().catch(() => false)) {
      await firstName.fill("Ann");
      await apply.fill('input[name="last_name"]', "New");
      await apply.fill('input[name="email"]', applicantEmail);
    }
    await apply.getByRole("button", { name: "Continue" }).click();
  }
  await expect(submit).toBeVisible();
  await submit.click();

  await expect(apply.getByText(/your application was received/i)).toBeVisible();
  await pub.close();
```

- [ ] **Step 2: Run the e2e spec**

The e2e suite needs the app running against the test database (see project notes: `npm run test:prepare`, dev server, Playwright config). From a prepared environment:

Run: `npm run e2e -- recruitment.spec.ts`
Expected: PASS. The test builds a cycle, publishes, applies through the wizard (fill section, Continue to Review, Submit), and sees the applicant in the roster.

If the environment is not yet prepared for e2e, run `npm run typecheck && npm run lint` instead and defer the e2e run to the verification step; note in the commit that e2e was not run locally.

- [ ] **Step 3: Commit**

```bash
git add e2e/recruitment.spec.ts
git commit -m "test(apply): walk the application wizard in the recruitment e2e"
```

---

## Task 11: Sign-in card polish + full verification

**Files:**
- Modify: `src/app/apply/page.tsx` (logged-out branch only, light polish)

**Interfaces:**
- No API change. Only class/copy adjustments so the logged-out card matches the masthead/brand-rule system. Keep the existing e2e/login selectors (`input[name="email"]`, the Yale sign-in link, `SignInForm`) intact.

- [ ] **Step 1: Light polish**

In the logged-out branch of `src/app/apply/page.tsx`, keep structure and selectors; only ensure the heading/spacing tokens match the rest of the portal (the glass card, `HavenLogo`, `Sign in with Yale` button, and `SignInForm` stay). Make no change that alters `input[name="email"]` or the button text. If nothing needs adjusting, skip the edit and proceed to verification.

- [ ] **Step 2: Full unit run**

Run: `npm test`
Expected: the new pure tests pass alongside the suite. (DB-backed tests require a prepared test DB; if unavailable in this environment, run just the new files: `npx vitest run src/modules/recruitment/services/portal-tracker.test.ts "src/app/apply/[slug]/wizard-steps.test.ts" "src/app/apply/[slug]/wizard-validation.test.ts" "src/app/apply/[slug]/wizard-review.test.ts"` and confirm all pass.)

- [ ] **Step 3: Typecheck, lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 4: Manual verification (invoke the `verify` skill)**

Drive the real app (dev server) and confirm, in light and dark:
- Portal landing: welcome hero, draft "Continue" card, submitted-app status card with the discreet tracker, open-applications list.
- Wizard: intro step (when the cycle accepts renewals) with New/Renewal/Transfer; one section per step; progress rail (desktop) and compact header (mobile); Back/Continue; per-step required-field block; autosave "Saved"; file upload shows "Attached"; department-choice reveals a supplement step; Review groups with working Edit; Submit shows "Application received".
- Regression: resume a draft (values and applicant type restored), and a server validation error jumps to the right step.

- [ ] **Step 5: Commit any polish**

```bash
git add src/app/apply/page.tsx
git commit -m "polish(apply): align portal sign-in card with the masthead system"
```

---

## Self-Review Notes

- Spec coverage: wizard (Tasks 2,3,4,5,7), tracker (Tasks 1,8,9), landing (Task 9), PortalShell width (Task 6), a11y/tokens (Global Constraints + component tasks), tests (unit Tasks 1-4, e2e Task 10, manual Task 11). Sign-in polish (Task 11). All spec sections map to a task.
- No placeholders: every code step contains complete code; every command lists expected output.
- Type consistency: `WizardSection`/`WizardField`/`WizardStep` defined in Task 2 and reused verbatim in Tasks 4 and 7; `ReviewGroup` defined in Task 4 and consumed in Task 7; `trackerStageFor` shape from Task 1 consumed in Task 8; `ApplyWizard` prop shape mirrors the previous `ApplyForm` so `page.tsx` wiring in Task 7 stays valid.
