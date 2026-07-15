# HAVEN Hub - Full-App UI/UX, Accessibility & Production-Readiness Audit (2026-07-11)

Fourth full-app audit, and the first to target the **UI/UX + accessibility + production-readiness** layer. The three prior passes (2026-07-09, and the two 2026-07-10 passes) were correctness / security / data-integrity bug hunts and exhausted that surface: zero critical and zero high defects remained after the third pass. This audit deliberately turns to what those passes did not cover: accessibility (WCAG 2.1 AA), light/dark theming discipline, responsive + touch behavior, performance, design-system consistency, copy hygiene, and route error/loading/empty-state coverage.

- **Baseline:** fresh `origin/main` @ `2203302`, deps installed clean.
- **Method:** 20 finders (13 module deep-dives + 7 cross-cutting sweeps) measured against the actual design system, feeding a code-level dedup and an **adversarial per-finding verifier** (instructed to refute; default REJECT unless the defect reproduces against current code and is not intentional house style). 39 agents total, 0 errors. **154 raw -> 136 deduped -> 132 confirmed, 4 rejected, 0 uncertain.**
- **Severity spread:** P0 = 0, P1 = 10, P2 = 50, P3 = 72.
- **Health score:** 11 / 20 (Acceptable). Weakest dimension: Accessibility (1/4).

## Hard production-readiness signals

| Check | Result |
|---|---|
| TypeScript (`tsc --noEmit`, source) | **Clean** - exit 0, 0 errors |
| ESLint (`eslint .`, `src/`) | **Clean** - 0 problems in tracked source |
| Prior correctness/security/data-integrity | **Cleared** across 3 audit passes (0 critical, 0 high remaining) |
| E2E (Playwright, CI) | Full 107-spec suite runs in CI |

Note: a local `tsc` run initially showed 21 errors and `eslint` 38 problems. Both were verified as **non-repo artifacts** - the TS errors came from a stale `.next/` cache referencing routes deleted upstream (cleared, re-ran clean), and every lint problem was in an **untracked** local `HAVEN Free Clinic Design System/` reference folder (git-tracked count 0), not in the shipped `src/` tree.

---

## Anti-Patterns Verdict

Verdict: PASS. This app does not read as AI-generated. Across 132 findings there is not a single instance of the generic-slop signature (unbranded system-font stacks, purple-blue gradients, emoji headings, boilerplate hero layouts, or copy-pasted card grids with no point of view). The 51 anti-pattern findings are almost entirely *drift away from* a deliberate, real design system (33 primitives, canonical radii, semantic tokens, Hanken-only type, Liquid Glass nav), which is the opposite of the pattern that makes AI output recognizable. When a page hand-rolls an `<h2 className="font-medium">`, it is failing to reach for a SectionHeader that already exists; that is a maintenance smell, not an authorship smell.

That said, a fair audit names the real tells, and there are a few genuine ones that leak machine origin to end users:

- Raw uppercase enum values surfaced directly in the UI: `VOLUNTEER` / `DIRECTOR` in the recruitment Track column, `ACCEPT` / `REJECT` / `WAITLIST` in interviews, `DRAFT` / `SCHEDULED` / `CANCELLED` in the campaigns list. These read as an internal database dump, especially since sibling surfaces (New-cycle form, campaign detail, My interviews) already humanize the same values.
- The double-hyphen `--` used as a label separator in the admin module (department cards, every term and department `<option>`, roster and assignment rows), which renders as an unpolished stand-in for a real dash while the same module uses a proper middot elsewhere.
- Developer-facing copy escaping into a user Alert: "Upload failed. See the browser console for details."
- Two broken affordances that betray generated wiring: both next-shift hero CTAs ("View my schedule" and "Request a change") point at the same `/schedule` route, and the "Active Departments" admin stat card links to `/admin/people`.

None of these are aesthetic tells; they are polish gaps. The visual system itself is coherent and intentional. The app looks hand-built by a team with taste, not assembled by a model.

## Audit Health Score

| Dimension | Score | Key finding |
|---|---|---|
| Accessibility | 1 / 4 | 45 findings incl. 7 of 10 P1s: colored status text (`text-success`/`text-warning`/`text-brand-fg/40`) fails AA on light surfaces app-wide, quiz radios and field-card controls are invisible on keyboard focus, and core Selects/inputs ship with no accessible name. |
| Performance | 3 / 4 | Only 6 findings; the real ones are the static `@react-pdf/renderer` import in the client bundle and several unbounded roster/applicant/learner tables that should use the existing Pagination primitive. |
| Responsive Design | 2 / 4 | 12 findings; recruitment field-card controls are hover-only and therefore completely unreachable on touch (a director cannot edit a field on a tablet), plus systemic sub-44px tap targets and un-broken two-column grids. |
| Theming | 3 / 4 | Token system is strong and mostly airtight; 11 leaks include one P1 (rich-text editor body unreadable in dark mode) plus ~6 hard-coded palette colors (`red-700`, `amber-700`, `green-50`, `red-600`) that bypass tokens, an undefined `success-foreground` token, and module chips with no dark variant. |
| Anti-Patterns | 2 / 4 | 51 findings; the app does not look AI-generated, but production readiness is undercut by a total absence of error boundaries in the `(app)` tree and irreversible bulk actions (release decisions, campaign Send now) firing with no confirmation. |
| **Total** | **11 / 20** | **Acceptable** (band 10-13) |

## Executive Summary

- Overall score 11/20 (Acceptable). Severity spread: P0 = 0, P1 = 10, P2 = 50, P3 = 72 across 132 confirmed findings. Three prior passes cleared all logic, security, and data-integrity defects; what remains is the UI/UX, accessibility, and production-readiness layer.
- The app is genuinely well-designed and does not read as AI-generated, but it is not yet accessible: 7 of the 10 P1s are WCAG failures, and they cluster into two fixable systemic patterns (colored-status-text contrast and invisible keyboard focus).

Top issues to fix before production:

1. WCAG AA contrast on colored status text: `text-success` / `text-warning` / `text-brand-fg/40` sit at roughly 3.2:1 on light card surfaces across the dashboard, clearance card, training hero and quiz, schedule, admin settings, and support (5 separate P1s plus P2s).
2. No error boundary anywhere in the `(app)` route group (only `/apply` and `/onboard` ship `error.tsx`): any transient Prisma or Graph throw blanks the entire authenticated shell to Next's bare error page with no recovery.
3. Invisible keyboard focus on core tasks: quiz answer radios are `sr-only` with no visible focus indicator, and recruitment field-card Edit/Duplicate/Remove controls render at `opacity-0` even when focused (both WCAG 2.4.7, both P1).
4. Irreversible bulk actions with no confirmation: "Release decisions" sends real acceptance emails and campaign "Send now" dispatches live email to up to 25 people on a single click, while far lower-stakes actions in the same modules use ConfirmButton.
5. Unlabeled interactive controls: subcommittee assignment Selects, audience-builder Selects, AVS action-item inputs, and onboarding row checkboxes ship with no accessible name (WCAG 4.1.2).
6. Dark-mode editor is unusable: the rich-text template/campaign body renders dark slate text on a dark surface (P1 theming), and module accent chips render as bright near-white islands in dark mode.

## Systemic Patterns

