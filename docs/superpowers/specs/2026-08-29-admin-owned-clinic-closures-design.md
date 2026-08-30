# Admin-Owned Clinic Closures

Date: 2026-08-29
Branch: its own, off `main`.

## Problem

A closed clinic date is a calendar fact: a holiday, a break week, a Saturday the
clinic does not run. `ClinicDay.closedNote` even reads like one — the importer's
parsed values look like `HAVEN FREE CLINIC CLOSED`. Admin already owns the other
half of that fact, `Term.clinicDates`, behind `admin.manage_terms`.

But closure itself is declared from Schedule > Attendings > Day, behind
`schedule.manage_attendings`. That put the decision with Faculty Relations, who
consume the fact to staff around it rather than being the ones to declare it.
The concept ends up split across two screens with two owners:

| Question | Stored as | Screen | Permission |
| --- | --- | --- | --- |
| Does this Saturday exist at all? | `Term.clinicDates` | Admin > Terms | `admin.manage_terms` |
| Is an existing Saturday closed? | `ClinicDay.isClosed` | Schedule > Attendings > Day | `schedule.manage_attendings` |

`attendingSchedule` then collapses both into one displayed answer
(`isClosed: !isClinicDate || storedClosed`), which is why the Day view shows a
checkbox in one case and flat text plus "Add the date in Admin > Terms" in the
other. One user-visible concept, two owners, two homes.

Three concrete defects fall out of the split:

- **`closedNote` has no UI writer at all.** `saveDayAction` posts `isClosed`
  only. The sole writer is the CLI workbook importer, so any closure set from
  the UI renders "No reason was recorded." everywhere the reason is surfaced.
- **The importer silently reverts closures.** Its upsert `update` branch writes
  `isClosed: row.isClosed` unconditionally, and `row.isClosed` defaults to
  `false`. Re-running an import on a sheet whose closed marker moved or was
  dropped un-closes the date with no warning.
- **The attendings date strip never got the closed markers.** PR #685 added
  `closedKeys` to `ClinicDateStrip` and wired it into the builder and full
  schedule, but not into the attendings page — the one screen where closure is
  set. `closedKeys` is optional, so nothing caught it.

## Decision

Closure originates from admins. `ClinicDay.isClosed` and `ClinicDay.closedNote`
become writable only by `admin.manage_terms`, edited in the existing Clinic
dates section of Admin > Terms. Faculty Relations keeps full visibility and
loses the write.

Closure stays on `ClinicDay` rather than moving onto the term calendar. Keeping
it there means no schema change, no migration, and no reader repointed —
`closedClinicDates`, `resolveOpenClinicDate`, the reminders, the builder and the
full schedule all keep working untouched. Ownership is expressed by permission
rather than by model, which is the accepted cost of this approach.

The move is permission-neutral in practice. In production only Platform Admin
holds `admin.manage_terms`, and that is the same single account that can reach
`schedule.manage_attendings` today, so nobody loses an ability they currently
exercise.

### Non-goals

- **No schema change.** `ClinicDay` keeps both fields exactly as they are.
- **No new permission.** Closure is a term-calendar fact, so `admin.manage_terms`
  is the right existing grant. Adding a dedicated permission would put a third
  owner on a concept this change exists to consolidate.
- **No change to what a closure *means*.** PR #685's semantics stand: a closed
  date stays fully assignable, the weekly reminder still goes out with a closed
  notice, and check-in and attendance stay off. This changes who declares it,
  not what happens after.
- **Not fixing the role data.** `Faculty Relations Manager` is missing
  `schedule.view` in production and no one is assigned to any closure-capable
  role. Both are pre-existing operational problems, tracked separately below.

## Ownership and guards

`setClinicDayClosure(actor, { termId, dateKey, isClosed, closedNote })` lands in
`src/modules/schedule/services/builder.ts`, beside `upsertClinicDay`, and
guards internally on `admin.manage_terms`.

