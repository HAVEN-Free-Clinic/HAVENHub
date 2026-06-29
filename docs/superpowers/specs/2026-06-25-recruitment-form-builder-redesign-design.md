# Recruitment Form Builder Redesign

**Date:** 2026-06-25
**Status:** Approved design, pre-implementation

## Problem

The recruitment form builder (`/recruitment/cycles/[id]/builder` and `.../builder/quiz`) is ugly and unintuitive. Concretely:

- Add-and-delete only. To fix a label typo you must delete the field and re-create it, even though `updateField` exists in the service layer.
- No reordering in the UI, despite `reorderFields`/`reorderSections` being fully implemented and guarded in the service layer.
- Raw enum names shown to users (`SHORT_TEXT`, `DEPARTMENT_CHOICE`) in the type dropdown and in each field's metadata line.
- The options textarea is `rows={1}` and always rendered, even for field types that have no options (e.g. `SHORT_TEXT`, `EMAIL`).
- The quiz builder is the worst offender: "Value A / Answer A / Value B / Answer B" hardcoded to exactly two options, plus a separate "Correct value — the value of the right answer, e.g. `a`" field, with setting the answer as a distinct save action.
- No preview of the actual applicant form.
- Every action triggers a full page reload.
- `helpText`, `validation`, and `FormSection.description` exist in the model and are rendered to applicants, but the builder never lets you set them.

## Goal

Rebuild both builders as an Airtable-style **WYSIWYG** form builder: the editing canvas *is* the form preview. Each field renders the way an applicant sees it; clicking it edits it in place. Drag to reorder, inline edit, friendly type names, type-aware editors. Make it feel modern and obvious.

## Decisions (from brainstorming)

- **Ambition:** full UX rebuild (not just visual polish).
- **Scope:** rebuild **both** the application form builder and the training-quiz builder.
- **Save model:** per-action save. Rename commits on blur; a toggle commits on change; a drag commits on drop. No global dirty-state machine; each action persists through a server action, then the page revalidates. Drag updates local order optimistically before persisting.
- **Drag library:** add `@dnd-kit` (`@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`). Keyboard- and touch-accessible; React 19 compatible.
- **Edit depth:** expose everything Airtable's form builder exposes — label, type, required, help text, choice options, file-type restrictions (for File), and section description (plus the existing section title / applies-to / dept code).
- **North star:** make it feel very similar to Airtable's form builder.

## Design — UX (Airtable-style WYSIWYG)

A single centered column that looks like the real application form, rendered with the shared field renderer.

**Form header card.** Brand-color cover strip, the cycle title, and an editable intro description.

**Sections as groups.** Each section is a labeled group containing its fields. Sections are a real domain need (NEW/RENEWAL scoping, department supplements, quiz purpose) and stay. A section header shows the title plus a scope chip (e.g. `NEW · RENEWAL`, or a department code). A gear on the header opens a small editor: title, description, applies-to, department code.

**Field card — two states:**