- **Missing error boundaries (roughly 11 findings, all P2/P3).** There is no `error.tsx` or `global-error.tsx` anywhere in `src/app/(app)`; the only two in the app are under public `/apply/[slug]` and `/onboard/[token]`. Every module (dashboard, get-started, recruitment, schedule, volunteers, incidents, learning/training, admin, admin/email, clinic, support) inherits the same gap, and several pages deliberately re-throw non-domain errors, so a single failing server call surfaces Next's unstyled default error screen with no nav, branding, or retry. This is one architectural fix, not eleven.
- **Colored status text failing AA contrast (roughly 8 findings, 5 of them P1).** The same three tokens/usages (`text-success` #16a34a, `text-warning` #d97706 at ~3.2:1, and `text-brand-fg/40` at ~2:1) recur as 12px status labels on white or near-white surfaces across dashboard, clearance card, training, schedule/full, admin settings, and support. It is one palette-calibration decision repeated everywhere.
- **Hard-coded palette colors bypassing the token system (roughly 6 findings).** `hover:bg-red-700` on the shared danger Button, `bg-amber-700` on the schedule Shadow toggle, `text-red-600`/`text-amber-600` on the support age label, and `bg-green-50`/`bg-red-50` in the quiz review. None adapt to dark mode; each is off the `@theme` token set the rest of the app uses. Plus an undefined `success-foreground` token and module chips with no `html.dark` override.
- **Controls with no accessible name or mismatched name (roughly 8 findings).** Bare `<Select>` and `<Input>` elements without `<label>`, `htmlFor`, or `aria-label` in subcommittees, audience builder, AVS action items, and onboarding checkboxes, plus an `aria-label` that contradicts the visible label in the incident subject picker (WCAG 2.5.3).
- **Sub-44px touch targets and hover-only reveal (roughly 8 findings).** Nav icon buttons at 32px, inline save/cancel icons at 24px, Edit/Remove text buttons, and availability chips all fall under the comfortable target; the recruitment field-card action cluster is `opacity-0 group-hover` with no touch or `focus-within` fallback, making it unreachable on tablets entirely.
- **Bypassed primitives (roughly 9 findings).** Hand-rolled section headings instead of SectionHeader, bespoke link-as-button markup instead of `buttonClasses()`, card-in-card surfaces instead of Card `size="compact"`, and a non-canonical radius on the sign-out button. The primitives exist; pages just do not reach for them.
- **`role="menu"` without menu keyboard semantics (2 findings) and heading-outline breaks (roughly 6 findings).** GlobalNav overflow and the builder TypePicker advertise WAI-ARIA menu roles but implement only Tab and Escape; duplicate h1s (form/quiz builder), skipped levels (History h1 to h3), and backwards nesting (roles panel h3 to h2) recur across modules.
- **Raw enum values and `--` separators leaking to UI (roughly 6 copy findings).** The same humanization gap appears in recruitment Track/decision columns and the campaigns list; the same `--` separator appears throughout the admin module.

## Positive Findings

- **The design system is real and largely enforced.** Token-driven light/dark theming, a documented radius scale (cards `rounded-2xl`, controls `rounded-lg`, alerts `rounded-xl`), Hanken Grotesk throughout, and 33 shared primitives mean the overwhelming majority of the app is consistent. The findings are notable precisely because they are deviations from a strong baseline rather than the baseline itself.
- **Semantic tokens are the norm, not the exception.** The audit could identify hard-coded palette colors as anomalies because nearly everything else correctly uses `bg-brand`, `bg-critical`, `bg-muted`, and friends. The support age label is explicitly called out as "the only raw-palette color usage in the entire src tree," which is a strong signal of discipline.
- **The primitives themselves encode good accessibility defaults.** The Field primitive already renders its required asterisk with `aria-hidden`; the GlobalNav More button already sets `aria-expanded` and `aria-haspopup`. The failures are pages diverging from these correct patterns, which means the fix is adoption, not invention.
- **Route-state coverage is mostly thoughtful.** Almost every module ships a tailored `loading.tsx` (admin, schedule, learning, clinic, recruitment, volunteers, my-info), and the public portals ship both `error.tsx` and empty states with a SupportLink. The gaps are specific and enumerable.
- **Landmark structure is sound.** The app shell uses proper `header` / `main` / `footer` / `nav` landmarks, so screen-reader users can still navigate by region even where the skip link is missing.
- **Genuine product-safety guards already exist.** ConfirmButton protects revoke-acceptance, reset-training, and archive-cycle; the campaign send confirms for audiences over 25. The footguns flagged are inconsistencies with an otherwise careful pattern, which makes them cheap to close.

## Recommended Actions

Priority order below. Each theme maps to one impeccable command, ending with `/polish`.

1. **`/harden` (P1, production readiness).** Add an `error.tsx` to the `(app)` route group (and per-module where re-throws are deliberate) so no thrown Prisma or Graph error can blank the authenticated shell; convert the unknown-template-key throw to `notFound()`; wrap the irreversible bulk actions ("Release decisions", campaign "Send now" for audiences of 25 or fewer, learner "Reset") in ConfirmButton to match the rest of the app; give the session-timeout warning a `role="alert"` live region; and add a `sandbox` attribute to the SCORM iframe.

2. **`/normalize` (P1, theming + accessibility mechanics).** Recalibrate the semantic status palette so `text-success` / `text-warning` and the `text-brand-fg/40` labels clear AA (4.5:1) on light and dark surfaces; replace every hard-coded palette color (`red-700`, `amber-700`, `green-50`/`red-50`, `red-600`/`amber-600`) with tokens; define the missing `success-foreground` token; add dark-mode variants for the module accent chips and the rich-text editor body; and restore the accessible-name, `aria-pressed`, `aria-activedescendant`, `scope="col"`, and visible-focus behavior on the controls that diverge from the primitives, plus correct the `role="menu"` usages to match the working More-button pattern.

3. **`/adapt` (P2, responsive and touch).** Reveal the recruitment field-card controls on `focus-within` and touch (they are currently unreachable on tablets); raise nav icon buttons, inline save/cancel icons, availability chips, and the review "Edit" button to a 44px target; and add `sm:`/`md:` breakpoints to the AVS medication rows, the two-column patient grids, and the department checkbox grid so they collapse cleanly at 375px.

4. **`/typeset` (P2, heading hierarchy).** Enforce one `h1` per page and no skipped levels: add the missing `h1` to the apply wizard, drop the duplicate `h1` in the form and quiz builders, promote the History month headings, and fix the roles-panel and incident-detail backwards nesting so heading navigation is coherent.

5. **`/clarify` (P2/P3, copy and broken affordances).** Humanize the raw enum labels (Track, interview decision, campaign status); replace the `--` separators with a proper dash or middot; rewrite "See the browser console for details" as user-facing guidance; fix the "Active Departments" card to link to `/admin/departments` and differentiate the two next-shift CTAs; and give the onboarding dead-end and the EHS "Action needed" task a real next step or SupportLink.

6. **`/optimize` (P3, performance).** Lazy-load `@react-pdf/renderer` behind the Generate action instead of shipping it in the initial bundle; page the unbounded EHS, applicants, and learner tables through the existing Pagination primitive; parallelize the per-shift swap-partner lookups instead of the serial await waterfall; and switch the progress bars to transform/opacity with a `motion-reduce` guard.

7. **`/polish` (final pass).** Sweep the residual system drift: restore the canonical radii (`rounded-xl` on Alert, `rounded-lg` on sign-out), remove the unused Poppins reference from HavenMark, route the remaining hand-rolled surfaces through Card / SectionHeader / `buttonClasses()`, flatten the card-in-card nests, add the app-shell skip link and the missing empty states, and do a final alignment and spacing check before ship.


---

## Detailed Findings

Every finding below survived adversarial verification against current code. Location is `file:line`; `dimension` is the primary axis; `evidence` quotes the offending code.


### P1 - Major - fix before release (10)

WCAG AA violations and significant UX/production defects users will hit.

#### Status pill text uses `text-success`/`text-warning` - fails WCAG AA contrast in light mode
- **Dimension:** accessibility  ·  **Location:** `src/app/(app)/page.tsx:448`  ·  **Area:** App shell, dashboard home, my-info, notifications
- **Impact:** The "Cleared" / "Not yet cleared" pill in the dashboard "Your status" card is 12px semibold text colored `text-success` (#16a34a ≈ 3.3:1) or `text-warning` (#d97706 ≈ 3.2:1) on the white card surface. Both fall well below the 4.5:1 AA threshold for small text in light mode, so low-vision users struggle to read the clearance status. (The colored dot beside it is redundant and aria-hidden.)
- **Fix:** Carry the status color on the dot/icon only and use a neutral token (e.g. text-foreground-soft) for the label - the same pattern the Badge primitive already uses - or darken the semantic text tokens to reach 4.5:1 on surface.
- **Evidence:**
  ```
  `className={`inline-flex items-center gap-1.5 text-xs font-semibold ${ onboarding.cleared ? "text-success" : "text-warning" }`}` (#16a34a on #ffffff ≈ 3.3:1, #d97706 ≈ 3.2:1; AA requires 4.5:1).
  ```
- **Verifier:** Verified: page.tsx:447-448 colors a 12px/600 (text-xs font-semibold = normal-size) status pill with text-success (#16a34a) or text-warning (#d97706) on the white Card surface. Computed contrast 3.30:1 and 3.19:1 respectively, both below the 4.5:1 AA threshold for normal text. globals.css:10-11 defines these hexes with no light override; in dark mode the same colors on #0f172a compute ~5.4-5.6:1, so the failure is light-mode-only as stated. Real WCAG AA text-contrast violation; per the rubric AA violations rate P1 (redundant summary softens practical impact but the violation is genuine).

#### Clearance banner "Cleared/Not yet cleared" labels fail AA contrast in light mode
- **Dimension:** accessibility  ·  **Location:** `src/modules/my-info/components/clearance-card.tsx:99`  ·  **Area:** App shell, dashboard home, my-info, notifications
- **Impact:** The My Info Clearance card banner sets its eyebrow label in `text-success` (line 99) or `text-warning` (line 114) - 12px bold uppercase text on the `bg-muted` (#f8fafc) banner. #16a34a and #d97706 on that near-white background measure ≈3.2:1, under the 4.5:1 AA minimum for small text, making the primary clearance verdict hard to read for low-vision users in light mode.
- **Fix:** Use a neutral foreground token for the label text and let the adjacent ShieldCheck/AlertTriangle icon (which already meets the 3:1 non-text threshold) carry the color, or darken the semantic tokens for AA on light surfaces.
- **Evidence:**
  ```
  `<p className="text-xs font-bold uppercase tracking-wider text-success">Cleared</p>` (line 99) and `...text-warning">Not yet cleared</p>` (line 114).
  ```
- **Verifier:** clearance-card.tsx:99 (text-success 'Cleared') and :114 (text-warning 'Not yet cleared') are 12px bold uppercase on bg-muted. Tokens: success #16a34a, warning #d97706, muted #f8fafc. Computed contrast ~3.15:1 (green) and ~3.05:1 (amber), below AA 4.5:1 for small text (12px bold is under the 14pt-bold large-text threshold). Genuine WCAG 1.4.3 AA failure -> P1 per baseline scale (finding under-rated P2). Mitigation: verdict is also shown in adjacent high-contrast text-foreground heading + colored icon, but the eyebrow text itself still violates AA.

#### Onboarding form field errors are not programmatically linked to their inputs
- **Dimension:** accessibility  ·  **Location:** `src/app/onboard/[token]/contract-field.tsx:118`  ·  **Area:** Login, welcome, apply portal, onboarding links, get-started gate
- **Impact:** On the new-volunteer onboarding form, a screen-reader or keyboard user who submits with validation errors cannot tell which field failed: the inputs never get aria-invalid, and the per-field error text is a bare <p> with no id, so it is not tied to the control via aria-describedby and is not announced when it appears after the server round-trip (no live region on the per-field errors).
- **Fix:** Give each error <p> a stable id, add aria-describedby (and aria-invalid={!!err(k)}) to the matching Input/Checkbox, so focus into an errored field announces the message. Apply the same pattern to the signature, HIPAA, name, and custom-question errors. Consider routing all field errors through the Field primitive so the association is centralized.
- **Evidence:**
  ```
  Line 118-119: `<Field label={label} required={required}><Input name={inputName} type={type} defaultValue={defaults[block.systemKey]} required={required} /></Field>` immediately followed by `{err(inputName) && <p className="mt-1 text-xs text-critical">{err(inputName)}</p>}` - the Input has no aria-invalid and no aria-describedby, and the <p> has no id. Same pattern at lines 40 (signature), 84/89 (HIPAA), 102/106 (first/last name).
  ```
- **Verifier:** Verified in contract-field.tsx. Input primitive (input.tsx) is a bare <input> that only spreads props; contract-field passes no aria-invalid and no aria-describedby, and every error node is a bare <p className="...text-critical"> with no id (lines 40, 70, 84, 89, 102, 106, 119). Field wraps only the label around the control; the error <p> is an unassociated sibling. onboard-form.tsx surfaces these only after a server round-trip via result state with no live region on the per-field errors. Screen-reader/keyboard users cannot tell which field failed. Genuine WCAG 3.3.1/1.3.1/4.1.3 defect on the new-volunteer onboarding form. P1 upheld.

#### Field edit/duplicate/remove controls invisible on keyboard focus (opacity-0, hover-only reveal)
- **Dimension:** accessibility  ·  **Location:** `src/app/(app)/recruitment/cycles/[id]/builder/field-card.tsx:64`  ·  **Area:** Recruitment: interviews, schedule builder, onboarding
- **Impact:** A keyboard user Tabbing through a section's fields lands focus on the drag handle and the Edit/Duplicate/Remove buttons while they are opacity-0, so the focused control is completely invisible (WCAG 2.4.7 Focus Visible failure). The only reveal is group-hover on the Card, and there is no group-focus-within / focus-visible override.
- **Fix:** Add group-focus-within:opacity-100 to the controls container (line 64) and the drag-handle button (line 58), plus focus-visible:opacity-100 on the buttons, so focused controls become visible. Alternatively render the controls always-visible.
- **Evidence:**
  ```
  Line 64: `<div className="flex items-center gap-1 opacity-0 group-hover:opacity-100">` wrapping the Edit/Duplicate/Remove buttons; line 58 drag handle `className="mt-1 cursor-grab text-subtle-foreground opacity-0 group-hover:opacity-100 ..."`; Card is the only `group` (line 55) and has no focus-within reveal.
  ```
- **Verifier:** field-card.tsx line 64 wraps Edit/Duplicate/Remove in opacity-0 group-hover:opacity-100 and line 58 drag handle likewise; Card (line 55) is the sole group with no group-focus-within/focus-visible reveal, and grep found no global focus-within CSS. opacity-0 keeps controls focusable but fully transparent (focus ring included), so keyboard focus lands on invisible controls. Genuine WCAG 2.4.7 (AA) failure. P1 correct.

#### Section labels at text-brand-fg/40 fail WCAG AA contrast
- **Dimension:** accessibility  ·  **Location:** `src/app/(app)/schedule/full/page.tsx:107`  ·  **Area:** Schedule builder, full schedule, attendings
- **Impact:** The 'Directors' / 'Volunteers' / 'Shadows' group labels on every department card are rendered at 40% opacity of brand-fg over the white card surface. That drops contrast to roughly 2:1, far below the 4.5:1 AA minimum for this small (text-xs) uppercase text. These labels are the primary cue for which role bucket each name belongs to, so low-vision users cannot reliably read the grouping. Same defect repeats at lines 126 and 149.
- **Fix:** Use a full-strength token that meets AA, e.g. text-subtle-foreground or text-muted-foreground (already used for the equivalent labels in builder/page.tsx), instead of text-brand-fg/40.
- **Evidence:**
  ```
  <p className="text-xs font-semibold uppercase tracking-widest text-brand-fg/40 mb-1.5">Directors</p> (repeated at lines 126, 149)
  ```
- **Verifier:** full/page.tsx lines 107/126/149 render `text-xs font-semibold uppercase ... text-brand-fg/40`. brand-fg light = brand #00356b; at 40% alpha over the white card body it composites to ~rgb(153,174,196), yielding ~2.28:1 vs white - far below 4.5:1 AA for this small uppercase text. These labels convey role-bucket grouping (not decorative). Real WCAG AA text-contrast failure. P1 correct.

#### Action item text inputs have no accessible name
- **Dimension:** accessibility  ·  **Location:** `src/modules/clinic/avs/avs-tool.tsx:210`  ·  **Area:** Clinic tools + After Visit Summary generator
- **Impact:** The 'Action items' list renders bare <Input> controls with no Field wrapper, no htmlFor/id, and no aria-label. The visible 'Action items' text (line 207) is a plain <span> with no programmatic association. A screen-reader user tabbing through the form lands on these fields announced only as 'edit text' with no name (WCAG 4.1.2 Name, Role, Value, Level A). Every med field by contrast is wrapped in a labeled Field.
- **Fix:** Give each input a name, e.g. `<Input aria-label={`Action item ${i + 1}`} ... />`, or wrap the group in `role="group" aria-label="Action items"` and reference it. Same fix applies to the remove buttons being individually distinguishable.
- **Evidence:**
  ```
  lines 207-213: `<span className="text-xs font-medium text-muted-foreground">Action items</span>` above `<Input value={item} onChange={...} />` - the input has no label, id, or aria-label.
  ```
- **Verifier:** Lines 207-213: the 'Action items' label is a plain <span> and each list <Input> (line 210) has no Field wrapper, no id/htmlFor, no aria-label, and no placeholder, so it has no accessible name. With multiple such inputs the standalone span cannot associate. WCAG 4.1.2 (Name, Role, Value) Level A violation, correctly described. P1 correct.

#### Quiz answer radios are sr-only with no visible focus indicator
- **Dimension:** accessibility  ·  **Location:** `src/app/(app)/training/training-quiz.tsx:180`  ·  **Area:** Learning + training modules
- **Impact:** A keyboard-only user tabbing into a quiz question and arrowing between options gets no visible focus indication at all, so they cannot tell which answer is currently focused. This is a WCAG 2.4.7 Focus Visible (AA) failure on the core interactive task of the page.
- **Fix:** Add a focus-within ring to the styled label (e.g. append `has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand has-[:focus-visible]:ring-offset-2` inside optionClass, or move the radio out of sr-only and style a visible custom control), so the focused option is visually distinguishable.
- **Evidence:**
  ```
  Line 180: `<input type="radio" name={`q:${q.key}`} value={o.value} checked={sel} disabled={reviewing || pending} onChange={() => choose(q.key, o.value)} className="sr-only" />` - and optionClass (lines 280-285) produces no focus-within/focus-visible styling: `const base = "flex items-center gap-3 rounded-xl border px-3.5 py-3 transition";` with only sel/reviewing/correct/wrong branches.
  ```
- **Verifier:** Confirmed. Line 180 radio is sr-only (native focus ring clipped) and optionClass (280-285) has only sel/reviewing/isCorrect/isWrong branches, no focus-within/focus-visible. Tabbing into an unanswered question group focuses the first radio with no visible indicator (the sel ring indicates selection, not focus). Genuine WCAG 2.4.7 Focus Visible AA gap on the core quiz task. P1 stands.

#### Colored eyebrow labels in the training hero fail AA contrast on the white card
- **Dimension:** accessibility  ·  **Location:** `src/app/(app)/training/page.tsx:48`  ·  **Area:** Learning + training modules
- **Impact:** The status eyebrow labels sit as 12px bold text on the white Card surface (#fff). text-success (#16a34a) computes to ~3.3:1 and text-warning (#d97706) to ~3.2:1 against white, both below the 4.5:1 AA minimum for non-large text. These convey the learner's clearance status ('Cleared for the term', 'Not yet cleared'), so low-vision users can miss the primary signal.
- **Fix:** Darken the label color for light mode (use a stronger success/warning text token or a darker shade) so these small bold eyebrow labels clear 4.5:1, or render status as a Badge which is already tuned for contrast.
- **Evidence:**
  ```
  Line 48: `<p className="text-xs font-bold uppercase tracking-wider text-success">Cleared for the term</p>`; line 111: `<p className="text-xs font-bold uppercase tracking-wider text-warning">Not yet cleared</p>`. Tokens: --color-success #16a34a, --color-warning #d97706 on --color-surface #ffffff.
  ```
- **Verifier:** Confirmed. text-success #16a34a computes to 3.30:1 and text-warning #d97706 to 3.19:1 on --color-surface #fff. At 12px bold (not WCAG large text) the 4.5:1 AA threshold applies; both fail. These are the primary clearance eyebrow labels on the training hero seen by every volunteer. P1 correct.

#### text-warning used as small body text fails WCAG AA contrast (3.19:1)
- **Dimension:** accessibility  ·  **Location:** `src/app/(app)/admin/settings/page.tsx:188`  ·  **Area:** Admin: people, roles, terms, departments, subcommittees, settings, audit, contract
- **Impact:** The "Currently overriding the default" hint renders in --color-warning (#d97706) at text-xs on the white Card surface. That pair is ~3.19:1, below the 4.5:1 AA minimum for normal text, so the override notice is hard to read for low-vision users. The warning token is tuned for icons/large stat values (3:1 graphical threshold), not 12px text.
- **Fix:** Render this hint in a token that meets AA for text (e.g. text-muted-foreground, which is AA-tuned) and convey "warning" via an icon or the existing amber icon in Alert, not via the low-contrast text color itself.
- **Evidence:**
  ```
  {s.isOverridden && (
    <span className="text-xs text-warning">Currently overriding the default</span>
  )}
  ```
- **Verifier:** Confirmed at settings/page.tsx:188. globals.css: --color-warning #d97706, light --color-surface #ffffff. #d97706 on #fff computes ~3.19:1, below the 4.5:1 AA minimum for normal text. The span is text-xs (12px) with no bold weight, so 1.4.3 Contrast (Minimum) AA applies and fails. The warning token clears the 3:1 graphical threshold but not body-text contrast. P1 (WCAG AA violation) correct.

#### Rich-text editor body is unreadable in dark mode (hard-coded slate text on a themed surface)
- **Dimension:** theming  ·  **Location:** `src/app/(app)/admin/email/templates/[key]/preview.tsx:259`  ·  **Area:** Admin: email monitor, campaigns, templates
- **Impact:** In dark mode the Formatted (WYSIWYG) editing surface renders dark slate text on a dark background, so admins cannot see what they type. The editor container sets no background and the ProseMirror content color is a fixed hex, so it never adapts to the theme. This is the primary composing surface for every platform email template and every campaign body.
- **Fix:** Give the editing region an explicit light surface like the email preview (or token-driven bg/text) so it mirrors the light email output in both themes, or replace the hard-coded hexes (#1e293b body, #475569 blockquote, #94a3b8 placeholder, #00356b link) with a fixed white card + brand token that stays light regardless of app theme. The wrapping div at line 128 (`className="mt-1 rounded-xl border border-border"`) has no background at all.
- **Evidence:**
  ```
  .tt-content { min-height: 16rem; padding: 12px 14px; font-size: 14px; line-height: 1.6; color: #1e293b; outline: none; }  (line 259) sits inside `<div className="mt-1 rounded-xl border border-border">` with no background (line 128); dark-mode surface is #0b1220-ish, so #1e293b text has near-zero contrast. Also `.tt-content blockquote { ... color: #475569; }` (268) and placeholder `color: #94a3b8` (269).
  ```
- **Verifier:** Verified. .tt-content sets color:#1e293b (line 259) with no background; the container div (line 128) has only 'border border-border' and inherits the page bg. In dark mode --color-canvas=#020617 / --color-surface=#0f172a, so dark-slate text on a dark surface is near-invisible. Fixed hex never adapts to theme. Real theming/WCAG-contrast defect on the primary WYSIWYG composing surface. HTML-mode Textarea is a workaround so not fully blocking; P1 is correct.


### P2 - Minor - fix in next pass (50)


#### Shared UI primitives

- **[theming] Danger button hover color hard-codes red-700, bypassing tokens** - `src/platform/ui/button.tsx:13`  
  The primary destructive button in the app changes to a fixed Tailwind red on hover that is not a semantic token and does not adapt to dark mode, so its rest state (bg-critical, a token) and hover state come from two unrelated color systems. Every ConfirmButton armed state and every danger action inherits this mismatch.  
  _Fix:_ Add a token (e.g. --color-critical-hover / --color-critical-strong with a dark override in globals.css) and use hover:bg-critical-hover, matching how primary uses bg-brand-hover.
- **[accessibility] Combobox does not expose the active option via aria-activedescendant** - `src/platform/ui/combobox.tsx:89`  
  The combobox implements arrow-key highlighting (active index) and a role="listbox" with role="option" children, but the input has no aria-activedescendant and the <li> options have no id. Screen-reader users pressing Arrow Up/Down hear nothing about which option is highlighted, so the keyboard selection flow is effectively invisible to them.  
  _Fix:_ Give each option a stable id and set aria-activedescendant on the input to the id of filtered[active] while open, so assistive tech announces the highlighted option as the user arrows through the list.
- **[accessibility] App shell has no skip-to-content link (WCAG 2.4.1 Bypass Blocks)** - `src/platform/ui/app-shell.tsx:115`  
  AppShell wraps every authenticated page with a sticky nav containing the logo, every module link, a More menu, theme toggle, notification bell and sign-out. There is no skip link anywhere in the app (grep confirms none), and <main> has no id, so keyboard and screen-reader users must tab through the entire global nav on every page load to reach content. This is a Level A criterion and is systemic.  
  _Fix:_ Add a visually-hidden-until-focused skip link as the first focusable element (href="#main-content") and give <main id="main-content"> so users can bypass the repeated nav block.

#### App shell, dashboard home, my-info, notifications

- **[theming] Undefined `text-success-foreground` token silently drops the EHS "Done" color** - `src/modules/my-info/components/ehs-panel.tsx:22`  
  On the My Info EHS Training panel, completed items are meant to read as green "Done" vs muted "Needed". No `--color-success-foreground` token is defined in globals.css (@theme only defines `--color-success`), so Tailwind v4 never generates the `text-success-foreground` utility. The class is a no-op: "Done" renders in the inherited default foreground (dark, bold) with no color distinction, weakening the completed/needed contrast the panel relies on. This breaks in both light and dark mode.  
  _Fix:_ Change the class to the real token `text-success` (matching clearance-card's usage), or add a `--color-success-foreground` token to @theme if a distinct shade is intended. Verify the utility is actually emitted.
- **[anti-pattern] No error boundary anywhere in the (app) group - a data-fetch throw 500s the whole authenticated shell** - `src/app/(app)/page.tsx:178`  
  UX: The dashboard awaits several external calls (mySchedule, listMyCertificates, getOnboardingStatus, getSetting) and streams a Suspense-wrapped ClinicChannelCard that hits Microsoft Graph. There is no error.tsx in the entire (app) route group (only loading.tsx files exist, plus error.tsx under public /apply and /onboard). Any throw - a transient DB error, a Graph outage in ClinicChannelCard, a settings miss - escapes to the root with no styled recovery, replacing the toolbar/nav/shell with Next.js's default error screen and no way back.  
  _Fix:_ Add an `src/app/(app)/error.tsx` client error boundary (and optionally a `global-error.tsx`) that renders inside the shell with a retry action, so authenticated route failures degrade gracefully instead of blanking the app.
- **[accessibility] Notification unread state is conveyed by an aria-hidden dot only** - `src/app/(app)/notifications/page.tsx:70`  
  In the notification inbox, unread rows are distinguished solely by a small `bg-brand` dot marked `aria-hidden`; the title uses the same `font-medium text-foreground` weight whether read or unread. Screen-reader users get no indication of which notifications are unread - read/unread status is communicated by color/shape alone with no text alternative.  
  _Fix:_ Add a visually-hidden label to unread rows (e.g. an `<span className="sr-only">Unread</span>` next to the dot) so the state is announced.
- **[theming] Module/quick-action accent chips don't adapt to dark mode** - `src/app/(app)/page.tsx:144`  
  Module tiles and quick-action tiles paint their icon chip with `background: var(--mhbg)` sourced from the `--mod-*-bg` tokens, which are defined once in `:root` at near-white lightness (oklch L≈0.96) with no `html.dark` override. In dark mode the tiles sit on the dark `bg-surface` card but the icon chips render as bright near-white squares - a set of light islands that break the dark theme's visual consistency. These are the only color tokens in globals.css lacking a dark variant.  
  _Fix:_ Add `html.dark` overrides for the `--mod-*` / `--mod-*-bg` families (darker tinted chip backgrounds with a lifted icon hue), so the accent chips track the theme like every other token.

#### Login, welcome, apply portal, onboarding links, get-started gate

- **[anti-pattern] Resumed-draft file uploads show "Attached: <filename>" twice on the apply wizard** - `src/app/apply/[slug]/apply-wizard.tsx:366`  
  When an applicant returns to a saved draft that already has a file attached (the common magic-link case where prefill is undefined), the same "Attached: myfile.pdf" label renders twice on a public applicant-facing form - once from FieldPreview's draftFile span and once from the wizard's fileStatus paragraph. It reads as a rendering bug and undermines trust in the form.  
  _Fix:_ Render the attached-file confirmation in exactly one place. Either don't seed fileStatus from initialAnswers when FieldPreview will already show the draft file, or suppress FieldPreview's built-in draftFile span when the wizard owns the status line.
- **[accessibility] The apply wizard page has no h1 (top heading starts at h2)** - `src/app/apply/[slug]/apply-wizard.tsx:288`  
  On the primary public application form (/apply/<slug>), PortalShell renders only a masthead logo and the wizard's top heading is an <h2>, with the review sections at <h3>. There is no <h1> anywhere on the page, so screen-reader users navigating by headings never land on a page title and the heading outline is broken. The success state (PortalNotice titleAs="h2", line 271) has the same gap.  
  _Fix:_ Promote the wizard's step heading to <h1>, or render an <h1> (e.g. the cycle title) in PortalShell for the wizard page and keep the step title as <h2>. Ensure the success PortalNotice uses h1 too.

#### Recruitment: cycles, applicants, decisions, subcommittees, training, emails

- **[anti-pattern] Applicant uploaded files (resumes/CVs) cannot be opened by reviewers** - `src/app/(app)/recruitment/cycles/[id]/applicants/[applicationId]/page.tsx:84`  
  UX: FILE-type answers are rendered as inert plain text of the filename only. Uploaded documents are stored in blob storage (recruitment/{cycleId}/{storedName} via upload.ts) but there is no download link/route anywhere in the recruitment reviewer tree (grep confirms only certificate + incident-attachment routes exist). A reviewer evaluating a file-collecting cycle literally cannot open the applicant's submitted document, with no in-app workaround.  
  _Fix:_ Render the FILE answer as a link to a permission-gated serving route (mirroring my-info/certificate/[id]/route.ts) so reviewers can download/preview the uploaded file, rather than showing only fileName as text.
- **[accessibility] Subcommittee assignment <Select> has no accessible name** - `src/app/(app)/recruitment/cycles/[id]/subcommittees/page.tsx:79`  
  The per-row assignment dropdown (the primary action of this page) is a bare Select with no wrapping <label>, no htmlFor/id, and no aria-label. It fails WCAG 4.1.2 (Name, Role, Value): a screen-reader user tabbing the table hears only 'combobox' with the current value and no field name. The visible 'Assignment' column header does not associate to controls inside <td> cells.  
  _Fix:_ Add an aria-label (e.g. aria-label={`Subcommittee for ${r.applicant.firstName} ${r.applicant.lastName}`}) to the Select, or wrap it with a visually-hidden label.
- **[accessibility] Field preview wraps multi-control field types in a single <label>, creating nested/ambiguous labels** - `src/modules/recruitment/components/field-preview.tsx:134`  
  The catch-all return wraps the whole field (label + control) in one <label>. For MULTI_SELECT the control is a <span> containing multiple <label><Checkbox/></label> rows, producing nested <label> elements (invalid HTML, ambiguous association). For SUBCOMMITTEE_RANK the single outer <label> wraps multiple <Select> controls. Both break implicit label association on the public applicant form: clicking the label focuses only the first control and screen readers mis-associate the group name.  
  _Fix:_ Only wrap single-control types in <label>. For MULTI_SELECT and SUBCOMMITTEE_RANK render the group label as a non-label element (e.g. a <fieldset>/<legend> or a plain heading) so the per-option labels are the only <label> elements.
- **[anti-pattern] 'Release decisions' fires irreversible bulk applicant emails with no confirmation** - `src/app/(app)/recruitment/cycles/[id]/decisions/page.tsx:70`  
  UX: A single click on a plain SubmitButton sends real acceptance emails to every accepted, non-conflicted, un-notified applicant - an irreversible external side effect (you cannot unsend). Elsewhere in this same module far lower-stakes destructive actions (revoke acceptance, reset training, archive cycle) are guarded by ConfirmButton, making this an inconsistent footgun.  
  _Fix:_ Gate the release behind the existing ConfirmButton (two-click arm) or a confirm step that surfaces how many emails will send, matching the destructive-action pattern used across the module.
- **[anti-pattern] Recruitment cycles subtree has no error boundary; thrown errors surface the raw framework error page** - `src/app/(app)/recruitment/cycles/[id]/subcommittees/page.tsx:32`  
  UX: No error.tsx exists anywhere in the (app) group or recruitment tree (find confirms only apply/[slug] and onboard/[token] have one). Pages that deliberately re-throw non-expected errors - subcommittees (`throw err`) and training (`throw e`) - plus any DB/runtime failure bubble to Next.js's built-in unstyled 'Application error' page, replacing the whole route with no branding, nav, or recovery affordance.  
  _Fix:_ Add an error.tsx boundary for the recruitment cycles subtree (or the (app) group) that renders a styled fallback with a retry/back action, consistent with the loading.tsx that already covers this subtree.

#### Recruitment: interviews, schedule builder, onboarding

- **[responsive] Field controls unreachable on touch devices (no hover to reveal them)** - `src/app/(app)/recruitment/cycles/[id]/builder/field-card.tsx:64`  
  Touch devices (tablet/phone) have no hover state, so the Edit, Duplicate, and Remove buttons for a field never become visible. A director cannot edit or delete an application field on a touchscreen at all, the drag handle is likewise hidden.  
  _Fix:_ Reveal the controls on focus-within and on coarse pointers, e.g. add a `@media (hover: none)` rule (or a `[@media(hover:none)]:opacity-100` utility) so the controls are always shown where hover is unavailable.
- **[accessibility] Duplicate h1 on Form builder and Quiz builder pages** - `src/app/(app)/recruitment/cycles/[id]/builder/form-builder.tsx:56`  
  The page already renders an h1 via PageHeader ("Form builder"), and the preview card renders a second h1 with the cycle title. Two h1 elements on one page break the heading outline and make heading-based screen-reader navigation ambiguous. Same defect exists in the quiz builder.  
  _Fix:_ Demote the preview-card title to an h2 (or a non-heading styled element) in both files, keeping the PageHeader as the sole page h1.
- **[accessibility] Onboarding row-select checkboxes have no accessible name; empty column header** - `src/app/(app)/recruitment/cycles/[id]/onboarding/page.tsx:66`  
  The per-applicant selection checkboxes in the onboarding table are bare inputs with no wrapping label and no aria-label, and the first column header is empty. A screen-reader user hears only "checkbox, not checked" with no way to tell which applicant a checkbox selects before sending onboarding links.  
  _Fix:_ Add `aria-label={`Select ${r.application.applicant.firstName} ${r.application.applicant.lastName}`}` to each checkbox (line 66) and give the empty `<TH>` (line 55) a visually-hidden label such as "Select".
- **[anti-pattern] Panelists cannot see interview time or Zoom link on the detail page** - `src/app/(app)/recruitment/interviews/[interviewId]/page.tsx:71`  
  UX: The Schedule card (scheduled time, Zoom link, notes) is gated entirely behind `canManage`. A panelist volunteer who opens their assigned interview to submit an evaluation sees only the Evaluations and 'Your evaluation' cards, no scheduled time and no Zoom link, so they have no way to learn when the interview is or how to join it from the hub.  
  _Fix:_ Render the scheduled time and Zoom link (read-only) for panelists (isPanelist) outside the canManage block, so panel members can see when and where to attend.

#### Schedule builder, full schedule, attendings

- **[theming] Shadow-active toggle uses raw bg-amber-700 instead of a semantic token** - `src/app/(app)/schedule/builder/page.tsx:608`  
  The active 'Shadow' assign-mode pill is painted with a hard-coded Tailwind amber that is not part of the app's @theme token set (no --color-amber-* is defined; the only amber-family token is --color-warning #d97706). It will not shift with the light/dark override chain the way every other control does, and it is an off-palette color the rest of the schedule UI never uses (siblings use bg-brand for the active Volunteer pill).  
  _Fix:_ Replace bg-amber-700 with the brand/warning token used elsewhere (e.g. bg-warning, or match the Volunteer pill's bg-brand) so the active Shadow state stays on-palette and theme-aware. If a distinct hue is intentionally wanted for Shadow, add a real semantic token in globals.css and reference it.
- **[accessibility] Department count pills: text-white/70 on bg-white/20 over brand is below AA** - `src/app/(app)/schedule/full/page.tsx:94`  
  The '{n} directors / volunteers / shadows' count pills in each department card header set text-white/70 on a bg-white/20 overlay over the brand navy. Compositing both alphas yields roughly 4.3:1, which fails the 4.5:1 AA threshold for this text-xs (normal-size) text. The counts are meaningful data, not decoration.  
  _Fix:_ Raise the text to full white (text-white) or drop the pill background overlay so the text/background pair clears 4.5:1. This is a contrast fix, not a theme-flip (white-on-brand is correctly non-flipping).
- **[anti-pattern] Schedule route segment has no error boundary** - `src/app/(app)/schedule/page.tsx:80`  
  UX: The /schedule segment ships loading.tsx but no error.tsx (none exists anywhere in the (app) tree). The page and its server actions rethrow any non-domain error (e.g. page.tsx:80 `throw err`, and runAction rethrows unexpected failures in builder/page.tsx). A DB blip or unexpected throw therefore falls through to the framework error screen / 500 for the whole subtree with no in-app recovery, on the densest and most action-heavy area of the app.  
  _Fix:_ Add a src/app/(app)/schedule/error.tsx (client error boundary with a reset button and support link) so transient failures in the builder/full-schedule/attendings flows degrade gracefully instead of 500-ing the segment.

#### Clinic tools + After Visit Summary generator

- **[responsive] Medication rows use a 4-column grid with no breakpoint; three inputs collapse on mobile** - `src/modules/clinic/avs/avs-tool.tsx:154`  
  Each medication row packs three text inputs plus a remove button into a single fixed 4-column track with no responsive fallback. On a 375px viewport the three 1fr columns shrink to roughly 90px each, so the 'Dose & instructions' and 'Lowest-cost source' labels wrap and the input fields become too narrow to read what is typed. A clinician entering meds on a phone/tablet gets an unusable row.  
  _Fix:_ Stack the fields on narrow screens, e.g. `grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end`, keeping the dense 4-column layout only at sm and up.
- **[performance] @react-pdf/renderer is statically imported into the client bundle** - `src/modules/clinic/avs/avs-tool.tsx:5`  
  AvsTool is a "use client" component that statically imports `pdf` from @react-pdf/renderer (line 5) and AvsDocument (line 12, which itself pulls the renderer's Document/Page/StyleSheet). This ships the entire heavy PDF engine in the route's initial JS for every visitor, even though it is only needed the moment the user clicks Generate PDF. It delays interactivity for a tool most sessions may never click 'Generate' on.  
  _Fix:_ Defer the library: `const { pdf } = await import("@react-pdf/renderer"); const { AvsDocument } = await import("./avs-pdf");` inside handleGenerate (or a lazy dynamic import), so the renderer loads on first generate rather than on route entry.
- **[accessibility] Chip toggle groups have no group label associated with the buttons** - `src/modules/clinic/avs/avs-tool.tsx:273`  
  ChipGroup (used for Vitals reviewed, Labs/tests ordered, Community resources, Financial resources) renders its label as a standalone <span> with no `role="group"`/`aria-labelledby` tying it to the toggle buttons. A screen-reader user hears each pressable chip ('Blood pressure, toggle button, not pressed') with no indication it belongs to the 'Vitals reviewed' group, losing the categorical context that sighted users get (WCAG 1.3.1).  
  _Fix:_ Wrap the chip row in `<div role="group" aria-label={label}>` (or use aria-labelledby pointing at the span's id) so assistive tech announces the group name.

#### Volunteers, compliance, EHS, offboarding, spanish-review

- **[accessibility] Button nested inside Link (invalid interactive nesting) on EHS dashboard** - `src/app/(app)/volunteers/ehs/page.tsx:22`  
  A <button> rendered inside an <a> is invalid HTML (an anchor may not contain interactive content). This produces nested focusable/interactive elements: screen readers and validators report conflicting roles, and keyboard/AT activation behavior is unpredictable. Every other link-styled-as-button in this area (e.g. master/page.tsx:273 'Clear') correctly uses the buttonClasses() pattern, so this is an inconsistency as well.  
  _Fix:_ Replace the wrapping with a single element: `<Link href="/volunteers/ehs/manage" className={buttonClasses("outline", "sm")}>Manage trainings</Link>` (import buttonClasses from @/platform/ui/button), matching the pattern already used in master/page.tsx.
- **[anti-pattern] Volunteers route segment has no error boundary** - `src/app/(app)/volunteers/page.tsx:70`  
  UX: Every page in this segment is a server component that loads data which can throw at request time (departmentCompliance, masterCompliance, offboardingView, getEhsDashboard, listSpanishReviewQueue). There is a loading.tsx but no error.tsx anywhere in the (app) tree, so a transient DB error or thrown exception during render bubbles to Next.js's default 500 screen for the whole route with no branded recovery or retry. Server-action domain errors are handled (redirect + Alert), but the initial data load is unprotected.  
  _Fix:_ Add an error.tsx (client component with a reset() retry button, styled with the app's Alert/Card tokens) at src/app/(app)/volunteers/ (or higher in the (app) tree) so unexpected load failures degrade gracefully instead of 500-ing the segment.
- **[performance] EHS dashboard renders entire active-volunteer roster with no pagination** - `src/app/(app)/volunteers/ehs/page.tsx:41`  
  getEhsDashboard() returns every active volunteer and the table renders all of them unbounded, emitting a <form> for the 'Added to EHS?' toggle plus one <form> per training cell in every row. With a full clinic roster (hundreds of members) and several trainings this is a large server render and a heavy DOM (hundreds to thousands of form elements). The sibling master-compliance view over the same roster population deliberately paginates at pageSize 25, confirming the roster is large enough that pagination matters.  
  _Fix:_ Paginate the EHS roster the same way master/page.tsx does (Pagination primitive + page/pageSize), or add search/department filtering so the rendered set is bounded.

#### Incident reports

- **[anti-pattern] Incidents route segment has no error boundary; unexpected errors 500 the whole subtree** - `src/app/(app)/incidents/strikes/page.tsx:120`  
  UX: The entire /incidents segment ships no error.tsx (only (app)/loading.tsx exists). The strikes page re-throws any non-Forbidden error from listActions and its server actions (`throw err`), and [id]/page.tsx re-throws anything that is not IncidentNotFound/IncidentForbidden. Because there is no error boundary up to the root, an unexpected DB or service error renders Next's bare default 500 with no app chrome, no navigation, and no way back - in a sensitive disciplinary area where users need reassurance and a path forward.  
  _Fix:_ Add an error.tsx at src/app/(app)/incidents/ (a client component with a reset() retry and a link back to /incidents) so thrown errors render inside the app shell instead of a raw 500.
- **[accessibility] SubjectPicker combobox accessible name does not match its visible label** - `src/app/(app)/incidents/subject-picker.tsx:59`  
  The visible Field label reads "Link the people involved (optional)" but the combobox input carries an aria-label of "Search people to link to this report". aria-label overrides the wrapping <label>, so the control's accessible name is the aria-label, which contains none of the visible label text. This fails WCAG 2.5.3 Label in Name: a voice-control user saying "click Link the people involved" will not match, and screen-reader and sighted users hear/see different labels for the same control.  
  _Fix:_ Drop the redundant ariaLabel (let the Field's <label> be the accessible name) or make the aria-label begin with the visible label text, e.g. "Link the people involved".

#### IT support / tech requests

- **[theming] Business-days-open indicator uses hard-coded text-red-600 / text-amber-600 (fails AA contrast in light theme, bypasses tokens)** - `src/modules/support/components/epic-request-tabs.tsx:266`  
  The 'N business days open' urgency label on every open Tracker ticket is painted with raw Tailwind palette colors instead of semantic tokens. On the default cool-neutral canvas (#eef1f5), text-amber-600 (#d97706, the common <=5-days branch) lands at roughly 2.8:1 and text-red-600 (#dc2626) at roughly 4.2:1 - both below the 4.5:1 WCAG 2.1 AA floor for this 12px text, so the aging signal is hard to read for low-vision users. It also never shifts for dark mode, unlike every tokenized color in the app. This is the only raw-palette color usage in the entire src tree.  
  _Fix:_ Replace with semantic tokens: text-critical for the overdue (>5) branch and text-warning (or another AA-passing token) for the on-track branch, so the color both passes AA on the canvas and adapts across light/dark. Consider pairing the color with a non-color cue (e.g. an 'Overdue' badge) since the red/amber distinction currently carries meaning by hue alone.
- **[anti-pattern] "Copy email" gives no success feedback and silently no-ops when clipboard is unavailable** - `src/modules/support/components/epic-request-form.tsx:495`  
  UX: The primary hand-off action of the Epic generator - copying the assembled YNHH email draft - calls navigator.clipboard?.writeText with zero confirmation. The user clicks 'Copy email' and nothing visibly changes, so they cannot tell whether the copy worked and may paste stale/empty content. The optional-chaining guard (?.) means in an insecure context or older browser the click is a complete silent no-op with no error either.  
  _Fix:_ Show a transient confirmation (e.g. flip the label to 'Copied!' for ~2s via local state, or surface a toast). Handle the unsupported-clipboard case by falling back or disabling the button with an explanation instead of a silent no-op.
- **[accessibility] Epic tabs do not expose the active tab to assistive tech (state via color/underline only)** - `src/modules/support/components/epic-request-tabs.tsx:78`  
  The Generate/Tracker/History tab buttons signal the active tab purely visually (border-brand text-brand-fg vs border-transparent text-muted-foreground). There is no aria-current / aria-selected / role=tab, so a screen-reader user cannot tell which tab is currently active - the selected state is conveyed by color and an underline border alone.  
  _Fix:_ Add aria-current="page" (or a proper tablist/role=tab + aria-selected pattern) to the active tab button so the active state is programmatically determinable, not visual-only.

#### Learning + training modules

- **[theming] Quiz review uses raw green/red palette instead of semantic tokens** - `src/app/(app)/training/training-quiz.tsx:281`  
  The correct/wrong answer highlight backgrounds hard-code Tailwind's green-50/green-950 and red-50/red-950 palette rather than the design tokens. A --color-critical-faint token already exists precisely for the danger tint (and adapts in dark mode), so this duplicates and bypasses the token system; theme/brand changes will not reach these tints and they drift from the rest of the app's neutral status styling.  
  _Fix:_ Replace `bg-red-50 dark:bg-red-950/40` with `bg-critical-faint`, and add/use a success-faint token for the correct-answer tint instead of `bg-green-50 dark:bg-green-950/40`.
- **[accessibility] "Correct" status label contrast fails on the green tint** - `src/app/(app)/training/training-quiz.tsx:187`  
  The 'Correct' label renders text-success (#16a34a) on the bg-green-50 (#f0fdf4) option row, ~3.1:1 in light mode, below the 4.5:1 AA minimum for this 12px bold text. Learners reviewing a graded attempt may not be able to read which option was correct.  
  _Fix:_ Use a darker success text shade for this label on the tinted background, or move the correctness cue onto a Badge/higher-contrast token pairing.
- **[anti-pattern] Destructive "Reset" of a learner's progress has no confirmation** - `src/app/(app)/learning/dashboard/page.tsx:59`  
  UX: The dashboard Reset button immediately and irreversibly wipes a learner's course progress/completion on a single click with no confirmation. A misclick in a dense table row destroys completion data. A ConfirmButton primitive exists for exactly this.  
  _Fix:_ Swap the plain `<Button type="submit">Reset</Button>` for the ConfirmButton primitive (or a confirm dialog) so a destructive reset requires explicit confirmation.
- **[anti-pattern] No error boundary for the learning/training route segments** - `src/app/(app)/learning/page.tsx:10`  
  UX: There is no error.tsx anywhere in the (app) tree (only apply/onboard have one) and no global-error.tsx. If any server call throws (e.g. getMyCourses, getCourseCompletion, getMyTraining hitting a DB/service error) the learner or manager gets an unstyled framework 500 instead of a recoverable in-app error state. Applies to both the learning and training segments.  
  _Fix:_ Add a shared `(app)/error.tsx` (client component with a reset action) so thrown errors in these segments render a styled, recoverable error surface instead of crashing the subtree.

#### Admin: people, roles, terms, departments, subcommittees, settings, audit, contract

- **[anti-pattern] "Active Departments" stat card links to /admin/people instead of /admin/departments** - `src/app/(app)/admin/page.tsx:87`  
  UX: An admin clicking the "Active Departments" metric expecting the Departments manager is navigated to the People list instead. The card is a broken/misleading control; Departments is only reachable via the module nav, so the primary affordance dead-ends on the wrong page.  
  _Fix:_ Change href to "/admin/departments". (Note "Active People" on line 77 already correctly points there, so both metrics currently resolve to /admin/people.)
- **[accessibility] Roles editor nests h2 section headers under h3 role names (backwards heading order)** - `src/modules/admin/components/roles-panel.tsx:203`  
  Each role card titles the role with a raw <h3> (line 174), but the per-module permission groups inside that card use <SectionHeader> which defaults to an <h2> (section-header.tsx `as = "h2"`). The document outline therefore drops from h3 back up to h2 repeatedly (once per module, per role), so screen-reader heading navigation reads the "Recruitment"/"Clinic"/"Platform" group labels as siblings of the top-level "Roles" section rather than children of the role. Violates 1.3.1 heading structure.  
  _Fix:_ Render the module-group SectionHeaders as a level below the role name (e.g. as="h3" with the role name promoted, or as a lower level) so the outline nests h1 -> h2 (Roles) -> h3 (role) -> h4 (module group).

#### Admin: email monitor, campaigns, templates

- **[accessibility] Audience condition selects have no accessible name** - `src/app/(app)/admin/email/campaigns/[id]/audience-builder.tsx:157`  
  Each audience condition row has a field `<Select>`, an operator `<Select>`, and value/boolean `<Select>`s with no `<label>`, `aria-label`, or `aria-labelledby`. A screen-reader user building an audience hears bare 'combobox' controls with no indication of what each one selects, making the campaign audience builder very hard to operate non-visually (WCAG 4.1.2 / 3.3.2).  
  _Fix:_ Add an aria-label to each Select (e.g. `aria-label="Field"`, `aria-label="Operator"`, `aria-label="Value"`, `aria-label="Yes or no"`), ideally including the row index/field name for context.
- **[accessibility] Rich-text editing region has no programmatic label** - `src/app/(app)/admin/email/templates/[key]/preview.tsx:114`  
  The 'Message body' `<label>` is an orphan: it has no htmlFor and does not wrap the editor, and the tiptap contentEditable region is rendered with no aria-label. A screen-reader user focusing the main body editor hears an unnamed editable text area, so the primary content control of the template/campaign editor is unlabeled (WCAG 1.3.1 / 4.1.2).  
  _Fix:_ Associate the label with the editor (e.g. give EditorContent `aria-label="Message body"` / role via editorProps attributes, or render the label with an id and point the editable region's `aria-labelledby` at it). The HTML-source Textarea path should likewise carry an accessible name.
- **[anti-pattern] Live "Send now" bulk send fires immediately with no confirmation for audiences of 25 or fewer** - `src/app/(app)/admin/email/campaigns/[id]/review-actions.tsx:84`  
  UX: The most irreversible action in this area, sending real bulk email, has no confirmation step for audiences of 25 or fewer (only >25 requires typing the recipient count). One click on 'Send now' dispatches live emails to up to 25 real people. This is inconsistent with the rest of the surface, where far less consequential actions (Retry, Retry all failed) use ConfirmButton.  
  _Fix:_ Gate 'Send now' behind a ConfirmButton / confirmation dialog for all audience sizes (e.g. 'Send to N recipients now?'), matching the confirm pattern already used for Retry and Retry-all on the email monitor.
- **[accessibility] Segmented Match ALL/ANY toggle conveys state by color only (no aria-pressed)** - `src/app/(app)/admin/email/campaigns/[id]/audience-builder.tsx:127`  
  The ALL/ANY match-mode toggle marks the active option purely with `bg-brand text-white` versus `bg-surface`. There is no `aria-pressed`/`role` state, so screen-reader users (and users who cannot distinguish the brand fill) cannot tell which match mode is selected, which changes who the campaign targets.  
  _Fix:_ Render the pair as a radiogroup or add `aria-pressed={match === 'ALL'}` / `aria-pressed={match === 'ANY'}` to the two buttons so the active state is exposed programmatically.
- **[accessibility] Editor Formatted/HTML mode toggle conveys state by color only (no aria-pressed)** - `src/app/(app)/admin/email/templates/[key]/preview.tsx:117`  
  The Formatted/HTML segmented toggle (and the formatting toolbar buttons that use the same `btn()` active style) indicate the active/pressed state only via `bg-brand text-white`. With no `aria-pressed`, assistive-tech users cannot tell which edit mode or which formatting mark is currently active.  
  _Fix:_ Add `aria-pressed` to the mode toggle buttons and to the toolbar toggle buttons (bold/italic/heading/list/quote/link) so their active state is announced, not just color-coded.
- **[anti-pattern] Email admin route segment has no error boundary** - `src/app/(app)/admin/email/page.tsx:87`  
  UX: There is no error.tsx anywhere in the (app) tree (only apply/ and onboard/ have one, and there is no global-error.tsx). These pages are server components that hit the DB and Microsoft Graph on every load (listEmails, getCampaign, mailConnectionStatus, prisma.* queries). A transient DB/Graph failure throws and surfaces Next's unstyled default error screen with no branded recovery UI across the whole email monitor/campaigns/templates area.  
  _Fix:_ Add an error.tsx boundary for the admin (or email) segment that renders a themed Alert with a retry/reset affordance, so an ops failure degrades gracefully instead of 500-ing the route subtree.

#### Cross-cut: accessibility mechanics

- **[accessibility] Public application wizard has no h1; page heading hierarchy starts at h2** - `src/app/apply/[slug]/apply-wizard.tsx:288`  
  The main /apply/<slug> applicant flow (public-facing, highest a11y stakes) renders no h1. The application's actual title (def.title) is a muted <p> (line 286), and the highest heading on the page is the step-title <h2> at line 288. A screen-reader user navigating by headings lands on 'Getting started' (h2) with no page-level h1 for orientation, and the true page title is not exposed as a heading at all. The two other apply states (closed/submitted via PortalNotice, and /apply root) correctly use h1, so this flow is the outlier.  
  _Fix:_ Promote the application title to the page's h1 (e.g. render def.title as <h1> and keep the step name as the h2 below it), or add an h1 in the wizard/PortalShell so the document starts at level 1 and descends without skipping.
- **[accessibility] Overdue-ticket age label fails WCAG AA contrast (hard-coded amber/red small text)** - `src/modules/support/components/epic-request-tabs.tsx:266`  
  The 'business days open' urgency label is 12px text (inherits the parent's text-xs) rendered in text-amber-600 (#d97706 ≈ 3.4:1 on the white Card surface) or text-red-600 (#dc2626 ≈ 4.0:1) - both under the 4.5:1 AA threshold for normal text, so the value is hard to read in light mode. The colors are also raw Tailwind palette values that bypass the token system, so they do not adapt on theme switch (no dark variant).  
  _Fix:_ Use the semantic text-warning / text-critical tokens (tuned to pass AA in both themes) instead of text-amber-600 / text-red-600. The '· N business days open' text is already present, so the non-color signal is fine; only the color needs fixing.
- **[accessibility] Session-timeout warning is not announced to assistive technology** - `src/platform/auth/inactivity.tsx:59`  
  The 'Still there? You'll be signed out in 5 minutes' banner that appears before an automatic logout is a plain <div> with no role="alert" and no aria-live region. It is inserted into the DOM when the warning fires, so a screen-reader user gets no announcement and can be signed out (losing unsaved form work) without warning. This is the exact scenario WCAG 2.2.1 (Timing Adjustable) / 4.1.3 (Status Messages) targets.  
  _Fix:_ Add role="alert" (or aria-live="assertive" with an appropriate region) to the banner container so the warning is announced when it appears, and ensure the 'Stay signed in' button is reachable/focusable at that moment.

#### Cross-cut: primitive adoption & anti-patterns

- **[accessibility] Field-builder row actions are hover-only (opacity-0 group-hover) with no focus-within or touch fallback** - `src/app/(app)/recruitment/cycles/[id]/builder/field-card.tsx:64`  
  The Edit / Duplicate / Remove action cluster (and the drag handle at line 58) is `opacity-0 group-hover:opacity-100` with no `group-focus-within:opacity-100`. A keyboard user tabbing into the card lands focus on buttons that are rendered at opacity 0 (their focus ring is invisible too) - a WCAG 2.4.7 Focus Visible failure. On touch devices there is no hover, so these controls can never be revealed at all, making editing/duplicating/removing a field impossible on a tablet.  
  _Fix:_ Add `group-focus-within:opacity-100` (and ideally `focus-visible:opacity-100` on the buttons) alongside the hover rule, or keep the controls always visible. This is the only place in the app that hides interactive controls behind hover-only opacity.

#### Cross-cut: route states & error/empty/loading coverage

- **[anti-pattern] Authenticated (app) subtree has no error.tsx boundary - any thrown error escapes the app shell to Next's bare error page** - `src/app/(app)/page.tsx:27`  
  UX: The entire signed-in app (~60 page.tsx under src/app/(app), plus public login/welcome/get-started) has zero error boundaries - the only two error.tsx in the whole app are src/app/apply/[slug]/error.tsx and src/app/onboard/[token]/error.tsx, and there is no root error.tsx or global-error.tsx. When any server component throws (a Neon/Prisma transient error, a service exception, an unexpected null), the error bubbles past the persistent AppShell to Next's built-in global error screen: the user loses all app chrome, navigation, and the toolbar, and gets no 'Try again' recovery. The dashboard itself fetches mySchedule, listMyCertificates, getOnboardingStatus, isInterviewPanelist and complianceStatus with no boundary, so a single failing call blanks the whole app.  
  _Fix:_ Add a client-component src/app/(app)/error.tsx (with reset()) that renders a recoverable error state inside the shell, and a src/app/global-error.tsx as the last-resort root fallback. Also add an error.tsx to the public get-started onboarding segment, which fetches onboarding status and is a new user's first impression.
- **[anti-pattern] Email template editor throws a raw Error on an unknown [key] instead of calling notFound()** - `src/app/(app)/admin/email/templates/[key]/page.tsx:31`  
  UX: getTemplateForEdit() throws `new Error("Unknown email template: <key>")` for any key it does not recognize, and the page calls it with no try/catch and no notFound(). Because the admin segment has a loading.tsx but no error.tsx, a mistyped, stale, or renamed template URL renders Next's bare error page (or a dev error overlay) rather than a clean 404 - an admin who followed an old link is stranded with a stack-trace-style screen instead of the standard not-found UI.  
  _Fix:_ Wrap the fetch in a guard: catch the unknown-key case (or have getTemplateForEdit return null) and call notFound() so the route renders src/app/not-found.tsx instead of 500-ing.


### P3 - Polish - fix if time permits (72)


**accessibility (13)**
- Table TH primitive never sets scope="col" - `src/platform/ui/table.tsx:28`  
  _Fix:_ Default scope="col" on TH (before spreading ...rest so callers can still override to "row" for row headers): <th scope="col" {...rest} ...>.
- Modal has no accessible name when title is omitted - `src/platform/ui/modal.tsx:86`  
  _Fix:_ Require a title, or accept an aria-label prop and fall back to it when title is absent so role="dialog" always has an accessible name.
- Notification bell toggle lacks aria-expanded/aria-haspopup - `src/platform/ui/notification-bell.tsx:91`  
  _Fix:_ Add aria-haspopup="true" and aria-expanded={open} to the toggle button.
- GlobalNav overflow uses role=menu/menuitem without menu keyboard semantics - `src/platform/ui/global-nav.tsx:191`  
  _Fix:_ For a simple list of navigation links, drop role="menu"/role="menuitem" (a labelled container of links is correct), or implement full APG menu keyboard support if the menu roles are kept.
- Required-field asterisk in field preview is not aria-hidden - `src/modules/recruitment/components/field-preview.tsx:33`  
  _Fix:_ Add aria-hidden="true" to the asterisk span, matching src/platform/ui/input.tsx Field.
- TypePicker menu advertises role="menu" but omits arrow-key navigation and focus move - `src/app/(app)/recruitment/cycles/[id]/builder/type-picker.tsx:48`  
  _Fix:_ Either implement roving tabindex + ArrowUp/Down navigation and move focus into the menu on open, or drop the menu/menuitem roles and treat it as a plain group of buttons.
- Validation errors are not linked to their fields and focus is not moved to the first error - `src/modules/clinic/avs/avs-tool.tsx:45`  
  _Fix:_ Mark invalid inputs with aria-invalid and move focus to the first invalid control instead of only scrolling to top; optionally link each message via aria-describedby.
- Nested "Strike requests" heading renders as an h2 sibling of its parent section - `src/app/(app)/incidents/[id]/page.tsx:339`  
  _Fix:_ Pass `as="h3"` to the nested "Strike requests" SectionHeader so the heading outline reflects the visual nesting.
- History month headings jump from h1 to h3, skipping a heading level - `src/modules/support/components/epic-request-tabs.tsx:333`  
  _Fix:_ Either add a SectionHeader (<h2>) for the History section, or render the month labels via SectionHeader as="h3" beneath an h2 so the outline is h1 -> h2 -> h3 without a gap.
- Quiz question text not part of the fieldset's accessible name - `src/app/(app)/training/training-quiz.tsx:167`  
  _Fix:_ Include the question text in the legend, or link the <p> to the group via aria-labelledby (legend id + question id) so the radio group's accessible name carries the question.
- Required form fields have no visible required indicator across every admin form - `src/modules/admin/components/person-form.tsx:52`  
  _Fix:_ Pass `required` to the <Field> wrapper (not only the <Input>) for mandatory fields so the visual asterisk renders, matching the primitive's intended contract.
- <label>Audience</label> has no associated form control - `src/app/(app)/admin/email/campaigns/[id]/audience-builder.tsx:116`  
  _Fix:_ Render this as a <p>/heading (styled the same), or associate it with the condition group via a proper grouping/labelledby relationship rather than a bare <label>.
- No skip-to-content link in the app shell - `src/platform/ui/app-shell.tsx:115`  
  _Fix:_ Add a visually-hidden 'Skip to content' link (revealed on focus) at the top of the shell that targets the <main> region (give <main> an id and focus target).

**anti-pattern (34)**
- Alert uses rounded-lg instead of the canonical rounded-xl for alerts - `src/platform/ui/alert.tsx:55`  
  _Fix:_ Change the Alert container radius from rounded-lg to rounded-xl to match the canonical alert radius.
- HavenMark hard-codes Poppins, a font the app never loads - `src/platform/ui/haven-mark.tsx:20`  
  _Fix:_ Either load Poppins for the mark or convert the wordmark to an outlined path / use the app font, so the rendered mark is deterministic rather than dependent on an unavailable font.
- Sign-out control is a hand-rolled native button with a non-canonical radius - `src/platform/ui/app-shell.tsx:99`  
  _Fix:_ Render the sign-out via the Button primitive (variant outline, size sm) so radius, focus ring, and hover come from the shared control; keep the responsive icon/text swap as its children.
- Both next-shift hero CTAs link to the same /schedule route - `src/app/(app)/page.tsx:364`  
  _Fix:_ Point "Request a change" at the actual change-request affordance (deep-link or query param) if one exists, or drop the second CTA to avoid two buttons with identical destinations.
- get-started route segment has no error boundary (thrown DB error falls through to Next's default 500) - `src/app/get-started/page.tsx:1`  
  _Fix:_ Add src/app/get-started/error.tsx (a client boundary mirroring onboard/[token]/error.tsx) rendering a branded retry + support contact. Consider one at the /apply root and a shared signed-out error boundary too.
- Invalid/used onboarding link is a dead end with no support contact or next step - `src/app/onboard/[token]/page.tsx:11`  
  _Fix:_ Give this terminal state a support contact (getSupportContact()/SupportLink) and/or a clear next action, matching the PortalNotice pattern used in apply/[slug]/page.tsx for closed cycles.
- No error boundary for the recruitment (app) route tree - `src/app/(app)/recruitment/interviews/[interviewId]/page.tsx:1`  
  _Fix:_ Add an error.tsx to the recruitment segment (or the shared (app) segment) presenting a themed error state with a retry/back affordance.
- TypePicker dropdown popover doesn't use the design-system glass-panel - `src/app/(app)/recruitment/cycles/[id]/builder/type-picker.tsx:49`  
  _Fix:_ Style the TypePicker menu with `glass-panel` (as the Combobox listbox does) for a consistent popover material.
- Availability chips look selected whether checked or not (ambiguous state + inconsistency) - `src/app/(app)/schedule/page.tsx:353`  
  _Fix:_ Make the unchecked branch neutral to match the builder view, e.g. "border-border text-muted-foreground hover:border-brand/40" (drop bg-brand/5 and text-brand-fg from the unchecked state).
- Date-strip unselected links have a dead hover state (hover class equals base) - `src/app/(app)/schedule/builder/page.tsx:572`  
  _Fix:_ Point the hover at a distinct token (e.g. base bg-muted / hover:bg-muted-strong, or hover:border-border-strong) so the date pills give feedback on hover. Fix both builder/page.tsx:572 and full/page.tsx:67.
- Pending-request rows are cards nested inside the panel card (hand-rolled surface) - `src/modules/schedule/components/pending-requests.tsx:80`  
  _Fix:_ Use <Card size="compact" pad={false}> (rounded-xl, no shadow) for the nested rows so the radius/border stay consistent and the nesting reads as a sub-panel rather than a duplicate content card.
- Assignable-member card hand-rolls a surface instead of the Card primitive - `src/app/(app)/schedule/builder/page.tsx:453`  
  _Fix:_ Render the tile via <Card pad={false}> (or cardClasses()) and keep only the available/unavailable state classes in className, matching how the Assigned column already uses <Card> for its rows.
- Required asterisk is typed into the label string instead of using Field's required prop - `src/modules/clinic/avs/avs-tool.tsx:109`  
  _Fix:_ Use `<Field label="Last name" required>` (and the same for Visit date / Reason for visit) so the asterisk comes from the primitive with aria-hidden.
- Clinic route segment has no error boundary - `src/app/(app)/clinic/avs/page.tsx:4`  
  _Fix:_ Add an error.tsx to src/app/(app)/clinic (or the (app) segment) rendering a themed retry fallback so runtime errors degrade gracefully instead of 500-ing the subtree.
- EHS 'Manage trainings' list has no empty state - `src/app/(app)/volunteers/ehs/manage/page.tsx:36`  
  _Fix:_ Add an empty-state line when trainings.length === 0, e.g. a muted `<p>No EHS trainings yet. Create one above.</p>`, matching the empty-state copy used elsewhere in the segment.
- Section headings hand-rolled instead of using the SectionHeader primitive - `src/app/(app)/volunteers/offboarding/page.tsx:118`  
  _Fix:_ Replace the hand-rolled section <h2>s with `<SectionHeader level="title" className="mb-3">...</SectionHeader>` so subsection headings stay consistent app-wide.
- "Your name" uses a disabled Input where the ReadonlyField primitive exists - `src/app/(app)/incidents/page.tsx:188`  
  _Fix:_ Replace `<Field label="Your name"><Input defaultValue={actor.name ?? ""} disabled /></Field>` with `<ReadonlyField label="Your name" value={actor.name ?? ""} />`.
- Strikes issue form has inconsistent required-field indicators - `src/app/(app)/incidents/strikes/page.tsx:324`  
  _Fix:_ Use the Field `required` prop consistently on Person, Date, Category, and Description, and remove the literal " *" from the Description label so all required markers render the same way.
- "Record action" (the form's primary CTA) is styled as a secondary outline button - `src/app/(app)/incidents/strikes/page.tsx:377`  
  _Fix:_ Use variant="primary" for the Record action submit to match the other primary CTAs in this module.
- "My reports" empty state gives no path to file the first report - `src/app/(app)/incidents/mine/page.tsx:79`  
  _Fix:_ Add a primary link/button to /incidents ("Report a concern") in the empty state so first-time users can act directly.
- "Mark complete" and other Tracker mutations run without pending/disabled feedback (double-submit risk) - `src/modules/support/components/epic-request-tabs.tsx:282`  
  _Fix:_ Wrap the mutation in a <form action={...}> with a SubmitButton (which already provides a pending state), or track a local pending flag to disable the button while the action is in flight.
- Support route segment has no error boundary; unexpected server-action throws surface the unstyled framework error page - `src/app/(app)/support/page.tsx:1`  
  _Fix:_ Add a src/app/(app)/support/error.tsx (or an (app)-level boundary) that renders a themed Alert/Card with a retry via reset(), matching the existing apply/onboard error boundaries.
- SCORM iframe embeds uploaded content with no sandbox attribute - `src/app/(app)/learning/[courseId]/ScormPlayer.tsx:156`  
  _Fix:_ Add a sandbox with the minimum needed grants (e.g. `sandbox="allow-scripts allow-same-origin allow-forms"`), deliberately withholding allow-top-navigation, allow-popups, and allow-downloads so course content cannot hijack the parent window.
- Link-styled buttons hand-rolled instead of reusing button classes - `src/app/(app)/training/page.tsx:195`  
  _Fix:_ Style these Links via `className={buttonClasses('primary'|'outline', 'md')}` (the helper is exported for Link/anchor use) so they stay consistent with Button, including its focus-visible outline.
- Raw <h2> headings instead of the SectionHeader primitive - `src/app/(app)/learning/manage/[courseId]/page.tsx:58`  
  _Fix:_ Replace the raw `<h2 className="font-medium">` headings with the SectionHeader primitive to keep heading styling consistent.
- Course-completion dashboard has no zero-courses guidance - `src/app/(app)/learning/dashboard/page.tsx:19`  
  _Fix:_ Add an explicit empty state when `courses.length === 0` (e.g. a message linking to Manage courses) instead of rendering an empty Select and the per-course empty row.
- Pervasive arbitrary px values bypass the spacing and type scale - `src/app/(app)/training/page.tsx:43`  
  _Fix:_ Map these to the nearest scale steps (text-sm/base, gap-4/gap-5, p-5/p-6, rounded-lg/rounded-2xl) so spacing, type, and radii align with the system tokens.
- Admin route segment has no error boundary; unmapped server-action throws surface a bare error page - `src/app/(app)/admin/page.tsx:13`  
  _Fix:_ Add an error.tsx boundary for the admin segment (or the (app) group) that renders a themed, retryable error state consistent with PageLoading, so a thrown error degrades gracefully instead of showing the framework fallback.
- Nested card: person-search results panel is a rounded-2xl bordered box inside a Card - `src/modules/admin/components/assignment-form.tsx:317`  
  _Fix:_ Match RosterPanel: render the results as a lighter inner list (no second rounded-2xl border) or lift it out to its own Card so surfaces don't stack.
- Section headings hand-rolled as <h2> instead of the SectionHeader primitive - `src/app/(app)/admin/settings/page.tsx:138`  
  _Fix:_ Use <SectionHeader level="title"> for these headings so size, weight, and the foreground token stay consistent with the rest of the admin area.
- "Sent runs" table is hand-rolled instead of using the Table primitive - `src/app/(app)/admin/email/campaigns/[id]/page.tsx:428`  
  _Fix:_ Replace the raw table with the Table/THead/TR/TH/TD primitives (imported and used in ../../page.tsx) so styling, radii, and horizontal-scroll behavior match the rest of the area.
- Manage courses list renders nothing (no empty state) when zero courses exist - `src/app/(app)/learning/manage/page.tsx:25`  
  _Fix:_ Add a `courses.length === 0` branch rendering a short empty-state line (e.g. 'No courses yet - create your first above.'), matching the Card empty states already used in RequestList / departments-list.
- Manage EHS trainings list has no empty state at zero rows - `src/app/(app)/volunteers/ehs/manage/page.tsx:37`  
  _Fix:_ Add a `trainings.length === 0` empty-state branch consistent with the app's other list empty states.
- incidents, support, and notifications segments have no dedicated loading.tsx for their paginated queries - `src/app/(app)/incidents/review/page.tsx:88`  
  _Fix:_ Add a loading.tsx to each of these three segments returning a Skeleton table/list that matches the page shape, matching the pattern already used by the sibling modules.

**copy (7)**
- EHS onboarding task shows "Action needed" with no actionable control - `src/app/get-started/onboarding-checklist.tsx:39`  
  _Fix:_ Give non-actionable INCOMPLETE tasks (href-less) a distinct label/tone such as "Pending" or "Awaiting coordinator" instead of the generic "Action needed".
- Track column shows raw uppercase enum value instead of proper-case label - `src/app/(app)/recruitment/page.tsx:55`  
  _Fix:_ Map the enum to a display label (Volunteer / Director), matching the Select options in cycles/new/page.tsx.
- Raw uppercase enum values shown as decision status labels - `src/app/(app)/recruitment/cycles/[id]/interviews/page.tsx:17`  
  _Fix:_ Map decisions to sentence-case labels (Accepted / Rejected / Waitlisted / Pending) before rendering, consistent with how recommendations are humanized elsewhere.
- Offboarding user-facing error copy uses '--' double-hyphen - `src/modules/volunteers/services/offboarding.ts:125`  
  _Fix:_ Replace '--' with a period or comma, e.g. "No active term. Cannot flag for offboarding." and "No active term. Cannot unflag." (line 165). Avoids the em-dash the house style forbids while reading as proper copy.
- Double-hyphen "--" used as a label separator, inconsistent with the "·" used elsewhere in the module - `src/modules/admin/components/roster-panel.tsx:361`  
  _Fix:_ Standardize on "·" (already used for person/term descriptions) for these code/name separators so the module reads consistently.
- Campaign list shows raw uppercase enum status - `src/app/(app)/admin/email/campaigns/page.tsx:53`  
  _Fix:_ Map the status to a human label (e.g. Draft / Sent / Scheduled / Recurring / Cancelled), ideally rendered with the Badge primitive to match the status styling used elsewhere.
- User-facing error message tells users to check the browser console - `src/app/(app)/learning/manage/[courseId]/UploadPackageForm.tsx:91`  
  _Fix:_ Replace the fallback with a plain-language message and a next step (e.g. "Upload failed. Please check the file and try again, or contact support.").

**performance (4)**
- Onboarding progress bar animates width (layout property) and lacks a reduced-motion guard - `src/app/get-started/page.tsx:59`  
  _Fix:_ Animate via transform: scaleX (with transform-origin left) instead of width, and add motion-reduce:transition-none as done in wizard-progress.tsx.
- Applicants table renders all rows with no pagination - `src/app/(app)/recruitment/cycles/[id]/applicants/page.tsx:47`  
  _Fix:_ Paginate the applicants table (Pagination primitive) or cap + lazy-load rows once counts grow.
- Per-shift swap-partner lookups run as a sequential await waterfall - `src/app/(app)/schedule/page.tsx:59`  
  _Fix:_ Collect the non-pending shift keys and resolve their partners with a single Promise.all (or a batched query) so the lookups run concurrently.
- Course-completion dashboard renders every learner with no pagination - `src/app/(app)/learning/dashboard/page.tsx:47`  
  _Fix:_ Paginate server-side (add `take`/`skip` to `getCourseCompletion` and render the `Pagination` primitive), or at minimum add a department filter that bounds the query, so the completion table does not grow linearly with total headcount.

**responsive (10)**
- Nav icon buttons are 32px, below the comfortable 44px touch target - `src/platform/ui/theme-toggle.tsx:46`  
  _Fix:_ Bump the interactive hit area of the header icon buttons toward ~44px on touch (e.g. larger padding or a min-h/min-w while keeping the icon at 16px), consistent with the lg Button target.
- PageHeader can collide title and action on narrow viewports - `src/platform/ui/page-header.tsx:14`  
  _Fix:_ Add a gap, min-w-0 on the title container, and stack on small screens (e.g. flex-col gap-3 sm:flex-row sm:items-start sm:justify-between).
- Review-step "Edit" button is below the 44px minimum touch target - `src/app/apply/[slug]/wizard-review.tsx:57`  
  _Fix:_ Increase the hit area (larger padding or a min-h-[44px] tap zone) for the Edit control while keeping its compact visual size.
- Date-strip and hero toggle tap targets are under ~44px - `src/app/(app)/schedule/builder/page.tsx:565`  
  _Fix:_ Increase vertical padding on the date pills and toggles to reach ~44px min height (e.g. py-2 with min-h) on touch, or bump hit area via a larger tappable wrapper.
- Two-column field grids have no responsive breakpoint - `src/modules/clinic/avs/avs-tool.tsx:105`  
  _Fix:_ Use `grid grid-cols-1 gap-4 sm:grid-cols-2` on both grids so fields stack below the sm breakpoint.
- "Remove" subject link is a sub-44px touch target on mobile - `src/app/(app)/incidents/subject-picker.tsx:93`  
  _Fix:_ Give the Remove control padding to reach ~44px tall/wide (e.g. py-2 px-2 with a larger tap area) or render it as an icon Button with an accessible label sized to the touch minimum.
- Inline SR-number save/cancel icon buttons are 24x24px, below the minimum touch target - `src/modules/support/components/ticket-number-field.tsx:46`  
  _Fix:_ Give the icon buttons at least a 44x44px hit area (e.g. min-h-11 min-w-11 or padding around the icon) while keeping the icon glyph small, so touch users can reliably save/cancel.
- Department checkbox grid is fixed at two columns with no breakpoint - `src/app/(app)/learning/manage/[courseId]/page.tsx:72`  
  _Fix:_ Start single-column and step up (e.g. `grid-cols-1 sm:grid-cols-2`) so labels have full width on narrow screens.
- Recruitment field-card edit/duplicate/remove controls and drag handle are hover-only (unreachable on touch) - `src/app/(app)/recruitment/cycles/[id]/builder/field-card.tsx:64`  
  _Fix:_ Reveal the controls on touch and focus, not just hover: either drop opacity-0 (show them always at reduced emphasis), add group-focus-within:opacity-100, or gate the hover-hide behind @media (hover: hover) so pointer-less devices always see them.
- Volunteer 'My Availability' date chips have sub-44px tap targets on a mobile-primary flow - `src/app/(app)/schedule/page.tsx:353`  
  _Fix:_ Increase the vertical hit area on these chips (e.g. py-2.5 or a min-h) so each toggle reaches ~44px tall on this mobile-first flow.

**theming (4)**
- 'Shadow' assign-mode toggle uses hard-coded bg-amber-700 - `src/app/(app)/schedule/builder/page.tsx:608`  
  _Fix:_ Replace bg-amber-700 with a semantic token (e.g. a warning/brand-accent token) so the active shadow state theming stays consistent in light and dark.
- Danger Button hover color is hard-coded (hover:bg-red-700) - `src/platform/ui/button.tsx:13`  
  _Fix:_ Introduce a critical-hover token (or use a token-derived shade) for the danger hover state so it tracks the critical color across themes.
- Quiz correct/incorrect option fills bypass faint tokens (raw green-50/red-50) - `src/app/(app)/training/training-quiz.tsx:281`  
  _Fix:_ Swap bg-green-50/bg-red-50 (+ dark variants) for the success-faint / critical-faint tokens to keep quiz feedback surfaces on the token system.
- Hard-coded text-red-600 / text-amber-600 instead of critical/warning tokens - `src/modules/support/components/epic-request-tabs.tsx:266`  
  _Fix:_ Swap to `text-critical` and `text-warning` for token consistency.


---

## Method & scope notes

- **Review-only.** No code was changed for this audit. Source `tsc` and `eslint` baselines are clean.
- **Measured against the real design system,** not a generic checklist: intentional house style (no em-dashes, Liquid Glass material, Hanken-only type, cool-neutral canvas, theme non-flip on brand/scrim, in-house email template subset) was explicitly excluded from findings.
- **Relationship to prior passes.** The 2026-07-09 and two 2026-07-10 audits covered logic, security, authz, concurrency, and data-integrity. This pass is orthogonal: it touches UI/UX, accessibility, theming, responsive, performance, and production-readiness. Only overlap: a few UX-consistency items (dead links, missing confirmations) that a logic audit would not frame as accessibility/UX.
- **Dominant, cheap wins.** Two systemic fixes close the majority of the P1 surface: (1) recalibrate the `success`/`warning`/`brand-fg` status-text tokens to clear AA on light and dark, and (2) add an `error.tsx` boundary to the `(app)` route group. Both are one-change-fixes-many.
