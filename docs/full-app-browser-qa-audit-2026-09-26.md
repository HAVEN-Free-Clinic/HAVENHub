# HAVEN Hub browser QA / UI audit, 2026-09-26

The previous UI audits (2026-07-11, 2026-07-29, 2026-09-05) read the source. This one drove
the running app in Chromium. The aim was to catch what only shows up at runtime: console and
hydration errors, failed requests, layout that breaks at phone width, axe accessibility
violations, and navigation that leads a user somewhere they cannot go.

## Method

- **App under test.** `next dev` (16.3.4) against a throwaway local Postgres (`havenhub_uxaudit`).
  It was built with `npm run db:seed` then `npm run fixtures:ux`, so every journey had data:
  an open cycle, an accepted applicant, a SCORM course, shifts, an incident, a tech request, and
  notifications.
- **Crawler.** A Playwright crawler signed in as each persona. It visited all 131 `page.tsx`
  routes, then followed in-app links to dynamic routes, up to 2 instances per route pattern.
  It made **554 page visits** in total:

  | Persona | Account | Visits |
  |---|---|---|
  | Platform admin | `j.carney` | 200 |
  | Department director | `dev.director` | 93 |
  | Cleared volunteer | `dev.volunteer` | 89 |
  | New member held at the onboarding gate | `ux.fresh` | 87 |
  | Signed out | none | 85 |

- **What was recorded on each visit.**
  - HTTP status and final URL (redirects included)
  - console errors and warnings, and uncaught page errors
  - requests that returned 4xx/5xx or failed
  - the visible `<h1>` count
  - raw `ENUM_CASE` text on screen
  - `undefined`, `NaN` or `Invalid Date` in rendered text
  - axe-core 4.x results (`wcag2a`, `wcag2aa`, `wcag21aa`, `best-practice`)
  - a desktop screenshot at 1366px and a mobile screenshot at 375px, with a horizontal-overflow probe
- **Targeted passes.**
  - Each persona's full header navigation, dropdown sub-pages included, followed link by link.
  - Keyboard focus order.
  - The command palette (Ctrl+K).
  - The mobile menu.
  - Dark mode.
  - The 404 page and the error state after a failed sign-in.
  - The public apply flow.
  - The support-auditor persona.
- **Noise excluded.** `.env.example` ships a placeholder PostHog token
  (`phc_your_project_token`), so every page logs PostHog 404s locally. Those errors, and the
  "2 Issues" badge they put on the Next dev overlay, are local-only and excluded below.
- **Not measured.**
  - Performance. Dev-mode compile times dominate, so none of the load times here are meaningful.
  - Form submissions that mutate data (not exercised).
  - The Yale SSO / Entra sign-in path. It isn't configured locally; the dev email sign-in was used.

## Summary

| Severity | Count |
|---|---|
| High | 2 |
| Medium | 5 |
| Low | 6 |

The app is in good shape at runtime:

- No page crashed.
- No page returned a 5xx.
- No error boundary rendered.
- No `undefined` or `Invalid Date` leaked into the UI.
- Every nav link a persona is shown resolves to a page that persona can open.

Keyboard support is solid: a skip link comes first, and every control in the header showed a
visible focus ring. The command palette, dark mode, the 404 page and the failed-sign-in message
all read well.

The problems cluster in two places:

1. **Phone-width layout on data-dense pages.** One shared-primitive bug accounts for most of it.
2. **Accessibility attributes lost at runtime.** Hydration mismatches, unlabelled inputs, and dimmed text.

---

## High

### H1. The `Table` primitive lets its sr-only header escape the scroll region, so wide tables scroll the whole page on phones

- **Where:** `src/platform/ui/table.tsx` (the `ScrollRegion` inside `Table`).
- **Seen on:**

  | Page | Width at 375px |
  |---|---|
  | `/volunteers` (and `/volunteers/master`, which redirects there) | 1328px |
  | `/admin/email` | 999px |
  | `/incidents/strikes` | 592px |

  Any other `Table` whose last column carries a visually hidden header is also affected.
- **Repro:**
  1. Open `/volunteers` at 375px wide as an admin or director.
  2. The entire page, header and filters included, pans sideways.
- **Cause:** The table is already inside an `overflow-x-auto` scroll region (325px wide),
  which works. But the last column's header is `<span class="sr-only">Actions</span>`, and
  `sr-only` is `position: absolute`. Because the scroll region is not positioned, that span lays
  out against an outer container instead. It lands at the table's full right edge (x=1328 on
  `/volunteers`) and widens the document.
- **Fix:** Add `relative` to the `ScrollRegion` className in `Table`.
- **Verified live:** Setting `position: relative` on the scroll wrapper in the browser brought
  all three pages to exactly 375px.

  | Page | Before | After |
  |---|---|---|
  | `/volunteers` | 1328 | 375 |
  | `/admin/email` | 999 | 375 |
  | `/incidents/strikes` | 592 | 375 |

