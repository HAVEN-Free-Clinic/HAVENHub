# Toast migration: page inventory (Task 2)

Produced for `docs/superpowers/plans/2026-07-30-toast-notifications.md`, Task 2. No production code
was written or modified for this task; this is a research document only.

Location choice: `docs/superpowers/plans/`, alongside the plan itself, because `.superpowers/` (the
SDD workspace) is gitignored and this document must be committed for Tasks 5 and 6 to read it.

## Methodology

Started from the two commands in the brief:

```bash
grep -rl "searchParams" src/app --include='page.tsx'   # 63 files
grep -rln "<Alert" src/app src/modules                  # 79 files
```

The union is 107 files. Every one of the 107 was read in full (not just grepped) to confirm: does it
actually read a search param, does it actually render `<Alert>` (or a bare `role="alert"` element),
and if a param drives an Alert, is that Alert in the same file or in a child component the page
passes props to. All 63 files from the first command are accounted for below; none were dropped.

Every param below was confirmed at its real read site, not inferred from the design doc's candidate
list. Two confirmed false positives from that candidate list are documented in the findings section.

## Read this first: findings that will bite a later task

These are worth more than the table. In priority order:

### 1. `saved` does not mean one thing. A single generic registry entry will silently corrupt copy on at least six pages.

Task 1 already seeded `saved -> "Saved."` in the registry (`src/platform/ui/toast/flash.ts`). That
text is correct for exactly five call sites: `admin/settings/page.tsx`, `admin/roles/page.tsx`,
`admin/terms/[id]/page.tsx` (the term lifecycle actions), and `admin/people/[id]/page.tsx` /
`my-info/page.tsx` (both of which convert the raw `saved=1` into the literal string `"Saved."`
themselves before handing it to a child form).

It is **wrong** for at least these:

| Page | Actual text rendered today |
|---|---|
| `admin/departments/[id,new]/page.tsx` (via `department-form.tsx`) | "Changes saved." |
| `admin/subcommittees/[id,new]/page.tsx` (via `subcommittee-form.tsx`) | "Changes saved." |
| `recruitment/cycles/[id]/subcommittees/page.tsx` | "Assignment saved." |
| `admin/email/campaigns/[id]/page.tsx` | "Campaign saved." |
| `schedule/page.tsx` | "Availability saved successfully." |
| `admin/terms/[id]/page.tsx` (`stepsSaved`, via `OnboardingStepsEditor`) | "Onboarding steps saved." (rendered as a plain `<p>`, not even an `<Alert>`) |

Two more pages use `saved` as a lookup key into a per-page whitelist of *different* success
sentences, not a flat flag at all:

- `recruitment/cycles/[id]/applicants/[applicationId]/page.tsx`: `saved=decision` -> "Decision
  recorded.", `saved=reopened` -> "Decision reopened.", `saved=rescind` -> "Acceptance rescinded."
- `recruitment/interviews/[interviewId]/page.tsx`: `saved=decision` -> "Decision recorded.",
  `schedule` -> "Schedule saved.", `panelist` -> "Panel updated.", `invite` -> "Invite sent.",
  `evaluation` -> "Evaluation saved.", `rescind` -> "Acceptance rescinded."

The classifier's registry binds one handler to the param name `saved` regardless of which page the
URL belongs to (it has no path awareness). As built today, at most one of these roughly nine live
text variants can be correct; every other page that keeps relying on the shared `saved` entry will
have its wording silently overwritten the moment Task 6 wires that entry into the automatic reader.
Every page in the table above, plus the two whitelist pages, needs to keep composing its own text and
call `useToast()` directly rather than depend on the generic registry entry, exactly per the design
spec's own carve-out ("Where a message genuinely depends on page-local data the page should keep
composing it"). This is not page-local *data*, it is page-local *copy*, but the same escape hatch
applies. `admin/terms/new/page.tsx` also references a `saved` prop on `term-form.tsx` that no live
redirect ever populates (dead code; not a live param on any reachable URL, excluded from the counts
below).

### 2. `message` is not always `error`'s companion. `schedule/page.tsx` uses it as an independent coded flash, and the shipped classifier will not toast it.

`src/platform/ui/toast/flash.ts` (already committed in `a20a718f`) only ever treats `message` as
`error`'s detail payload, and only strips it alongside `error`. `schedule/page.tsx` breaks that
assumption: at line 195, `redirect(sent > 0 ? "/schedule?message=reminded" :
"/schedule?message=already_reminded")` sets `message` **with no `error` present at all**, and the
page compares it directly: `{sp.message === "reminded" && <Alert tone="success">Reminder sent to your
department directors.</Alert>}` and `{sp.message === "already_reminded" && <Alert
tone="info">Your department directors were already reminded recently, so no new email was sent.</Alert>}`.

Under the classifier as shipped, a bare `message` param (no `error` alongside it) is not claimed by
the convention and is not in the registry, so it is left completely alone: not popped as a toast, not
stripped from the URL. This means today, if this page's inline Alert is deleted per Task 5/6's
mechanical rule ("delete the render for any param the convention or registry claims"), **the
reminder confirmation disappears with no replacement**, because the classifier never claims a bare
`message`. This page needs two new registry entries (`message=reminded` and `message=already_reminded`
as literal-value matches) before its Alerts can be safely deleted, and those entries must not
interfere with `message`'s existing role as `error`'s companion on the same page.

### 3. Two pages use `err`/`msg`, not `error`/`message`. Neither is claimed by the existing convention or registry.

