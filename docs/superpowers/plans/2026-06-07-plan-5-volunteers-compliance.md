# Plan 5: Volunteers Module Part 1, HIPAA Compliance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deterministic HIPAA compliance tracking replacing the Airtable AI flow: completion dates parsed from certificate PDFs, validity computed against the clinic's term-coverage rule, department directors verifying their own people, EXEC/SRR/ITCM holding the master view, and the computed status mirrored to Airtable so existing reminder automations keep working.

**Architecture:** Compliance logic lives in `src/platform/compliance/` (rules, parser, access) because both my-info (upload) and volunteers (dashboards) consume it. The Volunteers module goes live with its compliance surfaces; offboarding/Epic/disciplinary follow in part 2 (next plan). The mirror gains an eighth owned field (the status select) and a nightly recompute job, since statuses change with the passage of time, not only on events.

**Decisions from Jack (binding):**
- Parse the completion date from the PDF automatically from day one; manual entry is the FALLBACK when parsing fails (18 of 639 existing certs are images).
- Validity: a certificate is good for 365 days from completion. Compliance bar for a term: the certificate must remain valid through TERM END + 30 DAYS. Renewal warning when expiry is within 60 days of today.
- Department directors verify compliance for their own department(s). EXEC + SRR + ITCM hold the master view across the clinic and run tracking/reminders.
- Airtable "HIPAA Compliance Status" has exactly two options ("Compliant" select id selDbbVNujBiEDA7o, "Not Compliant" selKwfayjo91nZsuB): our richer status collapses to Compliant only when COMPLIANT; everything else mirrors "Not Compliant".

**Status enum (computed, never stored):**
```
COMPLIANT       expiresAt >= termEnd + 30d (or, with no active term, expiresAt >= now + 60d)
EXPIRING_SOON   valid today but fails the bar above, OR expiresAt within 60d of now
EXPIRED         expiresAt < now
UNKNOWN_DATE    certificate on file but no completionDate
NO_CERTIFICATE  nothing on file
```

**Conventions (binding):** no em-dashes; "HAVEN Hub" prose; UTC dates; audits on mutations; services trust callers; whitelists at service level.

---

### Task 0: Branch + plan commit
- [ ] On `plan-5/volunteers-compliance`: commit this doc.

### Task 1: Schema + compliance rules (TDD)
- Schema: `HipaaCertificate` += `completionDate DateTime?`, `extraction CertificateExtraction @default(NONE)` with `enum CertificateExtraction { PARSED MANUAL AIRTABLE NONE }`, `verifiedById String?`, `verifiedAt DateTime?`. Migration `certificate-compliance` (inspect SQL for DROPs; stop if any). resetDb untouched (same table).
- `src/platform/compliance/rules.ts` (pure, TDD ~10 tests): constants `CERT_VALIDITY_DAYS=365`, `TERM_END_BUFFER_DAYS=30`, `RENEWAL_WARNING_DAYS=60`; `certExpiresAt(completionDate)`; `complianceStatus(cert: { completionDate: Date | null } | null, termEnd: Date | null, now: Date): ComplianceStatus` implementing the enum exactly (every boundary tested: day-of expiry, exactly termEnd+30, no term fallback, null cert, null date).
- Commit: `feat(compliance): certificate metadata schema + deterministic rules`

### Task 2: PDF date parser + corpus calibration
- Dependency: `pdf-parse` (or equivalent pure-JS text extractor; implementer verifies it runs in the Next/route context, no native deps).
- `src/platform/compliance/parser.ts`: `extractCompletionDate(bytes: Buffer): Promise<{ date: Date; matchedText: string } | null>`. Strategy: extract text; scan with ordered patterns: labeled dates first (`completion date`, `date of completion`, `completed on`, `expiration` EXCLUDED), accepting formats MM/DD/YYYY, M/D/YYYY, DD-MMM-YYYY, "Month D, YYYY"; reject future dates and dates older than 5 years; return the labeled match nearest to a "completion" keyword. TDD with synthetic text fixtures for each format + a no-date case + an expiration-only case (must return null, never the expiration date).
- **Calibration (throwaway script, do not commit results as code):** run the extractor across ALL PDFs in `uploads/` joined to their rows; report: parsed count, unparsed count, sample of matchedText lines, and 10 random (fileName, extracted date) pairs for eyeball checking. Target: >=90 percent of the 621 PDFs parse. Iterate patterns against real failures until the target is met or the remainder are genuinely dateless scans. REPORT the final hit rate and pattern adjustments in the task report; the controller reviews samples before Task 4 backfills.
- Commit: `feat(compliance): pdf completion-date parser`

### Task 3: Upload integration + cross-person access
- my-info upload flow: `saveCertificate` gains parsing: after validation, run `extractCompletionDate`; on success store completionDate + extraction PARSED; on null leave NONE. The page after upload: when the new cert has no completionDate, render a follow-up inline form on the HIPAA panel ("We could not read a completion date from your certificate. Enter the date printed on it.") posting to `setCertificateCompletionDate(personId, certId, dateIso)` (owner-only, validates not-future/not-ancient, extraction MANUAL, audit). My Info HIPAA panel shows the computed status line (Badge per status, e.g. "Compliant through <expiry>", "Expires <date>, renew soon", "Expired", "Completion date needed").
- `src/platform/compliance/access.ts`: `canViewCertificate(viewerPersonId, ownerPersonId): Promise<boolean>`: self; or `can(viewer, "volunteers.manage_compliance")`; or (`can(viewer, "volunteers.view")` AND viewer has an ACTIVE DIRECTOR membership in the active term in a department where the owner has an ACTIVE membership). TDD all branches.
- Download route swaps its ownership check to `canViewCertificate`.
- Commit: `feat(compliance): parsed uploads, manual fallback, director file access`

