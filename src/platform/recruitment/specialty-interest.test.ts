import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  classifySpecialtyAnswer,
  specialtyInterestByApplication,
  specialtyInterestByMember,
  specialtyInterestForPerson,
} from "./specialty-interest";

// The FA26 options, verbatim.
const OPTIONS = [
  { label: "No (only primary care)", value: "option_1" },
  { label: "Yes (BOTH primary care and specialty clinic)", value: "option_2" },
  { label: "Yes (I ONLY want to do specialty clinic)", value: "option_3" },
];
const LABEL = "Are you interested in a specialty clinic (neurology, nephrology, or dermatology)?";

describe("classifySpecialtyAnswer (pure)", () => {
  it("reads the three FA26 answers", () => {
    expect(classifySpecialtyAnswer(OPTIONS[0].label)).toMatchObject({ interested: false, only: false });
    expect(classifySpecialtyAnswer(OPTIONS[1].label)).toMatchObject({ interested: true, only: false });
    expect(classifySpecialtyAnswer(OPTIONS[2].label)).toMatchObject({ interested: true, only: true });
  });
});

async function seed() {
  const term = await prisma.term.create({
    data: { code: "FA26", name: "Fall 2026", startDate: new Date("2026-08-01"), endDate: new Date("2026-12-31"), status: "ACTIVE" },
  });
  const otherTerm = await prisma.term.create({
    data: { code: "SP26", name: "Spring 2026", startDate: new Date("2026-01-01"), endDate: new Date("2026-05-31"), status: "ARCHIVED" },
  });
  await prisma.department.create({ data: { code: "SCTP", name: "Senior Clinical Team" } });
  const srr = await prisma.person.create({ data: { name: "SRR", status: "ACTIVE" } });
  const cycle = await prisma.recruitmentCycle.create({
    data: { track: "VOLUNTEER", termId: term.id, title: "Fall", publicSlug: "fa26", departments: ["SCTP"], createdById: srr.id, status: "OPEN" },
  });
  // Two copies of the question under different derived keys, as FA26 has.
  for (const [order, key] of [[1, "single_checkbox_2"], [2, "dropdown_one_2"]] as const) {
    const section = await prisma.formSection.create({ data: { cycleId: cycle.id, title: `Section ${order}`, order } });
    await prisma.formField.create({
      data: { sectionId: section.id, cycleId: cycle.id, key, label: LABEL, type: "SINGLE_SELECT", options: OPTIONS, order: 1 },
    });
  }
  const oldCycle = await prisma.recruitmentCycle.create({
    data: { track: "VOLUNTEER", termId: otherTerm.id, title: "Spring", publicSlug: "sp26", departments: ["SCTP"], createdById: srr.id, status: "CLOSED" },
  });
  return { term, srr, cycle, oldCycle };
}

async function seedApp(opts: {
  cycleId: string;
  srrId: string;
  name: string;
  answers: Record<string, unknown>;
  applicantPersonId?: string;
  promotedPersonId?: string;
}) {
  const email = `${opts.name.toLowerCase()}@yale.edu`;
  const applicant = await prisma.applicant.create({
    data: { cycleId: opts.cycleId, firstName: opts.name, lastName: "X", email, emailLower: email, applicantPersonId: opts.applicantPersonId ?? null },
  });
  const application = await prisma.application.create({
    data: { cycleId: opts.cycleId, applicantId: applicant.id, answers: opts.answers as object, departmentChoices: ["SCTP"], status: "SUBMITTED" },
  });
  const acceptance = await prisma.acceptance.create({
    data: { applicationId: application.id, departmentCode: "SCTP", approvedById: opts.srrId },
  });
  if (opts.promotedPersonId) {
    await prisma.onboardingContract.create({
      data: {
        acceptanceId: acceptance.id, token: `t-${acceptance.id}`, status: "PROMOTED",
        firstName: opts.name, lastName: "X", email, promotedPersonId: opts.promotedPersonId,
      },
    });
  }
  return application;
}

beforeEach(async () => {
  await resetDb();
});

describe("specialtyInterestByApplication", () => {
  it("matches either copy of the question by label and maps the option value to its label", async () => {
    const { srr, cycle, oldCycle } = await seed();
    const both = await seedApp({ cycleId: cycle.id, srrId: srr.id, name: "Both", answers: { single_checkbox_2: "option_2" } });
    const only = await seedApp({ cycleId: cycle.id, srrId: srr.id, name: "Only", answers: { dropdown_one_2: "option_3" } });
    const no = await seedApp({ cycleId: cycle.id, srrId: srr.id, name: "No", answers: { single_checkbox_2: "option_1" } });
    const blank = await seedApp({ cycleId: cycle.id, srrId: srr.id, name: "Blank", answers: { single_checkbox_2: "" } });
    const unasked = await seedApp({ cycleId: oldCycle.id, srrId: srr.id, name: "Old", answers: { single_checkbox_2: "option_2" } });

    const out = await specialtyInterestByApplication([both.id, only.id, no.id, blank.id, unasked.id]);
    expect(out.get(both.id)).toEqual({ answer: OPTIONS[1].label, interested: true, only: false });
    expect(out.get(only.id)).toEqual({ answer: OPTIONS[2].label, interested: true, only: true });
    expect(out.get(no.id)).toEqual({ answer: OPTIONS[0].label, interested: false, only: false });
    expect(out.has(blank.id)).toBe(false);
    // The spring cycle never asked, so a stray key with the same name means nothing.
    expect(out.has(unasked.id)).toBe(false);
  });
});

describe("specialtyInterestByMember", () => {
  it("reads a promoted member's application back, keyed by kind", async () => {
    const { term, srr, cycle } = await seed();
    const person = await prisma.person.create({ data: { name: "Pat", status: "ACTIVE" } });
    await seedApp({ cycleId: cycle.id, srrId: srr.id, name: "Pat", answers: { dropdown_one_2: "option_2" }, promotedPersonId: person.id });

    const out = await specialtyInterestByMember({ termId: term.id, departmentCode: "SCTP", personIds: [person.id] });
    expect(out.get(`${person.id}:VOLUNTEER`)?.answer).toBe(OPTIONS[1].label);
    expect(await specialtyInterestByMember({ termId: term.id, departmentCode: "PCAR", personIds: [person.id] })).toEqual(new Map());
  });
});

describe("specialtyInterestForPerson", () => {
  it("finds the term's application through promotion or the signed-in applicant link", async () => {
    const { term, srr, cycle } = await seed();
    const promoted = await prisma.person.create({ data: { name: "Promoted", status: "ACTIVE" } });
    const renewing = await prisma.person.create({ data: { name: "Renewing", status: "ACTIVE" } });
    const nobody = await prisma.person.create({ data: { name: "Nobody", status: "ACTIVE" } });
    await seedApp({ cycleId: cycle.id, srrId: srr.id, name: "Promoted", answers: { single_checkbox_2: "option_3" }, promotedPersonId: promoted.id });
    await seedApp({ cycleId: cycle.id, srrId: srr.id, name: "Renewing", answers: { single_checkbox_2: "option_1" }, applicantPersonId: renewing.id });

    expect((await specialtyInterestForPerson({ personId: promoted.id, termId: term.id }))?.only).toBe(true);
    expect((await specialtyInterestForPerson({ personId: renewing.id, termId: term.id }))?.interested).toBe(false);
    expect(await specialtyInterestForPerson({ personId: nobody.id, termId: term.id })).toBeNull();
  });
});