`recruitment/cycles/[id]/onboarding/page.tsx` and `recruitment/cycles/[id]/training/page.tsx` both
destructure `const { msg, err } = await searchParams;` and render `{err && <Alert
tone="error">{err}</Alert>}` / `{msg && <Alert tone="success">{msg}</Alert>}`. Neither `err` nor `msg`
matches the `error`/`/Error$/` convention (different literal names), and neither is in the registry.
As things stand, converting these two pages requires two *new*, independent, single-param registry
entries, not an extension of the existing `error` convention. They must be modeled as two
**independent** entries, not one joint group like `sent`+`skipped`, because `onboarding/page.tsx`'s
own action can set both in the same redirect (`msg: "Sent N onboarding link(s)."`, `err: "M could not
be sent."`) and expects **two separate simultaneous toasts**, not one composed sentence. A joint-group
registry entry (which fires one toast for the whole group) would wrongly collapse this into a single
message.

### 4. `sent` means three different things on three different pages, and two of the three are already safely disambiguated by the registry's AND-semantics. The third needs a new entry, added carefully.

- `recruitment/cycles/[id]/decisions/page.tsx`: `sent` = count of acceptance emails released in a
  bulk action, always paired with `skipped`. Already in the registry (Task 1).
- `recruitment/cycles/[id]/waitlist/page.tsx`: `sent` = a single-applicant email-outcome flag/reason
  string (`"1"`, `"conflicted"`, `"already_emailed"`, `"not_found"`), always paired with `promoted`
  (an applicant name). Needs a new two-param registry entry (`promoted`+`sent`).
- `admin/email/campaigns/[id]/page.tsx`: `sent` = count of campaign recipients, used **alone**, never
  paired with `skipped` or `promoted`.

Because the registry only fires an entry when every param it owns is present, the existing `sent`+
`skipped` entry cannot accidentally fire on the campaigns page (no `skipped` there) or the waitlist
page (no `skipped` there either). But if anyone adds a *bare* single-param `sent` entry to cover the
campaigns page, it must be defined so it does not also match when `skipped` or `promoted` is present
on the URL (order-of-registration matters in the current array-scan implementation: a lone-`sent`
entry placed before the two-param entries would wrongly hijack the decisions and waitlist pages, since
its own single-param requirement is trivially satisfied whenever more params are present too).

### 5. `admin/terms/[id]/page.tsx`'s `stepsSaved` renders as a plain `<p>`, not an `<Alert>`. A grep for `<Alert` will silently miss it.

`src/modules/onboarding/components/onboarding-steps-editor.tsx:74`: `{saved && <p
className="text-sm text-success-foreground">Onboarding steps saved.</p>}`. This is a genuine,
real, page-level flash (driven by `?stepsSaved=1`) that just happens not to use the `Alert`
component. Ruled TOAST here on its merits, but flagged because any tooling (including a repeat of
this inventory) that keys off `<Alert>` literally will miss it.

### 6. `admin/people/[id]/page.tsx`: an unrelated action's success reuses the same `saved` param as the page's main form, so a roster edit shows "Saved." on the Details card even though nothing in that form changed.

`PersonMembershipsPanel`'s `addAction`/`changeKindAction`/`removeAction` (its own server actions,
embedded in the same component file) all redirect to `?saved=1` on success. The page reads that same
`saved` param and forwards it only to `PersonForm` (the Details card), never to
`PersonMembershipsPanel` itself, which has no success Alert of its own. So editing someone's roster
membership currently pops "Saved." on a form the user never touched. Not a param-name collision with
a filter, but a real cross-feature semantic collision worth a design decision before Task 6: either
give roster mutations their own success param, or accept the existing behavior (the toast will
reproduce it exactly, since nothing here is fixed by the migration itself).

### 7. `lastError` is a confirmed false positive in the design doc's own "suffixed-error family" list.

The design doc's grounding section lists `lastError` alongside `rosterError`, `rbacError`, etc. as
part of the suffixed-error family "in play." It is not. Grepped the whole codebase: `lastError` is
exclusively a `TeamsMessage`/`EmailLog` **database column** (`row.lastError`), rendered as plain table
cell text with a `title` tooltip on `admin/email/page.tsx` and `admin/notifications/page.tsx`. It is
never read from `searchParams`, never set on a redirect. Harmless today only because nothing ever puts
`?lastError=` on a URL, but it should not appear in any shared code/param table as if it were a live
flash param, and the `/Error$/` convention would wrongly claim it if it ever did show up on a URL by
accident.

### 8. Zero literal same-param filter/flash collisions found. Several close, confirmed-safe near-misses.

The brief's highest-risk case ("a param that is also used as a filter on the same page") was checked
on every single file. **No file uses the identical param name for both an Alert message and a
filter/query/enum-validation.** The near-misses, all confirmed clean:

- `admin/email/page.tsx`, `admin/notifications/page.tsx`: `status`/`type`/`template` (filters) sit in
  the same `searchParams` type as `error`/`senderError` (flash). Different keys, no overlap.
- `admin/roles/page.tsx`: `assignq` (a person-search filter) sits beside `rbacError`/`saved` (flash).
  `assignq` only ever drives a `<p>` result-count string, never an `<Alert>`.
- `admin/terms/[id]/page.tsx`: `addq` (roster-search filter) sits beside `error`/`saved`/`rosterError`/
  `copied`/`skipped`/`stepsSaved` (flash). Same pattern as `assignq`.
- `incidents/strikes/page.tsx`: the filter param is `category`; the *error code value* (inside
  `error`, not a param name) is the string `"bad-category"`. Similar-sounding, not a param collision.
- `schedule/builder/page.tsx`: `dept`, `date`, `term`, `view`, `mode`, `gmode` are all filters/mode
  toggles used in the same file as `error`/`message`; none ever appears in the Alert text.
- `volunteers/master/page.tsx`, `support/all/page.tsx`: `status` is enum-validated and DB-query-bound
  on both; neither page's Alert (or lack of one, on `support/all`) ever references it.
- `recruitment/cycles/[id]/applicants/page.tsx`: `decision` is an enum-validated filter; this page
  renders **zero** Alerts at all (`Alert` is not even imported), so there is no possible collision.