### Task 4: Completion-date backfill (live)
- Script `scripts/backfill-completion-dates.ts` (dry-run default, --apply): for every cert with `completionDate IS NULL`: (1) if PDF, run the parser on the stored file -> PARSED; (2) else/fallback: fetch the person's Airtable record field `fldpQ3GY24wqJQ4Md` ("HIPAA Last Completed Date", aiText; REST returns an object with state/value or a plain string: probe and handle both), parse its text to a date -> AIRTABLE; (3) else leave NONE. Audit per applied row `compliance.backfill_date` with extraction method. Report: counts per method + remaining NONE list (recordIds).
- Run dry, review with controller, apply. Verify Jack's cert has a completionDate and My Info shows a real status.
- Commit: `feat(compliance): completion date backfill`

### Task 5: Volunteers module live + department dashboard
- Registry: volunteers -> active, nav [{Compliance, /volunteers}] (more nav arrives in part 2). Layout `src/app/volunteers/layout.tsx` via requireModuleAccess.
- Service `src/modules/volunteers/services/compliance.ts` (TDD): `departmentCompliance(viewerPersonId)`: departments where the viewer holds an ACTIVE DIRECTOR membership in the active term; for each, every ACTIVE member (both kinds) with newest cert + computed status + verifiedAt/by; `verifyCertificate(actorPersonId, certId)` stamps verifiedById/verifiedAt + audit `compliance.verify` (re-verify allowed, updates stamp); status summary counts.
- Page `/volunteers`: requireModuleAccess; renders the viewer's department cards: member rows (name, kind badge, status Badge with tone success/warning/critical/default, completion date UTC, cert download link via the access-checked route, Verify ConfirmButton when a cert exists). People with manage_compliance but no directorships see a pointer to the master view. e2e: Jack (ITCM director) sees the ITCM card with status badges.
- Commit: `feat(volunteers): department compliance dashboard`

### Task 6: Master view + seeded compliance managers
- Service: `masterCompliance({ status?, departmentId?, q?, page? })` across ALL active people with memberships in the active term (and a toggle to include unrostered actives), paginated, with summary counts per status.
- Page `/volunteers/master`: requirePermission("volunteers.manage_compliance"); filter bar (status select, department select, search), summary stat cards, table (person link to admin person page when the viewer also has admin access; else plain), CSV-free for now.
- Seed: new system role `Compliance Manager` (grants volunteers.view + volunteers.manage_compliance) with GLOBAL department assignments to EXEC, SRR, ITCM (skip silently if a department code is absent). Run db:seed in dev. Registry nav gains {Master view, /volunteers/master}.
- e2e: Jack reaches /volunteers/master (he is Platform Admin anyway) and sees the summary cards.
- Commit: `feat(volunteers): master compliance view + compliance manager role`

### Task 7: Status mirror + nightly recompute
- `ALL_PEOPLE_FIELDS` must stay the 7 text fields (mirror-map tests pin it). Add `ALL_PEOPLE_STATUS_FIELD = { hipaaStatus: "fldaDo5T6mhX9IHhb" }` and extend `personMirrorPayload(person, fieldMap, hipaaStatus?: "Compliant" | "Not Compliant" | null)`: when provided non-null, include the select by NAME (typecast writes it). drainPersonRow computes: newest cert + active term -> complianceStatus -> "Compliant" iff COMPLIANT else "Not Compliant" (and null -> omit ONLY when the platform has no certificate AND no Airtable status should be asserted; decision: always assert, NO_CERTIFICATE maps to "Not Compliant"). Reconcile compares the status field the same way. MirrorTarget gains `statusFieldId: string | null` (config `AIRTABLE_MIRROR_STATUS_FIELD_ID`, optional; unset skips, like the hipaa attachment field).
- Nightly `compliance-refresh` queue in the worker (cron `30 5 * * *`, before reconcile): recompute status for every person with any cert or membership; enqueue a Person outbox row when the MIRRORED status differs from the last asserted one. Track last asserted status: simplest durable approach is a `mirroredHipaaStatus String?` column on Person set by drainPersonRow after a successful send (migration rides Task 7; inspect SQL). TDD the job logic as a service function `refreshComplianceMirror()` returning enqueued count.
- Tests: payload with/without status; drain computes and stamps; refresh enqueues only changes; reconcile drift on the status field corrects it.
- Commit: `feat(compliance): status mirrored to airtable + nightly recompute`

### Task 8: Final verification + PR
- Full gauntlet (kill dev servers): lint, typecheck, npm test, build, e2e (16 + ~3 new).
- Screenshots: /volunteers and /volunteers/master and the my-info HIPAA panel with a real status -> /tmp/havenhub-shots/.
- Push, PR (summary covers the rules, parser hit rate, dashboards, mirror), watch CI green.

## Deferred deliberately
- Offboarding/verification workflow, Epic requests, disciplinary: Volunteers part 2 (next plan)
- In-app reminder emails (Graph): post-cutover; the mirrored status keeps Airtable automations alive meanwhile
- OCR for image certificates: manual-date fallback covers them
