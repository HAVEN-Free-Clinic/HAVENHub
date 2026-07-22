# Onboarding Contract Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Preview form" button to the onboarding-contract builder that opens a modal rendering the contract exactly as an accepted applicant sees it, live from the editor's unsaved layout.

**Architecture:** Mirror the application form's `ApplyPreview`. A new client modal re-renders the contract from the editor's in-hand `layout` through the SAME `ContractField` renderer and a shared visibility helper the live `/onboard` form's logic is built from. Track + department controls simulate the authoritative context that gates conditional blocks; the Epic requirement is derived from the selected department + track. Nothing is saved.

**Tech Stack:** Next.js App Router (React 19 server + client components), TypeScript, Prisma, vitest (+ `react-dom/server` `renderToStaticMarkup` for component tests), Tailwind, shared `@/platform/ui` primitives.

## Global Constraints

- No em-dash character (U+2014) anywhere in `src/**` (`local/no-em-dash` lint rule). Use commas, colons, parentheses, or hyphens.
- No raw styled `<button>/<input>/<select>/<textarea>` with `className` in `src/app/**` or `src/modules/**`; use `@/platform/ui` primitives (`Button`, `Select`, `Checkbox`, `Input`/`Field`).
- Modules may not import other modules; platform may not import modules. App→app imports are allowed (the preview imports `ContractField` and the training formatters from the `onboard` route).
- Do NOT modify the live `/onboard` form (`onboard-form.tsx`, `contract-field.tsx`, `actions.ts`) or the submit path. The new visibility helper is additive.
- Use `new Date()` (never `Date.now()`) for the `todayIso` stamp (`react-hooks/purity`).
- Verify with `npm run typecheck` and full-repo `npm run lint`; run tests with `npx vitest run <path>`.

## File Structure

- **Create** `src/modules/recruitment/contract/visibility.ts` → add `visibleOnboardingBlocks` (additive export in the existing file).
- **Create** `src/app/(app)/recruitment/cycles/[id]/builder/contract/onboarding-preview.tsx` → `OnboardingPreviewBody` (statically testable) + `OnboardingPreview` (Modal wrapper) + the `PreviewDepartment` / `OnboardingPreviewContext` types.
- **Create** `src/app/(app)/recruitment/cycles/[id]/builder/contract/preview-context.ts` → `loadOnboardingPreviewContext` server loader.
- **Modify** `src/app/(app)/recruitment/cycles/[id]/builder/contract/contract-editor.tsx` → add `preview` prop, "Preview form" button, modal render.
- **Modify** `src/app/(app)/recruitment/cycles/[id]/builder/contract/page.tsx` and `src/app/(app)/admin/contract/page.tsx` → load and pass the preview context.
- **Tests:** `contract/visibility.test.ts` (extend), `builder/contract/onboarding-preview.test.tsx` (new), `builder/contract/preview-context.test.ts` (new, DB-backed).

---

### Task 1: Shared `visibleOnboardingBlocks` helper

**Files:**
- Modify: `src/modules/recruitment/contract/visibility.ts`
- Test: `src/modules/recruitment/contract/visibility.test.ts`

**Interfaces:**
- Consumes: existing `buildContractAnswers`, `visibleContractBlocks`, `ContractContext` (same file); `SYSTEM_FIELDS` from `./system-fields`; `ContractLayout`, `ContractBlock` from `./layout`.
- Produces: `visibleOnboardingBlocks(layout: ContractLayout, formAnswers: Record<string, string | string[]>, ctx: ContractContext): ContractBlock[]` — the enabled/core filter + `buildContractAnswers` + `visibleContractBlocks`, i.e. exactly the blocks the applicant sees.

- [ ] **Step 1: Write the failing tests**

Append to `src/modules/recruitment/contract/visibility.test.ts` (add `visibleOnboardingBlocks` to the existing import from `./visibility`, and `ContractLayout` to the type import from `./layout` if not already present):

