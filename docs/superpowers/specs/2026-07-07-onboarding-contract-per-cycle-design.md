# Per-cycle editable onboarding contract

Date: 2026-07-07
Status: Approved (design)

## Problem

The onboarding contract sent via **Send onboarding links** (`/recruitment/cycles/[id]/onboarding` -> `/onboard/[token]`) is a fixed-schema form. Its fields, and the agreement/policy text a volunteer signs, are hardcoded in `onboard-form.tsx` and the `OnboardingContract` Prisma columns. Admins cannot tailor the contract per recruitment cycle. Notably, the "Acknowledgements" section captures a typed-name signature against labels ("Volunteer agreement", "Professionalism policy", "Training acknowledgement") but never displays the actual terms.

Goal: let admins edit **both** the contract's prose (agreements/policies) **and** its fields **per recruitment cycle**, without breaking the downstream promotion/compliance pipeline.

## Decisions (from brainstorming)

1. **Scope:** Both the agreement prose *and* the fields are editable per cycle.
2. **Field tiers (two tiers):**
   - **Core system fields** (name/email, Epic access block, HIPAA) are always present: reorderable and relabelable, but not deletable, and the core ones cannot be un-required. They keep writing their typed `OnboardingContract` columns and driving `promotion.ts`.
   - **Optional built-ins** (date of birth, dietary restrictions, Yale affiliation, graduation year, Spanish, licensed RN, works-with-YNHH, phone, NetID) can be toggled on/off and reordered per cycle.
   - **Custom questions** can be added, removed, and reordered freely.
3. **Template home:** A single global default (master template) seeds every cycle; per-cycle edits override just that cycle. New cycles inherit the current global default until their own copy is edited. Mirrors the recruitment email pattern.
4. **Snapshot at send time:** When "Send onboarding links" fires, the resolved template (prose + field layout) is frozen onto each contract. Later template edits do not change already-sent links. The signed record is exactly what the signer saw.
5. **Prose format:** Sanitized markdown / limited HTML (not a full WYSIWYG). Supports `{{firstName}}`/`{{orgName}}` style variables via the existing `renderTemplate`.
6. **Build order:** Parity-first, three phases (see Phasing).

## Architecture

### Block model

The contract is represented as a **layout**: an ordered JSON array of typed blocks. Three block types map onto the two tiers:

| Block type | Renders as | Answer stored where | Editability |
| --- | --- | --- | --- |
| `system_field` | The existing typed inputs (name, email, NetID, phone, DOB, dietary, Yale affiliation, grad year, Epic block, Spanish, RN, works-with-YNHH, HIPAA upload + date, initials) | Existing typed columns on `OnboardingContract` (unchanged) | Core: reorder + relabel only. Optional: toggle on/off + reorder + relabel. |
| `agreement` | Sanitized prose the signer reads + a "type your full name" signature input | New `signatures Json` column, keyed by block id | Add / remove / reorder / edit prose + title + signature label |
| `custom_question` | Reuses the existing `FieldType` enum + `FieldPreview` renderer | New `customAnswers Json` column, keyed by field key | Add / remove / reorder / edit |

A single ordered layout lets system, optional, and custom blocks interleave and reorder while system blocks keep writing their typed columns, so promotion and compliance behavior never change.

Each `system_field` block references a known **system key** (e.g. `epic`, `hipaa`, `name`, `dob`, `spanish`). A code-side registry maps each system key to: its input renderer, its validation, its target column(s), whether it is core (locked) or optional (toggleable), and its default label/help text. Unknown or removed optional keys simply do not render.

### Layout resolution (mirrors recruitment emails)

Three layers, same shape as `resolveCycleEmail` (descriptor default -> global override -> cycle override):

- **`DEFAULT_CONTRACT_LAYOUT`** — a code constant that reproduces today's form field-for-field. Parity baseline and final fallback.
- **Global default** — settings key `onboarding.contractTemplate` (JSON, validated by a zod schema, `envDefault` = `DEFAULT_CONTRACT_LAYOUT`). The "master template."
- **Per-cycle override** — new model `RecruitmentCycleContract { cycleId @unique, layout Json, updatedAt }`.

```
resolveContractLayout(cycleId):
  cycleOverride?.layout  ??  getSetting("onboarding.contractTemplate")
  // getSetting already falls back to envDefault (DEFAULT_CONTRACT_LAYOUT) when unset
```

A new cycle has no `RecruitmentCycleContract` row, so it renders the current global default. Editing that cycle's contract lazily copies the resolved layout into a `RecruitmentCycleContract` row and edits from there — giving "inherits latest default until you touch it."

### Snapshot at send time

`OnboardingContract` gains `templateSnapshot Json`. In `createOrResendContract` (onboarding.ts), after the existing gates, call `resolveContractLayout(cycle.id)` and freeze the result onto the contract (set on create; also set on resend if still `PENDING` and not yet snapshotted). `/onboard/[token]` renders from `templateSnapshot`. Contracts created before this feature have `templateSnapshot = null` and fall back to `DEFAULT_CONTRACT_LAYOUT`, so nothing breaks on deploy. No backfill required.

## Data model changes

