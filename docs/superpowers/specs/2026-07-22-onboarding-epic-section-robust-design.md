# Onboarding Epic section: don't re-collect what we already have

Date: 2026-07-22
Status: approved, ready to implement

## Problem

The Epic Access section of the onboarding contract collects information it does
not need to:

- It asks a returning member for their Epic ID even when we already have one on
  file for that person (`Person.epicId`). Promotion already prefers the stored
  id, so the collection is pure redundancy.
- It asks the applicant to choose an "access type" (new vs
  reactivation/renewal/modification). IT decides the account modification type,
  not the applicant.
- It always shows "I am a licensed RN", which is unrelated to Epic and no longer
  wanted on this form.
- It always shows "I currently work with Yale New Haven Hospital", which is only
  relevant when the applicant is entering an existing Epic ID we would have to
  modify.
- It shows the whole section even for departments that never use Epic.

The stacked checkboxes read as a confusing pile rather than a clear branch.

## Design

Two facts, both known server-side at render, drive the section:

- **`storedEpicId`** — the Epic ID already on file for this applicant, found by
  the same match promotion uses: `Person` by `netId` (case-insensitive), else by
  `contactEmail`. Null for a brand-new applicant with no `Person` yet.
- **`epicRequirement`** — the department's requirement (`ALL` / `NONE` / `SOME`),
  already computed and threaded into the onboarding context.

### Three states

1. **On file** (`storedEpicId` present): a read-only confirmation, "Your Epic ID
   (`<id>`) is already on file. No action needed." No inputs. Shown regardless of
   the department requirement, since having an id means there is nothing to
   collect.
2. **Needs Epic, none on file** (no `storedEpicId`, and requirement `ALL`, or
   `SOME` where the applicant answers the Epic-needed question yes): one question,
   "Do you already have a Yale Epic account?"
   - Yes -> enter the existing Epic ID, plus "I currently work with Yale New
     Haven Hospital" (only here).
   - No -> "We will set up your Epic account. Directions follow after you
     submit." No inputs.
3. **Not needed** (no `storedEpicId`, requirement `NONE`): the whole Epic section
   is hidden.

### Removed from the onboarding default layouts

- The `epicAccessType` select (IT decides the modification type).
- The `epicIdExpiration` field (IT tracks expiry).
- The `licensedRN` field.
- The standalone always-on `worksWithYnhh` checkbox (folded into state 2-Yes).

The `licensedRN`, `epicAccessType`, and `epicIdExpiration` columns and system
field types are RETAINED (a legacy contract snapshot may still reference them,
and the builder can still add them); they are only dropped from the shipped
default volunteer/director layouts.

## Visibility mechanism (client/server parity)

Client (`onboard-form.tsx`) and server (`submitContract`) must compute the same
visibility for the same submission, or a required field could be shown-but-not-
validated or validated-but-not-shown. Both already build an answers map via
`buildContractAnswers(formAnswers, context)` and filter through
`visibleContractBlocks`. This work:

- Adds `storedEpicId: string | null` to `ContractContext`.
- Derives one synthetic answer key in `buildContractAnswers`:
  `epicSection = (storedEpicId || epicRequirement !== "NONE") ? "show" : "hide"`.
  It depends only on the two authoritative context facts, not on any interactive
  answer, so it is static and identical on both sides.
- Gates the `sec_epic` section block AND the `epic` system-field block on
  `visibleWhen: { field: "epicSection", op: "is", value: "show" }`. The `epic`
  field is core, so this uses a code-authored condition in the default layout
  (the builder's core-field guard is unaffected; nothing in the Epic block is
  unconditionally required at submit, so hiding it creates no dead end).

The server must therefore also look up `storedEpicId` (same match) and pass it in
the context, so its `epicSection` matches the client's.

The internal three-state branching (on file vs collection) lives in the
`epicBlock` render, driven by `ctx.storedEpicId`. For a `SOME` department where
the applicant answers the Epic-needed question "no", the section still shows (to
carry the answered question) and the collection simply stays unchecked and
unrequired; `epicNeeded` resolves false via the existing `resolveEpicNeeded`.

## Submit changes

- `actions.ts` / `submitContract`: stop reading `epicAccessType` from the form
  (no longer collected). Keep `existingEpicId` (required when `hasEpic`) and
  `worksWithYnhh`. The `epicNeeded` derivation and the concurrency-safe claim are
  unchanged.
- No promotion change: `promotion.ts` already prefers `person.epicId` over the
  contract value and only raises an `EpicRequest` when `epicNeeded && !effectiveEpicId`.

## Testing

- `buildContractAnswers` derives `epicSection` correctly for the cross product of
  `{storedEpicId set/null}` x `{ALL, NONE, SOME}`, and the authoritative keys
  still win (Task-4 security property).
- Render: on-file shows the id and no inputs; needs-Epic shows the question and,
  on Yes, the id field + the YNHH checkbox and NOT the access-type select;
  not-needed hides the section and the epic block.
- Client and server compute the same `epicSection` for the same context (a shared
  fixture asserted on both sides).
- Submit: an on-file applicant submits with no Epic inputs; a needs-Epic Yes
  applicant is still required to enter the id; `epicAccessType` is no longer read.
- Default layouts: no `licensedRN` / `epicAccessType` / `epicIdExpiration` blocks;
  `sec_epic` and `epic` carry the `epicSection` condition; both layouts still pass
  `assertTwoTier` and `parseContractLayout`.

## Out of scope

- Expiration/renewal prompting when a stored id is near expiry (`Person` stores
  only the id today, not an expiry). Noted as a possible follow-up.
- Removing `licensedRN` from the rest of the app.