```ts
describe("visibleOnboardingBlocks", () => {
  const ctx = { department: "IM", track: "VOLUNTEER" as const, epicRequirement: "SOME" as const };

  it("drops a disabled optional system field but keeps core ones", () => {
    const layout: ContractLayout = {
      blocks: [
        { kind: "system_field", systemKey: "email" }, // core
        { kind: "system_field", systemKey: "netId", enabled: false }, // optional, off
      ],
    };
    const shown = visibleOnboardingBlocks(layout, {}, ctx);
    expect(shown.map((b) => (b.kind === "system_field" ? b.systemKey : null))).toEqual(["email"]);
  });

  it("shows a department-gated agreement only for the matching department", () => {
    const layout: ContractLayout = {
      blocks: [
        { kind: "agreement", id: "im_duties", title: "IM duties", body: "", signatureLabel: "Sign",
          confirmKind: "checkbox", visibleWhen: { field: "department", op: "is", value: "IM" } },
      ],
    };
    expect(visibleOnboardingBlocks(layout, {}, { ...ctx, department: "IM" })).toHaveLength(1);
    expect(visibleOnboardingBlocks(layout, {}, { ...ctx, department: "PEDS" })).toHaveLength(0);
  });

  it("reveals a block gated on hasEpic once hasEpic is answered", () => {
    const layout: ContractLayout = {
      blocks: [
        { kind: "system_field", systemKey: "epicIdExpiration",
          visibleWhen: { field: "hasEpic", op: "is", value: "on" } },
      ],
    };
    expect(visibleOnboardingBlocks(layout, {}, ctx)).toHaveLength(0);
    expect(visibleOnboardingBlocks(layout, { hasEpic: "on" }, ctx)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/modules/recruitment/contract/visibility.test.ts`
Expected: FAIL with "visibleOnboardingBlocks is not a function" (or an import error).

- [ ] **Step 3: Implement the helper**

In `src/modules/recruitment/contract/visibility.ts`, add the import near the top:

```ts
import { SYSTEM_FIELDS } from "./system-fields";
```

and append the function at the end of the file:

```ts
/**
 * The blocks an applicant actually sees on the onboarding form: optional system
 * fields a director disabled are dropped (the enabled/core filter), then
 * visibleWhen is evaluated against the applicant's answers merged with the
 * authoritative context. Mirrors the inline computation onboard-form.tsx does at
 * render time; kept here so the builder preview renders from the same logic.
 */
export function visibleOnboardingBlocks(
  layout: ContractLayout,
  formAnswers: Record<string, string | string[]>,
  ctx: ContractContext,
): ContractBlock[] {
  const enabled = layout.blocks.filter(
    (b) => b.kind !== "system_field" || b.enabled !== false || SYSTEM_FIELDS[b.systemKey].core,
  );
  return visibleContractBlocks(enabled, buildContractAnswers(formAnswers, ctx));
}
```

If `ContractLayout` is not already imported in this file, add it to the existing `import type { ContractBlock } from "./layout";` line so it reads `import type { ContractBlock, ContractLayout } from "./layout";`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/modules/recruitment/contract/visibility.test.ts`
Expected: PASS (all, including the three new cases).

- [ ] **Step 5: Typecheck + lint the change**

Run: `npm run typecheck` then `npx eslint src/modules/recruitment/contract/visibility.ts src/modules/recruitment/contract/visibility.test.ts`
Expected: no errors. (If a circular-import error appears, it means `system-fields` transitively imports `visibility`; it does not today, but if so, stop and report.)

- [ ] **Step 6: Commit**

```bash
git add src/modules/recruitment/contract/visibility.ts src/modules/recruitment/contract/visibility.test.ts
git commit -m "feat(recruitment): add visibleOnboardingBlocks shared visibility helper"
```

---

### Task 2: `OnboardingPreview` component

**Files:**
- Create: `src/app/(app)/recruitment/cycles/[id]/builder/contract/onboarding-preview.tsx`
- Test: `src/app/(app)/recruitment/cycles/[id]/builder/contract/onboarding-preview.test.tsx`

**Interfaces:**
- Consumes: `visibleOnboardingBlocks` (Task 1); `epicRequirementFor` from `@/modules/recruitment/contract/epic-requirement`; `ContractField` from `@/app/onboard/[token]/contract-field`; `ContractLayout` type; UI primitives `Modal`, `Button`, `Card`, `Select`, `Field`.
- Produces:
  - `type PreviewDepartment = { code: string; name: string; requiresEpicDirector: EpicRequirement; requiresEpicVolunteer: EpicRequirement }`
  - `type OnboardingPreviewContext = { departments: PreviewDepartment[]; orgName: string; trainingDate: string; trainingLocation: string; todayIso: string; title: string; fixedTrack: Track | null }`
  - `OnboardingPreviewBody(props: OnboardingPreviewContext & { layout: ContractLayout })` — the statically-testable panel + block list.
  - `OnboardingPreview(props: { open: boolean; onClose: () => void } & OnboardingPreviewContext & { layout: ContractLayout })` — the Modal wrapper.

- [ ] **Step 1: Write the failing test**

Create `src/app/(app)/recruitment/cycles/[id]/builder/contract/onboarding-preview.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OnboardingPreviewBody, type OnboardingPreviewContext } from "./onboarding-preview";
import type { ContractLayout } from "@/modules/recruitment/contract/layout";

