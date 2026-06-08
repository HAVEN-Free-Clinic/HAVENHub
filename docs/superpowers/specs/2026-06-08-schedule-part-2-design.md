# Schedule Module Part 2: Builder, Requests, Capacity, RHD Readiness

**Date:** 2026-06-08
**Status:** Approved design, pre-implementation
**Builds on:** Plan 7 (Schedule part 1: ShiftAssignment schema, SU 26 import, engine port, viewer), currently open as PR #6
**Legacy source:** github.com/jcarney2024/HAVEN-scheduler at origin/main (the LOCAL clone at /Users/jcarney/Documents/Code-Projects/HAVEN-scheduler is now synced to it; always port from main, the earlier local snapshot was stale)

## 1. Goal

Complete the scheduler port: the director builder (Saturday view AND full-term grid view, assign/shadow/availability modes, med-team tags, removal logging), the swap/drop request workflow end to end, the capacity panel, the HIPAA compliance banner, the RHD clinic-readiness panel, and the director availability override + acknowledge handshake. After this plan the legacy scheduler has no remaining users.

## 2. Binding decisions (from Jack)

- Compliance banner checks HIPAA only (plan-5 engine). Contract/training tracking stays in Airtable until its own plan.
- Capacity ports fully: Department gains idealHeadcount + patientCapacityPerProvider (admin-editable, one-time import); Person gains spanishSpeaking (imported: manual checkbox OR application proficiency Conversational+); patients booked is director-entered per (department, Saturday) in the builder, not imported. These fields will eventually be fed by the Recruitment module.
- RHD readiness is included. Postgres masters: RhdAttending + RhdClinic tables + Person.licensedRN, one-time import from the RHD Attendings / RHD Clinics Airtable tables; SRHD directors maintain clinic rows in the builder afterward.
- Builder architecture is server-first with client islands (server components + server actions; small "use client" components only where click interactions demand it).
- GridView (full-term grid layout) ships in this plan alongside the Saturday view, with the legacy ViewToggle.
- The Excel-import halves of legacy rhd.ts/medteam.ts are NOT ported (workbook ingestion is dead post-cutover).

**Conventions (binding):** no em-dashes; "HAVEN Hub" prose; UTC day-key date comparisons (isoDateKey); audits on mutations; services trust callers except directorship scoping enforced internally (offboarding.ts pattern); permission checks at page/action layer; TDD.

## 3. Data model

One migration. New:

```prisma
enum ShiftRequestStatus { PENDING APPROVED DENIED CANCELLED }

/// Swap/drop requests. Drop when targetId/targetDate are null; named swap otherwise.
model ShiftRequest {
  id            String             @id @default(cuid())
  termId        String
  requesterId   String
  requesterDate DateTime
  departmentId  String
  targetId      String?
  targetDate    DateTime?
  status        ShiftRequestStatus @default(PENDING)
  note          String?
  decidedById   String?
  decidedAt     DateTime?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  @@index([termId, status])
  @@index([requesterId])
}

/// Per-(department, clinic date) operational data maintained by directors.
model ScheduleDay {
  id             String   @id @default(cuid())
  termId         String
  departmentId   String
  clinicDate     DateTime
  patientsBooked Int?
  @@unique([termId, departmentId, clinicDate])
}

/// RHD attending physicians and their procedure qualification matrix.
/// Procedure values are "yes" | "no" | "unknown" strings (legacy semantics).
model RhdAttending {
  id           String  @id @default(cuid())
  scheduleName String  @unique
  fullName     String
  iudIn        String  @default("unknown")
  iudOut       String  @default("unknown")
  nexplanon    String  @default("unknown")
  gac          String  @default("unknown")
  emb          String  @default("unknown")
  seesMale     String  @default("unknown")
  notes        String?
  isActive     Boolean @default(true)
  clinics      RhdClinic[]
}

/// Per-Saturday RHD clinic row (attending on duty, director, procedures booked).
model RhdClinic {
  id               String        @id @default(cuid())
  termId           String
  clinicDate       DateTime
  attendingId      String?
  attending        RhdAttending? @relation(...)
  directorName     String?
  proceduresBooked Int?
  @@unique([termId, clinicDate])
}
```

Existing models gain: `Person.spanishSpeaking Boolean @default(false)`, `Person.licensedRN Boolean @default(false)`, `Department.idealHeadcount Int?`, `Department.patientCapacityPerProvider Int?`.

Config: `RHD_MAX_PROCEDURES` (number, default 3).

## 4. One-time imports (dry-run-default scripts, never delete)

