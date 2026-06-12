# After Visit Summary (AVS) Generator — Design

**Date:** 2026-06-11
**Status:** Approved, pending implementation plan
**Branch:** `feat/avs-generator`

## Summary

A point-of-care tool that lets a clinical volunteer fill out a short form during
a patient visit and generate a downloadable, branded After Visit Summary PDF in
English or Spanish. The tool is entirely client-side and ephemeral: no patient
data (PHI) is ever persisted or sent to a server. It is inspired by a standalone
HTML prototype (`haven_hub.html`) but trimmed to the clinical core and rebuilt on
HAVEN Hub's existing stack and design language.

## Goals

- Let an onboarded clinical volunteer produce a clear, patient-facing visit
  summary at the point of care.
- Offer the summary in English or Spanish.
- Keep the compliance burden minimal: no PHI at rest, no PHI sent to third
  parties.
- Reuse HAVEN Hub's UI kit and conventions; add as little new surface area as
  possible.

## Non-Goals

- No storage, retrieval, or editing of past summaries (ephemeral by design).
- Not an EMR or a replacement for Epic; this produces a handout, not a record.
- No Free Care status or Specialist Referral sections (those depend on tools and
  programs not being built here). Deferred from the prototype.
- No machine translation of free-text PHI fields (see Translation below).
- No automated/free online translation services.

## Key Decisions (from brainstorming)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| PHI handling | Ephemeral, no storage | Lowest compliance burden; matches prototype |
| Placement | Dedicated route for clinical volunteers (`/clinic/avs`) | Point-of-care use, not an admin tool |
| Role labels | Generic "Provider" / "Clinician" | No SCTP/SCTS terminology hardcoded |
| Output | Generated PDF download | Polished, consistent handout |
| PDF language | Staff picks EN **or** ES per PDF | Single-language document per generation |
| Translation | Approach A — static ES table; free text prints as typed | No PHI leaves the browser; clinic-reviewable strings |
| Sections | Clinical core (5 sections) | Trim Free Care + Referrals |

## Architecture

The tool is a single client-side React page. There is **no API route, no server
action, and no database model**. The flow is:

1. `page.tsx` (server component) calls `requirePersonSession()` to ensure the
   user is an onboarded, signed-in volunteer, then renders the client tool.
2. `avs-tool.tsx` (`'use client'`) holds all form state in a `useReducer`,
   validates required fields, and on **Generate PDF** maps the state into a
   structured, localized summary model and renders it to a PDF in the browser.
3. The PDF is produced client-side with `@react-pdf/renderer` and downloaded via
   an object URL. Patient data never leaves the browser.

### Data flow

```
form state (AvsData)
  --> validate required fields (inline errors if missing)
  --> build-summary.ts: AvsData + lang --> LocalizedSummary
  --> avs-pdf.tsx: LocalizedSummary --> PDF blob (@react-pdf/renderer)
  --> browser download
```

## Components / Units

Each unit has one clear purpose and a well-defined interface.

### `src/app/clinic/avs/page.tsx` (server)
- **Does:** Auth gate (`requirePersonSession()`) and renders `<AvsTool />`.
- **Depends on:** `src/platform/auth/session.ts`.

### `src/app/clinic/avs/avs-tool.tsx` (`'use client'`)
- **Does:** Renders the stacked-section form, manages state, validates, triggers
  generation and download. Holds the EN/ES toggle.
- **Interface:** Self-contained page component, no props.
- **Depends on:** UI kit (`Card`, `Field`/`Input`, `Button`, chips, `Alert`),
  `types.ts`, `strings.ts`, `build-summary.ts`, `avs-pdf.tsx`.

### `src/modules/clinic/avs/types.ts`
- **Does:** Defines `AvsData` (form state), `Medication`, `ActionItem`,
  `LocalizedSummary`, and the `Lang = "en" | "es"` type.
- **Depends on:** nothing.

### `src/modules/clinic/avs/strings.ts`
- **Does:** Typed EN/ES dictionaries for all controlled content — section
  headings, field labels, the vitals / labs / community-resource /
  financial-resource option lists, follow-up timeframes, and the fixed footer
  disclaimer. Exported as `STRINGS: Record<Lang, AvsStrings>` plus the localized
  option lists.