- **Why high:** It hits the compliance roster, the page directors use most on a phone on clinic
  Saturdays. The fix is one class on a shared primitive.

### H2. Hydration mismatch in the form builder drops the drag-and-drop instructions for screen readers

- **Where:** `src/app/(app)/recruitment/cycles/[id]/builder/sortable-list.tsx:73` (`<DndContext>`).
- **Seen on:**
  - `/recruitment/contract`
  - `/recruitment/cycles/[id]/builder`
  - `/recruitment/cycles/[id]/builder/contract`
  - `/recruitment/cycles/[id]/builder/quiz`
- **Console:** `A tree hydrated but some attributes of the server rendered HTML didn't match`.
  The diff shows the same line on every drag handle:
  `+ aria-describedby="DndDescribedBy-2"` / `- aria-describedby="DndDescribedBy-32"`.
- **Cause:** dnd-kit generates its describedby ID from a module-level counter. That counter
  differs between the server render and the client render.
- **Why it matters:** React does not patch attributes after a mismatch. So every drag handle
  points `aria-describedby` at an element ID that doesn't exist, and screen-reader users lose
  the "press space to pick up" instructions on the three builders.
- **Fix:** Pass a stable ID: `const id = useId(); <DndContext id={id} ...>`.

## Medium

### M1. The Epic request form overflows its card at phone width

- **Where:** `src/modules/support/components/epic-request-form.tsx:166-240`, the
  `grid gap-4 sm:grid-cols-3` holding Authorizer, Request type, Scope and Access date range.
- **Seen on:** `/support/epic`, Generate tab, at 375px. Every select and both date inputs extend
  about 50px past the card's right edge; the document is 395px wide.
- **Cause:** "Access date range" puts two `type="date"` inputs side by side in a flex row. Their
  combined minimum width forces the single-column grid track (`1fr` = `minmax(auto, 1fr)`)
  wider than the card, and every field in that column inherits the width.
- **Fix:** Either of these works:
  - Give the date inputs `min-w-0 flex-1`.
  - Stack the pair below `sm` (`flex-col sm:flex-row`).

  Pairing either with `grid-cols-[minmax(0,1fr)]` on the grid also stops it recurring.

### M2. `/schedule/attendings` overflows at phone width

- **Where:** the "Enable Hub access for all / Specialties / Credentialing" action row
  (`div.flex.items-center.gap-2`). It is 411px wide in a 375px viewport and does not wrap.
- **Fix:** Add `flex-wrap` to that row. It sits beside the page's other controls, which already
  wrap.

### M3. The login, magic-link and OAuth-consent screens have no `<main>` landmark

- **Where:**
  - `src/app/login/page.tsx:53`
  - `src/app/login/verify/page.tsx:56`
  - `/oauth/authorize`

  Each renders its card in a bare `<div>`.
- **axe:** `landmark-one-main` and `region` fire on every signed-out visit. That is 80 of the
  171 `region` hits; the remainder are M4.
- **Why it matters:** These are the first screens every user sees, and a screen-reader user's
  "jump to main" does nothing on them. `/welcome`, `/apply` and `/get-started` already use
  `<main>`.
- **Fix:** Change the outer `div` to `main` on each.

### M4. The `/get-started` copyright notice sits outside any landmark and forces a scroll

- **Where:** `src/app/get-started/layout.tsx:29`. The notice is rendered in a plain `div` after
  the page's `<main>`.
- **Effects:**
  - axe `region` fires on every onboarding page.
  - On desktop, the checklist's full-height brand rail (`min-h-screen`) is followed by this
    strip, so the page always scrolls about 48px, and the rail's "Need help? Contact your
    recruitment…" line sits against the bottom edge.
- **Fix:** Render the notice in a `<footer>`. Also either move it inside the grid's content
  column, or change the rail to `min-h-[calc(100dvh-footer)]`.

### M5. The support auditor persona is locked out of the one surface it was granted

- **Repro:** Sign in as `dev.support-auditor@yale.edu` on a database where
  `npm run fixtures:ux` has run. Every route, including `/support/all`, redirects to
  `/get-started` ("Let's get you cleared, Dev").
- **Cause:** The seed makes the auditor a VADM volunteer (`prisma/seed.ts`), and the onboarding
  gate exempts only `admin.access` (`src/modules/onboarding/services/onboarding.ts:27`). Once the
  fixtures add EHS requirements and a course assignment, the auditor is no longer onboarded, so
  `support.view_all_requests` becomes unreachable.
- **Why it matters:**
  - `e2e/support-tech-requests.spec.ts:283` asserts the auditor lands on `/support/all`. That
    holds only while the auditor's onboarding happens to be complete, so it depends on fixture
    state.
  - In production, the equivalent person is an IT auditor who also appears on a roster. They
    would have to finish HIPAA and EHS before reading tickets they were explicitly granted.
- **Decide one of:**
  - Take the auditor off the VADM roster in the seed, so the persona tests the permission rather
    than the gate.
  - Or let the gate pass through routes whose only access requirement is a non-clinical
    read permission.

  The first is a one-line seed change. The second is a product call.

