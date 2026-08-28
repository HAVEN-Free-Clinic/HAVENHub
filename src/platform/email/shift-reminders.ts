import type { ShiftRole } from "@prisma/client";
import { esc } from "@/platform/email/render/escape";
import { shiftReminderContext, ccReminderContext, triageReminderContext } from "./templates/shift";
import { prisma } from "@/platform/db";
import { getActiveTerm } from "@/platform/terms/active-term";
import { getSetting } from "@/platform/settings/service";
import { departmentAttendingsForDates } from "@/platform/attendings/coverage";
import { closedClinicDates } from "@/platform/attendings/open-clinic-date";
import { formatCalendarDate, isoDateKey } from "@/platform/dates";
import { firstNameOf } from "@/platform/person-name";
import { selectCurrentClinicDate, getCurrentClinicChannelLink } from "@/platform/teams/channel-link";
import { notify } from "@/platform/notifications/notify";
import { renderEmail } from "./templates/renderEmail";
import { claimReminderDispatch, releaseReminderDispatch } from "./reminder-dispatch";
import { log, errorAttrs } from "@/platform/logging";
import { captureEvent, flushEvents, GROUP_TERM } from "@/platform/posthog/capture";

export const ROLE_LABEL: Record<ShiftRole, string> = {
  DIRECTOR: "Director",
  VOLUNTEER: "Volunteer",
  SHADOW: "Shadow",
};

export type ReminderAssignment = {
  personId: string;
  role: ShiftRole;
  /**
   * Med-team tags on THIS assignment row (see ShiftAssignment). Only the two
   * that drive a supplemental reminder are carried; walkin/remote/specialty are
   * deliberately absent until ops asks for an email for one of them.
   */
  tags: { cc: boolean; triage: boolean };
  department: { id: string; code: string; name: string };
  person: { id: string; name: string; contactEmail: string | null; entraObjectId: string | null };
};

export type PreparedReminder = {
  person: ReminderAssignment["person"];
  context: Record<string, unknown>;
  teamsSummary: string;
};

export type BuildShiftRemindersInput = {
  /** ShiftAssignment rows already filtered to the target clinic date. */
  assignments: ReminderAssignment[];
  targetDate: Date;
  teamsChannelUrl: string;
  baseUrl: string;
  /**
   * Department id -> the attending(s) covering THAT department on this clinic
   * date, already formatted for the email. A department with no attending (or
   * one that maps to no schedule column) is simply absent, and its recipients
   * get no attending line at all.
   *
   * Per department rather than one clinic-wide string: the schedule is a single
   * grid with a column per team, and telling a behavioral health volunteer the
   * primary care attending's name is worse than telling them nothing.
   *
   * Resolved by the caller (ClinicDay + the slot-to-department mapping) rather
   * than derived from `assignments`: an attending is not a Person and holds no
   * ShiftAssignment, so unlike the EDs / Clinical Advisors / directors lists
   * there is nothing in the assignment rows to derive it from.
   */
  attendingNamesByDepartmentId: Record<string, string>;
  /**
   * Present when the clinic is CLOSED on `targetDate`; absent on a normal
   * Saturday. `note` is the recorded reason, routinely null.
   *
   * A closed Saturday used to stop this email dead. It no longer does:
   * departments still staff a closed date -- triage coverage is the case ops
   * named -- and the people they assign are exactly the people who need
   * reminding. What the closure changes is the WORDING: the reminder says the
   * clinic is shut, so the audit-14 failure it guarded against (volunteers told
   * to turn up to a cancelled clinic) cannot come back through the new door.
   */
  clinicClosed?: { note: string | null };
};

function uniqueNamesById(entries: { id: string; name: string }[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    names.push(entry.name);
  }
  return names;
}

/**
 * Clinic-wide leadership on shift, derived from the assignment rows: EDs are
 * whoever is scheduled in EXEC, Clinical Advisors whoever is scheduled in PCAR.
 * Shared by the main reminder and the role reminders so the two emails can
 * never name a different set of people for the same clinic day.
 */
