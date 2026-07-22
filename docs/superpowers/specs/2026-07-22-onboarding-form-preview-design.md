# Onboarding contract preview for the builder

**Date:** 2026-07-22
**Status:** Approved (design)

## Problem

The recruitment application form builder has a **Preview form** button
(`ApplyPreview`) that re-renders the applicant form live from the builder's
in-hand data, so staff can see what applicants will experience without
publishing. The **onboarding contract** builder (`ContractEditor`, used by both
the per-cycle builder and the global master-template editor) has no equivalent.
Staff editing the contract cannot see the rendered result (prose, agreements,
signatures, conditional blocks) without sending a real onboarding link and
opening it as the applicant. We want an onboarding-contract preview that works
"just like" the application preview.

## Goals

- A **Preview form** button in `ContractEditor` that opens a modal rendering the
  onboarding contract as an accepted applicant would see it.
- The preview renders from the editor's **in-hand `layout` state**, so it
  reflects unsaved edits.
- Parity with the live `/onboard/[token]` form: the same field renderer
  (`ContractField`) and the same visibility logic (`buildContractAnswers` +
  `visibleContractBlocks` + the enabled/core filter).
- Controls to simulate the authoritative context that gates conditional blocks:
  **track** and **accepted department** (which together derive the Epic
  requirement, and the department gates department-specific agreements).
- Works in both the per-cycle builder and the global master-template editor.
- Nothing is saved; closing the modal discards all preview state.

## Non-goals

- No changes to the live `/onboard` form or the submit path.
- No new persistence, no server round-trip on preview (fully client-side).
- No "applicant type" concept (onboarding is post-acceptance; that dimension
  does not exist here).

## Approach

Mirror `ApplyPreview` exactly. `ApplyPreview` does **not** reuse the live apply
wizard's form component; it re-implements the small section/field render loop
using the shared `FieldPreview` renderer and the shared visibility engine. We do
the same: a new client modal re-implements the onboarding form's block loop using
the shared `ContractField` renderer and the shared `buildContractAnswers` /
`visibleContractBlocks` helpers. Parity is guaranteed where it matters (the field
renderer and the visibility engine); only the trivial outer `.map` is duplicated.

**Rejected alternatives:**

- *Extract a shared `<ContractBody>` used by both the live form and the preview.*
  Guarantees the outer loop matches too, but requires refactoring the working,
  legally-sensitive `/onboard` form. `ApplyPreview` deliberately did not do this,
  and the outer loop is ~15 lines. Rejected to keep the live flow untouched.
- *Server-rendered static preview page.* Cannot react to filling fields live
  (conditional `visibleWhen` blocks would not reveal), and does not reflect
  unsaved builder edits. Rejected.

## Components and data flow

### `OnboardingPreview` (new client component)

`src/app/(app)/recruitment/cycles/[id]/builder/contract/onboarding-preview.tsx`

Props:

- `open: boolean`, `onClose: () => void`
- `layout: ContractLayout` — the editor's current (possibly unsaved) layout
- `departments: PreviewDepartment[]` where
  `PreviewDepartment = { code: string; name: string; requiresEpicDirector: EpicRequirement; requiresEpicVolunteer: EpicRequirement }`
- `orgName: string` — for `{{orgName}}` interpolation
- `trainingDate: string`, `trainingLocation: string` — pre-formatted interpolation strings
- `todayIso: string` — server-stamped date for HIPAA bounds (matches the live page)
- `title: string` — cycle title, or "master template" in global mode
- `fixedTrack: Track | null` — the cycle's track (locks the control); `null` in
  global mode (offer a VOLUNTEER/DIRECTOR toggle)

State:

- `selectedTrack: Track` — initialised to `fixedTrack ?? "VOLUNTEER"`
- `selectedDepartmentCode: string` — initialised to the first department's code
  (or `""` when the list is empty)
- `answers: Record<string, string | string[]>` — live answers, seeded empty

Derivation each render:

