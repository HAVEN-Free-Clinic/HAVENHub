/**
 * Sample applicants for a recruitment test run.
 *
 * Fills a test run with 20 made-up applicants so the team can practice review,
 * scoring, routing and decisions without first applying 20 times themselves.
 * Each one answers the test run's actual form, so what reviewers see is what a
 * real application to this cycle would look like.
 *
 * WHO THEY ARE. Famous names, chosen so nobody mistakes one for a real
 * applicant, with a mix of new, returning (renewal) and transfer applicants,
 * different departments, languages, and some optional questions left blank.
 * Returning and transfer applicants are only made when the cycle accepts them.
 *
 * WHAT IS LEFT OUT ON PURPOSE.
 * - No NetID and no link to a real person. A NetID is how applicant history and
 *   the roster find someone, and a made-up one could match a real volunteer.
 * - No file uploads or signatures; nothing real to attach.
 *
 * EMAIL. Every address is on SAMPLE_EMAIL_DOMAIN, which can never receive mail.
 * When the test run has a preview inbox (setTestPreviewEmail), the email queue
 * delivers each sample applicant's email there instead, marked with who it was
 * for, so the team sees exactly what applicants get. Without one, the emails
 * are kept in the email log as "Not sent (sample)". Nobody else is emailed.
 */
import type { ApplicantType, FieldType, Prisma } from "@prisma/client";
import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { recordAudit } from "@/platform/audit";
import { queueEmail } from "@/platform/email/send";
import { isDeliverableAddress, SAMPLE_EMAIL_DOMAIN } from "@/platform/email/address";
import { LANGUAGES_FIELD_KEY, languageCodeFromAnswer } from "@/platform/languages/catalog";
import { answersForConditions, isFieldVisible, mergeDepartmentAnswer } from "../engine/field-visibility";
import { isSectionVisible } from "../engine/visibility";
import { renderCycleEmail } from "../email/render";

export const SAMPLE_APPLICANT_COUNT = 20;

export class SampleApplicantsError extends Error {}

// Roster

type SampleProfile = {
  first: string;
  last: string;
  preferred?: string;
  /** Wanted type; falls back to NEW when the cycle takes no returning applicants. */
  type: ApplicantType;
};

const PROFILES: SampleProfile[] = [
  { first: "Beyoncé", last: "Knowles", type: "NEW" },
  { first: "Taylor", last: "Swift", type: "NEW" },
  { first: "Serena", last: "Williams", type: "NEW" },
  { first: "Lin-Manuel", last: "Miranda", type: "RENEWAL" },
  { first: "Zendaya", last: "Coleman", type: "NEW" },
  { first: "Keanu", last: "Reeves", type: "NEW" },
  { first: "Simone", last: "Biles", type: "TRANSFER" },
  { first: "Pedro", last: "Pascal", type: "NEW" },
  { first: "Robyn", last: "Fenty", preferred: "Rihanna", type: "RENEWAL" },
  { first: "Benito", last: "Martínez", preferred: "Benny", type: "NEW" },
  { first: "Dolly", last: "Parton", type: "NEW" },
  { first: "Oprah", last: "Winfrey", type: "NEW" },
  { first: "Shakira", last: "Mebarak", type: "NEW" },
  { first: "Lionel", last: "Messi", type: "RENEWAL" },
  { first: "Ariana", last: "Grande", type: "NEW" },
  { first: "Harry", last: "Styles", type: "TRANSFER" },
  { first: "Viola", last: "Davis", type: "NEW" },
  { first: "Selena", last: "Gomez", type: "RENEWAL" },
  { first: "Mindy", last: "Kaling", type: "NEW" },
  { first: "Timothée", last: "Chalamet", type: "NEW" },
];