1. **Person flags:** spanishSpeaking from All People (manual "Spanish Speaking" checkbox OR application "Spanish Proficiency Level" Conversational+; exact fields probed at implementation, mirroring the legacy live-sync logic in server/app.ts ~line 624) and licensedRN (field probed from the RHD integration's person attribute).
2. **Department config:** Ideal Headcount + patient-capacity-per-provider from the Airtable department records (field names probed; legacy reads "Ideal Headcount" at app.ts ~line 792).
3. **RHD reference:** RHD Attendings (tblxDJehirZSLFJna) + RHD Clinics (tbl0HrOcMHUQL0a6C) into RhdAttending/RhdClinic, resolving clinic dates by UTC day key against the term.

## 5. Requests workflow

- **Engine port** (`src/modules/schedule/engine/requests.ts` from upstream main server/requests.ts + tests): `validateRequest` unchanged (assignee drops always valid; shadows drop-only; named swaps require same role both sides, partner assigned on the target date). `planApply` re-targeted: instead of Airtable patch ops it returns assignment mutations; the service executes them in ONE transaction (drop = delete the requester's assignment; swap = requester and target exchange dates: delete both, recreate both). The legacy best-effort rollback machinery is replaced by transaction atomicity. Approval re-validates against current assignments before applying (legacy behavior, including the race-safe duplicate guard from upstream).
- **Member UI (viewer /schedule):** per shift, a "Request a change" affordance: drop (optional note) or named swap (partner select limited to same-role people in the same department assigned on a DIFFERENT date). One open (PENDING) request per person per shift. Cancel own pending request. Audit `schedule.request` / `schedule.request_cancel`.
- **Director UI (builder pending tab):** PENDING requests for the department; approve (re-validate, apply transactionally, audit `schedule.request_approve`) or deny with note (`schedule.request_deny`). Stale/invalid requests surface the validation error instead of applying.

## 6. Director builder (`/schedule/builder`)

Access: ACTIVE DIRECTOR membership in the active term (manageable departments incl. one-hop delegation, same helper as compliance) OR `schedule.edit_all`. Server component + client islands.

- **Department switcher** (the director's manageable departments; edit_all holders get all departments) + **date tab strip** + **ViewToggle** (Saturday view / Grid view) + **mode toggle** (Assign / Shadow / Availability).
- **Saturday view:** the selected department-and-date roster: assigned people grouped by role with tag toggles (triage/walk-in/CC shown per `rolesForDept`-equivalent driven by department code; remote for all), unassigned-but-available members listed for one-click assign; cell interactions are a client island posting server actions.
- **Grid view (legacy GridView):** rows = the department's ACTIVE term members, columns = all term Saturdays, compact cells (assignment state + tags + availability shading); clickable in Assign/Shadow modes; read-only in Availability mode.
- **Modes:** Assign toggles VOLUNTEER assignments (directors assign DIRECTOR rows for themselves/other directors via the same cells); Shadow toggles SHADOW rows; Availability shows the three-tier resolution per member and lets the director set/clear the override tier (directorAvailabilityDates + directorAvailabilitySetAt) and **Acknowledge** a member's pending self-update (sets availabilityAcknowledgedAt).
- **Removal logging:** unassigning prompts for an optional reason; audit `schedule.remove` with before state.
- **Capacity panel** (selected Saturday): ported computeDayMetrics: headcount vs idealHeadcount, triage/walk-in/CC quotas (department-code-driven), shadow count, Spanish-speaker count, maxPatientCapacity = patientCapacityPerProvider x onShift, patientsBooked (inline editable -> ScheduleDay) and patientsToReschedule.
- **Compliance banner:** scheduled-but-not-HIPAA-compliant volunteers for the selected department/date via the plan-5 compliance engine, summarized like legacy summarizeCompliance.
- **RHD readiness panel** (SCTS/JCTS/CCRH only): ported computeClinicReadiness (attending + procedure matrix, SCTM/JCTM/RN/Spanish coverage, depoOk, procedures cap warning, emails); inline clinic-row editing (attending select, director name, procedures booked) for the selected Saturday.

## 7. Engine ports (all TDD, from upstream main)

- `requests.ts`: validateRequest + planApply (re-targeted) + upstream tests adapted.
- `capacity.ts`: computeDayMetrics + rolesForDept (renamed/kept; driven by department CODE) + upstream tests.
- `rhd.ts`: computeClinicReadiness + PROCEDURE_KEYS + upstream tests. parseRhdCell/buildRhdImportPlan NOT ported.
- Compliance banner summarization: a small pure helper over plan-5 statuses (legacy buildNonCompliantByDept shape, missing = ["hipaa"]).

## 8. Services (`src/modules/schedule/services/`)

- `builder.ts`: builderView(viewer, departmentId?, dateKey?, view?, mode?) (scoped data for the page); assign/unassign/toggleTag/setShadow mutations (directorship-scoped internally, audited, conflict-aware); setPatientsBooked; setAvailabilityOverride / clearAvailabilityOverride / acknowledgeAvailability; RHD clinic upsert; all date comparisons via isoDateKey.
- `requests.ts` (service): createRequest (member-scoped: must own the shift), cancelRequest, listDepartmentRequests, approveRequest (re-validate + transactional apply), denyRequest.
- Viewer service additions: eligible swap partners query for the request form.

## 9. Testing

- Engine: upstream test suites adapted (requests validate/apply, capacity, rhd readiness) + banner summarizer.
- Services: assignment mutations (incl. unique-constraint paths and removal audit), request lifecycle with revalidation races (approve after the underlying shift changed -> validation error, no mutation), availability override/acknowledge, ScheduleDay + RhdClinic upserts, scoping matrices (director own dept, delegation, edit_all, outsider Forbidden).
- e2e (~4): builder assign/unassign round trip; member files drop -> director approves -> assignment gone (restore state after); capacity panel renders metrics; RHD panel renders for an SRHD-delegated department.
- Imports: fixture-reader tests per script; live dry-run -> controller review -> apply (same checkpoint pattern as plan 7).

## 10. Deferred deliberately

- Login-log analytics; schedule mirroring to Airtable; FA 26 roster bootstrap (term lifecycle plan)
- Contract/training compliance integration (own plan; banner is HIPAA-only until then)
- Recruitment module as the future source of spanishSpeaking/licensedRN/dept config
- Retiring the legacy scheduler deployment (manual, after this plan ships)