- `selectedDept = departments.find(d => d.code === selectedDepartmentCode) ?? null`
- `epicRequirement = epicRequirementFor(selectedDept, selectedTrack)`
- `ctx = { firstName: "", orgName, todayIso, trainingDate, trainingLocation, department: selectedDepartmentCode || null, track: selectedTrack, epicRequirement }`
- `answersWithCtx = buildContractAnswers(answers, { department: ctx.department, track: ctx.track, epicRequirement })`
- `enabled = layout.blocks.filter(b => b.kind !== "system_field" || b.enabled !== false || SYSTEM_FIELDS[b.systemKey].core)`
- `shown = visibleContractBlocks(enabled, answersWithCtx)`
- render each `shown` block through `ContractField` with `prefill` = empty
  strings, `err: () => undefined`, `onAnswer` = set `answers`, and
  `departments = departments.map(d => d.code)`.

Wrapped in the shared `Modal` (`size="large"`), a context-control panel styled
like `ApplyPreview`'s, an explanatory line ("This is how accepted applicants see
… Nothing here is saved."), and a `<form onSubmit={e => e.preventDefault()}>`
wrapping the blocks (submit suppressed; the form element only exists so grouped
controls can read sibling values, mirroring `ApplyPreview`).

**Track control:** in cycle mode (`fixedTrack` set) render a read-only chip
showing the track. In global mode (`fixedTrack === null`) render a
VOLUNTEER/DIRECTOR toggle.

**Department control:** a single-select of the real departments (no
"(no department)" option), defaulting to the first. The derived Epic requirement
is shown beside it so staff understand why the Epic block does or does not appear.

### `ContractEditor` (modified)

`src/app/(app)/recruitment/cycles/[id]/builder/contract/contract-editor.tsx`

- Add one prop: `preview: OnboardingPreviewContext` (the bundle of
  departments/orgName/training/todayIso/title/fixedTrack above).
- Add a **Preview form** button to the toolbar (same `<Eye/>` icon + label as the
  application form builder) that sets `previewOpen`.
- Render `<OnboardingPreview open={previewOpen} onClose={…} layout={layout} {...preview} />`
  so it always previews the current in-hand `layout`.

### Server pages (modified)

- `builder/contract/page.tsx` (per-cycle): load the cycle's departments with
  their Epic flags
  (`prisma.department.findMany({ where: { code: { in: cycle.departments } }, select: { code, name, requiresEpicDirector, requiresEpicVolunteer } })`),
  `orgName` (`branding.orgName`), the display zone → `formatTrainingDate(cycle.inPersonTrainingDate, zone)` /
  `formatTrainingLocation(cycle.trainingLocation)`, `todayIso`, `title = cycle.title`,
  `fixedTrack = cycle.track`. Pass as `preview`.
- `admin/contract/page.tsx` (global): load **all active** departments with Epic
  flags, `orgName`, `todayIso`, `title = "master template"`, `fixedTrack = null`,
  and placeholder training strings (`formatTrainingDate(null, zone)` /
  `formatTrainingLocation(null)`). Pass as `preview`.

A small shared helper `loadOnboardingPreviewContext(...)` (in the contract module)
builds this bundle so both pages stay DRY and consistent.

## Testing

Component test `onboarding-preview.test.tsx` (following `contract-field.test.tsx`):

- A department-gated agreement (visibleWhen `field: "department"`) appears only
  when its department is selected.
- Switching track from VOLUNTEER to DIRECTOR (global mode) reveals a
  director-only block and derives the expected Epic requirement.
- Checking `hasEpic` reveals the existing-Epic-ID field (answer-driven
  visibility).
- A disabled optional system field never renders; a core one always does.
- Submit is suppressed (no navigation / no action call).

Plus `npm run typecheck` and full-repo `npm run lint`. The live-form parity is
inherently maintained by reusing `ContractField` + `visibleContractBlocks`.

## Risks

- **Client reuse of `ContractField`:** it is already `"use client"` and imports
  only client-safe modules (UI primitives, `FieldPreview`, `Prose`,
  `system-fields`), so importing it from the builder route is safe.
- **Interpolation drift:** `ContractField.renderVars` handles
  `{{firstName}}/{{orgName}}/{{trainingDate}}/{{trainingLocation}}` client-side.
  The preview supplies the same context keys the live page does, so previewed
  prose matches. `firstName` is empty in preview (no applicant yet), which is
  acceptable and clearly a preview.