const LONG_ANSWERS = [
  "I want to spend time with patients who have a hard time getting care anywhere else. I volunteered at a food pantry for two years and saw how often people skipped seeing a doctor because of cost.",
  "I'm interested in how clinics run day to day. I like organizing things, and I'd love to help make a visit go smoothly for patients and for the team.",
  "Mostly I want to learn. I'm hoping to go to medical school, and I'd like real experience talking with patients before I apply.",
  "I grew up translating at appointments for my grandparents, so I know how much it matters when someone explains things in your own language.",
  "I've worked as an EMT for a year and want to keep using those skills in a setting where I can follow patients a little longer.",
  "I care a lot about public health, and a student-run clinic seems like the best place to see what access to care actually looks like in New Haven.",
  "A friend volunteered last year and said it was the most meaningful thing she did at Yale. I want to be part of a team like the one she described.",
  "I like solving problems under time pressure and working with people from different backgrounds. I think I'd be steady on a busy clinic night.",
  "I'm a nursing student and want more practice with intake, vitals and patient education outside of class.",
  "Honestly, I want to be useful. I have Saturday mornings free all semester and would rather spend them here than anywhere else.",
];

const SCHOOLS = ["Yale College", "Yale School of Medicine", "Yale School of Nursing", "Yale School of Public Health", "Yale PA Program"];
const YEARS = ["1st year", "2nd year", "3rd year", "4th year"];
const MAJORS = ["Biology", "Neuroscience", "Global Health", "Psychology", "Chemistry", "Economics", "History"];

// Helpers

