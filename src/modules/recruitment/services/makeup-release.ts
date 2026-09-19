/**
 * Releasing the online makeup training, and chasing it afterwards.
 *
 * Release does two things at once, on purpose: the course becomes visible to
 * the people who owe it, and they are told so. Split apart, the hub would
 * either show a course nobody has been told about or promise one that is not
 * there, and the day this matters most is the week after a training session
 * when ops are already chasing people by hand.
 *
 * Three audiences, one email (see recruitment.makeup_training):
 *
 *   - Members whose absence was unexcused: the reprimand paragraph.
 *   - Members with an excuse on file: the neutral one.
 *   - Accepted applicants with no contract submitted: they have no Person at
 *     all, because promotion is what creates it, so the course link would go
 *     nowhere. They are told to do the contract first. They cannot be chased
 *     afterwards by this stream for the same reason -- there is no Training row
 *     to stamp -- so the contract chase is what carries them until they are
 *     promoted, at which point promotion's recompute puts them in the roster
 *     half above.
 *
 * Mock clinic rides in the same email rather than one of its own. It is not
 * something they can finish online (their director arranges it, IT marks it
 * off), but leaving it out is how somebody finishes the course and believes
 * they are done.
 */
import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { queueEmail } from "@/platform/email/send";
import { recordAudit } from "@/platform/audit";
import { log, errorAttrs } from "@/platform/logging";
import { formatDueDate, formatTrainingDate } from "../training-date";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { getSetting } from "@/platform/settings/service";
import { applicantFirstName, firstNameOf } from "@/platform/person-name";
import { renderResolvedEmail, resolveCycleEmail, type EmailSources } from "../email/render";
import { RecruitmentAuthError } from "./review";
import { TrainingStateError } from "./training";

/** How often the follow-up goes out. Ops asked for no cap: it stops when they
 *  finish, which is the only stopping condition anyone wanted. */
const REMINDER_INTERVAL_DAYS = 3;

export type MakeupReleaseState = {
  releasedAt: Date | null;
  dueAt: Date | null;
  /** The linked course, and whether it is ready to be taken (active, with a
   *  video on every section). Release refuses without a ready one. */
  course: { id: string; title: string; ready: boolean } | null;
  owesMorning: number;
  owesMockClinic: number;
  /** Accepted applicants with no contract yet who missed the morning: they are
   *  emailed at release and then carried by the contract chase. */
  notOnboarded: number;
  emailed: number;
};

/** What the Training tab's release card shows. */
export async function getMakeupReleaseState(cycleId: string): Promise<MakeupReleaseState> {
  const cycle = await prisma.recruitmentCycle.findUnique({
    where: { id: cycleId },
    select: { id: true, termId: true, track: true, makeupReleasedAt: true, makeupDueAt: true },
  });
  if (!cycle) throw new TrainingStateError("Cycle not found.");

  const [course, rows, notOnboarded] = await Promise.all([
    prisma.course.findUnique({
      where: { makeupForCycleId: cycleId },
      select: { id: true, title: true, isActive: true, videoReady: true },
    }),
    prisma.training.findMany({
      where: { termId: cycle.termId, track: cycle.track },
      select: { morningStatus: true, mockClinicStatus: true, makeupEmailedAt: true },
    }),
    countAcceptedAbsentees(cycleId),
  ]);

  return {
    releasedAt: cycle.makeupReleasedAt,
    dueAt: cycle.makeupDueAt,
    course: course ? { id: course.id, title: course.title, ready: course.isActive && course.videoReady } : null,
    owesMorning: rows.filter((r) => r.morningStatus === "OWED").length,
    owesMockClinic: rows.filter((r) => r.mockClinicStatus === "OWED").length,
    notOnboarded,
    emailed: rows.filter((r) => r.makeupEmailedAt !== null).length,
  };
}

/** Accepted applicants of the cycle with no submitted contract who were not
 *  checked in at the morning session. Keyed on the address, like every other
 *  reader of a pre-promotion attendance row. */
