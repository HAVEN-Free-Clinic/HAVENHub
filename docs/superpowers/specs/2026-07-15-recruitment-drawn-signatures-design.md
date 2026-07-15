# Drawn signatures for recruitment forms

**Date:** 2026-07-15
**Status:** Approved design, pending implementation plan
**Branch:** `feat/recruitment-drawn-signatures`

## Problem

The recruitment module asks people to "sign" and "initial" in two places, and both
capture only typed text today:

1. **Onboarding contract** (`/onboard/[token]`), signed by accepted volunteers. Its
   agreement blocks (Volunteer Agreement, Professionalism Policy, Training
   Acknowledgement) are "signed" by typing a full name into a text box, and there is a
   separate typed **initials** field.
2. **Application form** (`/apply/[slug]`), filled out by applicants. It has 12 field
   types (`SHORT_TEXT`, `FILE`, etc.) and no signing concept at all.

We want people to be able to **draw** an actual signature (finger, mouse, or stylus)
instead of typing a name, in both flows.

### Constraint discovered during research

The onboarding contract's stored signatures are currently **write-only**. Nothing in
the app displays, exports, or emails them after signing, and promotion-to-Person
discards them. A typed name that is never shown is harmless, but a *drawn* signature no
one can view has no value. Making this feature meaningful therefore requires building
the first display surface for contract signatures (see Section E3). This was approved as
in-scope.

## Decisions (agreed with product owner)

- **Scope:** both flows. Drawn signature replaces typed signing in the onboarding
  contract, AND a new `SIGNATURE` field type is available in the application form
  builder.
- **Sign method:** draw pad primary, with a "type instead" fallback (accessibility and
  keyboard/screen-reader users). Typed fallback rasterizes the name to the canvas so the
  stored artifact is always a PNG.
- **Contract UX:** sign each block separately (a pad per agreement block + one for
  initials), not draw-once-reuse.
- **Storage:** always a private PNG in Vercel Blob, reusing existing storage
  infrastructure. Not base64 in the DB row.
- **Build approach:** thin in-house `SignaturePad` primitive wrapping the `signature_pad`
  npm library (~10KB, zero-dependency, MIT), rather than hand-rolling canvas math for a
  legally weighty field.
- **Admin viewer:** include a minimal signed-contract view now (the payoff surface).

## Architecture overview

```
SignaturePad primitive (client)
  canvas + toolbar (clear/undo) + "type instead" toggle
  -> writes data:image/png;base64 into a hidden <input name={key}>
     plus hidden {key}__method and {key}__name

Application form (/apply)
  builder: new SIGNATURE FieldType (registered across type registry/preview/schema)
  wizard: renders live <SignaturePad> (special-cased like FILE)
  submit: submissions.ts decodes data URL -> Blob PNG, stores file-ref in answers JSON
  display: applicant review thumbnail; admin detail inline <img> via existing file route

Onboarding contract (/onboard/[token])
  contract-field.tsx: agreement + initials render <SignaturePad>
  actions.ts: sig__* / initials harvest carries data URLs (existing prefix loop)
  submitContract: decode -> Blob PNG, store structured record in signatures JSON
  display: NEW admin signed-contract page inlines blobs server-side as data URIs
```

Only one schema change: add `SIGNATURE` to the `FieldType` enum. No new columns.

## A. `SignaturePad` primitive

New client component `src/platform/ui/signature-pad.tsx`.

- Wraps `signature_pad` on a `<canvas>` with a signing baseline. High-DPI (`devicePixelRatio`)
  scaling, `touch-action: none`, pointer events for finger/mouse/stylus. Handles resize.
- Toolbar: **Clear** and **Undo** (pop last stroke).
- **Type instead** toggle: reveals a text input; on input, rasterizes the name to the
  canvas in a cursive stack (`'Snell Roundhand','Segoe Script',cursive`). Output is always
  a PNG, so storage and display have a single path.
- **Value transport:** writes the canvas as `toDataURL("image/png")` into a hidden
  `<input name={name}>`, plus hidden `<input name={`${name}__method`}>` (`draw`|`type`) and
  `<input name={`${name}__name`}>` (printed name). Both the apply wizard and the contract
  form already serialize via `new FormData(form)`, so no submit-plumbing changes are needed.
