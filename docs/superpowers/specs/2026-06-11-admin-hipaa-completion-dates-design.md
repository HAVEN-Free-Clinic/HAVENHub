# Admin-managed HIPAA completion dates

**Date:** 2026-06-11
**Branch / worktree:** `feat/admin-hipaa-completion-dates` (branched from `origin/main`, which includes the merged CertificateViewer from PR #38)
**Status:** Design approved; pending spec review

## Summary

Move HIPAA certificate completion-date entry from self-service to **compliance-manager-only**. Volunteers can no longer set their own `completionDate`; a holder of `volunteers.manage_compliance` sets it instead, typically while reading the cert PDF in the CertificateViewer. Setting the date also verifies the certificate in the same action.

## Motivation

Letting volunteers type in their own completion date is a compliance-integrity gap: a volunteer can enter any date that makes them look current. Completion dates should be entered by a compliance manager who has looked at the certificate. The recently shipped in-app PDF viewer (`CertificateViewer`, PR #38) makes this practical — the manager can read the date off the PDF and enter it in the same modal.

## Scope

In scope:
- A compliance-manager-only server action to set a cert's completion date.
- Date-entry UI in two surfaces, both gated to compliance managers: the master roster and the CertificateViewer modal.
- Removal of all self-service date entry.

Out of scope (explicitly):
- Creating "date-only" certificate records for people with no uploaded file. Only certs that **already exist but have no `completionDate`** can be edited.
- Overwriting a date that is already set (parsed or otherwise). Entry is offered only when `completionDate === null`.
- Department directors (`volunteers.view`) gaining date entry. They keep view + verify only.
- Any change to the 365-day validity rule or compliance-status logic.

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Which certs | Existing cert with **no** `completionDate` only |
| Who can enter | **Compliance managers only** (`volunteers.manage_compliance`) |
| Where | **Both** the master roster row and the CertificateViewer modal |
| Self-service | **Removed everywhere** — `/my-info` and `/get-started/hipaa` |
| Onboarding gate impact | Accepted: a volunteer whose PDF didn't auto-parse stays "date unknown" / not-cleared until a manager sets the date |
| Set-date = verify | **Yes** — saving the date also stamps `verifiedById` + `verifiedAt` |
| Date validation | Keep current rules: `YYYY-MM-DD`, not future, **not older than 5 years**, normalized to noon UTC |
| Inline roster affordance | Opens the CertificateViewer modal (single date form lives in the modal; no duplicated inline input) |

## Current behavior (baseline)

- `HipaaCertificate` model (`prisma/schema.prisma`): `completionDate DateTime?`, `extraction` (`PARSED | MANUAL | AIRTABLE | NONE`), `verifiedById`, `verifiedAt`, `source`, `mimeType`, file fields.
- Expiry = `completionDate + 365 days` (`src/platform/compliance/rules.ts`, `certExpiresAt`).
- `setCertificateCompletionDate(personId, certId, dateIso)` in `src/modules/my-info/services/my-info.ts` — self-service. Validates format/future/5-year, normalizes to noon UTC, sets `extraction = "MANUAL"`, enqueues the Person mirror, audits `my-info.certificate_date`. Ownership-gated via `getOwnedCertificate`.
- `verifyCertificate(actorPersonId, certId)` in `src/modules/volunteers/services/compliance.ts` — stamps `verifiedById`/`verifiedAt`, audits `compliance.verify`. Gated by `canViewCertificate`.
- Permission helper: `can(personId, "volunteers.manage_compliance")`.
- `CertificateViewer({ certId, fileName, ownerName })` in `src/modules/my-info/components/certificate-viewer.tsx` — button that opens a `Modal` with the inline PDF.
- Self-service date form lives in `src/modules/my-info/components/hipaa-panel.tsx` (the `dateAction`/`needsDateEntry` block), wired from `src/app/my-info/page.tsx` and `src/app/get-started/hipaa/page.tsx`.

## Design

### 1. Server action — `setCompletionDateAsManager`

New export in `src/modules/volunteers/services/compliance.ts`:

```
setCompletionDateAsManager(actorPersonId: string, certId: string, dateIso: string): Promise<void>
```

Behavior:
1. **Permission:** `if (!(await can(actorPersonId, "volunteers.manage_compliance"))) throw new ComplianceForbiddenError(...)`. This is a master-key check — it does NOT use `canViewCertificate` (department directors must not get entry).
2. **Load cert:** `findUnique({ where: { id: certId } })`; throw `CertificateNotFoundError` if missing.
3. **Guard:** if `cert.completionDate !== null`, throw a validation error (`"completion date already set"`). Entry is set-once via this path.
4. **Validate date:** identical rules to the existing self-service path — reuse the validation. Factor the date-parsing/validation block out of `setCertificateCompletionDate` into a shared helper (e.g. `parseCompletionDate(dateIso): Date` in `src/platform/compliance/`), returning the noon-UTC `Date` or throwing a validation error. Both the (now admin-only) services call it. Rules: `YYYY-MM-DD`, no calendar overflow, not future, not older than 5 years.
5. **Write (single transaction):** update `completionDate`, `extraction = "MANUAL"`, `verifiedById = actorPersonId`, `verifiedAt = now`; enqueue the Person mirror row (`changedFields: ["hipaaStatus"]`) exactly as the self-service path does.
6. **Audit:** one entry, action `compliance.set_date`, `entityType "HipaaCertificate"`, `entityId certId`, `before { completionDate: null, extraction }`, `after { completionDate, extraction: "MANUAL", verifiedById, verifiedAt }`.

Errors reuse existing types: `ComplianceForbiddenError`, `CertificateNotFoundError`, and the certificate validation error type used by the date helper.

### 2. Remove self-service date entry

- `src/modules/my-info/services/my-info.ts`: remove the self-service `setCertificateCompletionDate` export (after extracting the shared `parseCompletionDate` helper). Keep upload (`saveCertificate`) and read paths.
- `src/app/my-info/page.tsx`: remove the `dateAction` server function and stop passing `dateAction`/`dateError`/`dateSaved` to `HipaaPanel`.
- `src/app/get-started/hipaa/page.tsx`: same removal at the onboarding gate.
- `src/modules/my-info/components/hipaa-panel.tsx`: remove the `needsDateEntry` form block and the related props. When the latest cert has no date, show a read-only status (e.g. the existing "Completion date needed" badge / a line saying a compliance manager will confirm the date) instead of an input.

### 3. CertificateViewer — manager date entry

Extend `CertificateViewer` with optional manager-entry capability:

```
type CertificateViewerProps = {
  certId: string;
  fileName: string;
  ownerName?: string;
  completionDate?: Date | null;        // new
  canEditDate?: boolean;               // new — true only when viewer is a compliance manager
  onSetDate?: (formData: FormData) => Promise<void>; // new — bound server action
};
```

- When `canEditDate === true` **and** `completionDate == null`, render a date input (`type="date"`, `max=today`) + Save in the modal footer, posting to `onSetDate`. On success, close/refresh so the roster reflects the new date and verified stamp.
- When `canEditDate` is false/absent (self-view in `/my-info`, director view), the modal is view-only exactly as today.
- Validation errors from the action surface inline in the modal.

### 4. Master roster wiring

`src/app/volunteers/master/page.tsx` (already `requirePermission("volunteers.manage_compliance")`):
- For each person's cert, render the `CertificateViewer` with `canEditDate={true}`, `completionDate`, and an `onSetDate` server action bound to that `certId` that calls `setCompletionDateAsManager(viewer.personId, certId, dateIso)`.
- The "inline" affordance is satisfied by the viewer button in the row; clicking it opens the modal where the dateless cert shows the entry form. No separate inline input.
- Department roster (`src/app/volunteers/page.tsx`) renders the viewer with `canEditDate={false}` (view + existing verify only).

## Data flow

1. Compliance manager opens master roster → clicks a member's cert → CertificateViewer modal shows the PDF.
2. Cert has no date → date input shown → manager reads the date off the PDF, enters it, Saves.
3. `onSetDate` → `setCompletionDateAsManager` → permission check → validate → transactional update (`completionDate`, `extraction=MANUAL`, `verifiedById`, `verifiedAt`) + Person mirror enqueue → audit `compliance.set_date`.
4. Mirror drain recomputes `hipaaStatus`; roster row now shows the date + "Verified by <manager>".

## Error handling

- Non-manager actor → `ComplianceForbiddenError` (should not be reachable from UI; defense in depth).
- Missing cert → `CertificateNotFoundError`.
- `completionDate` already set → validation error (UI only offers entry when null, so defense in depth).
- Bad/future/too-old date → validation error surfaced inline in the modal.
- Audit is fire-and-forget (does not block the response), matching existing patterns.

## Testing

Service tests (`src/modules/volunteers/services/compliance.test.ts`):
- Manager sets date on a dateless cert → `completionDate` set, `extraction = MANUAL`, `verifiedById`/`verifiedAt` stamped, audit `compliance.set_date` written, Person mirror enqueued.
- Non-manager (director with `volunteers.view` only, and plain member) → `ComplianceForbiddenError`, no write.
- Cert already has a date → validation error, no write.
- Future date / >5-year-old date / malformed date → validation error, no write.
- Missing cert → `CertificateNotFoundError`.

Shared helper tests: `parseCompletionDate` accepts valid noon-UTC dates and rejects overflow/future/too-old/malformed.

Regression: confirm self-service date entry is gone from `/my-info` and `/get-started/hipaa` and that `setCertificateCompletionDate` is no longer exported/called.

## Implications / accepted trade-offs

- **Onboarding bottleneck (accepted):** a volunteer whose uploaded PDF didn't auto-parse cannot self-clear the HIPAA onboarding gate; they remain "date unknown" until a compliance manager enters the date. Most volunteers clear automatically via `PARSED`. See `[[onboarding-gate]]`.
- The inline roster requirement is met through the existing per-row CertificateViewer button rather than a separate input, keeping a single date form.

## Files touched (anticipated)

- `src/modules/volunteers/services/compliance.ts` — new `setCompletionDateAsManager`.
- `src/platform/compliance/` — new shared `parseCompletionDate` helper.
- `src/modules/my-info/services/my-info.ts` — remove self-service `setCertificateCompletionDate`. (`saveCertificate` keeps its PDF-based `extractCompletionDate` parsing; it does not use the new string helper.)
- `src/modules/my-info/components/certificate-viewer.tsx` — manager date-entry props + footer form.
- `src/modules/my-info/components/hipaa-panel.tsx` — remove self date form.
- `src/app/my-info/page.tsx`, `src/app/get-started/hipaa/page.tsx` — remove `dateAction`.
- `src/app/volunteers/master/page.tsx` — wire `canEditDate` + `onSetDate`.
- `src/app/volunteers/page.tsx` — render viewer with `canEditDate={false}`.
- Tests as above.