async function acceptedAbsentees(cycleId: string) {
  const acceptances = await prisma.acceptance.findMany({
    where: { application: { cycleId }, contract: { is: { submittedAt: null } } },
    select: {
      contract: { select: { token: true, email: true, firstName: true, preferredFirstName: true } },
      application: {
        select: { applicant: { select: { firstName: true, emailLower: true, email: true } } },
      },
    },
  });
  if (acceptances.length === 0) return [];

  const emails = acceptances.map((a) => a.application.applicant.emailLower);
  const attended = await prisma.eventAttendance.findMany({
    where: { attendeeEmail: { in: emails }, event: { cycleId, kind: "TRAINING" } },
    select: { attendeeEmail: true },
  });
  const came = new Set(attended.flatMap((a) => (a.attendeeEmail ? [a.attendeeEmail] : [])));

  // One row per person, not per acceptance: a dual-department acceptance is two
  // rows and one human, and two identical emails is how a mailbox learns to
  // ignore this address.
  const byEmail = new Map<string, { email: string; firstName: string; token: string | null }>();
  for (const a of acceptances) {
    const applicant = a.application.applicant;
    if (came.has(applicant.emailLower)) continue;
    if (byEmail.has(applicant.emailLower)) continue;
    byEmail.set(applicant.emailLower, {
      email: a.contract?.email ?? applicant.email,
      firstName: (a.contract ? applicantFirstName(a.contract) : applicant.firstName) || "there",
      token: a.contract?.token ?? null,
    });
  }
  return [...byEmail.values()];
}

async function countAcceptedAbsentees(cycleId: string): Promise<number> {
  return (await acceptedAbsentees(cycleId)).length;
}

/** Set the date the makeup is due (or clear it). Quoted in the emails and on
 *  the member's training page. Requires manage_cycles. */
export async function setMakeupDueDate(cycleId: string, dueAt: Date | null, actorId: string): Promise<void> {
  if (!(await can(actorId, "recruitment.manage_cycles"))) {
    throw new RecruitmentAuthError("Only recruitment leads can set the makeup due date.");
  }
  await prisma.recruitmentCycle.update({ where: { id: cycleId }, data: { makeupDueAt: dueAt } });
  await recordAudit({
    actorPersonId: actorId,
    action: "recruitment.makeup_due_date",
    entityType: "RecruitmentCycle",
    entityId: cycleId,
    after: { makeupDueAt: dueAt },
  });
}

/**
 * Release the makeup training: show the course and send the email.
 *
 * Refuses without a ready course, which is the whole point of the gate: an
 * email that links to an empty course costs more than waiting a day for the
 * video to finish uploading.
 *
 * Re-running is safe and is how somebody who onboarded late gets their copy:
 * each send claims its row by stamping makeupEmailedAt inside the same
 * transaction, so a second run reaches only the people the first could not.
 */
