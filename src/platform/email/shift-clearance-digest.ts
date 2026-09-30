/**
 * Weekly "on shift but not cleared" digest to department directors.
 *
 * Sent Wednesday evenings: for this week's clinic day, each department director
 * gets one email naming everyone scheduled in their department(s) who is not
 * fully cleared, with what each is still missing. The point is lead time. A
 * volunteer who is not cleared cannot work the shift, and Wednesday leaves the
 * director Thursday and Friday to chase them or find cover before Saturday.
 *
 * Separate from the weekly clearance digest in reminders.ts, which lists every
 * uncleared member of a department whether or not they are scheduled. This one
 * is narrower and more urgent: only the people the schedule is counting on.
 *
 * Enqueue-only, like every other reminder job: notify() writes the rows and the
 * enqueue flush (backstopped by /api/cron/email) delivers them.
 */
import type { ShiftRole } from "@prisma/client";
import { prisma } from "@/platform/db";
import { getActiveTerm } from "@/platform/terms/active-term";
import { getSetting } from "@/platform/settings/service";
import { loadClearanceMap, type ClearanceSummary } from "@/platform/clearance";
import { outstandingShortLabels } from "@/platform/compliance/outstanding-items";
import { CLINIC_DATE_LONG, formatCalendarDate, isoDateKey } from "@/platform/dates";
import { comparePersonName, type PersonNameParts } from "@/platform/person-name";
import { selectCurrentClinicDate } from "@/platform/teams/channel-link";
import { notify } from "@/platform/notifications/notify";
import { renderEmail } from "./templates/renderEmail";
import { shiftClearanceDigestContext, type ShiftClearanceDigestMember } from "./templates/clearance";
import { claimReminderDispatch, releaseReminderDispatch } from "./reminder-dispatch";
import { ROLE_LABEL } from "./shift-reminders";
import { log, errorAttrs } from "@/platform/logging";

const TEMPLATE_KEY = "shift-clearance-digest";
const MS_PER_DAY = 24 * 60 * 60 * 1000;

type Person = PersonNameParts & { id: string; name: string };
type DirectorPerson = { id: string; name: string; contactEmail: string | null; entraObjectId: string | null };

export type DigestAssignment = {
  role: ShiftRole;
  department: { id: string; code: string; name: string };
  person: Person;
};

export type DigestDirector = {
  department: { id: string; code: string; name: string };
  person: DirectorPerson;
};

export type PreparedShiftClearanceDigest = {
  director: DirectorPerson;
  /** Comma-joined names of the director's departments that have someone listed. */
  departmentNames: string;
  members: ShiftClearanceDigestMember[];
};

/**
 * Pure: turn one clinic day's assignments, the directors of each department,
 * and the clearance of everyone scheduled into one digest per director.
 *
 * A director in several departments gets ONE email spanning all of them. A
 * person scheduled in two of that director's departments is listed once per
 * department, since each department is separately short a cleared person.
 * Directors with nobody to report get nothing: an "all clear" email every
 * week would train people to ignore the one that matters.
 *
 * The director's own row is kept. Unlike the membership-wide digest, which
 * leaves a director out of their own list, a director who is scheduled and not
 * cleared is a gap in the shift like anyone else, and they are the one best
 * placed to fix it.
 */
export function buildShiftClearanceDigests(input: {
  assignments: DigestAssignment[];
  directors: DigestDirector[];
  clearance: Map<string, ClearanceSummary>;
}): PreparedShiftClearanceDigest[] {
  const unclearedByDept = new Map<string, { dept: DigestAssignment["department"]; rows: Array<{ person: Person } & ShiftClearanceDigestMember> }>();
  for (const a of input.assignments) {
    const summary = input.clearance.get(a.person.id);
    // Absent from the map means the clearance load never saw them; treat that as
    // unknown rather than uncleared so a loader bug cannot mass-flag a roster.
    if (!summary || summary.cleared) continue;
    const entry = unclearedByDept.get(a.department.id) ?? { dept: a.department, rows: [] };
    entry.rows.push({
      person: a.person,
      name: a.person.name,
      roleLabel: ROLE_LABEL[a.role],
      departmentName: a.department.name,
      missing: outstandingShortLabels(summary.missing),
    });
    unclearedByDept.set(a.department.id, entry);
  }

  const directorById = new Map<string, DirectorPerson>();
  const deptIdsByDirector = new Map<string, Set<string>>();
  for (const d of input.directors) {
    directorById.set(d.person.id, d.person);
    const set = deptIdsByDirector.get(d.person.id) ?? new Set<string>();
    set.add(d.department.id);
    deptIdsByDirector.set(d.person.id, set);
  }

  const out: PreparedShiftClearanceDigest[] = [];
  for (const [directorId, deptIds] of deptIdsByDirector) {
    const depts = [...deptIds]
      .map((id) => unclearedByDept.get(id))
      .filter((e): e is NonNullable<typeof e> => Boolean(e))
      .sort((a, b) => a.dept.code.localeCompare(b.dept.code));
    if (depts.length === 0) continue;

    const members: ShiftClearanceDigestMember[] = [];
    for (const d of depts) {
      const rows = [...d.rows].sort((a, b) => comparePersonName(a.person, b.person));
      for (const { person: _person, ...row } of rows) members.push(row);
    }

    out.push({
      director: directorById.get(directorId)!,
      departmentNames: depts.map((d) => d.dept.name).join(", "),
      members,
    });
  }
  return out;
}

export type ShiftClearanceDigestRunResult = {
  digestsSent: number;
  skipped: number;
  failed: number;
  /** Scheduled people found not cleared, across all departments. */
  unclearedOnShift: number;
};

