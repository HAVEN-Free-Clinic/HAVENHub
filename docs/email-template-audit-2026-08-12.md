# Production Email Audit, 2026-08-12

Workstream 9 of the ops request batch. Covers all **44 registered templates** in `listDescriptors()`.

**Headline:** the template layer is structurally sound. Zero undeclared variables, zero syntax errors, zero missing sample values across all 44. Every finding below is about *content*, not machinery.

**How to read this:** the copy decisions are ops calls, not engineering ones. Nothing in the "needs an ops decision" table has been changed. The mechanical checks were run with a script against the live registry, not by eye.

---

## Priority 1: a hardcoded shared password that may already be stale (FIXED, but still needs verifying)

**Templates:** `epic-activation` and `epic-password-reset` (`src/platform/email/templates/epic.ts`)

The password appeared **three times** across two templates, not once as first reported:

> …enter your Epic ID and the temporary password: **SecureCare4u#25**. (`epic-activation`)
>
> ATTENTION: your password has been reset to **"SecureCare4u#25"** due to inactivity… (`epic-password-reset`)
>
> Your temporary password: **SecureCare4u#25** (`epic-password-reset`)

Three problems, in descending order of urgency:

1. **It may be wrong right now.** The `#25` strongly suggests an annual YNHH rotation keyed to 2025. It is currently August 2026. If YNHH rotated it, every Epic activation and reset email sent since then has given people a password that does not work, and the failure mode is silent: the volunteer just cannot log in and contacts the help desk. **Someone still needs to confirm the current value with YNHH IT.** That cannot be verified from the codebase.
2. **Nothing prompted an update.** The value lived in TypeScript default bodies in git, with no reminder, no expiry, and no failing test when it went stale.
3. **It was a credential in source control.** Lower severity than it sounds, since it is a YNHH-issued shared default meant to be transmitted to the user rather than a HAVEN secret. But it should not have been a code constant.

**Fixed 2026-08-12.** All three occurrences now read from a new `epic.temporaryPassword` setting (Settings > Integrations), resolved at send time in `sendEpicEmail`. IT can rotate it without a deploy.

Two deliberate choices:

- **The setting is seeded with the existing value**, so moving it changed no outbound email. The staleness question is unchanged and still needs answering; what changed is that answering it no longer requires an engineer.
- **Blank omits the clause** rather than rendering an empty password. Each of the three sites is wrapped in `{{#if temporaryPassword}}` with the surrounding sentence still reading correctly, so if IT would rather the email not assert a password at all, clearing the setting is a safe way to do that. Covered by a test.

It is registered with `secret: false`, consistent with the registry (which holds no secrets by design; genuine secrets live in env). This value is emailed in plaintext to every recipient by design, and an admin needs to read it to check it against what YNHH currently sets.

---

## Priority 2: stale copy in the weekly shift reminder

**Template:** `shift-reminder`

> Please verify your Epic access by Wednesday before your shift. If you are experiencing issues, submit a Help Desk ticket [**at an Airtable form**] as soon as possible.

The Hub now has its own IT ticketing at `/support` (the IT Support module). The reminder still routes every Epic problem to an Airtable form, which means those tickets never enter the system built to track them.

**Needs an ops/IT decision:** is the Airtable form still the intended intake for Epic issues specifically, or should this point at `/support`? Do not change it without asking; IT may deliberately keep Epic requests separate.

Second item in the same template:

> As we move into the summer, we are piloting a more centralized process for clinic-day reminders and volunteer communication. We appreciate your patience as we refine this process through trial and error.

This paragraph describes the reminder system as a summer pilot. It has been in production long enough that this now reads as odd. Recommend deleting it.

---

## Priority 3: possibly outdated external product references

**Templates:** `epic-activation` and `epic-password-reset`, via the shared `EPIC_DOWNLOAD_AND_NOTES_HTML` constant