export async function releaseMakeupTraining(
  cycleId: string,
  actorId: string,
): Promise<{ sent: number; notOnboarded: number; skipped: number }> {
  if (!(await can(actorId, "recruitment.manage_cycles"))) {
    throw new RecruitmentAuthError("Only recruitment leads can release the makeup training.");
  }
  const cycle = await prisma.recruitmentCycle.findUnique({
    where: { id: cycleId },
    select: { id: true, title: true, termId: true, track: true, makeupReleasedAt: true, makeupDueAt: true, inPersonTrainingDate: true },
  });
  if (!cycle) throw new TrainingStateError("Cycle not found.");

  const course = await prisma.course.findUnique({
    where: { makeupForCycleId: cycleId },
    select: { id: true, isActive: true, videoReady: true },
  });
  if (!course || !course.isActive || !course.videoReady) {
    throw new TrainingStateError(
      "This cycle has no online makeup course ready yet. Upload the videos and their quiz questions in Learning, then release.",
    );
  }

  const [zone, baseUrl, sources] = await Promise.all([
    getDisplayTimeZone(),
    getSetting<string>("app.baseUrl"),
    resolveCycleEmail(cycleId, "recruitment.makeup_training"),
  ]);
  const courseUrl = `${baseUrl}/learning/${course.id}`;
  const dueDate = cycle.makeupDueAt ? formatDueDate(cycle.makeupDueAt, zone) : "";
  const trainingDate = cycle.inPersonTrainingDate ? formatTrainingDate(cycle.inPersonTrainingDate, zone) : "";

  // Mark the cycle released FIRST. The member page reads this flag, so a send
  // that fails halfway still leaves the course reachable for everyone it did
  // email, rather than linking them to a page that refuses them.
  if (!cycle.makeupReleasedAt) {
    await prisma.recruitmentCycle.update({ where: { id: cycleId }, data: { makeupReleasedAt: new Date() } });
  }

  const owing = await prisma.training.findMany({
    where: {
      termId: cycle.termId,
      track: cycle.track,
      makeupEmailedAt: null,
      OR: [{ morningStatus: "OWED" }, { mockClinicStatus: "OWED" }],
    },
    select: {
      id: true,
      morningStatus: true,
      mockClinicStatus: true,
      person: { select: { id: true, name: true, legalFirstName: true, lastName: true, preferredFirstName: true, contactEmail: true } },
    },
  });

  // One query for the excuses rather than one per person: which paragraph they
  // read turns on it, and both keys have to be asked for (see
  // resolveApplicantExcuseKeys).
  const excused = await excusedKeys(cycleId, owing.map((r) => r.person.id));

  let sent = 0;
  let skipped = 0;
  for (const row of owing) {
    const to = row.person.contactEmail;
    if (!to) {
      skipped += 1;
      continue;
    }
    const email = renderResolvedEmail(sources, {
      firstName: firstNameOf(row.person) || "there",
      cycleTitle: cycle.title,
      courseUrl,
      contractUrl: "",
      dueDate,
      trainingDate,
      unexcused: row.morningStatus === "OWED" && !excused.has(row.person.id),
      owesMorning: row.morningStatus === "OWED",
      owesMockClinic: row.mockClinicStatus === "OWED",
      needsContract: false,
    });
    const claimed = await claimAndQueue(row.id, to, email, "recruitment.makeup_training");
    if (claimed) sent += 1;
  }

  // The people with no hub account yet. Nothing to stamp, so they are emailed
  // once per release run rather than once ever; releasing twice in a day is
  // not a thing anyone does, and the alternative is never telling them at all.
  const absentees = await acceptedAbsentees(cycleId);
  for (const person of absentees) {
    try {
      const email = renderResolvedEmail(sources, {
        firstName: person.firstName,
        cycleTitle: cycle.title,
        courseUrl,
        contractUrl: person.token ? `${baseUrl}/onboard/${person.token}` : "",
        dueDate,
        trainingDate,
        unexcused: false,
        owesMorning: true,
        owesMockClinic: false,
        needsContract: true,
      });
      await prisma.$transaction(async (tx) => {
        await queueEmail(tx, { to: person.email, subject: email.subject, html: email.html, template: "recruitment.makeup_training" });
      });
    } catch (err) {
      log.error("[makeup] release email failed", errorAttrs(err, { cycleId, to: person.email }));
    }
  }

  await recordAudit({
    actorPersonId: actorId,
    action: "recruitment.makeup_release",
    entityType: "RecruitmentCycle",
    entityId: cycleId,
    after: { sent, notOnboarded: absentees.length, skipped },
  });
  return { sent, notOnboarded: absentees.length, skipped };
}

/** Person ids with an excuse on file for the cycle, under either key. */
async function excusedKeys(cycleId: string, personIds: string[]): Promise<Set<string>> {
  if (personIds.length === 0) return new Set();
  const [rows, people] = await Promise.all([
    prisma.trainingAbsenceExcuse.findMany({ where: { cycleId }, select: { personId: true, emailLower: true } }),
    prisma.person.findMany({ where: { id: { in: personIds } }, select: { id: true, contactEmail: true } }),
  ]);
  const byPerson = new Set(rows.flatMap((r) => (r.personId ? [r.personId] : [])));
  const byEmail = new Set(rows.flatMap((r) => (r.emailLower ? [r.emailLower] : [])));
  for (const p of people) {
    if (p.contactEmail && byEmail.has(p.contactEmail.toLowerCase())) byPerson.add(p.id);
  }
  return byPerson;
}

/** Stamp the row and queue the email in one transaction, so two runs (or a
 *  release racing the cron) cannot both send. Returns false when another run
 *  claimed it first. */