/**
 * Wednesday digest run. Targets this week's clinic day, the same date the
 * Monday shift reminder uses, and evaluates clearance AS OF that date, so a
 * HIPAA certificate that lapses on Thursday is flagged now rather than after
 * the director has stopped looking.
 */
export async function runShiftClearanceDigests(now: Date = new Date()): Promise<ShiftClearanceDigestRunResult> {
  const result: ShiftClearanceDigestRunResult = { digestsSent: 0, skipped: 0, failed: 0, unclearedOnShift: 0 };

  const term = await getActiveTerm();
  if (!term) return result;

  const targetDate = selectCurrentClinicDate(term.clinicDates, now);
  if (!targetDate) return result;

  // This week's clinic only. selectCurrentClinicDate is unbounded, so on a break
  // week it returns a Saturday weeks away; without this bound directors would be
  // warned about a clinic they have no reason to think about yet. Compared by
  // UTC calendar day, since clinic dates are anchored at noon UTC.
  const nowDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const targetDay = Date.UTC(targetDate.getUTCFullYear(), targetDate.getUTCMonth(), targetDate.getUTCDate());
  if (Math.round((targetDay - nowDay) / MS_PER_DAY) > 6) return result;

  const targetKey = isoDateKey(targetDate);

  const rows = await prisma.shiftAssignment.findMany({
    where: { termId: term.id },
    select: {
      personId: true,
      departmentId: true,
      clinicDate: true,
      role: true,
      department: { select: { id: true, code: true, name: true } },
      person: {
        select: { id: true, name: true, legalFirstName: true, legalMiddleName: true, lastName: true, preferredFirstName: true },
      },
    },
  });
  const dated = rows.filter((r) => isoDateKey(r.clinicDate) === targetKey);
  if (dated.length === 0) return result;

  // Same rule as the shift reminder: only people still ACTIVE in the department
  // they are assigned to. A leftover assignment for someone offboarded is a
  // schedule-cleanup problem, not a clearance one, and they would read as
  // "not cleared" here because clearance is computed from active memberships.
  const memberships = await prisma.termMembership.findMany({
    where: { termId: term.id, status: "ACTIVE" },
    select: {
      personId: true,
      departmentId: true,
      kind: true,
      department: { select: { id: true, code: true, name: true } },
      person: { select: { id: true, name: true, contactEmail: true, entraObjectId: true, status: true } },
    },
  });
  const activeInDept = new Set(memberships.map((m) => `${m.personId}:${m.departmentId}`));
  const assignments: DigestAssignment[] = dated
    .filter((r) => activeInDept.has(`${r.personId}:${r.departmentId}`))
    .map((r) => ({ role: r.role, department: r.department, person: r.person }));
  if (assignments.length === 0) return result;

  const scheduledIds = [...new Set(assignments.map((a) => a.person.id))];
  const clearance = await loadClearanceMap(scheduledIds, term.id, targetDate);

  // Directors resolved from TermMembership kind DIRECTOR, like the weekly
  // clearance digest, so the two emails reach the same people.
  const scheduledDeptIds = new Set(assignments.map((a) => a.department.id));
  const directors: DigestDirector[] = memberships
    .filter((m) => m.kind === "DIRECTOR" && m.person.status === "ACTIVE" && scheduledDeptIds.has(m.departmentId))
    .map((m) => ({ department: m.department, person: m.person }));

  const prepared = buildShiftClearanceDigests({ assignments, directors, clearance });

  const seenUncleared = new Set<string>();
  for (const a of assignments) {
    const s = clearance.get(a.person.id);
    if (s && !s.cleared) seenUncleared.add(`${a.person.id}:${a.department.id}`);
  }
  result.unclearedOnShift = seenUncleared.size;

  const baseUrl = await getSetting<string>("app.baseUrl");
  const clinicDateLabel = formatCalendarDate(targetDate, CLINIC_DATE_LONG);
  const reviewUrl = `${baseUrl}/volunteers`;
  const scheduleUrl = `${baseUrl}/schedule/full`;

  for (const item of prepared) {
    const { director } = item;
    if (!director.contactEmail && !director.entraObjectId) {
      result.skipped++;
      continue;
    }

    // One digest per director per clinic day, so a re-fired or overlapping run
    // cannot double-send.
    if (!(await claimReminderDispatch(TEMPLATE_KEY, director.id, targetKey))) {
      result.skipped++;
      continue;
    }

    try {
      const rendered = await renderEmail(
        TEMPLATE_KEY,
        shiftClearanceDigestContext({
          directorName: director.name,
          departmentNames: item.departmentNames,
          clinicDateLabel,
          members: item.members,
          reviewUrl,
          scheduleUrl,
        }),
      );
      const n = item.members.length;
      await notify(prisma, {
        type: TEMPLATE_KEY,
        person: { id: director.id, entraObjectId: director.entraObjectId, contactEmail: director.contactEmail },
        email: { subject: rendered.subject, html: rendered.html },
        teams: {
          title: "Not cleared for this week's shift",
          summary: `${n} ${n === 1 ? "person" : "people"} scheduled in ${item.departmentNames} on ${clinicDateLabel} ${n === 1 ? "is" : "are"} not cleared.`,
          link: reviewUrl,
        },
      });
      result.digestsSent++;
    } catch (err) {
      // Release so a re-run can retry this director instead of the claim
      // silently suppressing them, and keep going for the rest.
      await releaseReminderDispatch(TEMPLATE_KEY, director.id, targetKey);
      result.failed++;
      log.error(
        `[shift-clearance-digest] Failed to send to director ${director.id}`,
        errorAttrs(err, { personId: director.id }),
      );
    }
  }

  return result;
}