const base: OnboardingPreviewContext = {
  departments: [
    { code: "IM", name: "Internal Medicine", requiresEpicDirector: "ALL", requiresEpicVolunteer: "SOME" },
    { code: "PEDS", name: "Pediatrics", requiresEpicDirector: "NONE", requiresEpicVolunteer: "NONE" },
  ],
  orgName: "HAVEN Free Clinic",
  trainingDate: "Sunday, May 3",
  trainingLocation: " in person",
  todayIso: "2026-07-22",
  title: "Fall 2026",
  fixedTrack: "VOLUNTEER",
};

const render = (layout: ContractLayout, ctx: Partial<OnboardingPreviewContext> = {}) =>
  renderToStaticMarkup(<OnboardingPreviewBody {...base} {...ctx} layout={layout} />);

describe("OnboardingPreviewBody", () => {
  it("renders the department picker and a read-only track chip in cycle mode", () => {
    const out = render({ blocks: [] });
    expect(out).toContain("Internal Medicine");
    expect(out).toContain("Pediatrics");
    expect(out).toContain("Volunteer"); // fixed-track chip
    expect(out).not.toContain('value="DIRECTOR"'); // no toggle button in cycle mode
  });

  it("renders a track toggle when there is no fixed track (global mode)", () => {
    const out = render({ blocks: [] }, { fixedTrack: null });
    expect(out).toContain("Director");
    expect(out).toContain("Volunteer");
  });

  it("shows a block gated to the first (default-selected) department", () => {
    const layout: ContractLayout = {
      blocks: [
        { kind: "agreement", id: "im_duties", title: "IM duties", body: "", signatureLabel: "I agree",
          confirmKind: "checkbox", visibleWhen: { field: "department", op: "is", value: "IM" } },
        { kind: "agreement", id: "peds_duties", title: "PEDS duties", body: "", signatureLabel: "I agree",
          confirmKind: "checkbox", visibleWhen: { field: "department", op: "is", value: "PEDS" } },
      ],
    };
    const out = render(layout);
    expect(out).toContain("IM duties"); // IM is departments[0], selected by default
    expect(out).not.toContain("PEDS duties");
  });

  it("does not render a submit control", () => {
    const out = render({ blocks: [{ kind: "system_field", systemKey: "email" }] });
    expect(out).not.toContain('type="submit"');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run "src/app/(app)/recruitment/cycles/[id]/builder/contract/onboarding-preview.test.tsx"`
Expected: FAIL with "Cannot find module './onboarding-preview'".

- [ ] **Step 3: Write the component**

Create `src/app/(app)/recruitment/cycles/[id]/builder/contract/onboarding-preview.tsx`:

```tsx
"use client";

import { useMemo, useState } from "react";
import type { EpicRequirement, Track } from "@prisma/client";
import { Modal } from "@/platform/ui/modal";
import { Button } from "@/platform/ui/button";
import { Card } from "@/platform/ui/card";
import { Select } from "@/platform/ui/select";
import { Field } from "@/platform/ui/input";
import { ContractField } from "@/app/onboard/[token]/contract-field";
import { visibleOnboardingBlocks } from "@/modules/recruitment/contract/visibility";
import { epicRequirementFor } from "@/modules/recruitment/contract/epic-requirement";
import type { ContractLayout } from "@/modules/recruitment/contract/layout";

export type PreviewDepartment = {
  code: string;
  name: string;
  requiresEpicDirector: EpicRequirement;
  requiresEpicVolunteer: EpicRequirement;
};

export type OnboardingPreviewContext = {
  departments: PreviewDepartment[];
  orgName: string;
  trainingDate: string;
  trainingLocation: string;
  todayIso: string;
  title: string;
  /** The cycle's track locks the control; null (global master template) offers a toggle. */
  fixedTrack: Track | null;
};

const EMPTY_PREFILL = { firstName: "", lastName: "", email: "", netId: "", phone: "", yaleAffiliation: "", gradYear: "" };
const noErr = () => undefined;

function trackLabel(t: Track): string {
  return t === "DIRECTOR" ? "Director" : "Volunteer";
}

/**
 * A read-only-but-interactive preview of the onboarding contract, rendered from
 * the builder's in-hand layout through the SAME ContractField renderer and the
 * visibleOnboardingBlocks helper the live /onboard form's render is built from.
 * Staff pick a track + accepted department (which derive the Epic requirement),
 * and can fill fields so conditional (visibleWhen) blocks reveal exactly as an
 * applicant would experience them. Nothing is saved.
 *
 * Split from the Modal wrapper so it can be rendered directly in a static test
 * (Modal renders through a portal, which react-dom/server does not capture).
 */
export function OnboardingPreviewBody({
  layout,
  departments,
  orgName,
  trainingDate,
  trainingLocation,
  todayIso,
  title,
  fixedTrack,
}: OnboardingPreviewContext & { layout: ContractLayout }) {
  const [track, setTrack] = useState<Track>(fixedTrack ?? "VOLUNTEER");
  const [departmentCode, setDepartmentCode] = useState<string>(departments[0]?.code ?? "");
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});

  const selectedDept = departments.find((d) => d.code === departmentCode) ?? null;
  const epicRequirement = epicRequirementFor(selectedDept, track);
  const department = departmentCode || null;
  const ctx = { firstName: "", orgName, todayIso, trainingDate, trainingLocation, department, track, epicRequirement };

  const shown = useMemo(
    () => visibleOnboardingBlocks(layout, answers, { department, track, epicRequirement }),
    [layout, answers, department, track, epicRequirement],
  );
  const departmentCodes = departments.map((d) => d.code);
  const onAnswer = (name: string, value: string | string[]) => setAnswers((prev) => ({ ...prev, [name]: value }));

  return (
    <>
      <p className="text-sm text-muted-foreground">
        This is how accepted applicants see the <span className="font-medium text-foreground">{title}</span> onboarding
        contract. Nothing here is saved. Fill fields to see conditional blocks appear as an applicant would.
      </p>

      <div className="mt-4 space-y-3 rounded-lg border border-border bg-muted/40 p-3">
        <div>
          <span className="text-xs font-medium text-foreground">Track</span>
          {fixedTrack ? (
            <p className="mt-1 text-sm text-foreground-soft">{trackLabel(fixedTrack)}</p>
          ) : (
            <div className="mt-1.5 flex flex-wrap gap-2">
              {(["VOLUNTEER", "DIRECTOR"] as Track[]).map((t) => (
                <Button
                  key={t}
                  type="button"
                  size="sm"
                  variant={track === t ? "primary" : "outline"}
                  onClick={() => setTrack(t)}
                >
                  {trackLabel(t)}
                </Button>
              ))}
            </div>
          )}
        </div>
        {departments.length > 0 && (
          <div className="max-w-xs">
            <Field label="Accepted department" hint={`Epic requirement: ${epicRequirement}`}>
              <Select value={departmentCode} onChange={(e) => setDepartmentCode(e.target.value)}>
                {departments.map((d) => (
                  <option key={d.code} value={d.code}>
                    {d.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}
      </div>

      {/* Submit is suppressed: the form element only exists so grouped controls
          (MULTI_SELECT / SUBCOMMITTEE_RANK) can read their sibling values back
          for live visibleWhen evaluation, mirroring ApplyPreview. */}
      <form className="mt-4" onSubmit={(e) => e.preventDefault()}>
        <Card className="space-y-6">
          {shown.length === 0 ? (
            <p className="text-sm text-subtle-foreground">No blocks are shown for this context yet.</p>
          ) : (
            shown.map((b) => (
              <ContractField
                key={"id" in b ? b.id : b.kind === "system_field" ? b.systemKey : b.key}
                block={b}
                prefill={EMPTY_PREFILL}
                ctx={ctx}
                err={noErr}
                onAnswer={onAnswer}
                departments={departmentCodes}
              />
            ))
          )}
        </Card>
      </form>
    </>
  );
}

export function OnboardingPreview({
  open,
  onClose,
  ...body
}: { open: boolean; onClose: () => void } & OnboardingPreviewContext & { layout: ContractLayout }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Contract preview"
      size="large"
      footer={
        <Button type="button" variant="outline" onClick={onClose}>
          Close preview
        </Button>
      }
    >
      <OnboardingPreviewBody {...body} />
    </Modal>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run "src/app/(app)/recruitment/cycles/[id]/builder/contract/onboarding-preview.test.tsx"`
Expected: PASS (all four cases).

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck` then `npx eslint "src/app/(app)/recruitment/cycles/[id]/builder/contract/onboarding-preview.tsx" "src/app/(app)/recruitment/cycles/[id]/builder/contract/onboarding-preview.test.tsx"`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/recruitment/cycles/[id]/builder/contract/onboarding-preview.tsx" "src/app/(app)/recruitment/cycles/[id]/builder/contract/onboarding-preview.test.tsx"
git commit -m "feat(recruitment): onboarding contract preview modal component"
```

---

### Task 3: Preview-context server loader

**Files:**
- Create: `src/app/(app)/recruitment/cycles/[id]/builder/contract/preview-context.ts`
- Test: `src/app/(app)/recruitment/cycles/[id]/builder/contract/preview-context.test.ts`

**Interfaces:**
- Consumes: `prisma`; `getSetting` from `@/platform/settings/service`; `getDisplayTimeZone` from `@/platform/dates/resolve`; `formatTrainingDate` / `formatTrainingLocation` from `@/app/onboard/[token]/training-date`; the `OnboardingPreviewContext` type from Task 2.
- Produces: `loadOnboardingPreviewContext(opts: { departmentCodes: string[] | "all"; fixedTrack: Track | null; inPersonTrainingDate: Date | null; trainingLocation: string | null; title: string }): Promise<OnboardingPreviewContext>`.

- [ ] **Step 1: Write the failing test**

Create `src/app/(app)/recruitment/cycles/[id]/builder/contract/preview-context.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { loadOnboardingPreviewContext } from "./preview-context";

beforeEach(async () => {
  await resetDb();
});

describe("loadOnboardingPreviewContext", () => {
  it("loads the named departments with their Epic flags and formatted training", async () => {
    await prisma.department.create({ data: { code: "IM", name: "Internal Medicine", requiresEpicVolunteer: "SOME", isActive: true } });
    await prisma.department.create({ data: { code: "OFF", name: "Inactive", isActive: false } });
    const ctx = await loadOnboardingPreviewContext({
      departmentCodes: ["IM"],
      fixedTrack: "VOLUNTEER",
      inPersonTrainingDate: new Date(Date.UTC(2026, 4, 3, 12)),
      trainingLocation: "Room 100",
      title: "Fall 2026",
    });
    expect(ctx.departments).toEqual([
      { code: "IM", name: "Internal Medicine", requiresEpicDirector: "NONE", requiresEpicVolunteer: "SOME" },
    ]);
    expect(ctx.fixedTrack).toBe("VOLUNTEER");
    expect(ctx.title).toBe("Fall 2026");
    expect(ctx.trainingDate).toContain("May"); // formatted, not a placeholder
    expect(ctx.trainingLocation).toBe(" Room 100");
    expect(ctx.todayIso).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("loads all active departments in global mode with placeholder training", async () => {
    await prisma.department.create({ data: { code: "IM", name: "Internal Medicine", isActive: true } });
    await prisma.department.create({ data: { code: "OFF", name: "Inactive", isActive: false } });
    const ctx = await loadOnboardingPreviewContext({
      departmentCodes: "all",
      fixedTrack: null,
      inPersonTrainingDate: null,
      trainingLocation: null,
      title: "master template",
    });
    expect(ctx.departments.map((d) => d.code)).toEqual(["IM"]);
    expect(ctx.fixedTrack).toBeNull();
    expect(ctx.trainingLocation).toBe(""); // placeholder for no location
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run "src/app/(app)/recruitment/cycles/[id]/builder/contract/preview-context.test.ts"`
Expected: FAIL with "Cannot find module './preview-context'".

- [ ] **Step 3: Write the loader**

Create `src/app/(app)/recruitment/cycles/[id]/builder/contract/preview-context.ts`:

```ts
import type { Track } from "@prisma/client";
import { prisma } from "@/platform/db";
import { getSetting } from "@/platform/settings/service";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { formatTrainingDate, formatTrainingLocation } from "@/app/onboard/[token]/training-date";
import type { OnboardingPreviewContext } from "./onboarding-preview";

/**
 * Build the context the onboarding preview needs: the selectable departments
 * (with their Epic-requirement flags so the preview can derive the requirement
 * per track), the org name and training strings for {{...}} interpolation, and a
 * server-stamped todayIso for the HIPAA date bounds. `departmentCodes: "all"`
 * loads every active department (global master-template editor); an array loads
 * exactly a cycle's departments.
 */
export async function loadOnboardingPreviewContext(opts: {
  departmentCodes: string[] | "all";
  fixedTrack: Track | null;
  inPersonTrainingDate: Date | null;
  trainingLocation: string | null;
  title: string;
}): Promise<OnboardingPreviewContext> {
  const where = opts.departmentCodes === "all" ? { isActive: true } : { code: { in: opts.departmentCodes } };
  const [departments, orgName, zone] = await Promise.all([
    prisma.department.findMany({
      where,
      select: { code: true, name: true, requiresEpicDirector: true, requiresEpicVolunteer: true },
      orderBy: { name: "asc" },
    }),
    getSetting<string>("branding.orgName"),
    getDisplayTimeZone(),
  ]);
  return {
    departments,
    orgName,
    trainingDate: formatTrainingDate(opts.inPersonTrainingDate, zone),
    trainingLocation: formatTrainingLocation(opts.trainingLocation),
    todayIso: new Date().toISOString().slice(0, 10),
    title: opts.title,
    fixedTrack: opts.fixedTrack,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run "src/app/(app)/recruitment/cycles/[id]/builder/contract/preview-context.test.ts"`
Expected: PASS (both cases).

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck` then `npx eslint "src/app/(app)/recruitment/cycles/[id]/builder/contract/preview-context.ts" "src/app/(app)/recruitment/cycles/[id]/builder/contract/preview-context.test.ts"`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/recruitment/cycles/[id]/builder/contract/preview-context.ts" "src/app/(app)/recruitment/cycles/[id]/builder/contract/preview-context.test.ts"
git commit -m "feat(recruitment): onboarding preview context loader"
```

---

### Task 4: Wire the Preview button into the editor and both pages

**Files:**
- Modify: `src/app/(app)/recruitment/cycles/[id]/builder/contract/contract-editor.tsx`
- Modify: `src/app/(app)/recruitment/cycles/[id]/builder/contract/page.tsx`
- Modify: `src/app/(app)/admin/contract/page.tsx`

**Interfaces:**
- Consumes: `OnboardingPreview`, `OnboardingPreviewContext` (Task 2); `loadOnboardingPreviewContext` (Task 3).
- Produces: `ContractEditor` gains a required `preview: OnboardingPreviewContext` prop; both pages pass it.

- [ ] **Step 1: Add the prop, button, and modal to `ContractEditor`**

In `contract-editor.tsx`:

1. Add `Eye` to the lucide import: change `import { Check, Plus } from "lucide-react";` to `import { Check, Eye, Plus } from "lucide-react";`.
2. Add the component import below the other local imports:

```ts
import { OnboardingPreview, type OnboardingPreviewContext } from "./onboarding-preview";
```

3. Add `preview` to the props destructure and type. Change the signature to include it:

```ts
export function ContractEditor({
  cycleId,
  initialLayout,
  hasOverride,
  mode = "cycle",
  status,
  preview,
}: {
  cycleId: string;
  initialLayout: ContractLayout;
  hasOverride: boolean;
  mode?: "cycle" | "global";
  status?: string;
  preview: OnboardingPreviewContext;
}) {
```

4. Add preview state next to the other `useState` hooks (e.g. after `const [confirmReset, setConfirmReset] = useState(false);`):

```ts
  const [previewOpen, setPreviewOpen] = useState(false);
```

5. In the bottom action row (the `<div className="flex flex-wrap items-center gap-3">` that holds Save/Reset), add a Preview button as the first child, before the Save button:

```tsx
        <Button type="button" variant="outline" onClick={() => setPreviewOpen(true)}>
          <Eye className="h-4 w-4" aria-hidden /> Preview form
        </Button>
```

6. Immediately before the final closing `</div>` of the component's returned tree, render the modal with the live layout:

```tsx
      <OnboardingPreview
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        layout={layout}
        {...preview}
      />
```

- [ ] **Step 2: Pass the context from the per-cycle builder page**

In `src/app/(app)/recruitment/cycles/[id]/builder/contract/page.tsx`:

1. Add the import:

```ts
import { loadOnboardingPreviewContext } from "./preview-context";
```

2. After `const { layout, hasOverride } = await getContractLayoutForEdit(id);`, load the context:

```ts
  const preview = await loadOnboardingPreviewContext({
    departmentCodes: cycle.departments,
    fixedTrack: cycle.track,
    inPersonTrainingDate: cycle.inPersonTrainingDate,
    trainingLocation: cycle.trainingLocation,
    title: cycle.title,
  });
```

3. Pass it to the editor:

```tsx
      <ContractEditor cycleId={id} initialLayout={layout} hasOverride={hasOverride} status={cycle.status} preview={preview} />
```

- [ ] **Step 3: Pass the context from the global master-template page**

In `src/app/(app)/admin/contract/page.tsx`:

1. Add the import:

```ts
import { loadOnboardingPreviewContext } from "@/app/(app)/recruitment/cycles/[id]/builder/contract/preview-context";
```

2. Before the `return`, load the context:

```ts
  const preview = await loadOnboardingPreviewContext({
    departmentCodes: "all",
    fixedTrack: null,
    inPersonTrainingDate: null,
    trainingLocation: null,
    title: "master template",
  });
```

3. Pass it to the editor:

```tsx
      <ContractEditor mode="global" cycleId="" initialLayout={layout} hasOverride={false} preview={preview} />
```

- [ ] **Step 4: Typecheck + lint**

Run: `npm run typecheck` then `npx eslint "src/app/(app)/recruitment/cycles/[id]/builder/contract/contract-editor.tsx" "src/app/(app)/recruitment/cycles/[id]/builder/contract/page.tsx" "src/app/(app)/admin/contract/page.tsx"`
Expected: no errors. (Typecheck fails until BOTH pages pass the now-required `preview` prop; that is why all three files change in one task.)

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/recruitment/cycles/[id]/builder/contract/contract-editor.tsx" "src/app/(app)/recruitment/cycles/[id]/builder/contract/page.tsx" "src/app/(app)/admin/contract/page.tsx"
git commit -m "feat(recruitment): wire the onboarding contract preview into the builder"
```

---

### Task 5: Final verification

**Files:** none (verification only).

- [ ] **Step 1: Run the touched test suites**

Run: `npx vitest run src/modules/recruitment/contract "src/app/(app)/recruitment/cycles/[id]/builder/contract"`
Expected: PASS.

- [ ] **Step 2: Full typecheck + lint**

Run: `npm run typecheck` then `npm run lint`
Expected: both clean.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin feat/onboarding-form-preview
gh pr create --base main --title "feat(recruitment): onboarding contract preview for the builder" --body "<summary from the spec>"
```

---

## Self-Review

**Spec coverage:**
- Preview button in `ContractEditor` → Task 4. ✓
- Renders from in-hand `layout` → Task 4 passes `layout={layout}` (editor state). ✓
- Parity via `ContractField` + shared visibility → Tasks 1, 2. ✓
- Track + department controls, derived Epic requirement → Task 2. ✓
- Track fixed in cycle / toggle in global → Task 2 (`fixedTrack`), Task 4 (cycle passes `cycle.track`, global passes `null`). ✓
- Departments only, default first → Task 2 (`departments[0]`, no "(no department)" option). ✓
- Both cycle + global → Task 4 (both pages). ✓
- Nothing saved; submit suppressed → Task 2. ✓
- No changes to the live `/onboard` form → confirmed: only additive helper (Task 1) and new files; `onboard-form.tsx`/`contract-field.tsx` untouched. ✓
- Component test for visibility parity → Tasks 1 (pure helper, the real visibility coverage) + 2 (initial-state render). ✓

**Placeholder scan:** none; every code step shows full code.

**Type consistency:** `OnboardingPreviewContext` / `PreviewDepartment` defined in Task 2, consumed by Tasks 3 and 4 with matching field names and types. `loadOnboardingPreviewContext` signature identical in Task 3 definition and Task 4 call sites. `visibleOnboardingBlocks` signature identical in Task 1 and its use in Task 2.