function onShiftLeadership(assignments: ReminderAssignment[]): {
  edsOnShift: string[];
  clinicalAdvisorsOnShift: string[];
} {
  return {
    edsOnShift: uniqueNamesById(
      assignments.filter((a) => a.department.code === "EXEC").map((a) => a.person),
    ),
    clinicalAdvisorsOnShift: uniqueNamesById(
      assignments.filter((a) => a.department.code === "PCAR").map((a) => a.person),
    ),
  };
}

/**
 * Pure: turn one clinic day's assignments into one prepared reminder per
 * scheduled person. Leadership lists (EDs from EXEC, Clinical Advisors from
 * PCAR, department directors) are derived from the same assignment rows. A
 * person with multiple same-day shifts gets one reminder: the shift whose
 * department code sorts last (descending) drives the headline, the rest
 * render in additionalShifts. Sorting (rather than input order) keeps the
 * choice deterministic regardless of the order the caller passes assignments.
 */
export function buildShiftReminders(input: BuildShiftRemindersInput): PreparedReminder[] {
  const { assignments, targetDate, teamsChannelUrl, baseUrl, attendingNamesByDepartmentId, clinicClosed } = input;

  const clinicDateLabel = formatCalendarDate(targetDate, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const hipaaComplianceUrl = `${baseUrl}/my-info`;
  const shiftSwapUrl = `${baseUrl}/schedule`;
  const masterScheduleUrl = `${baseUrl}/schedule/full`;
  // Epic problems now go through the Hub's own IT ticketing. This used to be a
  // hardcoded Airtable form, so those tickets never entered the system built to
  // track them. Built from baseUrl like every other link here, rather than a
  // literal host, so it follows the deployment.
  const helpDeskUrl = `${baseUrl}/support/new`;

  // Raw HTML like additionalShifts, and empty on an ordinary Saturday, so the
  // template needs no {{#if}} around it.
  //
  // Leads with the closure and names the concrete consequence (no check-in),
  // because "you are scheduled" and "the clinic is shut" read as a
  // contradiction otherwise, and the member has no other way to tell which one
  // to believe. Falling back to "no reason was recorded" rather than omitting
  // the sentence: an unexplained closure is still worth saying out loud.
  const closedNotice = clinicClosed
    ? `<p><strong>Note: the clinic is closed on ${esc(clinicDateLabel)}.</strong> ${
        clinicClosed.note ? esc(clinicClosed.note) : "No reason was recorded."
      } You are still on the schedule for that day, and there is no clinic-day check-in. If you are not sure whether to come in, ask your department director before Saturday.</p>`
    : "";

  const { edsOnShift, clinicalAdvisorsOnShift } = onShiftLeadership(assignments);

  const directorsByDeptCode = new Map<string, { id: string; name: string }[]>();
  for (const a of assignments) {
    if (a.role !== "DIRECTOR") continue;
    const list = directorsByDeptCode.get(a.department.code) ?? [];
    list.push({ id: a.person.id, name: a.person.name });
    directorsByDeptCode.set(a.department.code, list);
  }

  const byPerson = new Map<string, ReminderAssignment[]>();
  for (const a of assignments) {
    const list = byPerson.get(a.personId) ?? [];
    list.push(a);
    byPerson.set(a.personId, list);
  }

  const prepared: PreparedReminder[] = [];
  for (const personAssignments of byPerson.values()) {
    const sorted = [...personAssignments].sort((a, b) =>
      a.department.code > b.department.code ? -1 : a.department.code < b.department.code ? 1 : 0,
    );
    const primary = sorted[0];
    const person = primary.person;
    const extras = sorted.slice(1);

    const additionalShifts = extras.length
      ? `<p>You are also scheduled for ${extras
          .map((a) => `a <strong>${ROLE_LABEL[a.role]}</strong> Shift in the <strong>${esc(a.department.name)}</strong> department`)
          .join(", and ")}.</p>`
      : "";

    // "Your department director(s) on shift" is guidance for volunteers and
    // shadows about who is leading their shift. A director recipient does not
    // need it (they are themselves a director on shift), so only populate the
    // list when the recipient has no director shift that day.
    const recipientIsDirector = sorted.some((a) => a.role === "DIRECTOR");
    const deptDirectorsOnShift: string[] = [];
    if (!recipientIsDirector) {
      const seenDirectorIds = new Set<string>();
      for (const a of sorted) {
        const dirs = directorsByDeptCode.get(a.department.code) ?? [];
        for (const dir of dirs) {
          if (dir.id === person.id) continue;
          if (seenDirectorIds.has(dir.id)) continue;
          seenDirectorIds.add(dir.id);
          deptDirectorsOnShift.push(dir.name);
        }
      }
    }

    prepared.push({
      person,
      teamsSummary: `You are scheduled for a ${ROLE_LABEL[primary.role]} shift in ${primary.department.name} this ${clinicDateLabel}.${
        clinicClosed ? " Note that the clinic is closed that day." : ""
      }`,
      context: shiftReminderContext({
        firstName: firstNameOf(person.name),
        roleLabel: ROLE_LABEL[primary.role],
        departmentName: primary.department.name,
        clinicDateLabel,
        additionalShifts,
        closedNotice,
        edsOnShift: edsOnShift.join(", "),
        deptDirectorsOnShift: deptDirectorsOnShift.join(", "),
        clinicalAdvisorsOnShift: clinicalAdvisorsOnShift.join(", "),
        // The headline shift's department, matching departmentName above, so
        // the attending named is the one covering the shift the email leads
        // with rather than an arbitrary one of the recipient's teams.
        attendingOnShift: attendingNamesByDepartmentId[primary.department.id] ?? "",
        teamsChannelUrl,
        hipaaComplianceUrl,
        helpDeskUrl,
        shiftSwapUrl,
        masterScheduleUrl,
      }),
    });
  }

  prepared.sort((a, b) => a.person.name.localeCompare(b.person.name));
  return prepared;
}

/**
 * The supplemental role reminders: one extra email to the person holding a
 * special med-team post that clinic day, sent alongside the reminder everyone
 * else gets.
 *
 * BOTH the department code and the tag must match. `rolesForDept` scopes cc to
 * JCTP and triage to SCTP, so a tag left set on a row in some other department
 * is stale data rather than a recipient, and must not trigger an email.
 *
 * `templateKey` doubles as the notification-registry key and the dedup claim
 * kind. Keeping them one string is what guarantees the EmailLog lookup, the
 * ReminderDispatch claim, and the admin channel setting all describe the same
 * email; splitting them invites a claim that guards nothing.
 *
 * Ops asked for these two only. Adding walkin, remote or specialty later is a
 * descriptor plus a registry key plus one row here, with no change to the loop.
 */
export type RoleReminderSpec = {
  tag: "cc" | "triage";
  deptCode: string;
  templateKey: string;
  /** Human label for the Teams summary and logs. */
  roleLabel: string;
  context: (input: RoleReminderContextInput) => Record<string, unknown>;
};

type RoleReminderContextInput = {
  firstName: string;
  clinicDateLabel: string;
  baseUrl: string;
  edsOnShift: string;
  clinicalAdvisorsOnShift: string;
  attendingOnShift: string;
};

export const ROLE_REMINDERS: RoleReminderSpec[] = [
  {
    tag: "cc",
    deptCode: "JCTP",
    templateKey: "shift-reminder-cc",
    roleLabel: "cc JCTM",
    context: (i) =>
      ccReminderContext({
        firstName: i.firstName,
        clinicDateLabel: i.clinicDateLabel,
        helpDeskUrl: `${i.baseUrl}/support/new`,
      }),
  },
  {
    tag: "triage",
    deptCode: "SCTP",
    templateKey: "shift-reminder-triage",
    roleLabel: "Triage SCTM",
    context: (i) =>
      triageReminderContext({
        firstName: i.firstName,
        clinicDateLabel: i.clinicDateLabel,
        edsOnShift: i.edsOnShift,
        clinicalAdvisorsOnShift: i.clinicalAdvisorsOnShift,
        // The attending covering the triage department itself, not a
        // clinic-wide pick: this is the person the triage SCTM actually works
        // with, and an unstaffed column collapses to "" so the template hides
        // the clause rather than printing a dangling "and , the on-call attending".
        attendingOnShift: i.attendingOnShift,
        masterScheduleUrl: `${i.baseUrl}/schedule/full`,
      }),
  },
];

export type PreparedRoleReminder = {
  person: ReminderAssignment["person"];
  spec: RoleReminderSpec;
  context: Record<string, unknown>;
  teamsSummary: string;
};

/**
 * Pure: the supplemental role reminders for one clinic day. Takes the same
 * input as buildShiftReminders, so every filter the caller has already applied
 * (active term, this week only, open clinic date, still-active membership)
 * covers these emails too and cannot drift out of step with the main reminder.
 *
 * A person holding two posts across two shifts gets one email per post. The
 * (term, department, date, person) uniqueness on ShiftAssignment means no
 * person can match one spec twice, so no dedup pass is needed here.
 */
export function buildRoleReminders(input: BuildShiftRemindersInput): PreparedRoleReminder[] {
  const { assignments, targetDate, baseUrl, attendingNamesByDepartmentId } = input;

  const clinicDateLabel = formatCalendarDate(targetDate, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const { edsOnShift, clinicalAdvisorsOnShift } = onShiftLeadership(assignments);

  const prepared: PreparedRoleReminder[] = [];
  for (const spec of ROLE_REMINDERS) {
    for (const a of assignments) {
      if (a.department.code !== spec.deptCode) continue;
      if (!a.tags[spec.tag]) continue;
      prepared.push({
        person: a.person,
        spec,
        teamsSummary: `You are the ${spec.roleLabel} for HAVEN clinic on ${clinicDateLabel}.`,
        context: spec.context({
          firstName: firstNameOf(a.person.name),
          clinicDateLabel,
          baseUrl,
          edsOnShift: edsOnShift.join(", "),
          clinicalAdvisorsOnShift: clinicalAdvisorsOnShift.join(", "),
          attendingOnShift: attendingNamesByDepartmentId[a.department.id] ?? "",
        }),
      });
    }
  }

  prepared.sort(
    (a, b) =>
      a.person.name.localeCompare(b.person.name) || a.spec.templateKey.localeCompare(b.spec.templateKey),
  );
  return prepared;
}

export type ShiftReminderRunResult = {
  remindersSent: number;
  skipped: number;
  roleRemindersSent: number;
  roleRemindersSkipped: number;
};

/**
 * Weekly shift reminders. Sent Monday mornings to everyone scheduled for the
 * upcoming Saturday clinic day. Enqueue-only: notify() writes the EmailLog /
 * Teams / inbox rows and the per-minute /api/cron/email tick delivers them.
 */
export async function runShiftReminders(now: Date = new Date()): Promise<ShiftReminderRunResult> {
  const result: ShiftReminderRunResult = { remindersSent: 0, skipped: 0, roleRemindersSent: 0, roleRemindersSkipped: 0 };

  const term = await getActiveTerm();
  if (!term) return result;

  // Same date selection as the Teams channel link, so the email date and the
  // linked channel always agree.
  const targetDate = selectCurrentClinicDate(term.clinicDates, now);
  if (!targetDate) return result;

  // Only remind for THIS week's clinic. selectCurrentClinicDate returns the next
  // clinic date on or after `now` with no upper bound, so on a break week it would
  // point at a future Saturday and, because the dedup window is shorter than the
  // weekly cadence, re-send every Monday until that week arrives. Bail when the next
  // clinic is more than 6 days out. Compare by UTC calendar day (clinic dates are
  // anchored at noon UTC), never by raw timestamp.
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const nowDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const targetDay = Date.UTC(targetDate.getUTCFullYear(), targetDate.getUTCMonth(), targetDate.getUTCDate());
  if (Math.round((targetDay - nowDay) / MS_PER_DAY) > 6) return result;

  const targetKey = isoDateKey(targetDate);

  // A CLOSED Saturday no longer stops the run. This used to bail outright (audit
  // 14, CLINIC-01 / SCHED-4, on the reasoning that reminding volunteers to turn
  // up to a cancelled clinic is worse than sending nothing) -- but ops schedule
  // departments onto closed dates on purpose, to cover triage, and those are the
  // people this email exists for. The audit's concern is met by the wording
  // instead: `clinicClosed` below puts the closure at the top of the email.
  //
  // Recipients are still assignment-driven, so a genuinely dead Saturday with
  // nobody scheduled sends nothing, exactly as before.
  const closures = await closedClinicDates(term.id);
  const clinicClosed = closures.has(targetKey) ? { note: closures.get(targetKey) ?? null } : undefined;

  // Load the term's assignments and filter to the target clinic date by UTC day
  // key (never compare clinicDate by raw timestamp).
  const rows = await prisma.shiftAssignment.findMany({
    where: { termId: term.id },
    select: {
      personId: true,
      departmentId: true,
      clinicDate: true,
      role: true,
      cc: true,
      triage: true,
      department: { select: { id: true, code: true, name: true } },
      person: { select: { id: true, name: true, contactEmail: true, entraObjectId: true } },
    },
  });
  const dated = rows.filter((r) => isoDateKey(r.clinicDate) === targetKey);
  if (dated.length === 0) return result;

  // Only remind people who are STILL active in the department they're assigned to.
  // Offboarding flips Person.status and REMOVES the membership, but a leftover
  // future assignment can survive until a director clears it -- without this filter
  // the cron would email an offboarded person "you're scheduled Saturday" (and list
  // them as on-shift leadership to everyone). Keyed on (person, department) so a
  // single-department removal is caught too, not just a full offboard.
  const activeMemberships = await prisma.termMembership.findMany({
    where: { termId: term.id, status: "ACTIVE", personId: { in: [...new Set(dated.map((r) => r.personId))] } },
    select: { personId: true, departmentId: true },
  });
  const activeInDept = new Set(activeMemberships.map((m) => `${m.personId}:${m.departmentId}`));
  const assignments: ReminderAssignment[] = dated
    .filter((r) => activeInDept.has(`${r.personId}:${r.departmentId}`))
    .map((r) => ({
      personId: r.personId,
      role: r.role,
      tags: { cc: r.cc, triage: r.triage },
      department: r.department,
      person: r.person,
    }));
  if (assignments.length === 0) return result;

  const channelLink = await getCurrentClinicChannelLink({ now });
  const teamsChannelUrl = channelLink?.webUrl ?? "";
  const baseUrl = await getSetting<string>("app.baseUrl");

  // The attending covering each department scheduled today.
  //
  // Per department rather than one clinic-wide list: the schedule is a single
  // grid with a column per team, and departmentAttendingsForDates resolves a
  // department to its columns through ClinicSlot.departmentId plus one hop of
  // DepartmentDelegation. Only the departments actually on shift are resolved.
  //
  // A closed date, no assignment, an unmapped department, and a deactivated
  // attending all collapse to an absent entry, which buildShiftReminders turns
  // into "" and the template's {{#if}} hides rather than printing an empty line.
  const scheduledDepartmentIds = [...new Set(assignments.map((a) => a.department.id))];
  const attendingNamesByDepartmentId: Record<string, string> = {};
  await Promise.all(
    scheduledDepartmentIds.map(async (departmentId) => {
      const byDate = await departmentAttendingsForDates(term.id, [targetDate], departmentId);
      const names = (byDate.get(targetKey) ?? [])
        .map((a) => `${a.name} (${a.slotLabel})`)
        .join(", ");
      if (names) attendingNamesByDepartmentId[departmentId] = names;
    }),
  );

  const prepared = buildShiftReminders({
    assignments,
    targetDate,
    teamsChannelUrl,
    baseUrl,
    attendingNamesByDepartmentId,
    clinicClosed,
  });

  // Idempotency: skip anyone already sent a shift-reminder within the last 6
  // days, which scopes to the current clinic week so a re-fired Monday cron
  // cannot double-send. Relies on the default email channel writing an EmailLog
  // row (the shipping config). An admin who switches this type to Teams-only
  // would weaken this guard; revisit with a dedicated marker if that is done.
  const cutoff = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);

  for (const item of prepared) {
    if (!item.person.contactEmail) {
      result.skipped++;
      continue;
    }

    const already = await prisma.emailLog.findFirst({
      where: { personId: item.person.id, template: "shift-reminder", createdAt: { gte: cutoff } },
      select: { id: true },
    });
    if (already) {
      result.skipped++;
      continue;
    }

    // Atomic per-clinic-week claim: even if two Monday runs overlap and both pass
    // the EmailLog check above (no row written yet), only one wins this insert, so
    // no volunteer is double-reminded for the same Saturday. Also covers the
    // Teams-only case the EmailLog guard misses.
    const claimed = await claimReminderDispatch("shift-reminder", item.person.id, targetKey);
    if (!claimed) {
      result.skipped++;
      continue;
    }

    try {
      const rendered = await renderEmail("shift-reminder", item.context);
      await notify(prisma, {
        type: "shift-reminder",
        person: {
          id: item.person.id,
          entraObjectId: item.person.entraObjectId,
          contactEmail: item.person.contactEmail,
        },
        email: { subject: rendered.subject, html: rendered.html },
        teams: { title: "Shift reminder", summary: item.teamsSummary, link: `${baseUrl}/schedule` },
      });
      result.remindersSent++;
      // Per-recipient engagement event; flush once after the batch.
      await captureEvent({
        event: "shift_reminder_sent",
        distinctId: item.person.id,
        properties: { target_date: targetKey },
        groups: { [GROUP_TERM]: term.id },
        flush: false,
      });
    } catch (err) {
      // Per-recipient isolation: a single failed render/notify must not abort the
      // rest of the weekly batch. Release the claim (taken before the enqueue) so a
      // re-run can retry this person instead of the claim silently suppressing them,
      // then log and continue.
      await releaseReminderDispatch("shift-reminder", item.person.id, targetKey);
      log.error(
        `[shift-reminders] Failed to remind person ${item.person.id}`,
        errorAttrs(err, { personId: item.person.id }),
      );
    }
  }

  // The supplemental role reminders. Deliberately a second pass over the SAME
  // prepared inputs rather than extra sections of the loop above: each carries
  // its own claim and its own EmailLog window, so a cc or triage email that
  // fails to render cannot cost that person the reminder everybody gets, and an
  // admin switching one off leaves the other untouched.
  //
  // These carry no closure notice of their own, on purpose. Every recipient
  // here also gets the main reminder above, which leads with it -- and the
  // triage post is exactly the one a department staffs on a closed Saturday, so
  // its prep email is wanted unchanged.
  const preparedRoles = buildRoleReminders({
    assignments,
    targetDate,
    teamsChannelUrl,
    baseUrl,
    attendingNamesByDepartmentId,
  });

  for (const item of preparedRoles) {
    if (!item.person.contactEmail) {
      result.roleRemindersSkipped++;
      continue;
    }

    const already = await prisma.emailLog.findFirst({
      where: { personId: item.person.id, template: item.spec.templateKey, createdAt: { gte: cutoff } },
      select: { id: true },
    });
    if (already) {
      result.roleRemindersSkipped++;
      continue;
    }

    const claimed = await claimReminderDispatch(item.spec.templateKey, item.person.id, targetKey);
    if (!claimed) {
      result.roleRemindersSkipped++;
      continue;
    }

    try {
      const rendered = await renderEmail(item.spec.templateKey, item.context);
      await notify(prisma, {
        type: item.spec.templateKey,
        person: {
          id: item.person.id,
          entraObjectId: item.person.entraObjectId,
          contactEmail: item.person.contactEmail,
        },
        email: { subject: rendered.subject, html: rendered.html },
        teams: { title: `${item.spec.roleLabel} reminder`, summary: item.teamsSummary, link: `${baseUrl}/schedule` },
      });
      result.roleRemindersSent++;
      await captureEvent({
        event: "role_reminder_sent",
        distinctId: item.person.id,
        properties: { target_date: targetKey, role: item.spec.roleLabel, template: item.spec.templateKey },
        groups: { [GROUP_TERM]: term.id },
        flush: false,
      });
    } catch (err) {
      await releaseReminderDispatch(item.spec.templateKey, item.person.id, targetKey);
      log.error(
        `[shift-reminders] Failed to send ${item.spec.templateKey} to person ${item.person.id}`,
        errorAttrs(err, { personId: item.person.id, template: item.spec.templateKey }),
      );
    }
  }

  if (result.remindersSent > 0 || result.roleRemindersSent > 0) await flushEvents();
  return result;
}