Placing an admin-owned write in the schedule module is deliberate. The two
modules follow different conventions: admin services trust their callers ("Pages
guard with requirePermission. The service trusts its callers and stays
testable"), while `builder.ts` enforces scope internally per mutation. Every
`ClinicDay` mutation already lives in `builder.ts` under the second convention,
and splitting one field's write into a module with the opposite convention would
leave `ClinicDay` writes guarded two different ways. The admin page still calls
`requirePermission("admin.manage_terms")` as its own gate, so the check holds at
both layers.

Behaviour:

- Upserts the `ClinicDay` row, creating one when absent. Rows are sparse — FA26
  has 13 clinic dates and 2 rows — so closing a date routinely creates one.
- Touches `isClosed` and `closedNote` only. Slots, on-call, specialty, director
  and booked counts are left standing.
- Clearing a closure sets `closedNote` to null alongside `isClosed: false`, so a
  stale reason cannot outlive the closure it explained.
- Accepts a date the term does not list, matching `upsertClinicDay`'s existing
  tolerance, and anchors it noon-UTC through `dateKeyToNoonUtc` so the
  `(term, date)` unique key lands on the same instant a calendar edit produces.
- Records an audit entry under its own action, `admin.clinic_day_closure`, so
  the log distinguishes an admin declaring a closure from Faculty Relations
  editing the day's staffing. `upsertClinicDay` keeps `schedule.clinic_day`.

`upsertClinicDay` **drops `isClosed` and `closedNote` from its options type**.
The schedule module then cannot write closure at all, and the compiler enforces
it rather than a convention. Its `schedule.manage_attendings` guard is unchanged
for every remaining field.

## Admin UI

The Clinic dates section of `/admin/terms/[id]` gains per-date closure editing.
`ClinicDatesEditor` currently manages a list of dates; each row gains a closed
toggle and an optional reason input, saved through a new server action that
calls `requirePermission("admin.manage_terms")` then `setClinicDayClosure`.

This is also the first UI writer `closedNote` has ever had, which resolves the
"No reason was recorded." defect on its own.

The reason stays optional. Every reader already handles null, and requiring text
would block the common case of a break week that needs no explanation.

Closure state has to be read into the page: the editor renders from
`Term.clinicDates`, which carries no closure, so the page loads the term's
`ClinicDay` rows and merges `isClosed` / `closedNote` by date key.

## Schedule side

The attendings Day view becomes read-only for closure:

- The `isClosed` checkbox and its `closedMarker` hidden field are removed, and
  `saveDayAction` stops reading them.
- In their place, closure is stated with its reason and a link to Admin > Terms
  — mirroring the pattern already used for a date the term does not list, which
  says "Add the date in Admin > Terms."
- `clinicalEditable` keeps its existing meaning: a closed date's clinical
  controls stay disabled, since `storedClosed` still feeds it.

Faculty Relations must keep *seeing* closures — PR #685's entire "label, don't
hide" premise depends on the people staffing a closed Saturday knowing it is
shut. Only the ability to declare one moves.

The missing `closedKeys` on the attendings `ClinicDateStrip` is fixed in the
same pass, from the `ClinicDay` rows the page now already loads for the Day
view. Marking closed dates on the screen that links to the closure editor is
the same feature, not a drive-by.

## Importer

`runTermScheduleImport` stops writing closure. Both the `create` and `update`
branches drop `isClosed` and `closedNote`, and the `CLOSED` marker parse is
removed along with the two `ParsedScheduleRow` fields.

This is the strict reading of admin-origin: closure is declared in the UI by a
person, never as a side effect of a bulk import. It also removes the silent
revert outright rather than working around it.

Nothing is lost today. Production holds zero closed days and zero `closedNote`
values across all nine terms, so no existing closure depends on the importer.

The import remains authoritative for what it actually owns: slot assignments,
on-call, and the specialty clinic.

## Testing

- `setClinicDayClosure` refuses an actor without `admin.manage_terms`; creates a
  row for a date that has none; leaves slots, on-call and specialty untouched;
  clears `closedNote` when the closure is cleared.
- `upsertClinicDay` no longer accepts `isClosed` / `closedNote` — a type-level
  assertion, plus a test that a `schedule.manage_attendings` holder cannot reach
  closure through any remaining path.
- The importer leaves an existing closure standing across a re-import of a sheet
  with no closed marker. This is the regression test for the silent revert and
  is the one most worth having.
- The attendings Day view renders closure read-only, and its date strip marks
  closed dates.
- Existing closure readers are untouched and their tests should stay green
  unmodified — `closedClinicDates`, `resolveOpenClinicDate`, the shift reminder
  build, the builder banner and the full schedule. A change to any of them
  means this design leaked.

## Operational follow-ups

Out of scope for the code change, but the feature does not function without
them:

1. **`Faculty Relations Manager` is missing `schedule.view`.** `system-roles.ts`
   grants `["schedule.view", "schedule.manage_attendings"]`; production has only
   the latter. The schedule module gates on `schedule.view` with no
   `additionalAccessPermissions`, so anyone assigned the role today is bounced to
   `/no-access` before the permission check runs. System roles are seeded once by
   a frozen bootstrap migration with no reconcile, so this will not self-heal.
2. **No one is assigned to any closure-capable role.** Faculty Relations Manager,
   RHD and Executive Director all have zero people. Closure depends on a single
   `*` holder.
3. **Granting `admin.manage_terms` alone is not enough.** The Admin module gates
   on `admin.access` with no `additionalAccessPermissions`, so any role meant to
   close dates needs both — the same trap as (1).
