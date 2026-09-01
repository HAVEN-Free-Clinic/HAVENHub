import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/platform/db";
import { getCycle } from "./cycles";
import { getApplication } from "./submissions";

/** A term whose clinic calendar deliberately disagrees with its Saturdays: one
 *  Saturday is missing (a break), one weekday is present (a special clinic), and
 *  one Saturday is on the calendar but closed. Any loader still deriving options
 *  from the term window will fail these, and so will any loader reading
 *  Term.clinicDates without joining ClinicDay. */
const TERM_START = new Date("2026-06-01T12:00:00.000Z");
const TERM_END = new Date("2026-06-30T12:00:00.000Z");
const CLOSED_DATE = new Date("2026-06-20T12:00:00.000Z"); // Saturday, declared closed
const CLINIC_DATES = [
  new Date("2026-06-06T12:00:00.000Z"), // Saturday
  new Date("2026-06-10T12:00:00.000Z"), // Wednesday, never a "term Saturday"
  CLOSED_DATE,
];
// 2026-06-13 and 2026-06-27 are Saturdays the admin removed.

let termId = "";
let cycleId = "";
let applicationId = "";
let personId = "";

beforeAll(async () => {
  const term = await prisma.term.create({
    data: { code: "LOADT1", name: "Loader Test", startDate: TERM_START, endDate: TERM_END, clinicDates: CLINIC_DATES },
  });
  termId = term.id;

  // Closure is a flag on ClinicDay, not a removal from Term.clinicDates: the
  // date stays on the calendar and the schedule renders it as shut. The
  // application must not offer it.
  await prisma.clinicDay.create({
    data: { termId, clinicDate: CLOSED_DATE, isClosed: true, closedNote: "HAVEN FREE CLINIC CLOSED" },
  });

  // RecruitmentCycle.createdById is a required relation to Person.
  const person = await prisma.person.create({
    data: { name: "Loader Test Creator", contactEmail: "loader-creator@example.com", status: "ACTIVE" },
  });
  personId = person.id;

  const cycle = await prisma.recruitmentCycle.create({
    data: {
      track: "VOLUNTEER", termId, title: "Loader Test Cycle", publicSlug: "loader-test-cycle",
      departments: [], acceptsRenewals: false, status: "OPEN", createdById: person.id,
      sections: { create: { title: "Availability", order: 0, appliesTo: "BOTH", purpose: "APPLICATION" } },
    },
    include: { sections: true },
  });
  cycleId = cycle.id;

  await prisma.formField.create({
    data: {
      sectionId: cycle.sections[0].id, cycleId, key: "availability", label: "Clinic dates",
      type: "MULTI_SELECT", required: true, order: 0,
      // A deliberately stale snapshot, as a real seeded cycle would carry.
      options: [{ value: "2026-06-27", label: "Jun 27" }],
    },
  });

  // firstName and lastName are required on Applicant; emailLower must equal
  // lower(email) to satisfy the (cycleId, emailLower) dedup unique.
  const applicant = await prisma.applicant.create({
    data: { cycleId, firstName: "Loader", lastName: "Test", email: "loader@example.com", emailLower: "loader@example.com" },
  });
  const application = await prisma.application.create({
    data: {
      applicantId: applicant.id, cycleId, applicantType: "NEW", status: "SUBMITTED",
      answers: { availability: ["2026-06-06"] },
    },
  });
  applicationId = application.id;
});

afterAll(async () => {
  await prisma.application.deleteMany({ where: { cycleId } });
  await prisma.applicant.deleteMany({ where: { cycleId } });
  await prisma.formField.deleteMany({ where: { cycleId } });
  await prisma.formSection.deleteMany({ where: { cycleId } });
  await prisma.recruitmentCycle.deleteMany({ where: { id: cycleId } });
  // ClinicDay.term is onDelete: Restrict, so this has to go before the term.
  await prisma.clinicDay.deleteMany({ where: { termId } });
  await prisma.term.deleteMany({ where: { id: termId } });
  await prisma.person.deleteMany({ where: { id: personId } });
});

const availabilityOptions = (sections: { fields: { key: string; options: unknown }[] }[]) =>
  sections.flatMap((s) => s.fields).find((f) => f.key === "availability")?.options;

// 2026-06-20 is on the calendar but closed, so it is absent here.
const EXPECTED = [
  { value: "2026-06-06", label: "Sat, Jun 6" },
  { value: "2026-06-10", label: "Wed, Jun 10" },
];

describe("every cycle-form loader resolves availability from Term.clinicDates", () => {
  it("getCycle (form builder and ApplyPreview)", async () => {
    const cycle = await getCycle(cycleId);
    expect(availabilityOptions(cycle!.sections)).toEqual(EXPECTED);
  });

  it("getApplication (reviewer display)", async () => {
    const app = await getApplication(applicationId);
    expect(availabilityOptions(app!.cycle.sections)).toEqual(EXPECTED);
  });

  it("never offers a date the clinic has been closed on", async () => {
    const cycle = await getCycle(cycleId);
    const app = await getApplication(applicationId);
    for (const options of [availabilityOptions(cycle!.sections), availabilityOptions(app!.cycle.sections)]) {
      expect((options as { value: string }[]).map((o) => o.value)).not.toContain("2026-06-20");
    }
  });
});