function asciiSlug(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * A sample applicant's address. The short code from the test run's id keeps
 * the same famous name in two test runs from sharing an address, which is how
 * the email queue finds the right test run's preview inbox.
 */
export function sampleEmail(p: { first: string; last: string }, cycleId: string): string {
  return `${asciiSlug(p.first)}.${asciiSlug(p.last)}.${cycleId.slice(-6).toLowerCase()}@${SAMPLE_EMAIL_DOMAIN}`;
}

type Choice = { value: string; label: string };
function choicesOf(options: unknown): Choice[] {
  if (!Array.isArray(options)) return [];
  return options.filter(
    (o): o is Choice => !!o && typeof o === "object" && typeof (o as Choice).value === "string",
  );
}

type FieldRow = {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  options: unknown;
  validation: unknown;
  visibleWhen: unknown;
};

/** A plausible answer for one field, or undefined to leave it blank. */
function answerFor(
  field: FieldRow,
  i: number,
  p: SampleProfile,
  email: string,
  deptChoice: string | undefined,
): unknown {
  // Every fourth applicant skips the optional questions, like real people do.
  const skipOptional = !field.required && i % 4 === 3;

  switch (field.key) {
    case "first_name": return p.first;
    case "last_name": return p.last;
    case "preferred_first_name": return p.preferred;
    case "email": return email;
    case "phone": return `203-555-01${String(i).padStart(2, "0")}`;
    case "net_id": return undefined;
  }

  const label = field.label.toLowerCase();
  const choices = choicesOf(field.options);
  switch (field.type) {
    case "SHORT_TEXT":
      if (skipOptional) return undefined;
      if (label.includes("school") || label.includes("program")) return SCHOOLS[i % SCHOOLS.length];
      if (label.includes("year")) return YEARS[i % YEARS.length];
      if (label.includes("major") || label.includes("concentration")) return MAJORS[i % MAJORS.length];
      if (label.includes("pronoun")) return ["she/her", "he/him", "they/them"][i % 3];
      return `Sample answer from ${p.preferred ?? p.first}`;
    case "LONG_TEXT":
      if (skipOptional) return undefined;
      return LONG_ANSWERS[(i + field.key.length) % LONG_ANSWERS.length];
    case "EMAIL":
      return email;
    case "PHONE":
      return `203-555-01${String(i).padStart(2, "0")}`;
    case "NUMBER": {
      if (skipOptional) return undefined;
      const v = (field.validation ?? {}) as { min?: number; max?: number };
      const lo = v.min ?? 1;
      const hi = v.max ?? lo + 9;
      return String(lo + (i % (hi - lo + 1)));
    }
    case "DATE": {
      if (skipOptional) return undefined;
      const d = new Date(Date.UTC(2027, 0, 10 + i));
      return d.toISOString().slice(0, 10);
    }
    case "CHECKBOX":
    case "NOTICE":
      return field.required || !skipOptional ? true : undefined;
    case "SINGLE_SELECT":
      if (choices.length === 0 || skipOptional) return undefined;
      return choices[i % choices.length].value;
    case "MULTI_SELECT": {
      if (choices.length === 0) return undefined;
      // Languages: about half speak none besides English, the rest one or two.
      if (field.key === LANGUAGES_FIELD_KEY) {
        if (i % 2 === 0) return undefined;
        const picks = [choices[i % choices.length].value];
        if (i % 3 === 0) picks.push(choices[(i + 5) % choices.length].value);
        return [...new Set(picks)];
      }
      if (skipOptional) return undefined;
      const n = 1 + (i % Math.min(3, choices.length));
      return Array.from({ length: n }, (_, k) => choices[(i + k) % choices.length].value).filter(
        (v, k, a) => a.indexOf(v) === k,
      );
    }
    case "DEPARTMENT_CHOICE":
      return deptChoice;
    // Nothing real to attach or sign; the ranking is stored on the application.
    case "FILE":
    case "SIGNATURE":
    case "SUBCOMMITTEE_RANK":
      return undefined;
  }
  return undefined;
}

// Service

/**
 * Add the 20 sample applicants to a test run. Refuses anything that is not a
 * test run, and refuses a second fill so the same people are never added twice.
 * Returns how many were added.
 */
export async function addSampleApplicants(cycleId: string, actorId: string): Promise<number> {
  if (!(await can(actorId, "recruitment.manage_cycles"))) {
    throw new SampleApplicantsError("Only recruitment leads can add sample applicants.");
  }
  const cycle = await prisma.recruitmentCycle.findUnique({
    where: { id: cycleId },
    include: {
      sections: {
        where: { purpose: "APPLICATION" },
        orderBy: { order: "asc" },
        include: { fields: { orderBy: { order: "asc" } } },
      },
    },
  });
  if (!cycle) throw new SampleApplicantsError("Cycle not found.");
  if (!cycle.isTest) {
    throw new SampleApplicantsError("Sample applicants can only be added to a test run, never to a real cycle.");
  }
  if (cycle.status === "ARCHIVED") throw new SampleApplicantsError("This test run is archived.");
  const already = await prisma.applicant.count({
    where: { cycleId, emailLower: { endsWith: `@${SAMPLE_EMAIL_DOMAIN}` } },
  });
  if (already > 0) throw new SampleApplicantsError("This test run already has its sample applicants.");
  if (cycle.departments.length === 0) {
    throw new SampleApplicantsError("Add at least one department to the real cycle first.");
  }

  const depts = cycle.departments;
  const autoRoute = new Set(
    (
      await prisma.department.findMany({
        where: { code: { in: depts }, autoRouteApplicants: true },
        select: { code: true },
      })
    ).map((d) => d.code),
  );
  const activeSubcommittees = (
    await prisma.subcommittee.findMany({ where: { isActive: true }, select: { id: true }, orderBy: { id: "asc" } })
  ).map((s) => s.id);

  const deptField = cycle.sections.flatMap((s) => s.fields).find((f) => f.type === "DEPARTMENT_CHOICE");
  const now = Date.now();

  const rows = PROFILES.map((p, i) => {
    // Returning and transfer applicants only when the cycle takes them, and a
    // transfer needs a second department to be coming from.
    let type: ApplicantType = cycle.acceptsRenewals ? p.type : "NEW";
    if (type === "TRANSFER" && depts.length < 2) type = "NEW";

    const first = depts[i % depts.length];
    const departmentChoices =
      type === "RENEWAL" || cycle.track === "VOLUNTEER"
        ? [first]
        : Array.from({ length: Math.min(3, depts.length) }, (_, k) => depts[(i + k) % depts.length]);
    const transferFromDepartments = type === "TRANSFER" ? [depts[(i + 1) % depts.length]] : [];
    const email = sampleEmail(p, cycleId);

    // Build answers section by section, then drop any answer whose question
    // would have been hidden from this applicant.
    const ctx = { applicantType: type, selectedDepartmentCodes: departmentChoices };
    const fields = cycle.sections.filter((s) => isSectionVisible(s, ctx)).flatMap((s) => s.fields);
    const answers: Record<string, unknown> = {};
    for (const f of fields) {
      const a = answerFor(f, i, p, email, type === "RENEWAL" ? undefined : first);
      if (a !== undefined) answers[f.key] = a;
    }
    const forConditions = mergeDepartmentAnswer(answersForConditions(answers), deptField?.key, departmentChoices);
    const visible = fields.filter((f) => isFieldVisible(f.visibleWhen, forConditions));
    for (const f of fields) if (!visible.includes(f)) delete answers[f.key];

    const rankField = visible.find((f) => f.type === "SUBCOMMITTEE_RANK");
    const rankCount = (rankField?.validation as { rankCount?: number } | null)?.rankCount ?? 3;
    const subcommitteeRanking =
      rankField && activeSubcommittees.length > 0
        ? Array.from({ length: Math.min(rankCount, activeSubcommittees.length) }, (_, k) =>
            activeSubcommittees[(i + k) % activeSubcommittees.length])
        : [];

    const langRaw = answers[LANGUAGES_FIELD_KEY];
    const languagesClaimed = Array.isArray(langRaw)
      ? [...new Set(langRaw.map((v) => languageCodeFromAnswer(String(v))).filter((c): c is string => c !== null))]
      : [];

    // Same routing a real submission gets: a volunteer renewal goes back to its
    // department, and a first choice that auto-routes skips the committee.
    const routedDepartmentCode =
      cycle.track === "VOLUNTEER"
        ? type === "RENEWAL" ? first : autoRoute.has(first) ? first : null
        : null;

    return {
      p,
      email,
      phone: `203-555-01${String(i).padStart(2, "0")}`,
      // Spread over the last few days so the queue has a believable order.
      submittedAt: new Date(now - (PROFILES.length - i) * 3 * 60 * 60 * 1000),
      app: {
        answers: answers as Prisma.InputJsonValue,
        applicantType: type,
        departmentChoices,
        renewalDepartment: type === "RENEWAL" ? first : null,
        transferFromDepartments,
        subcommitteeRanking,
        languagesClaimed,
        ...(routedDepartmentCode ? { routedDepartmentCode, routedAt: new Date() } : {}),
        status: "SUBMITTED" as const,
      },
    };
  });

  await prisma.$transaction(
    async (tx) => {
      for (const r of rows) {
        const applicant = await tx.applicant.create({
          data: {
            cycleId,
            firstName: r.p.first,
            lastName: r.p.last,
            preferredFirstName: r.p.preferred ?? null,
            email: r.email,
            emailLower: r.email.toLowerCase(),
            phone: r.phone,
          },
        });
        await tx.application.create({
          data: { cycleId, applicantId: applicant.id, submittedAt: r.submittedAt, ...r.app },
        });
        // The same confirmation a real applicant gets. It is recorded as not
        // sent (sample address), so the team can read it in the email log.
        const received = await renderCycleEmail(cycleId, "recruitment.application_received", {
          firstName: r.p.preferred ?? r.p.first,
          cycleTitle: cycle.title,
        });
        await queueEmail(tx, {
          to: r.email,
          subject: received.subject,
          html: received.html,
          template: "recruitment.application_received",
        });
      }
    },
    { timeout: 60_000 },
  );

  await recordAudit({
    actorPersonId: actorId,
    action: "recruitment.test_cycle_samples",
    entityType: "RecruitmentCycle",
    entityId: cycleId,
    after: { count: rows.length },
  });
  return rows.length;
}

/**
 * Set the inbox that receives this test run's sample applicants' emails, or
 * clear it with a blank value. Applies to emails queued from now on.
 */
export async function setTestPreviewEmail(cycleId: string, raw: string | null, actorId: string): Promise<void> {
  if (!(await can(actorId, "recruitment.manage_cycles"))) {
    throw new SampleApplicantsError("Only recruitment leads can change where sample emails go.");
  }
  const cycle = await prisma.recruitmentCycle.findUnique({
    where: { id: cycleId },
    select: { isTest: true, testPreviewEmail: true },
  });
  if (!cycle) throw new SampleApplicantsError("Cycle not found.");
  if (!cycle.isTest) throw new SampleApplicantsError("Only a test run has sample applicants.");
  const email = raw?.trim() || null;
  if (email && !isDeliverableAddress(email)) {
    throw new SampleApplicantsError("Enter a full email address, like you@yale.edu.");
  }
  if (email === cycle.testPreviewEmail) return;
  await prisma.recruitmentCycle.update({ where: { id: cycleId }, data: { testPreviewEmail: email } });
  await recordAudit({
    actorPersonId: actorId,
    action: "recruitment.test_cycle_preview_email",
    entityType: "RecruitmentCycle",
    entityId: cycleId,
    before: { testPreviewEmail: cycle.testPreviewEmail },
    after: { testPreviewEmail: email },
  });
}