## Step 1b: the eight `?error=` slug tables

Per the design spec's 2026-07-30 amendment, these eight pages map `error` to a *code*, not treat the
value as the message. For each: every code, its exact text, and a page-level ruling (a page cannot be
half TOAST half INLINE for one param; the classifier's convention strips or does not strip the whole
`error` param, so a page with even one page-specific code cannot safely split).

### `admin/notifications/page.tsx` and `admin/email/page.tsx`: not actually a code table

Correction to the brief's premise: neither page has a `Record<string,string>` dictionary. Both use the
identical inline ternary (`admin/notifications/page.tsx:94-99`, `admin/email/page.tsx:120-125`):

```
const errorCode = sp.error ?? null;
const errorMessage = errorCode
  ? errorCode === "validation" && sp.message
    ? sp.message
    : "An unexpected error occurred."
  : null;
```

Only one code is recognized (`"validation"`, paired with the free-text `message` param); every other
code falls back to the fixed string `"An unexpected error occurred."`. Both pages' own redirects only
ever set `error=validation`. **Ruling: TOAST (SHARED CODES).** `"validation"` and the generic fallback
belong in the classifier's shared code table.

### `schedule/page.tsx` and `schedule/builder/page.tsx`: also not a dictionary, and a different fallback shape again

Same one-recognized-code shape, but the fallback is different from the two admin pages above: it
echoes the **raw code itself** as display text, not a fixed phrase (`schedule/page.tsx:55-60`,
`schedule/builder/page.tsx:157-162`):

```
const errorMessage = errorCode
  ? errorCode === "validation" && sp.message
    ? sp.message
    : errorCode
  : null;
```

Both pages' own redirects only ever set `error=validation`, so the raw-echo branch is dead in
practice, but present in code. **Ruling: TOAST (SHARED CODES)**, same as above. Flag for whoever
builds the shared table: if it is ever asked to render an unrecognized code for these two specific
pages via a stale/foreign link, today's behavior is "show the raw code word," not the generic
fallback used elsewhere; a single shared fallback string will change that page's specific (if
unreachable-in-practice) behavior. Low priority since no live redirect ever exercises it.

### `incidents/[id]/page.tsx`: real `ERROR_MESSAGES` dictionary, all shared vocabulary

```
const ERROR_MESSAGES: Record<string, string> = {
  forbidden: "You do not have permission for that action.",
  "not-found": "The incident report could not be found.",
  validation: "Please check your input and try again.",
};
```
Fallback: `"An unexpected error occurred."`

All three codes (`forbidden`, `not-found`, `validation`) are in the design doc's own named generic
family. **Ruling: TOAST (SHARED CODES).**

### `incidents/page.tsx`: mixed vocabulary

```
const ERROR_MESSAGES: Record<string, string> = {
  forbidden: "You do not have permission for that action.",
  "subject-not-found": "The selected person could not be found.",
  validation: "Please check your input and try again.",
};
```
Fallback: `"An unexpected error occurred."`

`forbidden` and `validation` are shared; `subject-not-found` is page-owned vocabulary (the design
doc's own amendment lists it in the page-specific bucket, alongside `person-not-found`). Since one
param can't be half-stripped, **ruling: INLINE**, for the whole `error`/`message` pair on this page.
(Confirmed the grep false positive named in the brief while here: `count` on this page, lines 83-97,
is only inside a code comment about notification-recipient counts; it is not a `searchParams` key at
all. **Ruling: not a param, excluded from the table entirely.**)

### `incidents/strikes/page.tsx`: mostly page-owned vocabulary, and a genuine text conflict with `incidents/[id]/page.tsx`

```
const ERROR_MESSAGES: Record<string, string> = {
  forbidden: "You do not have permission for that action.",
  "not-found": "The disciplinary action could not be found.",
  "bad-category": "Invalid category. Please select a valid category.",
  "blank-description": "Description must not be blank.",
  "future-date": "Occurred date must not be in the future.",
  "person-not-found": "Person not found. Search and select a person from the list, then try again.",
  validation: "Please check your input and try again.",
};
```
Fallback: `"An unexpected error occurred."`

Four of seven codes are page-owned (`bad-category`, `blank-description`, `future-date`,
`person-not-found`). **Ruling: INLINE**, for the whole `error`/`message` pair.

**Confirmed conflict, exactly the shape the brief asked to find:** the code `not-found` means two
different things on two different pages that both claim it as "shared":

| Page | `not-found` text |
|---|---|
| `incidents/[id]/page.tsx` | "The incident report could not be found." |
| `incidents/strikes/page.tsx` | "The disciplinary action could not be found." |

`forbidden` and `validation`, by contrast, are byte-identical across all three incidents pages. Only
`not-found` conflicts. Since `incidents/strikes/page.tsx` is ruled INLINE as a whole page anyway (it
has other page-owned codes forcing that ruling), this conflict is currently moot for the shared table
(only `incidents/[id]/page.tsx` would contribute `not-found` to it), but it needs to stay moot on
purpose: if `incidents/strikes/page.tsx` is ever revisited and partially carved out, its `not-found`
text must not be merged with `incidents/[id]/page.tsx`'s.

A second, smaller inconsistency: the three incidents pages fall back to
`ERROR_MESSAGES["validation"]` = "Please check your input and try again." when `error=validation` has
no companion `message`, while `admin/notifications/page.tsx`/`admin/email/page.tsx` fall back to the
generic "An unexpected error occurred." for that exact same case. Low-stakes (message-less validation
errors are presumably rare) but worth a single ruling when the shared table is built.

### `login/page.tsx`: own vocabulary, as the spec already says

```
const ERROR_MESSAGES: Record<string, string> = {
  CredentialsSignin:
    "We couldn't sign you in. That email isn't in our records or the account isn't active.",
  MemberLinkExpired:
    "That sign-in link has expired or was already used. Request a new one below.",
};
const DEFAULT_ERROR = "Sign-in failed. Please try again, or contact the IT team.";
```

Both codes are NextAuth's own vocabulary (`CredentialsSignin` is NextAuth's built-in failure type;
`MemberLinkExpired` is manually substituted by `login/verify/page.tsx:49` when it catches a
`CredentialsSignin` from the magic-link confirm flow specifically). **Ruling: INLINE**, matching the
spec's own explicit call. This page also does not use the shared `Alert` component at all: it
hand-rolls `<p role="alert">` (lines 98-105), which is worth knowing if a later task greps for
`<Alert` expecting to find every flash site.

