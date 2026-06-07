# Plan 4: My Info Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The first member-facing module: every signed-in member (including alumni with no current term) can view and edit their own contact details, declare they are not volunteering this term, and upload their HIPAA certificate, replacing updatemyinfo.

**Architecture:** Spec §9.2. Three structural moves beyond the pages themselves: (1) the person-mutation core (diff, audit, mirror enqueue, typed errors) moves from `modules/admin` into `src/platform/people.ts` so both admin and my-info use it without violating the module boundary; (2) `ModuleManifest.accessPermission` becomes optional, where absent means "any signed-in matched person" (spec decision: non-current members keep My Info access); (3) HIPAA certificates get a `HipaaCertificate` table plus local file storage, with the Airtable attachment push riding the existing outbox/worker, gated exactly like the field mirror.

**Tech Stack:** existing stack only. Files stored under `UPLOAD_DIR` (config, default `./uploads`, gitignored; a volume on SpinUp later).

**Conventions (binding):** no em-dashes; "HAVEN Hub" in prose; UTC date rendering; every mutation audited; services trust callers for permissions (pages/actions gate); self-service writes are whitelisted at the SERVICE level, not just the form.

---

## File structure (end state)

```
src/platform/people.ts / people.test.ts   # moved core: updatePersonFields, PersonConflictError,
                                          # PersonNotFoundError, MIRRORED_FIELDS
src/platform/modules/types.ts             # accessPermission?: string (optional)
src/platform/modules/registry.ts          # my-info: active, no accessPermission, permissions []
src/app/page.tsx + src/platform/auth/session.ts  # hub filter + a requireModuleAccess helper
src/modules/admin/services/people.ts      # delegates to platform core (public API unchanged)
prisma/schema.prisma                      # + HipaaCertificate
src/platform/config.ts                    # + UPLOAD_DIR, MAX_UPLOAD_MB, AIRTABLE_MIRROR_HIPAA_FIELD_ID
src/modules/my-info/services/my-info.ts / my-info.test.ts
  # getMyInfo, updateMyInfo (whitelist), withdrawFromTerm, saveCertificate, listMyCertificates
src/modules/my-info/components/my-info-form.tsx, hipaa-panel.tsx, memberships-card.tsx
src/app/my-info/page.tsx                  # session-gated, AppShell, all sections
src/app/my-info/certificate/[id]/route.ts # owner-only download
src/platform/airtable/client.ts           # + uploadAttachment (content API)
src/platform/airtable/mirror.ts           # + drainOutbox handles entityType "HipaaCertificate"
worker unchanged (drain already routes through mirror.ts)
e2e/my-info.spec.ts
```

---

### Task 0: Branch + plan commit

- [ ] On `plan-4/my-info`: `git add docs/ && git commit -m "docs: plan 4 - my info module"`

### Task 1: Platform extraction + optional module access

**Files:** create `src/platform/people.ts` (+ move tests), modify `src/modules/admin/services/people.ts`, `src/platform/modules/types.ts`, `registry.ts`, `src/app/page.tsx`, `src/platform/auth/session.ts`, registry test.