- **Props:** `name: string`, `label: string`, `required?: boolean`, `personName?: string`
  (prefills typed fallback + printed name), `defaultValue?: string` (existing PNG data URL
  for redraw on draft resume), `error?: string`.
- **Required UX:** empty canvas counts as unsigned; shows an inline error and blocks
  submit. Accessible: labeled, error wired with `aria-describedby` matching the existing
  contract-field pattern.
- Styling follows platform primitives (Card radii, muted toolbar buttons); no new tokens.

## B. Storage and data model

Every signature becomes a **private PNG in Vercel Blob** via `storage.ts` `putObject`
(`access: "private"`). Audit context stored alongside: `method` (`draw`/`type`), `name`
(printed name), `signedAt` (**server-stamped** ISO string, client time never trusted).

- **Application form** (`Application.answers` JSON): a SIGNATURE answer uses the same
  file-ref shape as FILE, extended with audit fields, so it inherits the existing download
  route:
  ```ts
  answers[key] = { storedName, fileName, mimeType: "image/png", size, method, name, signedAt }
  ```
  Blob key: `recruitment/<cycleId>/<safeKey>-<uuid>.png` (existing `persistFiles` convention).
- **Onboarding contract** (`OnboardingContract.signatures` JSON): shape changes from
  `Record<blockId, string>` (typed name) to:
  ```ts
  Record<blockId, { method: "draw" | "type"; name: string; imageKey: string; signedAt: string }>
  ```
  keyed by each agreement id and by `"initials"`. Blob key:
  `onboarding/<contractId>/sig-<blockId>.png`. The legacy `initials` String column keeps
  receiving the printed name for continuity (nothing else reads it).

**Schema:** add `SIGNATURE` to `enum FieldType` in `prisma/schema.prisma`; migration trimmed
to `ALTER TYPE "FieldType" ADD VALUE 'SIGNATURE'`. Follow the enum-add and
`prisma migrate status`-before-Neon-deploy caveats. No new columns.

## C. Application form: `SIGNATURE` field type

Registration touch points (each existing switch has a text-input `default`, so all must be
updated or SIGNATURE silently renders as a text box):

1. `prisma/schema.prisma`: `FieldType` enum value + migration.
2. `src/modules/recruitment/engine/field-types.ts`: new `"Signature"` group (add to
   `FieldGroup` union, `FIELD_TYPE_META` entry with a Lucide icon, `FIELD_GROUP_ORDER`).
3. `src/app/(app)/recruitment/cycles/[id]/builder/type-picker.tsx`: add `"Signature"` to
   `GROUP_LABELS` (and fix the pre-existing missing `"Subcommittee"` label while here).
4. `src/modules/recruitment/components/field-preview.tsx`: SIGNATURE renders a static
   placeholder ("Applicant will sign here"), keeping the builder preview lightweight.
5. `src/app/apply/[slug]/apply-wizard.tsx`: special-case SIGNATURE (as FILE is) to render
   the live `<SignaturePad>` with prefill/`defaultValue` from draft answers.
6. `src/modules/recruitment/engine/schema-builder.ts`: validate SIGNATURE as a
   required-capable `data:image/png;base64,` string.
7. `src/modules/recruitment/services/submissions.ts`: for each SIGNATURE field, read
   `answers[key]` (data URL) plus its companions `answers[`${key}__method`]` and
   `answers[`${key}__name`]`, decode the data URL to a Blob PNG (mirror FILE persistence +
   rollback), write the audit-extended file-ref into `answers[key]`, and **delete the two
   companion keys** so they never persist as stray answers. Draft autosave may transiently
   store the companions; that is harmless and they are cleaned at submit.

The onboarding contract builder's custom-question `TypePicker` is intentionally NOT given
SIGNATURE, because agreement blocks are already the contract's signing mechanism.

## D. Onboarding contract: draw pads per block