```prisma
model RecruitmentCycleContract {
  id        String   @id @default(cuid())
  cycleId   String   @unique
  layout    Json
  updatedAt DateTime @updatedAt
  cycle     RecruitmentCycle @relation(fields: [cycleId], references: [id], onDelete: Cascade)
}

model OnboardingContract {
  // ... existing columns unchanged ...
  templateSnapshot Json?   // frozen resolved layout at send time; null = pre-feature, use DEFAULT_CONTRACT_LAYOUT
  customAnswers    Json?   // { [fieldKey]: answer } for custom_question blocks
  signatures       Json?   // { [agreementBlockId]: typedName } for agreement blocks
}

model RecruitmentCycle {
  // ... existing ...
  contract RecruitmentCycleContract?
}
```

The existing typed acknowledgement columns (`agreementSignature`, `professionalismSignature`, `trainingSignature`, `initials`) are retained (nullable) so pre-feature rows keep their data. Going forward, **all** agreement-block signatures are stored uniformly in `signatures Json` keyed by block id — including the default layout's three named agreements — so there is a single source of truth for signatures. `initials` remains a `system_field` block writing its existing column. The legacy signature columns are no longer written by new submissions and are not read by promotion. New settings-registry entry: `onboarding.contractTemplate` (category e.g. "Recruitment"/"Onboarding"), edited via a dedicated page rather than the generic settings form.

## Rendering (`/onboard/[token]`)

- Read `templateSnapshot` (or `DEFAULT_CONTRACT_LAYOUT` when null). Render blocks in order.
- `system_field` -> dispatch on system key to the existing input + client behavior (e.g. the `hasEpic` reveal of `existingEpicId`). Submit and validation for these are unchanged; they still write typed columns in `submitContract`.
- `agreement` -> render title + sanitized prose (markdown/limited HTML, run through `renderTemplate` for variables) + a required signature input. Store into `signatures`.
- `custom_question` -> reuse `FieldPreview` / the same input rendering as the application form. Store into `customAnswers`. Validate by `required` + `type`.

`submitContract` is extended to accept and persist `customAnswers` and `signatures`, validating required custom questions and required agreement signatures, alongside the existing typed-field validation.

## Editing surfaces

Both surfaces reuse the same block-editor component and enforce the two-tier rules (system blocks: lock/toggle; agreements + custom questions: full edit; drag reorder across all blocks).

- **Per-cycle:** new builder tab `/recruitment/cycles/[id]/builder/contract`, beside the application and quiz builders, reusing their primitives and server-action patterns. Gated on `recruitment.manage_cycles`. First edit lazily materializes the `RecruitmentCycleContract` row from the resolved layout.
- **Global master:** the same editor mounted on an admin page (under `/admin`), writing `onboarding.contractTemplate` via `setSetting`. Gated on the same permission that guards other admin settings.

Editing is **not** gated on cycle status (unlike the application form's DRAFT gate): snapshotting protects already-sent contracts, and onboarding happens while a cycle is OPEN/CLOSED. Archived cycles are read-only, consistent with existing archive behavior.

## Validation and safety

- Prose is sanitized on render (admin-authored, shown to unauthenticated applicants) to prevent stored XSS. Reuse/extend existing sanitization utilities; allowlist a safe subset of tags.
- Layout JSON validated by a zod schema on write (both surfaces): known block types, unique field keys, valid system keys, core system blocks present and required, valid `FieldType` for custom questions.
- Custom-question keys are unique within a layout and namespaced so they cannot collide with system-field column names in `customAnswers`.

## Phasing (parity-first)

1. **Model + resolution + snapshot + parity rendering.** Add schema, `DEFAULT_CONTRACT_LAYOUT`, `resolveContractLayout`, snapshot on send, and render `/onboard` from the layout. Ships with behavior identical to today (no editing yet). Highest structural risk; isolated and testable.
2. **Per-cycle editor.** The builder tab, block editor, two-tier enforcement, `customAnswers`/`signatures` submit + validation, agreements + custom questions live end-to-end.
3. **Global master editor.** Admin page writing `onboarding.contractTemplate`; new cycles inherit it.

Each phase is independently shippable and reviewable.

## Testing

- **Parity golden:** `/onboard` rendered from `DEFAULT_CONTRACT_LAYOUT` matches today's field set, labels, and required-ness.
- **Resolution precedence:** cycle override > global default > code default; new cycle inherits global default; lazy materialization on first edit.
- **Snapshot immutability:** editing a cycle/global template after send does not change an already-sent contract's rendered form.
- **Promotion intact:** `promotion.ts` still reads system-field columns (Epic request generation, HIPAA cert, Spanish/RN flags, person match) after the refactor.
- **Custom round-trip:** custom question answers and agreement signatures persist and display; required ones block submission when empty.
- **Sanitization:** malicious prose is neutralized on render.
- Note: full DB-backed contract/email tests run in CI, not in worktrees (shared stale Prisma client).

## Non-goals / out of scope

- No change to the recruitment onboarding *email* (already per-cycle editable).
- No change to promotion, compliance, Epic, or Spanish-verification logic beyond reading the same typed columns.
- No WYSIWYG editor; prose is markdown/limited HTML.
- No versioned template history/audit UI beyond the per-contract snapshot (snapshot is the record of what was signed).
- No per-department contract variation (per-cycle only), unless a later iteration adds it.