## Full inventory

Grouped by route area. `error`/`*Error` rows are TOAST via the existing convention unless noted;
`saved`/multi-param rows are TOAST via a registry entry (existing or needed, noted per row); NOT A
FLASH rows are never claimed and must not be touched.

### Admin

| File | Param | Ruling | Notes / exact text |
|---|---|---|---|
| `admin/audit/page.tsx` | `action` | NOT A FLASH | free-text DB filter |
| `admin/audit/page.tsx` | `entityType` | NOT A FLASH | DB filter |
| `admin/audit/page.tsx` | `page` | NOT A FLASH | pagination |
| `admin/contract/page.tsx` | `track` | NOT A FLASH | tab selector (DIRECTOR/VOLUNTEER) |
| `admin/departments/[id]/page.tsx` | `error` | TOAST | raw text; rendered by child `department-form.tsx` |
| `admin/departments/[id]/page.tsx` | `saved` | TOAST, needs own registry/`useToast` | "Changes saved." (fixed, not "Saved.") |
| `admin/departments/new/page.tsx` | `error` | TOAST | raw text, via `department-form.tsx` |
| `admin/email/campaigns/[id]/page.tsx` | `error` | TOAST | raw text |
| `admin/email/campaigns/[id]/page.tsx` | `saved` | TOAST, needs own registry/`useToast` | "Campaign saved." |
| `admin/email/campaigns/[id]/page.tsx` | `tested` | TOAST, new registry entry | "Test email sent to your address." |
| `admin/email/campaigns/[id]/page.tsx` | `sent` | TOAST, new registry entry (standalone, see finding 4) | "Campaign sent to {N} recipient(s)." |
| `admin/email/campaigns/[id]/page.tsx` | `preview`+`count`+`excluded` | TOAST, new 3-param registry entry | "Audience preview: {count} recipient(s)[, {excluded} excluded (no email address on file)]." |
| `admin/email/campaigns/[id]/page.tsx` | `scheduled` | TOAST, new registry entry | "Campaign scheduled." |
| `admin/email/campaigns/[id]/page.tsx` | `cancelled` | TOAST, new registry entry, tone=info | "Schedule cancelled." |
| `admin/email/page.tsx` | `status` | NOT A FLASH | enum filter, `VALID_STATUSES` |
| `admin/email/page.tsx` | `template` | NOT A FLASH | free-text filter |
| `admin/email/page.tsx` | `q` | NOT A FLASH | free-text filter |
| `admin/email/page.tsx` | `page` | NOT A FLASH | pagination |
| `admin/email/page.tsx` | `error`+`message` | TOAST | see Step 1b (shared "validation" code) |
| `admin/email/page.tsx` | `retried` | TOAST, new registry entry | "Email re-queued." |
| `admin/email/page.tsx` | `retriedAll` | TOAST, new registry entry | "{N} failed email(s) re-queued." |
| `admin/email/page.tsx` | `connected` | TOAST, new registry entry | "Mailbox connected." |
| `admin/email/page.tsx` | `senderSaved` | TOAST, new registry entry | "Sender address saved." |
| `admin/email/page.tsx` | `senderError` | TOAST | raw text, via `/Error$/` convention |
| `admin/email/page.tsx` | `senderTested` | TOAST, new registry entry | "Test message sent. Check the inbox to confirm." |
| `admin/email/templates/[key]/page.tsx` | `error` | TOAST | raw text, e.g. "A from address and your account email are required to send a test." |
| `admin/notifications/page.tsx` | `status` | NOT A FLASH | enum filter, `VALID_STATUSES` |
| `admin/notifications/page.tsx` | `type` | NOT A FLASH | enum filter, `NOTIFICATION_TYPES` |
| `admin/notifications/page.tsx` | `q` | NOT A FLASH | free-text filter |
| `admin/notifications/page.tsx` | `page` | NOT A FLASH | pagination |
| `admin/notifications/page.tsx` | `error`+`message` | TOAST | see Step 1b (shared "validation" code) |
| `admin/notifications/page.tsx` | `retried` | TOAST, new registry entry | "Teams message re-queued." |
| `admin/people/[id]/page.tsx` | `error` | TOAST | raw text, via `person-form.tsx` |
| `admin/people/[id]/page.tsx` | `saved` | TOAST | page pre-converts to "Saved." before passing to `person-form.tsx`; safe to rely on the existing generic entry. See finding 6 for a cross-feature caveat. |
| `admin/people/[id]/page.tsx` | `rosterError` | TOAST | raw text, via `person-memberships-panel.tsx`, `/Error$/` convention |
| `admin/people/new/page.tsx` | `error` | TOAST | raw text, e.g. "netId already belongs to another person" |
| `admin/people/page.tsx` | `q` | NOT A FLASH | free-text filter |
| `admin/people/page.tsx` | `status` | NOT A FLASH | 3-way filter (ALL/OFFBOARDED/ACTIVE), no Alert on page at all |
| `admin/people/page.tsx` | `page` | NOT A FLASH | pagination |
| `admin/roles/page.tsx` | `rbacError` | TOAST | raw text, `/Error$/` convention |
| `admin/roles/page.tsx` | `saved` | TOAST | fixed "Saved.", matches the existing generic entry |
| `admin/roles/page.tsx` | `assignq` | NOT A FLASH | person-search filter inside `AssignmentForm`, never rendered in an Alert |
| `admin/settings/page.tsx` | `error` | TOAST | raw text, several literals |
| `admin/settings/page.tsx` | `saved` | TOAST | fixed "Saved.", matches the existing generic entry |
| `admin/subcommittees/[id]/page.tsx` | `error` | TOAST | raw text, via `subcommittee-form.tsx` |
| `admin/subcommittees/[id]/page.tsx` | `saved` | TOAST, needs own registry/`useToast` | "Changes saved." (fixed, not "Saved.") |
| `admin/subcommittees/new/page.tsx` | `error` | TOAST | raw text, via `subcommittee-form.tsx` |
| `admin/terms/[id]/page.tsx` | `error` | TOAST | raw text (lifecycle actions) |
| `admin/terms/[id]/page.tsx` | `saved` | TOAST | fixed "Saved.", matches the existing generic entry |
| `admin/terms/[id]/page.tsx` | `addq` | NOT A FLASH | roster-search filter inside `roster-panel.tsx`, never rendered in an Alert |
| `admin/terms/[id]/page.tsx` | `copied`+`skipped` | TOAST, new 2-param registry entry | "Copied {N} membership(s); {M} already existed and were skipped." (via `roster-panel.tsx`) |
| `admin/terms/[id]/page.tsx` | `rosterError` | TOAST | raw text, via `roster-panel.tsx`, `/Error$/` convention |
| `admin/terms/[id]/page.tsx` | `stepsSaved` | TOAST, new registry entry; NOT an `<Alert>` today (see finding 5) | "Onboarding steps saved." |
| `admin/terms/new/page.tsx` | `error` | TOAST | raw text, via `term-form.tsx` |
| `admin/page.tsx` (dashboard) | none | out of scope | no `searchParams` read at all; its Alert is DB-state driven (`staleCrons`) |

