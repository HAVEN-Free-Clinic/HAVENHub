# Scheduling: Director Guide

This guide is for directors and schedule managers. It covers building a clinic
schedule, reading capacity and conflicts, managing swap and drop requests,
overriding availability, and the RHD attending roster.

Volunteers should read the [Volunteer Guide](./scheduling-volunteers.md). For how
the system works under the hood, see the [technical reference](./scheduling.md).

## Contents

- [What you can do](#what-you-can-do)
- [Building a clinic in the builder](#building-a-clinic-in-the-builder)
- [How availability resolves](#how-availability-resolves)
- [Overriding a member's availability](#overriding-a-members-availability)
- [Reading capacity](#reading-capacity)
- [Conflicts](#conflicts)
- [The compliance banner](#the-compliance-banner)
- [Approving swaps and drops](#approving-swaps-and-drops)
- [RHD clinics: readiness and attendings](#rhd-clinics-readiness-and-attendings)
- [Quick answers](#quick-answers)

## What you can do

Your reach depends on your permissions:

| You have | You can |
| --- | --- |
| `schedule.view` | Open the module and all of its pages. |
| `schedule.edit_own_dept` | Build and edit the schedule for departments you manage. |
| `schedule.edit_all` | Build and edit across every department, and approve or deny any request. |
| `schedule.manage_requests` | Approve and deny swap and drop requests. |

"Departments you manage" includes departments delegated to you. If your
department is set as a manager over another department, you can build that
department's schedule too (one hop out).

If you try to edit a department outside your reach, the action is refused.

## Building a clinic in the builder

The **Builder** (`/schedule/builder`) is your workspace. Pick a department and a
clinic date, then assign people into roles:

- **Director**: runs the department's clinic that day.
- **Volunteer**: a standard shift. You can tag volunteers with triage, walk-in,
  CC (continuity care), or remote to show their role for the day.
- **Shadow**: an observer slot.

A person holds at most one assignment per department per date, but the three
roles are independent across departments, so the same person can be a volunteer
in one department and a shadow in another on the same Saturday.

The builder scopes everything to the departments you manage and the date you
select, and re-checks your permission on every change.

## How availability resolves

For each candidate, the builder shows availability resolved through three tiers.
The highest tier that is set wins:

1. **Director override** (highest). What a director explicitly set for the
   member. An empty override is intentional: it means "available on no dates,"
   which is different from never having set one.
2. **Self update** (middle). The clinic dates the member selected for
   themselves.
3. **Baseline** (lowest). The availability captured from the member's
   application. The fallback when no higher tier is set.

Schedule against the resolved set so you are not assigning people to dates they
cannot work.

## Overriding a member's availability

When you need to set availability for a member directly (for example after
talking with them), set a director override. It takes priority over their self
update and their baseline for the rest of the term. Setting an empty override is
a valid way to mark someone as available on no dates.

## Reading capacity

For the selected department and date, the builder computes live capacity:

- **Headcount** against an ideal headcount, shown as under, at, over, or unknown.
- **Triage** and **walk-in** coverage, each shown as missing (nobody), ok (one),
  or excess (two or more).
- **Shadow** and **Spanish-speaker** counts for the day.
- **Patient capacity**: from the patients booked you enter for the day against
  the patient-capacity-per-provider setting, giving a maximum capacity and any
  patients who would need to be rescheduled.

Ideal headcount and patient-capacity-per-provider come from configuration, not
hardcoded values, so they can be tuned per department.

## Conflicts

The builder flags **same-day conflicts**: a person already scheduled in another
department on the date you are working. Use this to avoid double-booking someone
across teams on the same Saturday.

## The compliance banner

The builder surfaces a HIPAA compliance banner listing departments that have at
least one scheduled volunteer whose certification is not current. Fully compliant
departments are not listed. Use it to catch volunteers who need to renew before
clinic. Compliance is managed from each volunteer's My Info; the banner is a
read-only heads-up.

## Approving swaps and drops

Volunteers submit swap and drop requests from their own schedule. You review them
where you manage the department, as a delegated manager, or with
`schedule.edit_all`.

Each request is one of:

- **Drop**: the volunteer leaves a shift with no replacement.
- **Swap**: the volunteer trades their shift with a named partner's shift on
  another date.

When you **approve** a request, the system re-validates it and applies the change
in a single transaction:

- A drop removes the volunteer from the shift.
- A swap moves each person to the other's date, keeping the shared role.

The rules the system enforces (so you do not have to police them by hand):

- A swap partner must be assigned to the named date and hold the **same role**.
- Shadow shifts can only be dropped, never swapped.
- A volunteer cannot have two pending requests open for the same shift.

You can also **deny** a request. Requesters can cancel their own pending requests
before you act.

## RHD clinics: readiness and attendings

Reproductive Health Department clinics (department codes `SCTS`, `JCTS`, `CCRH`)
need a qualified attending physician on duty.

### Attending roster

Maintain attendings on **Attendings** (`/schedule/attendings`). Each attending
carries a qualification matrix across six procedures, each marked yes, no, or
unknown:

| Procedure | |
| --- | --- |
| IUD In | IUD Out |
| Nexplanon | GAC |
| EMB | Sees Male |

Editing the roster requires you to manage an RHD-family department.

### Clinic readiness

Each RHD clinic date records the attending on duty, the director on point, and
procedures booked. The builder's readiness panel combines the assigned
attending's capabilities with the people on shift to tell you whether the clinic
can cover its booked procedures before the day arrives.

## Quick answers

**A volunteer says they are available but I do not see it.** Check which tier is
active. A director override (yours or another director's) outranks their self
update.

**I need to force someone's availability.** Set a director override. It wins for
the rest of the term. An empty override means "no dates."

**A department I do not own needs scheduling.** You can only build departments you
manage or that are delegated to you, unless you hold `schedule.edit_all`.

**Why can't this swap be approved?** The partner must hold the same role on the
named date, and shadows cannot be swapped. The system re-validates at approval
time.

**Someone is double-booked.** The same-day conflict flag in the builder catches a
person scheduled in another department on the same date.

**A volunteer is flagged on the compliance banner.** Their HIPAA certification is
not current. They renew it from My Info.