- Move from the admin service into `src/platform/people.ts`: `PersonInput`, `PersonConflictError`, `PersonNotFoundError`, the normalize/diff/changed-fields logic, the transactional update (write + enqueueMirror) and create, P2002 mapping, and `MIRRORED_FIELDS`. Export `createPersonRecord(actorPersonId, input)`, `updatePersonFields(actorPersonId, personId, input)`, `setPersonStatusField(actorPersonId, personId, status)`. The admin service keeps its exact public API (searchPeople/getPerson/createPerson/updatePerson/setPersonStatus + re-exported error classes) by delegating; its test file MUST pass unchanged (that is the refactor's proof). Platform-level tests: move/duplicate the mutation behaviors into `src/platform/people.test.ts` (diff semantics, tx rollback, conflicts, not-found); admin tests keep covering the delegation surface.
- `ModuleManifest.accessPermission?: string`. Registry: my-info entry becomes `status: "active"`, NO accessPermission, `permissions: []` (drop "my-info.access" from the registry; stale seed grants are harmless and get swept on next grants edit). Registry test: the "accessPermission included in permissions" invariant applies only when accessPermission is defined; eight-module list unchanged.
- Hub filter: visible when `m.status === "coming-soon" || !m.accessPermission || hasPermission(perms, m.accessPermission)`; active tiles link as before.
- `requireModuleAccess(moduleId)` helper in session.ts: looks up the manifest; no accessPermission -> requirePersonSession; otherwise requirePermission. Use it in BOTH module layouts (swap admin's layout to it for symmetry; admin still resolves to requirePermission("admin.access")).
- Gauntlet green (259 unit incl. moved tests, e2e 14: hub e2e may need updating ONLY if tile text assertions change; they should not).
- Commit: `refactor(platform): person mutation core + optional module access`

### Task 2: Schema + config

- `HipaaCertificate { id cuid, personId FK -> Person (onDelete Cascade), fileName (original, display only), storedName (generated, server filename), size Int, mimeType, uploadedAt DateTime @default(now()), @@index([personId, uploadedAt]) }`. Migration `hipaa-certificates`; resetDb adds the table.
- Config (TDD, extend config.test.ts): `UPLOAD_DIR` default `"./uploads"`; `MAX_UPLOAD_MB` default `"10"` transformed to number; `AIRTABLE_MIRROR_HIPAA_FIELD_ID` optional (NOT required when mirror enabled; the attachment push silently skips and logs when unset). `.env.example` documents all three. Add `uploads/` to `.gitignore`.
- Commit: `feat(my-info): certificate schema + upload config`

### Task 3: My Info service (TDD)

`src/modules/my-info/services/my-info.ts`:

```ts
export async function getMyInfo(personId: string) // person + ACTIVE memberships (term+department) in the ACTIVE term + latest certificate
export type MyInfoInput = { phone?: string | null; contactEmail?: string | null; epicId?: string | null; yaleAffiliation?: string | null; gradYear?: string | null };
export async function updateMyInfo(personId: string, input: MyInfoInput) // WHITELIST: strips any other keys defensively, then platform updatePersonFields(personId, personId, clean)
export async function withdrawFromTerm(personId: string): Promise<number> // sets own ACTIVE VOLUNTEER memberships in the active term to REMOVED; audit my-info.withdraw with count + termId; returns count; 0 when none (no audit). DIRECTOR memberships untouched (stepping down as director goes through the EDs; comment).
export async function saveCertificate(personId: string, file: { name: string; type: string; size: number; bytes: Buffer }): Promise<HipaaCertificate>
// validates: mimeType application/pdf AND name ends .pdf; size <= MAX_UPLOAD_MB; typed CertificateValidationError otherwise.
// writes bytes to UPLOAD_DIR/<cuid>.pdf (mkdir -p on first use); creates the row; audit my-info.certificate_upload
// (fileName + size in after, never the bytes); enqueueMirror IN THE SAME TX with entityType "HipaaCertificate", entityId = cert id.
export async function listMyCertificates(personId: string)
export async function getOwnedCertificate(personId: string, certId: string) // row only when owned, else null
```

Tests: whitelist strips a smuggled `name`/`netId` key (person name unchanged after updateMyInfo with extra keys); update delegates with self as actor (audit actorPersonId === personId); withdraw removes only VOLUNTEER kind + only active term + audit; withdraw with none returns 0 no audit; saveCertificate rejects non-pdf mime, .exe name, oversize (typed); accepts a small pdf buffer, file exists on disk at storedName, row + audit + outbox row written transactionally (outbox count proves enqueue; bogus-person FK violation leaves no file orphan: write file AFTER the tx commits OR clean up on failure; pick write-after-commit: tx creates row + outbox, then bytes hit disk, and a disk failure deletes the row in a catch with comment); listMyCertificates ordered desc; getOwnedCertificate enforces ownership (other personId -> null). Use a temp UPLOAD_DIR per test run (override env in the test file before importing config: vitest setup pattern; simplest: config reads process.env at import, so set UPLOAD_DIR in vitest.setup.ts to a /tmp path).

Commit: `feat(my-info): self-service profile, withdrawal, certificate service`

### Task 4: Pages + components

- Registry already active (Task 1). `/my-info/page.tsx`: `requireModuleAccess("my-info")`, AppShell (userName + active-term chip like admin layout, no ModuleNav needed for a single page), PageHeader ("My Info", description "Keep your contact details current."), then:
  - **Profile form** (`my-info-form.tsx`): Fields phone, contactEmail, yaleAffiliation (Select with the known affiliation options + freeform fallback acceptable as Input), gradYear, epicId, plus READ-ONLY display rows for name and netId with helper text "Contact the IT team to correct your name or NetID." Action -> updateMyInfo, PersonConflictError -> ?error, success ?saved=1.
  - **Memberships card**: current-term memberships (dept code + kind Badge); when the person has ACTIVE VOLUNTEER memberships: ConfirmButton "I am not volunteering this term" -> withdrawFromTerm -> ?withdrawn=N renders confirmation line. Directors see the contact-the-EDs note instead of a button for their director rows.
  - **HIPAA panel** (`hipaa-panel.tsx`): latest cert line ("Uploaded Jun 7, 2026" + download link) or "No certificate on file"; upload form `<input type="file" name="certificate" accept="application/pdf">` + Button; the server action reads `formData.get("certificate") as File`, converts arrayBuffer -> Buffer, calls saveCertificate, CertificateValidationError -> ?error; history list (all certs, download links).
- Download route `/my-info/certificate/[id]/route.ts`: GET; requirePersonSession (route handlers can call auth(); on failure return 401 JSON instead of redirect), getOwnedCertificate -> 404 when not owned; stream the file with content-type application/pdf + content-disposition attachment; storedName only ever comes from the DB row (no user input in the path).
- e2e (`e2e/my-info.spec.ts`): admin login -> hub shows My Info tile as ACTIVE (link) -> /my-info renders the form with the Name read-only row and the HIPAA section; volunteer login -> /my-info also renders (session-only access proof). Read-only.
- Commit: `feat(my-info): member-facing pages`

### Task 5: Airtable attachment push (worker side)

- `AirtableClient.uploadAttachment(baseId, recordId, fieldId, file: { name, type, base64 })`: POST `https://content.airtable.com/v0/{baseId}/{recordId}/{fieldId}/uploadAttachment` body `{ contentType, file: base64, filename }` with the same retry/error envelope (content API host differs; add as a method using a second root constant). TDD with fake fetch (URL, body shape, retry-on-429).
- `drainOutbox`: route by `row.entityType`: "Person" as today; "HipaaCertificate": load cert + person; skip-FAIL when person has no MirrorRecord mapping yet (lastError "person not mirrored yet; will retry", attempts++ so it retries after the person row mirrors) BUT when `AIRTABLE_MIRROR_HIPAA_FIELD_ID`/target field unset, mark SENT with a comment (configured-off is success, not failure); otherwise read the file from disk, base64, uploadAttachment to the person's mapped record. Thread the hipaa field id through MirrorTarget (`hipaaFieldId: string | null`). Tests with fake io + temp files: success path marks SENT; unmapped person retries; unset field id marks SENT without calling the writer; missing file on disk FAILs with reason.
- Worker `mirrorTarget()` gains `hipaaFieldId: config.AIRTABLE_MIRROR_HIPAA_FIELD_ID ?? null`.
- Commit: `feat(my-info): hipaa certificate push through the mirror outbox`

### Task 6: Final verification + PR

- Full gauntlet (kill dev servers): lint, typecheck, npm test, build, e2e (14 + ~2 new my-info).
- Screenshots: /my-info as j.carney@yale.edu -> /tmp/havenhub-shots/my-info.png.
- Push, `gh pr create` (summary: member-facing My Info; platform person-core extraction; session-only module access; HIPAA storage + gated Airtable push), watch CI green.

## Deferred deliberately

- HIPAA compliance STATUS display and director-facing compliance dashboards: Plan 5 (Volunteers)
- Admin/director access to others' certificates: Plan 5
- Live sandbox smoke of the attachment push (needs an attachment field on the sandbox table): cutover runbook or Plan 5, where compliance owns the field
- Cert file retention/cleanup policy: deployment plan (volume sizing)