- *Resting:* the field rendered exactly as the applicant sees it — label with required `*`, the actual (non-interactive) input control, help text underneath. On hover: a drag handle (`⠿`) on the left; a type icon + actions (edit, duplicate, delete) on the right.
- *Selected (click to expand):* the card expands inline into an editor showing:
  - **Label** (text)
  - **Help text** (Airtable's "description")
  - **Required** toggle
  - **Type** dropdown with friendly names + icons
  - **Type-specific settings:**
    - Choice types (`SINGLE_SELECT`, `MULTI_SELECT`): an options editor — add / remove / reorder choices. You type only the choice **label**; the stored `value` is auto-derived (slugged) and stays stable once created so editing a label never invalidates submitted answers.
    - `FILE`: accepted-file-type chips (writes `validation.acceptedTypes`).
    - `DEPARTMENT_CHOICE`: an explanatory note (options come from the cycle's departments, not user-entered).
  - Delete uses the two-click confirm (`ConfirmButton`).

  Edits commit on blur/toggle (per-action save). The card shows a subtle inline "Saved ✓" / "Couldn't save" state from the action result.

**Adding fields.** A full-width "+ Add field" button at the bottom of each section opens a **type picker menu** with friendly names + icons, grouped like Airtable (Text, Choice, Contact, Date/Number, File, Department). Picking a type drops a new field into that section and selects it for editing.

**Adding sections.** A "+ Add section" control adds a group (defaults: title "Section", applies-to BOTH, no dept code), then selects it.

**Reorder.** Fields reorder within a section by their drag handle; sections reorder by their header handle (dnd-kit, keyboard-accessible). Drop persists via the existing reorder services. **Cross-section field moves are out of scope for v1** (within-section reorder + section reorder only).

**Published cycles.** When `cycle.status !== "DRAFT"`, structural controls (type change, delete, add field/section, applies-to, dept code) are disabled with a tooltip explaining why; safe edits (labels, help text, descriptions) stay live. This mirrors the existing `assertCycleEditable` guards. A banner at the top explains the state. (Reorder is treated as non-structural by the service and remains allowed.)

**Quiz builder.** Same canvas, but a field card is a question: prompt + its answer options shown as radios, with the correct one marked by **clicking its radio** (one step — no "type the value" field). "+ Add question" adds a prompt with two starter options you can add to. Quiz sections (`purpose === "QUIZ"`) are edited here; application sections are edited on the main builder. Reuses the same `FieldCard` / options-editor components.

## Design — Architecture

### Shared field renderer (extraction)

Extract the `Field` switch currently inline in `src/app/apply/[slug]/apply-form.tsx:79-107` into:

- `src/modules/recruitment/components/field-preview.tsx` — exports `FieldPreview`, the canonical per-type control renderer.

Both the public applicant form (`apply-form.tsx`) and the builder canvas import it. The builder renders it in a non-interactive "preview" mode (controls disabled / not submitting). This guarantees the builder preview matches what applicants see.

### Field-type metadata (single source of truth)

- `src/modules/recruitment/engine/field-types.ts` — a map keyed by every `FieldType`:
  ```ts
  { label: string; icon: LucideIcon; group: "Text" | "Choice" | "Contact" | "DateNumber" | "File" | "Department"; hasOptions: boolean; isFile: boolean }
  ```
  Replaces the raw `FIELD_TYPES` string array and the inline enum text everywhere. Drives the type picker, the row type icons, and which editors render.

### Options handling

- Choice options stored as `[{ value, label }]` (unchanged shape).
- Editor surface exposes only the **label**. On create, `value` is derived from the label via the existing slug utility (same idea as `uniqueKey`) and made unique within the field. On label edit, `value` stays fixed. This removes the value/label confusion and keeps stored answers valid.

### Server actions

`src/app/(app)/recruitment/cycles/[id]/builder/actions.ts` moves from FormData + redirect-on-error to typed-arg actions that return `{ ok: true } | { ok: false; error: string }`, so the client can show inline save state and revalidate. New / changed actions (all `requirePermission("recruitment.manage_cycles")`, all wrapping existing services):

- `addSectionAction(cycleId, input)` — existing service `addSection`.
- `updateSectionAction(cycleId, sectionId, patch)` — wraps existing `updateSection` (title, description, appliesTo, departmentCode). **New wiring.**
- `deleteSectionAction(cycleId, sectionId)` — existing.
- `reorderSectionsAction(cycleId, orderedSectionIds)` — wraps existing `reorderSections`. **New wiring.**
- `addFieldAction(cycleId, sectionId, { type })` — adds a field of the chosen type (label defaults to the type's friendly name; no options initially). Existing `addField`.
- `updateFieldAction(cycleId, fieldId, patch)` — enriched to accept `label`, `helpText`, `required`, `type`, `options`, `validation`, `correctValue`. Wraps existing `updateField` (which already enforces the structural guards). **Enriched.**
- `duplicateFieldAction(cycleId, fieldId)` — reads a field, re-adds a copy in the same section. **New (small).**
- `deleteFieldAction(cycleId, fieldId)` — existing.
- `reorderFieldsAction(cycleId, sectionId, orderedFieldIds)` — wraps existing `reorderFields`. **New wiring.**

Quiz actions: `addQuizSectionAction` stays; `addQuizQuestionAction` simplified (prompt + starter options, correct answer set via the option radio using `updateFieldAction`/`setCorrectAnswerAction`). `setCorrectAnswerAction` stays.

No service-layer changes are required — `reorderFields`, `reorderSections`, `updateField`, `updateSection`, `addField`, `deleteField`, `addSection`, `deleteSection` already exist with the correct guards.

### Components (client, under the builder route)

- `builder/form-builder.tsx` — `FormBuilder` client canvas (receives loaded cycle, holds minimal local order/selection state).
- `builder/quiz/quiz-builder.tsx` — `QuizBuilder` client canvas.
- `builder/section-card.tsx` — `SectionCard` (header + scope chip + gear editor + field list + add-field).
- `builder/field-card.tsx` — `FieldCard` (resting preview via `FieldPreview` + inline editor).
- `builder/options-editor.tsx` — add/remove/reorder choice labels (shared by app + quiz).
- `builder/type-picker.tsx` — `TypePicker` menu driven by `field-types.ts`.
- `builder/sortable-list.tsx` — thin dnd-kit `SortableContext` + sortable item wrapper (handle, keyboard sensors).
- `builder/page.tsx` and `builder/quiz/page.tsx` — become thin server wrappers: load the cycle, render the client canvas.

### Files

**New:**
- `src/modules/recruitment/components/field-preview.tsx`
- `src/modules/recruitment/engine/field-types.ts`
- `src/app/(app)/recruitment/cycles/[id]/builder/form-builder.tsx`
- `src/app/(app)/recruitment/cycles/[id]/builder/section-card.tsx`
- `src/app/(app)/recruitment/cycles/[id]/builder/field-card.tsx`
- `src/app/(app)/recruitment/cycles/[id]/builder/options-editor.tsx`
- `src/app/(app)/recruitment/cycles/[id]/builder/type-picker.tsx`
- `src/app/(app)/recruitment/cycles/[id]/builder/sortable-list.tsx`
- `src/app/(app)/recruitment/cycles/[id]/builder/quiz/quiz-builder.tsx`

**Modified:**
- `src/app/(app)/recruitment/cycles/[id]/builder/page.tsx` — thin server wrapper.
- `src/app/(app)/recruitment/cycles/[id]/builder/quiz/page.tsx` — thin server wrapper.
- `src/app/(app)/recruitment/cycles/[id]/builder/actions.ts` — typed-arg actions returning result objects; new reorder/updateSection/duplicate wiring.
- `src/app/apply/[slug]/apply-form.tsx` — replace inline `Field` with shared `FieldPreview`.
- `package.json` — add `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`.

## Error handling

- Actions return `{ ok, error }`; the client surfaces inline "Saved ✓" / "Couldn't save: <message>" near the affected card and revalidates on success.
- `FormEditError` from the services (e.g. attempting a structural edit on a published cycle) maps to the inline error rather than a redirect bounce. The UI also pre-disables structural controls when not in DRAFT, so this is a backstop.
- Optimistic reorder reverts to server order if the reorder action returns an error.

## Testing

Run against the per-worktree `TEST_DATABASE_URL` (see vitest test-DB isolation note).

- **field-types map:** every `FieldType` enum value has an entry (label, icon, group, flags) — guards against a future enum addition slipping through.
- **FieldPreview:** renders the correct control for each field type; required asterisk and help text appear.
- **Actions:** `reorderFieldsAction` / `reorderSectionsAction` persist order and reject foreign ids; `updateSectionAction` updates safe fields; `updateFieldAction` applies the enriched patch; type change on a published cycle is rejected (structural guard) while a label edit succeeds; `duplicateFieldAction` copies into the same section.
- **Options:** value auto-derivation is stable across label edits.

## Out of scope (v1)

- Cross-section field drag (move a field from one section to another).
- Conditional logic / branching beyond the existing section visibility (`appliesTo` / department).
- A separate "share/preview" route — the canvas is the preview.
- Per-field validation beyond File accepted-types (e.g. min/max, regex).
