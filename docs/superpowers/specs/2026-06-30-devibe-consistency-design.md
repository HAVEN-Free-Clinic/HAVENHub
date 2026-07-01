# De-vibecode / Consistency Hardening (UI cohesion Phase 5)

Date: 2026-06-30
Status: Design (awaiting user review)
Part of: App-wide UI cohesion initiative. Phases 1 to 4 standardized forms, surfaces, page chrome, and controls (PRs #166, #168, #173, #181, all merged). This phase removes the residual "machine-generated" fingerprints a scan of fresh main surfaced.

## Background

A scan of fresh main (commit edc51da) for "AI-generated / vibecoded" tells found the codebase is genuinely clean by the usual measures: zero marketing cliches, zero TODO/FIXME, one `as any` tree-wide, no dead code blocks, no boilerplate JSDoc, no swallowed catches, no smart quotes. Two deep review agents independently rated it "~80% human-polished."

What remains are three specific signatures, all verified firsthand:

1. **Per-file generation that never reconciled against the rest of the tree.** The same small helpers are re-pasted across the codebase while a canonical version already exists: `cx` (14 copies), `fmtDate`/`fmtDateTime` (15 copies), `getActiveTerm` (4 local copies that even drop the request `cache()`), three different idioms for the Prisma P2002 unique-constraint check, and a server-action try/catch-to-redirect skeleton duplicated about 19 times.
2. **Em-dashes plus small copy drift.** About 31 em-dashes in non-test source (the maintainer treats em-dashes as a top AI tell and wants them gone everywhere), four Title Case page headers in an otherwise sentence-case app, an `EPIC` vs `Epic` capitalization split that begins on the public onboarding form, and the volunteers module dropping the trailing period the rest of the app uses.
3. **One latent RBAC bug.** `holders.ts` (the inverse permission resolver) still folds in Director/Volunteer baseline roles from membership kind via a pre-#158 `AUTO_ROLE_KIND` map, while `engine.ts` (the forward resolver) was decoupled in #158 to read kind-target `RoleAssignment` rows only. They agree in the seeded state, but diverge the moment role wiring is edited via the roles page. Comments in `holders.ts` and `system-roles.ts` reference a removed symbol (`MEMBERSHIP_KIND_ROLE`) and contradict `engine.ts`.

## Goal

Eliminate these fingerprints so the codebase reads fully human-authored and stays that way: extract the shared helpers, fix the RBAC divergence with a regression test, sweep all em-dashes and enforce their absence with a lint rule, normalize the copy inconsistencies, and strip the boilerplate banner and path-echo comments.

## Scope: two PRs

The work splits into two PRs for review ergonomics (the user's choice). PR B is stacked on PR A because both touch many of the same files (for example `platform/ui/*.tsx` get `cx` changes in A and banner removal in B); GitHub auto-retargets PR B to main when PR A merges.

- **PR A (substantive):** workstreams A, B, C, D below. Branch `feat/devibe-consistency`, base main.
- **PR B (cosmetic):** workstream E below. Branch `feat/devibe-cosmetic`, base = PR A tip.

This document is the shared design; writing-plans produces one plan per PR.

## Global Constraints

- No em-dashes (`—`) anywhere, including comments and this document. Use commas, colons, semicolons, parentheses, or a plain hyphen.
- Product name is "HAVEN Hub" (two words) in prose and UI; identifiers stay `havenhub`.
- All refactors in workstreams A and E must be output-equivalent: existing tests stay green, and visible output (rendered class strings, formatted dates, page copy) is unchanged except where a copy fix is explicitly specified in workstream D.
- This repo has no tailwind-merge: never rely on a `className` override of a primitive's conflicting base class.
- Do not run `prisma generate` in the worktree (the shared Prisma client is cross-worktree; CI regenerates). Local `tsc` may show pre-existing stale-client errors; "clean" means no new errors in changed files.
- Presentational and behavioral preservation: control `name`/`value`/`defaultValue`/`onChange`/`onClick`/`type` and focus behavior are preserved across every conversion.

---

# PR A: substantive

## Workstream A: de-duplicate helpers (output-equivalent)

### A1. `cx`

Canonical `cx` is currently defined and exported in `src/platform/ui/button.tsx:22`. Create `src/platform/ui/cx.ts` exporting the identical function:

```ts
export function cx(...parts: (string | undefined | false | null)[]): string {
  return parts.filter(Boolean).join(" ");
}
```

Repoint every definition and every importer to `./cx` (or `@/platform/ui/cx`), then delete the 14 local definitions. Definitions are in: `platform/ui/{button,card,radio,alert,combobox,section-header,table,checkbox,badge,select,input,stat-card,form}.tsx` and `modules/recruitment/components/field-preview.tsx`. The authoritative list of definitions and importers comes from grepping `function cx` / `const cx` and `import { ... cx ... }` at plan time. `button.tsx` keeps `buttonClasses` and imports `cx` from `./cx`.

### A2. `fmtDate` / `fmtDateTime`

Add display formatters to the existing `src/platform/dates.ts`. The shared signatures accept the most permissive input the call sites use and reproduce the exact visible format already shipped:

```ts
export function fmtDate(d: Date | null | undefined, fallback = ""): string { ... }
export function fmtDateTime(d: Date | null | undefined, fallback = ""): string { ... }
```

At plan time, read the ~12 `fmtDate` and ~3 `fmtDateTime` local copies (in `schedule/page.tsx`, the five `volunteers/*` pages, `training/page.tsx`, `admin/email/campaigns/page.tsx`, `admin/email/page.tsx`, `admin/notifications/page.tsx`, `notifications/page.tsx`) and confirm they share one format. Collapse the identical ones onto the shared helper. Any call site with a genuinely different format keeps its own local formatter (note it in the plan rather than forcing a false merge). The null/empty rendering must match each call site; where a site rendered the em-dash glyph for null, the empty rendering is reconciled with workstream C (plain hyphen, not em-dash).

### A3. `getActiveTerm`

Use the canonical `getActiveTerm` from `src/platform/terms/active-term.ts` (which is request-memoized via React `cache()`). Replace the 4 byte-identical local redefinitions in `modules/schedule/services/{builder.ts,requests.ts}` and `modules/volunteers/services/{disciplinary.ts,offboarding.ts}` with an import. For the inlined `findFirst({ where: { status: "ACTIVE" } })` occurrences (for example `compliance.ts`, `schedule.ts`, `training.ts`, `roster.ts`, `itcm.ts`), repoint only those that are exact equivalents of the canonical helper (same select, same single-active assumption); leave any that intentionally select differently and note them. This also restores the dropped `cache()` (a small perf win).

### A4. `isUniqueConstraintError`

Add a typed guard to `src/platform/db.ts`:

```ts
import { Prisma, PrismaClient } from "@prisma/client";
export function isUniqueConstraintError(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}
```

Replace the three idioms with this guard: the verbose `typeof err === "object" && "code" in err && ...` form (in `recruitment/services/{interviews.ts,submissions.ts,review.ts,departments.ts}`), the existing `instanceof Prisma.PrismaClientKnownRequestError` form (in `recruitment/services/requests.ts`, `admin/services/rbac.ts`, `airtable/import/importer.ts`), and the loose-cast form (in `admin/services/{terms.ts,people.ts}`). Sites that additionally inspect `err.meta?.target` for a specific constraint keep that check after the guard narrows the type.

### A5. `withActionRedirect` (highest risk)

The server actions in `app/(app)/schedule/builder/page.tsx` (about 11 actions) and `app/(app)/recruitment/actions.ts` (about 7 to 8 actions) repeat: try the service call, catch a typed domain error and `redirect` to an error href, re-throw anything else (so Next's `redirect` sentinel passes through), then `revalidatePath` and `redirect` to a base href.

Add `src/platform/actions.ts` with a wrapper that captures this shape while preserving the Next `redirect` passthrough. The exact wrapper shape is decided at plan time after reading the actions; a sketch:

```ts
// Runs work(), maps a known domain error to an error redirect, revalidates,
// then redirects to success. Next's redirect() throws a NEXT_REDIRECT sentinel
// that must NOT be treated as a domain error: only map errors the caller names.
export async function withActionRedirect(...) { ... }
```

Fallback rule: if an action cannot be expressed through the wrapper without contortion (heterogeneous revalidate targets, multiple catch arms, conditional redirects), leave that action as-is. The wrapper exists to remove genuine duplication, not to force every action into one mold. The plan flags any action left unwrapped with the reason.

### A6. smaller dedup

- `platform/notifications/render.ts` re-implements HTML escaping; import `esc` from `platform/email/render/escape.ts` and delete the local `escapeHtml`.
- `platform/settings/service.ts` duplicates a safeParse-warn-default block in `getSetting` and `getCategory` (lines ~47 and ~87); extract a local `resolveStored(def, raw)` helper in that file.
- Remove genuinely dead exports only where a grep confirms zero non-test callers: `airtable/client.ts` `escapeFormulaString` plus its never-passed `filterByFormula` param; `schedule/services/attendings.ts` `setAttendingActive` (collapse into `updateAttending` if a caller passes `isActive`, else delete); `recruitment/services/submissions.ts` `listApplications`; `recruitment/services/portal-status.ts` `listApplicantApplications`; `recruitment/services/evaluations.ts` `listEvaluations`; `my-info/services/my-info.ts` `getOwnedCertificate`. When a function is deleted, delete its now-orphaned test. If a function turns out to have a non-test caller, leave it untouched.

### A testing

- Add `src/platform/dates.test.ts` cases for `fmtDate`/`fmtDateTime` (format and null/fallback behavior).
- Add `src/platform/db.test.ts` (or extend) for `isUniqueConstraintError` (true on a P2002 known-request error, false on a plain Error and on other codes).
- Add `src/platform/actions.test.ts` for `withActionRedirect`: a thrown Next redirect passes through untouched; a named domain error maps to the error redirect; success path revalidates then redirects.
- `cx` is a trivial join; cover it with one assertion in a `cx.test.ts` only if convenient, otherwise the existing primitive tests exercise it.
- All existing tests stay green (output-equivalence gate).

## Workstream B: RBAC fix

`src/platform/rbac/holders.ts`: delete the `AUTO_ROLE_KIND` map (lines 18 to 21) and the fold-in loop (lines 64 to 68), so `peopleWithAnyPermission` derives kinds only from the matched `RoleAssignment` rows (line 61 already does this). Update the docstring (lines 23 to 33) to drop the "auto-attached baseline" language and state that it walks the same sources as `getEffectivePermissions`.

`src/platform/rbac/system-roles.ts`: fix the comment (lines 3 to 5) that says Director and Volunteer are "auto-attached by the RBAC engine from TermMembership.kind (see engine.ts MEMBERSHIP_KIND_ROLE)". Replace with the post-#158 truth: baseline Director/Volunteer access is provisioned as kind-target `RoleAssignment` rows (seed plus backfill migration), not auto-attached in code.

Test (`src/platform/rbac/holders.test.ts`, new or extended): seed a Director kind-target `RoleAssignment` granting a permission to DIRECTOR members in the active term, assert `peopleWithAnyPermission([perm])` returns an active DIRECTOR member; then remove that kind-target assignment and assert the member is no longer returned. This proves the inverse resolver now agrees with the forward resolver and no longer auto-folds. Cross-check that a permission reachable only through the deleted wiring is not reported.

## Workstream C: em-dash sweep plus guardrail

### C1. the guardrail (added first, so it drives the sweep)

esquery cannot match comment text, so a `no-restricted-syntax` selector cannot catch em-dashes in comments. Add a small inline custom rule in `eslint.config.mjs` that scans raw source text and reports every em-dash, including in comments and strings:

```js
const noEmDash = {
  meta: { type: "problem", docs: { description: "Em-dash reads as AI-generated" } },
  create(context) {
    const src = context.sourceCode;
    return {
      Program(node) {
        const text = src.getText();
        for (let i = text.indexOf("—"); i !== -1; i = text.indexOf("—", i + 1)) {
          context.report({ node, loc: src.getLocFromIndex(i),
            message: "Em-dash reads as AI-generated; use a comma, colon, parentheses, or hyphen. Add an eslint-disable-next-line local/no-em-dash with a reason if genuinely required." });
        }
      },
    };
  },
};
```

Register it as a new flat-config block scoped to `src/**/*.{ts,tsx}` via `plugins: { local: { rules: { "no-em-dash": noEmDash } } }` and `rules: { "local/no-em-dash": "error" }`. Reporting at the em-dash's own line lets `eslint-disable-next-line local/no-em-dash` on the preceding line work. The config file and markdown are not linted; the sweep handles those by hand.

Verification: a negative check (add an em-dash in a `.ts` file, confirm `eslint` errors, remove it). After the rule is added, `npm run lint` lists every remaining em-dash, which becomes the authoritative completeness checklist for C2.

### C2. the sweep

Replace every em-dash flagged by the rule across `src/**` (including test files, so lint is globally green). Known user-facing copy and the intended replacement:

- `modules/admin/components/epic-request-form.tsx:381` `— choose a department —` becomes `Choose a department`.
- `epic-request-form.tsx:328,384` `{code} — {name}` separator becomes a colon or a middot, matching the app's existing separator usage.
- `app/(app)/training/training-quiz.tsx:100` becomes a sentence break (period or colon).
- `training-quiz.tsx:183` `All questions answered — ready to submit.` becomes `All questions answered. Ready to submit.`
- `app/(app)/schedule/page.tsx:223` becomes a comma.
- `schedule/page.tsx:364,370` the `"—"` empty-value glyph becomes a plain hyphen `"-"`.
- `app/(app)/admin/itcm/page.tsx:57` becomes a period.
- `app/(app)/admin/email/campaigns/[id]/page.tsx:245,247` become periods (`Scheduled. Waiting to send.`, `Recurring. Sends on a schedule.`).

Comment em-dashes (about 20, concentrated in `modules/admin/services/itcm-pdf.ts` and `app/api/admin/itcm/generate/route.ts`, plus singles across platform and modules) become commas, colons, semicolons, or parentheses as reads best. Also fix the en-dash in `src/platform/dates.ts:18` (`Mon–Fri` becomes `Monday to Friday`) so no fancy dash remains in that file.

## Workstream D: copy consistency

- Sentence-case the four Title Case page headers: `volunteers/master/page.tsx:172` (`Master compliance view`), `volunteers/epic/page.tsx:381` (`Epic requests`), `volunteers/disciplinary/page.tsx:265` (`Disciplinary actions`), `admin/audit/page.tsx:41` (`Audit log`).
- Normalize `EPIC` to `Epic` in user-facing copy: `app/onboard/[token]/onboard-form.tsx:126,129,133,137` and `platform/email/templates/recruitment.ts:70`. Grep for any other all-caps `EPIC` in copy.
- Add the trailing period the rest of the app uses to the volunteers module page descriptions: `volunteers/page.tsx:138,156`, `volunteers/offboarding/page.tsx:114`, `volunteers/master/page.tsx:173`, `volunteers/epic/page.tsx:382`, `volunteers/disciplinary/page.tsx:266`.
- Replace raw glyphs used as UI with Lucide icons: `modules/clinic/avs/avs-tool.tsx:173,214` (`✕` becomes `<X />`), `app/(app)/learning/[courseId]/ScormPlayer.tsx:139` (`✓` becomes `<Check />`, keeping the numbered fallback). Confirm whether `schedule/components/builder-cell.tsx` renders a glyph as button content and convert it too if so.
- `app/(app)/training/page.tsx:190` `What this unlocks` becomes plain language (for example `What you can do now`).
- Align casing for repeated labels: `Back to hub` / `Back to Hub` to `Back to Hub` (`training/page.tsx:266`, `not-found.tsx:27`); `My info` quick action to `My Info` (`page.tsx:232`) to match the module name and registry.
- Normalize the admin email descriptor names to one convention (the `Category: detail` form already used by `recruitment.ts`, applied to the Title Case names in `compliance.ts:181,231,249` and `epic.ts:154,180`).
- Light touch on the repeated `to get started.` tails and `Manage <title>` openers (`recruitment/page.tsx:64`, `admin/email/campaigns/new/page.tsx:25`, `admin/components/epic-request-tabs.tsx:83`, and the admin terms/roles/departments/subcommittees descriptions): trim the filler where it adds nothing. Do not over-rewrite; this is the lowest-priority item in PR A.

## PR A verification

`npm run lint` green (new em-dash rule passes, controls rule still passes), `npx tsc --noEmit` shows no new errors in changed files, the full test suite green (the new util/RBAC tests plus all existing tests, proving output-equivalence).

---

# PR B: cosmetic comment cleanup

Stacked on PR A. Pure comment and micro-cleanup, no behavior change.

## Workstream E

- **Path-echo headers (mechanical):** delete the line-1 `// src/...` path-echo comment in the ~36 files that have one (authoritative list from grepping a line-1 `// src/` header). A comment restating the file's own path adds nothing and rots on move.
- **Name-only banners (judgment):** remove `// -----` divider banners whose only content is a single symbol name that restates the declaration directly below it (for example `// createTicket` over `function createTicket`). Keep banners that group multiple related declarations into a meaningful section (for example the `LogTransport` / `GraphTransport` section dividers in `platform/email/transport.ts`). About 80 files contain dash banners; the worst name-echo pockets are `modules/volunteers/services/epic.ts`, `modules/schedule/services/{builder.ts,requests.ts}`, `modules/admin/services/itcm.ts`. Group the work by directory in the plan rather than one task per file.
- **Empty banner:** delete the empty `// Sub-components` banner in `modules/admin/components/roles-panel.tsx:54-56`.
- **Single-statement transaction:** unwrap the single-statement `$transaction` in `src/platform/people.ts:85` (and the similar spots near 185 and 204) into a plain awaited call.
- **Self-contradicting assertion:** in `app/(app)/recruitment/cycles/[id]/builder/options-editor.tsx:23`, replace `orderedIds.map((id) => options.find(...)!).filter(Boolean)` with a `flatMap` (or equivalent) that does not both assert non-null and then filter null.
- **Restate comments:** remove or replace with a why-comment the small set of comments that restate the code: `volunteers/epic/page.tsx:133` (`// Fetch data`), the bare `// Render` labels across about 8 page files, `modules/schedule/services/builder.ts:766`, and the duplicated comment in `modules/schedule/engine/map.ts:27,41`.

## PR B verification

`npm run lint` green, `npx tsc --noEmit` no new errors, full test suite green. Because workstream E is comment-and-cleanup only, the test suite passing plus a `git diff` review (no logic lines changed beyond the unwrap and the flatMap) is the completeness gate.

---

## Non-goals

- Re-migrating forms, surfaces, headers, or controls (Phases 1 to 4).
- A semantic-token sweep for pre-existing non-token palette classes (for example the ScormPlayer teal); logged separately.
- The epic-panel duplicate "Epic Access" heading content restructure; logged separately.
- Rewriting human-drafted long-form copy (login, welcome, onboarding gate, email bodies): the scan rated these strong; only the specific consistency fixes in workstream D apply.

## Risks and mitigations

- **`withActionRedirect` and Next `redirect` passthrough:** the highest-risk task. Mitigation: the explicit fallback to leave heterogeneous actions unwrapped, plus the `actions.test.ts` redirect-passthrough case and the existing action tests.
- **RBAC behavior change:** mitigated by the regression test that pins forward/inverse agreement, and by the change being a deletion of a redundant fold-in (the seeded state already agrees).
- **Em-dash rule false scope:** the rule covers only `src/**/*.{ts,tsx}`; the config file and markdown are swept by hand. The negative check proves the rule fires; `npm run lint` proves the sweep is complete.
- **Banner-removal judgment (PR B):** the keep-meaningful-section-dividers rule plus a `git diff` review prevent stripping useful structure.
- **Stale shared Prisma client:** do not `prisma generate`; CI regenerates. Local `tsc` baseline noise is expected.

## Open questions

None blocking.