## Low

### L1. The support reply form's file input has no accessible name (axe critical)

- **Where:** `src/modules/support/components/comment-thread.tsx:110`. The same unlabelled input
  is in `submit-form.tsx:57` and `epic-request-tabs.tsx:187`; the latter two have a visible
  "Attachments" label but it isn't associated with the input.
- **Fix:** Wrap each input in `Field label="Attachments"`, as `/incidents/new` already does via
  `UploadSizeField`.

### L2. Inactive department rows fail contrast

- **Where:** `src/app/(app)/admin/departments/page.tsx:37`. `opacity-60` is applied to the whole
  row.
- **Measured:**

  | Element | Contrast | Required |
  |---|---|---|
  | Department link | 3.8:1 | 4.5:1 |
  | "Inactive" chip | 2.64:1 | 4.5:1 |

- **Fix:** The chip already says "Inactive". Drop the row opacity, or dim only the non-text
  cells.

### L3. Empty `<th>` on three tables

- **Where:**
  - `/admin/roles` (column 5)
  - `/learning/dashboard` (column 5)
  - `/outreach/identities` (column 3)
- **Fix:** Add `<span className="sr-only">Actions</span>`. It becomes safe to do once H1 lands.

### L4. Heading levels skip from h1 to h3

- **Where:**
  - The dashboard `/` (the "Your status" rail)
  - `/get-started/hipaa`
  - Two email-template previews (`/admin/email/templates/epic-activation`, `epic-password-reset`)
- **Fix:** Render these section titles as `h2`; `SectionHeader` supports `as`.

### L5. The profile step says date of birth is "Set during onboarding" while you are onboarding

- **Where:** `src/modules/my-info/components/my-info-form.tsx:74`. On `/get-started/profile`,
  a new member sees "Date of Birth — Not set. *Set during onboarding*; contact the IT team to
  correct it." The field is read-only.
- **Why it confuses:** "Onboarding" here means the recruitment contract (`/onboard/[token]`),
  but the member is reading it on a page titled Getting Started.
- **Fix:** Suggested copy: "Taken from your signed volunteer contract. Contact the IT team to
  correct it."

### L6. The SCORM player iframe uses both `allow-scripts` and `allow-same-origin`

- **Where:** `/get-started/learning/[courseId]` and `/learning/[courseId]`. Chromium warns: *An
  iframe which has both allow-scripts and allow-same-origin for its sandbox attribute can escape
  its sandboxing.*
- **Context:** SCORM content needs same-origin access to the runtime API. So this is likely
  deliberate, and it is safe only as long as packages are admin-uploaded. Worth one sentence in
  the player's code comment stating that assumption.

## Checked and fine

- **Schedule builder** (`/schedule/builder`). It loads in about 5.5s in dev with no mobile
  overflow. The crawler's timeout there came from its live update stream (`/api/schedule/builder/stream`),
  which is open by design, so the page never goes network-idle.
- **Access-denied pages.** Every permission-gated route shows a consistent "You don't have access
  to that page" screen with a way back. No gated route 500s or shows a blank page.
- **Header navigation.** Every link each persona is offered (director 17, volunteer 9, admin 49)
  resolves to a page they can open.
- **Onboarding gate for a new member.** It redirects cleanly from every route to a clear
  five-step checklist. Each step has one primary action.
- **Public screens.** The failed-sign-in message and the 404 page are plain-language and on-brand.
- **Dark mode.** The dashboard, My info, Schedule, Submit a request and Learning pages showed no
  unreadable text in dark mode.
- **Command palette.** It opens with Ctrl+K and filters as you type.
- **Mobile menu.** It opens and lists the persona's sections.

## Carry-overs still visible in the browser

These were raised in `full-app-ui-cohesion-audit-2026-09-05.md` and are still visible at runtime:

- **The same state in different words.** On `/my-info` the clearance list shows "Complete",
  "Valid" and "Action needed" side by side, while the dashboard rail says "Not yet cleared".
  That is T1 in the earlier audit.
- **Stacked tab rows in recruitment.** On a cycle's Applicants page a director sees three tab
  rows: Cycles / Attendance events, then Review / Accepted, then Applicants / Dual appointments.
  At 375px that is about 150px of tabs before the page title.
- **Truncated dashboard tiles.** At 375px the tiles are ellipsised ("My sche…",
  "Request…") because the two-column grid holds even when the labels don't fit.

## Reproducing

The crawler, the targeted checks and all 1,100+ screenshots live outside the repo. To rerun:

1. Start Postgres on 5434 and create `havenhub_uxaudit`.
2. Put its URL in `.env.local` as `DATABASE_URL`.
3. Run `npm run db:deploy`, `npm run db:seed` and `npm run fixtures:ux`, with
   `DEV_DATABASE_URL` pointing at the same database.
4. Run `DEV_DATABASE_URL=… npm run dev`.
5. Walk the personas with Playwright, using the checks listed under Method.