### My-info and clinic

| File | Param | Ruling | Notes / exact text |
|---|---|---|---|
| `my-info/page.tsx` | `error` | TOAST | raw text, via `my-info-form.tsx`, e.g. "{field} already belongs to another person" |
| `my-info/page.tsx` | `saved` | TOAST | page pre-converts to "Saved."; matches the generic entry |
| `my-info/page.tsx` | `certError` | TOAST | raw text, via `hipaa-panel.tsx`. Param is **renamed** on the way in (`certError` on the URL becomes the `error` prop on `HipaaPanel`); `/Error$/` convention still claims the URL param correctly since the rename happens after the classifier runs client-side against the raw URL. |
| `my-info/page.tsx` | `certSaved` | TOAST, new registry entry | "Certificate uploaded successfully." (fixed) |
| `my-info/page.tsx` | `withdrawn` | TOAST, new registry entry, page-composed count+pluralization | "Withdrawn from {N} volunteer assignment(s) this term." Only renders when `withdrawn > 0`; `withdrawn=0` must stay silent. Candidate for `useToast()` rather than the registry, since the zero-suppression logic is not something the registry's `message()` function alone can express without also owning the render-or-not decision (today that decision lives in the JSX condition, not the message builder). |
| `clinic/avs/avs-tool.tsx` | none | out of scope | zero `searchParams`; local client validation-message array, not a URL flash at all |

`get-started/hipaa/page.tsx` and `get-started/profile/page.tsx` reuse the same `hipaa-panel.tsx` /
`my-info-form.tsx` components with their own `certError`/`certSaved`/`error` params (see the
apply/login/get-started section below); the same registry entries serve both routes.

### Incidents

| File | Param | Ruling | Notes / exact text |
|---|---|---|---|
| `incidents/[id]/page.tsx` | `error`+`message` | TOAST | see Step 1b |
| `incidents/mine/page.tsx` | `submitted` | TOAST, new registry entry | "Report #{N} submitted." |
| `incidents/page.tsx` | `error`+`message` | INLINE | see Step 1b (mixed vocabulary) |
| `incidents/review/page.tsx` | `status`, `concernType`, `immediateRisk`, `strikePending`, `q`, `page` | NOT A FLASH (all six) | filters feeding `listReviewQueue`; zero `Alert` in file |
| `incidents/strikes/page.tsx` | `q`, `departmentId`, `category`, `page` | NOT A FLASH (all four) | filters feeding `listActions` |
| `incidents/strikes/page.tsx` | `error`+`message` | INLINE | see Step 1b (mostly own vocabulary) |

### Learning and training

| File | Param | Ruling | Notes / exact text |
|---|---|---|---|
| `learning/dashboard/page.tsx` | `course`, `page` | NOT A FLASH | filters; zero `Alert` in file |
| `learning/manage/[courseId]/page.tsx` | `error` | TOAST | raw `LearningValidationError.message`, not slug-mapped |
| `learning/manage/page.tsx` | `error` | TOAST | raw `LearningValidationError.message` |

`learning/[courseId]/ScormPlayer.tsx`, `learning/manage/[courseId]/UploadPackageForm.tsx`,
`training/page.tsx`, `training/training-quiz.tsx`, `get-started/learning/[courseId]/page.tsx`: no
`searchParams`-driven Alert anywhere in this group. All Alerts are local client state (save failures,
quiz grading results) or server-computed business state (permission checks). `training/page.tsx`
itself reads no props at all. Confirmed out of scope.

### Recruitment