async function claimAndQueue(
  trainingId: string,
  to: string,
  email: { subject: string; html: string },
  template: string,
  /** The reminder stream passes its interval cutoff: the claim must re-assert
   *  the same condition the query selected on, so two passes cannot both send.
   *  Written as an explicit OR with `null` because Prisma's `not` does NOT
   *  match NULL rows -- a first reminder, whose last-sent is null, would claim
   *  nothing at all. */
  opts: { reminderCutoff?: Date } = {},
): Promise<boolean> {
  const cutoff = opts.reminderCutoff;
  try {
    return await prisma.$transaction(async (tx) => {
      const now = new Date();
      const claimed = await tx.training.updateMany({
        where: cutoff
          ? {
              id: trainingId,
              OR: [{ makeupNudgeLastSentAt: null }, { makeupNudgeLastSentAt: { lt: cutoff } }],
            }
          : { id: trainingId, makeupEmailedAt: null },
        data: cutoff
          ? { makeupNudgeLastSentAt: now, makeupNudgeCount: { increment: 1 } }
          : { makeupEmailedAt: now },
      });
      if (claimed.count !== 1) return false;
      await queueEmail(tx, { to, subject: email.subject, html: email.html, template });
      return true;
    });
  } catch (err) {
    log.error("[makeup] email failed", errorAttrs(err, { trainingId, to }));
    return false;
  }
}

/**
 * The follow-up pass, on the daily reminders cron.
 *
 * Chases whatever is still owed, every REMINDER_INTERVAL_DAYS days, with no
 * cap: it stops when the parts stop being OWED, which is the only end ops
 * wanted. Only released cycles, and only people the release already emailed --
 * a reminder must never be somebody's first word on the subject.
 */
export async function runMakeupReminders(): Promise<{ sent: number; skipped: number }> {
  const cycles = await prisma.recruitmentCycle.findMany({
    where: { isTermTraining: true, makeupReleasedAt: { not: null }, term: { status: { in: ["ACTIVE", "PLANNING"] } } },
    select: { id: true, title: true, termId: true, track: true, makeupDueAt: true },
  });
  if (cycles.length === 0) return { sent: 0, skipped: 0 };

  const now = new Date();
  const cutoff = new Date(now.getTime() - REMINDER_INTERVAL_DAYS * 86_400_000);
  const [zone, baseUrl] = await Promise.all([getDisplayTimeZone(), getSetting<string>("app.baseUrl")]);

  let sent = 0;
  let skipped = 0;
  for (const cycle of cycles) {
    const course = await prisma.course.findUnique({
      where: { makeupForCycleId: cycle.id },
      select: { id: true, isActive: true, videoReady: true },
    });
    if (!course || !course.isActive || !course.videoReady) {
      skipped += 1;
      continue;
    }
    const due = await prisma.training.findMany({
      where: {
        termId: cycle.termId,
        track: cycle.track,
        makeupEmailedAt: { not: null },
        OR: [{ morningStatus: "OWED" }, { mockClinicStatus: "OWED" }],
        AND: [{ OR: [{ makeupNudgeLastSentAt: null }, { makeupNudgeLastSentAt: { lt: cutoff } }] }],
      },
      select: {
        id: true,
        morningStatus: true,
        mockClinicStatus: true,
        makeupEmailedAt: true,
        person: { select: { name: true, legalFirstName: true, lastName: true, preferredFirstName: true, contactEmail: true } },
      },
    });
    if (due.length === 0) continue;

    // The first reminder must not land the same day as the release email.
    const ready = due.filter((r) => !r.makeupEmailedAt || r.makeupEmailedAt < cutoff);
    if (ready.length === 0) continue;

    const sources = await resolveCycleEmail(cycle.id, "recruitment.makeup_reminder");
    const dueDate = cycle.makeupDueAt ? formatDueDate(cycle.makeupDueAt, zone) : "";
    const overdue = cycle.makeupDueAt !== null && cycle.makeupDueAt < now;
    for (const row of ready) {
      const to = row.person.contactEmail;
      if (!to) {
        skipped += 1;
        continue;
      }
      const email = renderResolvedEmail(sources, {
        firstName: firstNameOf(row.person) || "there",
        cycleTitle: cycle.title,
        courseUrl: `${baseUrl}/learning/${course.id}`,
        contractUrl: "",
        dueDate,
        overdue,
        owesMorning: row.morningStatus === "OWED",
        owesMockClinic: row.mockClinicStatus === "OWED",
        needsContract: false,
      });
      if (await claimAndQueue(row.id, to, email, "recruitment.makeup_reminder", { reminderCutoff: cutoff })) sent += 1;
    }
  }
  return { sent, skipped };
}

export type { EmailSources };