> Download **Citrix Receiver** (but don't sign into it) at https://www.citrix.com/products/receiver/

Citrix Receiver was superseded by **Citrix Workspace app**. The old URL redirects. The instruction still broadly works, but a volunteer following it lands on a page naming a different product than the email does, which is exactly the kind of small mismatch that generates help desk tickets during onboarding.

**Recommend:** update the product name and link. Low risk, worth doing while the template is open for the Priority 1 fix.

---

## Priority 4: sample-value domain inconsistency

**Template:** `auth.member_login_link`

Its `loginUrl` sample value uses `hub.havenfreeclinic.**com**`. All ten other templates that carry a hub sample use `hub.havenfreeclinic.**org**`.

**Impact is limited to the admin preview** (the real link is injected at render from `app.baseUrl`), so no email has ever gone out with the wrong domain. But an admin editing templates sees an inconsistent example and may draw the wrong conclusion about which domain is canonical.

**Recommend:** change to `.org` to match the other ten, assuming `.org` is canonical. Worth confirming, since two domains apparently exist.

---

## Checked and clean

| Check | Result |
|---|---|
| Body/subject reference only declared variables | 44/44 pass |
| `{{#if}}` blocks balanced | 44/44 pass |
| Every declared variable has a sample value | 44/44 pass |
| No hardcoded Hub URLs in any template body | Confirmed. All `hub.havenfreeclinic.*` occurrences are sample values only, so a domain change does not strand a live link |
| Sender resolution | `resolveSenderForTemplate` is applied in `queueEmail` for every template and snapshotted at queue time, with per-group and per-template override scopes |
| Anonymous-reporter withholding on `incidents.strike_issued` | Correct and tested. `strike-notifications.ts` substitutes the reviewer's notes for the reporter's narrative on a confidential strike; covered by "never sends the anonymous reporter's narrative to the subject" |

### Two non-findings worth recording

**Nine "declared but unused" variables are not defects.** Seven schedule templates declare `requestsUrl` without using it in the default body, one declares `scheduleUrl` likewise, and `schedule-request-approved` declares an unused `partnerDate`. `requests.ts` supplies both URL variables to every schedule template at render time, so an admin who inserts them gets a working link. They are available-but-unused, which is the intended design of the admin editor, not dead weight.

`partnerDate` on `schedule-request-approved` is the one to watch: that template covers both swaps and drops, and a drop has no partner date. An admin who inserts it would get an empty value on every drop email. Consider dropping the declaration, or guarding it with `{{#if}}` if it is ever used.

**Three empty sample values are intentional.** `epic-onboarding.returningPermissionsSentence`, `epic-onboarding.noRetrainingSentence`, and `shift-reminder.additionalShifts` are optional pre-rendered HTML blocks whose builders emit either markup or an empty string. Empty is the correct sample.

---

## Suggested order of work

1. **Confirm the Epic temporary password with YNHH IT and set it at Settings > Integrations.** Still the only finding that may be actively harming volunteers. The plumbing is done; the value is not verified.
2. **Decide the Epic help desk routing** (Airtable vs `/support`) with IT.
3. Bundle the rest into one copy-edit pass: remove the summer-pilot paragraph, update Citrix Receiver to Citrix Workspace, fix the `.com` sample value, and drop or guard `partnerDate`.

## A note on this audit's own reliability

The first pass of this document reported the password in one template (`epic-onboarding`). It was actually in two others (`epic-activation`, `epic-password-reset`), three occurrences total. The mechanical checks were script-driven and are trustworthy; the content findings came from reading and grepping, and that miss is a fair warning about their completeness. A `grep` for the literal value across the repo is what caught it, and is worth repeating for any other suspected constant.

## Reproducing the mechanical checks

The script that produced the structural results is not committed (it is throwaway analysis). It imports `listDescriptors()` and `validateTemplate()` and reports, per template: undeclared variables, unbalanced `{{#if}}`, missing or empty sample values, declared-but-unused variables, and unguarded variable usage. Re-deriving it is a few minutes' work if this audit is repeated.