| File | Param | Ruling | Notes / exact text |
|---|---|---|---|
| `recruitment/cycles/[id]/applicants/[applicationId]/page.tsx` | `error` | TOAST | raw text; renders at 4 mutually-exclusive JSX sites, one logical toast |
| `recruitment/cycles/[id]/applicants/[applicationId]/page.tsx` | `routeError` | TOAST | raw text, `/Error$/` convention |
| `recruitment/cycles/[id]/applicants/[applicationId]/page.tsx` | `scoreError` | TOAST | raw text, `/Error$/` convention |
| `recruitment/cycles/[id]/applicants/[applicationId]/page.tsx` | `saved` | TOAST, new registry entry, 3-way lookup (see finding 1) | "Decision recorded." / "Decision reopened." / "Acceptance rescinded." |
| `recruitment/cycles/[id]/applicants/page.tsx` | `page`, `decision`, `sort`, `dir` | NOT A FLASH (all four) | `decision` is enum-validated against `DECISION_STATUSES`; zero `Alert` on this page (not even imported) |
| `recruitment/cycles/[id]/decisions/page.tsx` | `error` | TOAST | raw text |
| `recruitment/cycles/[id]/decisions/page.tsx` | `sent`+`skipped` | TOAST, existing registry entry (Task 1) | "Released {sent} acceptance email(s); skipped {skipped} conflicted applicant(s)." |
| `recruitment/cycles/[id]/emails/[key]/page.tsx` | `error` | TOAST | raw joined validation-problems text |
| `recruitment/cycles/[id]/onboarding/page.tsx` | `err` | TOAST, new registry entry (see finding 3) | raw dynamic text |
| `recruitment/cycles/[id]/onboarding/page.tsx` | `msg` | TOAST, new registry entry (see finding 3) | raw dynamic text, e.g. "Sent {N} onboarding link(s)." |
| `recruitment/cycles/[id]/page.tsx` | `error` | TOAST | raw text |
| `recruitment/cycles/[id]/page.tsx` | `deptsaved` | TOAST, new registry entry | "Departments updated." |
| `recruitment/cycles/[id]/page.tsx` | `deptwarn` | TOAST, new registry entry, page-composed | "Saved. These removed departments still have applicants: {deptwarn}. Existing applications keep their choices, but you can no longer accept into a removed department." |
| `recruitment/cycles/[id]/page.tsx` | `windowsaved` | TOAST, new registry entry | "Application window updated." |
| `recruitment/cycles/[id]/speed-route/page.tsx` | `error` | TOAST | raw text |
| `recruitment/cycles/[id]/subcommittees/page.tsx` | `error` | TOAST | raw text |
| `recruitment/cycles/[id]/subcommittees/page.tsx` | `saved` | TOAST, needs own registry/`useToast` | "Assignment saved." (fixed, not "Saved.", see finding 1; this is the exact page Task 1's report already warned about) |
| `recruitment/cycles/[id]/training/page.tsx` | `err` | TOAST, new registry entry (see finding 3) | raw dynamic text |
| `recruitment/cycles/[id]/training/page.tsx` | `msg` | TOAST, new registry entry (see finding 3) | raw dynamic text |
| `recruitment/cycles/[id]/waitlist/page.tsx` | `error` | TOAST | raw text |
| `recruitment/cycles/[id]/waitlist/page.tsx` | `promoted`+`sent` | TOAST, new 2-param registry entry (see finding 4) | "Promoted {promoted} to accepted, but they now hold offers from more than one department..." (conflicted) or "Promoted {promoted} to accepted[ and emailed them]." |
| `recruitment/cycles/new/page.tsx` | `error` | TOAST | raw text |
| `recruitment/interviews/[interviewId]/page.tsx` | `error` | TOAST | raw text |
| `recruitment/interviews/[interviewId]/page.tsx` | `saved` | TOAST, new registry entry, 6-way lookup (see finding 1) | "Decision recorded." / "Schedule saved." / "Panel updated." / "Invite sent." / "Evaluation saved." / "Acceptance rescinded." |

`recruitment/cycles/[id]/builder/*.tsx` (5 files: `contract-editor.tsx`, `field-card.tsx`,
`form-builder.tsx`, `quiz/quiz-builder.tsx`, `section-card.tsx`), plus their parent `page.tsx` files
under `builder/`, `builder/contract/`, `builder/quiz/`: none read `searchParams` at all (confirmed by
direct grep, not just the earlier batch read). Their "This cycle is {status}..." Alerts use a `status`
**prop** sourced from `cycle.status` (a DB field), not a URL param of the same name; their `error`
Alerts are local client `useState`. Confirmed out of scope.
`rescind-acceptance-notice.tsx`, `speed-route-board.tsx`, `speed-route-modal.tsx`,
`speed-score-modal.tsx`: all prop/local-state driven, zero `searchParams`. Confirmed out of scope.

### Schedule

| File | Param | Ruling | Notes / exact text |
|---|---|---|---|
| `schedule/attendings/[id]/page.tsx` | `error` | TOAST | raw text, via `attending-form.tsx` |
| `schedule/attendings/new/page.tsx` | `error` | TOAST | raw text, via `attending-form.tsx` |
| `schedule/builder/page.tsx` | `dept`, `date`, `term` | NOT A FLASH | filters feeding `builderView` |
| `schedule/builder/page.tsx` | `view`, `mode`, `gmode` | NOT A FLASH | UI-mode toggles, round-tripped via hidden inputs/hrefs |
| `schedule/builder/page.tsx` | `error`+`message` | TOAST | see Step 1b (shared "validation" code) |
| `schedule/full/page.tsx` | `date` | NOT A FLASH | filter; zero `Alert` in file |
| `schedule/page.tsx` | `error`+`message` (validation companion) | TOAST | see Step 1b |
| `schedule/page.tsx` | `saved` | TOAST | "Availability saved successfully." (fixed, not "Saved.", see finding 1) |
| `schedule/page.tsx` | `requested` | TOAST, new registry entry | "Change request submitted. Your director will review it." |
| `schedule/page.tsx` | `message` (as `"reminded"`/`"already_reminded"`, standalone) | TOAST, two NEW registry entries required (see finding 2, currently unclaimed by the shipped classifier) | "Reminder sent to your department directors." (success) / "Your department directors were already reminded recently, so no new email was sent." (info) |
| `schedule/requests/page.tsx` | `error`+`message` | TOAST | same "validation"-only pattern, one-line ternary |

### Support

| File | Param | Ruling | Notes / exact text |
|---|---|---|---|
| `support/[id]/page.tsx` | `submitted` | TOAST, new registry entry | "Request submitted. We will keep you posted here." |
| `support/[id]/page.tsx` | `commentError` | TOAST | raw text, via `comment-thread.tsx`, `/Error$/` convention |
| `support/[id]/page.tsx` | `attachmentError` | TOAST | raw text, `/Error$/` convention |
| `support/[id]/page.tsx` | `manageError` | TOAST | raw text, via `ticket-detail.tsx` (2 mutually-exclusive JSX sites, 1 logical toast), `/Error$/` convention |
| `support/[id]/page.tsx` | `epicError` | TOAST | raw text, via `ticket-detail.tsx`, `/Error$/` convention |
| `support/all/page.tsx` | `status`, `category`, `priority`, `assignee`, `q`, `page` | NOT A FLASH (all six) | `status`/`category`/`priority` enum-validated via a local `pick()` helper; zero `Alert` on page at all, cleanest "pure filter page" found |
| `support/epic/page.tsx` | `tab`, `term` | NOT A FLASH | mode/routing + filter, also gates a real term-batch DB query |
| `support/epic/page.tsx` | `error` | TOAST | raw text, via `epic-request-tabs.tsx`, renders at 2 JSX sites depending on `tab` (1 logical toast) |
| `support/epic/page.tsx` | `incidentError` | TOAST | raw text, via `epic-request-tabs.tsx`'s `LogIncidentForm`, deliberately kept separate from `error` per ticket #115 |
| `support/new/page.tsx` | `error` | TOAST | raw text, via `submit-form.tsx` |

`comment-thread.tsx`, `submit-form.tsx`, `epic-request-tabs.tsx`, `ticket-detail.tsx`: all render the
props above (no `searchParams` of their own). `epic-request-form.tsx`, `term-batch-tab.tsx`: all
local client state, zero flash wiring. Confirmed out of scope for those two.

### Volunteers and notifications

| File | Param | Ruling | Notes / exact text |
|---|---|---|---|
| `volunteers/ehs/manage/[trainingId]/page.tsx` | `error` | TOAST | raw text |
| `volunteers/ehs/manage/page.tsx` | `error` | TOAST | raw text |
| `volunteers/ehs/page.tsx` | `page` | NOT A FLASH | pagination; zero `Alert` in file |
| `volunteers/master/page.tsx` | `q`, `departmentId`, `page` | NOT A FLASH | filters feeding `masterCompliance` |
| `volunteers/master/page.tsx` | `status` | NOT A FLASH | enum-validated against `ALL_STATUSES`, feeds `masterCompliance` |
| `volunteers/master/page.tsx` | `error` | TOAST | raw text, confirmed never overlapping with any filter |
| `volunteers/offboarding/page.tsx` | `error` | TOAST | raw text |
| `volunteers/page.tsx` | `error` | TOAST | raw text; note: an early-return branch (zero director departments) bypasses this Alert entirely today regardless of `error`'s presence, a pre-existing bug the toast migration would incidentally fix since the root-layout toast fires independent of page body branching |
| `notifications/page.tsx` | `page` | NOT A FLASH | pagination; zero `Alert` in file |

`certificate-viewer.tsx`: client-local state from a direct (non-redirecting) server-action result, not
a URL flash. Confirmed out of scope. `clearance-card.tsx`: no `<Alert>` element at all in the file.

### Apply, login, get-started, onboard

| File | Param | Ruling | Notes / exact text |
|---|---|---|---|
| `apply/[slug]/page.tsx` | `type` | NOT A FLASH | mode selector (NEW/RENEWAL/TRANSFER); zero `Alert` in file |
| `apply/page.tsx` | `error` | TOAST | only `error === "link"` renders anything; any other value renders nothing (a silent no-op fallback, not a generic message). "That link has expired or was already used. Request a new one below." Origin: `apply/verify/page.tsx`'s `confirmAction` redirecting `?error=link`. |
| `apply/page.tsx` | `next` | NOT A FLASH | redirect target, sanitized via `safeNextPath`, never rendered |
| `apply/verify/page.tsx` | `token` | NOT A FLASH | auth token, never rendered as text |
| `apply/verify/page.tsx` | `next` | NOT A FLASH | redirect target |
| `get-started/hipaa/page.tsx` | `certError` | TOAST | raw text, forwarded to `hipaa-panel.tsx`; page itself renders no `<Alert>` |
| `get-started/hipaa/page.tsx` | `certSaved` | TOAST | forwarded to `hipaa-panel.tsx` |
| `get-started/profile/page.tsx` | `error` | TOAST | raw text, forwarded to `my-info-form.tsx` |
| `get-started/training/page.tsx` | `track` | NOT A FLASH | mode selector; the 3 Alerts on this page are DB/business-state driven (cycle existence, lock, makeup window), not param-value driven at all |
| `login/page.tsx` | `error` | INLINE | see Step 1b |
| `login/page.tsx` | `callbackUrl` | NOT A FLASH | redirect target, never rendered |
| `login/verify/page.tsx` | `token`, `next` | NOT A FLASH | auth token / redirect target; page uses plain unmarked `<h1>`/`<p>`, no `Alert` component at all |

`apply/[slug]/apply-wizard.tsx`, `apply/[slug]/wizard-review.tsx`, `apply/sign-in-form.tsx`,
`login/member-sign-in-form.tsx`, `onboard/[token]/next-steps-screen.tsx`,
`onboard/[token]/onboard-form.tsx`: all client-local state from direct (non-redirecting) server-action
call results, or static unconditional copy. None read `searchParams`. Confirmed out of scope.

`apply/sign-in-form.tsx` has a local `useState<boolean>` variable literally named `error`
(unrelated to any URL param); flagging so a text-only search for the word "error" in that file is not
mistaken for a flash site.

## Counts

Every `page.tsx` file the original `grep -rl "searchParams" src/app --include='page.tsx'` command
found (63 files, confirmed zero missing and zero extra against this inventory) was ruled on a
per-param basis:

| Ruling | Count (file, param) pairs |
|---|---|
| TOAST | 105 |
| INLINE | 5 |
| NOT A FLASH | 62 |
| **Total** | **172** |

- **49 distinct pages** carry at least one TOAST or INLINE param (a genuine flash/inline site).
- **14 distinct pages** carry only NOT A FLASH params (pure filter/pagination/mode pages with zero
  flash surface at all: `admin/audit`, `admin/contract`, `admin/people`, `incidents/review`,
  `learning/dashboard`, `recruitment/cycles/[id]/applicants`, `schedule/full`, `support/all`,
  `volunteers/ehs`, `notifications`, `apply/[slug]`, `get-started/training`, plus the two `*/verify`
  pages).
- **3 pages ruled INLINE**: `incidents/page.tsx`, `incidents/strikes/page.tsx`, `login/page.tsx`, all
  because at least one of their `?error=` codes is page-owned vocabulary that cannot be safely split
  from the param's shared codes (`incidents/[id]/page.tsx` is the sibling counter-example: same shape
  of page, but every one of its codes is shared, so it is ruled TOAST).