- `src/app/onboard/[token]/contract-field.tsx`: replace `<Input name="sig__<id>">`
  (agreement branch) and `<Input name="initials">` (system-field branch) with
  `<SignaturePad>`, prefilled `personName` from the contract's known name.
- `src/app/onboard/[token]/actions.ts`: the existing prefix loop harvests every `sig__*`
  key, so it must be updated to recognize the pad's companion inputs. For a block `id` the
  form now carries `sig__<id>` (data URL), `sig__<id>__method`, and `sig__<id>__name`; the
  loop groups these three into one entry rather than treating `__method`/`__name` as
  separate signature blocks. The `initials` pad likewise carries `initials`,
  `initials__method`, `initials__name`. Harvest produces a structured
  `Record<blockId, { method, name, dataUrl }>` passed to `submitContract`.
- `src/modules/recruitment/services/onboarding.ts` (`submitContract`): decode each data URL
  to a Blob PNG, build the structured `{ method, name, imageKey, signedAt }` record per
  block, retain the existing required-signature validation against the frozen
  `templateSnapshot`. Rollback written blobs on transaction failure.

## E. Display surfaces

1. **Applicant review step** (`src/app/apply/[slug]/wizard-review.tsx`): `formatFieldValue`
   gains a SIGNATURE case rendering a small thumbnail of the drawn PNG.
2. **Admin applicant detail**
   (`src/app/(app)/recruitment/cycles/[id]/applicants/[applicationId]/page.tsx`): render
   the SIGNATURE answer inline as `<img>` via the existing download route
   (`.../files/<key>?inline=1`; `image/png` is already inline-safe).
3. **NEW admin signed-contract view**
   (`src/app/(app)/recruitment/cycles/[id]/onboarding/[contractId]/page.tsx`): a server
   component gated by the existing reviewer scope. Shows each agreement + its rendered
   signature image + printed name + `signedAt`, plus initials. Reads the private blobs
   **server-side via `getObject`** and inlines them as data URIs, so no new public route is
   needed and blobs stay private. Handles the **legacy shape** (old contracts whose
   `signatures[id]` is a plain string render as typed text). The onboarding status table
   (`.../onboarding/page.tsx`) gains a "View" link into this page.

## F. Validation, security, backward compatibility

- Server validates each incoming signature string is `data:image/png;base64,...`,
  size-capped (reject > ~1MB), before decoding. Rejects other MIME types.
- `signedAt` is stamped server-side.
- Backward compatibility: only the new admin contract view reads signatures, and it handles
  both the old string shape and the new object shape. Existing submitted applications are
  unaffected (SIGNATURE is a net-new field type; no existing app has one).
- Draft autosave: the signature data URL rides along in the draft `answers` and re-hydrates
  the pad on resume via `defaultValue`. Conversion to Blob happens only at submit.

## G. Testing

- **Unit:** pad serializes a non-empty PNG data URL; typed fallback rasterizes a non-empty
  PNG; data-URL decode helper enforces `image/png` + size cap and rejects malformed input.
- **Server:** required SIGNATURE rejects an unsigned (empty) submission; `submitApplication`
  converts the data URL to a Blob file-ref in `answers`; `submitContract` writes the
  structured per-block record; admin contract view renders both legacy-string and
  new-object shapes.
- **E2E (Playwright):** draw on the canvas via pointer events, submit, and assert the admin
  sees the image, for both the application SIGNATURE field and the onboarding contract.
  Follow the project's test-DB isolation (per-worktree `TEST_DATABASE_URL`, never Neon).

## H. Dependencies and migration

- Add `signature_pad` to `package.json`.
- Prisma migration limited to the `FieldType` enum addition; run `prisma migrate status`
  before any Neon deploy; be mindful that preview deploys share the prod Neon branch.

## Out of scope

- Draw-once-reuse across contract blocks (explicitly chose per-block signing).
- Bundling a custom signature webfont (system cursive stack is sufficient; the legal record
  is the stored typed name + timestamp, the cursive is cosmetic).
- Signature capture anywhere outside the recruitment module.
- Exporting signed contracts to PDF (no contract PDF exists today; not requested).