- **Interface:** A single typed `AvsStrings` shape so every EN key must have an
  ES counterpart; a missing key is a TypeScript error.
- **Depends on:** `types.ts`.

### `src/modules/clinic/avs/build-summary.ts`
- **Does:** Pure function `buildSummary(data: AvsData, lang: Lang):
  LocalizedSummary`. Resolves controlled values to localized labels, passes
  free-text fields through unchanged, and omits empty sections.
- **Depends on:** `types.ts`, `strings.ts`.

### `src/modules/clinic/avs/avs-pdf.tsx`
- **Does:** Exports an `<AvsDocument summary={...} />` `@react-pdf/renderer`
  `Document`: branded header (clinic name + visit date), patient info bar, one
  block per populated section, footer disclaimer. Built-in Helvetica (covers
  Spanish accents) for v1; brand-color accents. Multi-page flow handles long
  medication lists.
- **Depends on:** `@react-pdf/renderer`, `types.ts`.

### Entry point
- A link to `/clinic/avs` added to the appropriate navigation surface for
  clinical tools (exact location to be confirmed during implementation).

## Sections (form content)

1. **Patient info** — First, Last (required), DOB (optional), Visit date
   (required), Preferred language (EN/ES), Provider/Clinician name, optional ID.
2. **Visit summary** — Primary reason (required), Diagnoses (free text), Clinical
   notes in plain language (free text), Vitals reviewed (multi-select chips).
3. **Medications** — repeatable rows: name, dose/instructions, lowest-cost
   source note. Add/remove.
4. **Next steps** — Follow-up timeframe + note, Labs/tests ordered (multi-select),
   Action items (repeatable list), Lifestyle recommendations (free text).
5. **Resources** — Community + Financial resource checklists (controlled
   vocabulary), plus one custom-resource free-text line.

Required fields: Last name, Visit date, Primary reason.

## Translation (Approach A)

- All **controlled content** (headings, labels, option lists, disclaimer) is
  authored in both EN and ES in `strings.ts`. The language toggle selects the
  dictionary used for the generated PDF.
- The **four free-text fields** (diagnoses, clinical notes, lifestyle
  recommendations, custom resource) print exactly as the provider typed them, in
  whatever language they wrote. They are never sent to a translation service.
- Result: a Spanish-preferring patient receives a fully Spanish *structure* with
  the clinical specifics in the provider's words. No PHI leaves the browser; the
  Spanish strings are finite and reviewable by the clinical team.

## Error Handling

- Required-field validation runs on Generate; missing fields show inline errors
  and block PDF creation (an `Alert` summarizes what is missing).
- PDF generation is async and client-side; failures surface a non-blocking error
  `Alert` and leave the form intact.
- Empty optional sections are omitted from the PDF rather than printed blank.

## Testing

- `build-summary.ts`: unit tests for state→model mapping — section omission, med
  rows, action items, language selection, free-text passthrough.
- `strings.ts`: a test asserting structural parity between the EN and ES
  dictionaries (every key present in both), enforcing translation completeness.
- `avs-pdf.tsx`: a smoke test via `renderToBuffer` asserting a non-empty PDF for
  a representative payload in both languages.
- Client form interactions get light coverage; core logic lives in the pure,
  testable modules.

## Dependencies

- Adds **`@react-pdf/renderer`** for client-side PDF generation of flowing,
  multi-page content. (The existing `pdf-lib` precedent fills fixed-field
  templates, which does not fit variable-length, multi-section content.)

## Risks / Open Items

- **New dependency** (`@react-pdf/renderer`): bundle size on the `/clinic/avs`
  route; acceptable for a dedicated tool, and it is loaded client-side only on
  that page.
- **Spanish string accuracy:** machine-free, but the static ES table should be
  reviewed by a Spanish-speaking clinical team member before relying on it.
- **Entry-point placement:** exact nav location to confirm during implementation.
- **Fonts:** v1 uses built-in Helvetica; switching to the brand Hanken font later
  requires registering and bundling the font with `@react-pdf/renderer`.