This inventory confirms 49 pages with a real flash param, against the design doc's estimate of 57.
The gap is the over-match the doc itself warned about: pages the original grep flagged (via
`searchParams` + a same-file `<Alert`) that turned out, on full read, to have either an Alert that is
not param-driven at all (DB/business state, or local client state in a component the page merely
renders) or no `Alert` in the render path the page actually uses. Every one of those is documented
above as "confirmed out of scope" rather than silently dropped.

Component files (under `src/modules/**`) that render `<Alert>` but never read `searchParams`
themselves are not counted in the 172 rows above; they are listed per section as "confirmed out of
scope" since they have no param of their own to rule on. Their parent page's params (where relevant)
are the rows that count.

## Params confirmed to never touch the toast system (filters, modes, tokens)

Every name in the plan's own "never consume" list was independently reconfirmed here, per page, at
its actual read site: `status` (5+ pages, enum-validated on `admin/notifications`, `admin/email`,
`volunteers/master`, `incidents/review`; 3-way on `admin/people`), `page`, `q`, `tab`, `token`,
`type`, `term`, `track`, `next`, `callbackUrl`, `view`, `mode`, `date`, `dept`, `assignee`,
`priority`, `category`, `departmentId`, plus this inventory's own additions: `action`, `entityType`,
`concernType`, `immediateRisk`, `strikePending`, `template`, `assignq`, `addq`, `course`, `decision`,
`sort`, `dir`, `gmode`. None of these render inside an `<Alert>` anywhere in the 107 files read.

## Files read in full but confirmed to have no `searchParams`-driven Alert at all

Listed here once rather than repeated per section: `admin/page.tsx`, `admin/email/campaigns/[id]/
review-actions.tsx`, `admin/email/campaigns/[id]/timing-actions.tsx`, `(app)/error.tsx`,
`recruitment/cycles/[id]/applicants/[applicationId]/error.tsx` (both `error.tsx` files are Next.js
error boundaries: `error`/`reset` are React error-boundary props, not search params),
`learning/[courseId]/ScormPlayer.tsx`, `learning/manage/[courseId]/UploadPackageForm.tsx`,
`training/page.tsx`, `training/training-quiz.tsx`, `get-started/learning/[courseId]/page.tsx`,
`recruitment/cycles/[id]/builder/*.tsx` (5 files) and their 3 parent `page.tsx` files,
`recruitment/modules/components/{rescind-acceptance-notice,speed-route-board,speed-route-modal,
speed-score-modal}.tsx`, `schedule/components/attending-form.tsx` (renders a prop, not its own
param), `support/components/{epic-request-form,term-batch-tab}.tsx`, `certificate-viewer.tsx`,
`clearance-card.tsx`, `avs-tool.tsx`, `apply/[slug]/apply-wizard.tsx`, `apply/[slug]/wizard-review.tsx`,
`apply/sign-in-form.tsx`, `login/member-sign-in-form.tsx`, `onboard/[token]/next-steps-screen.tsx`,
`onboard/[token]/onboard-form.tsx`.

## What this task could not rule on

Nothing was left genuinely unrulable. Two rulings required a judgment call beyond mechanical
classification, both documented above with full reasoning so they can be revisited:

1. `incidents/page.tsx` and `incidents/strikes/page.tsx`: ruled INLINE as whole pages because each has
   at least one page-owned error code alongside shared ones, and the classifier cannot split a single
   `error` param by value. If a future design lets the shared code table register page-specific codes
   too (accepting the collision risk that implies), these two could be reconsidered.
2. `apply/verify/page.tsx` and `login/verify/page.tsx`: their "this link is invalid or expired"
   messaging is functionally the same one-shot notice concept as every other flash on this list, but
   it is implemented via `PortalNotice`/plain markup driven by a database lookup result, not by a
   literal `searchParams` value rendered as text. Ruled NOT A FLASH for the `token`/`next` params
   themselves (neither is ever rendered), but flagging that these two pages sit just outside this
   migration's scope by construction, not because anyone decided they should.

Every param not explicitly ruled TOAST or INLINE above defaults to NOT A FLASH per the brief's own
instruction, and every NOT A FLASH ruling in this document was reached by finding zero Alert reference
to that param, not by failing to find one.
