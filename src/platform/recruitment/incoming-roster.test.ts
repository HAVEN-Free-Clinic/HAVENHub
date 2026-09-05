/**
 * Tests for the incoming-roster read layer.
 *
 * The parser cases moved here from promotion.test.ts when the parser did: it is
 * now shared with the schedule builder, and the point of the sharing is that both
 * readers of an application's availability answer agree, so the guarantees are
 * tested next to the one implementation rather than at one of the two call sites.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  applicationAvailabilityDates,
  findIncomingMember,
  listIncomingMembers,
  parseAvailabilityDates,
} from "./incoming-roster";

/** Noon-UTC anchored calendar date, matching how the schema stores clinicDate. */
function clinicDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
}

const CLINIC_DATES = [clinicDate(2026, 9, 5), clinicDate(2026, 9, 12), clinicDate(2026, 9, 19)];

describe("parseAvailabilityDates (pure)", () => {
  it("parses YYYY-MM-DD values to UTC-midnight dates", () => {
    expect(parseAvailabilityDates(["2026-05-30", "2026-06-06"]).map((d) => d.toISOString()))
      .toEqual(["2026-05-30T00:00:00.000Z", "2026-06-06T00:00:00.000Z"]);
  });
  it("accepts a single scalar string (one MULTI_SELECT checkbox)", () => {
    expect(parseAvailabilityDates("2026-05-30").map((d) => d.toISOString())).toEqual(["2026-05-30T00:00:00.000Z"]);
  });
  it("dedupes and drops malformed / non-string / empty values", () => {
    expect(parseAvailabilityDates(["2026-05-30", "2026-05-30", "not-a-date", "", "2026-13-99", 42, null]).map((d) => d.toISOString()))
      .toEqual(["2026-05-30T00:00:00.000Z"]);
  });
  it("returns [] for missing/empty answers", () => {
    expect(parseAvailabilityDates(undefined)).toEqual([]);
    expect(parseAvailabilityDates(null)).toEqual([]);
    expect(parseAvailabilityDates("")).toEqual([]);
    expect(parseAvailabilityDates([])).toEqual([]);
  });
});

describe("applicationAvailabilityDates (pure)", () => {
  // Clinic dates are noon UTC and parsed availability is midnight UTC, so this
  // can only work on the day key. A raw timestamp compare would drop everything.
  it("keeps answers that fall on a clinic day, comparing by UTC day key", () => {
    expect(
      applicationAvailabilityDates({ availability: ["2026-09-05", "2026-09-19"] }, CLINIC_DATES)
        .map((d) => d.toISOString()),
    ).toEqual(["2026-09-05T00:00:00.000Z", "2026-09-19T00:00:00.000Z"]);
  });

  // An application submitted before availability options were sourced from the
  // clinic calendar can carry dates that are not clinic days at all.
  it("drops an answered date that is not a clinic day of the term", () => {
    expect(applicationAvailabilityDates({ availability: ["2026-09-06"] }, CLINIC_DATES)).toEqual([]);
  });

  it("returns [] when the answer is missing entirely", () => {
    expect(applicationAvailabilityDates({}, CLINIC_DATES)).toEqual([]);
    expect(applicationAvailabilityDates(null, CLINIC_DATES)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function seed() {
  const term = await prisma.term.create({
    data: {
      code: "FA26",
      name: "Fall 2026",
      startDate: new Date("2026-08-01"),
      endDate: new Date("2026-12-31"),
      status: "PLANNING",
      clinicDates: CLINIC_DATES,
    },
  });
  const dept = await prisma.department.create({ data: { code: "SRHD", name: "SRHD" } });
  const other = await prisma.department.create({ data: { code: "PCAR", name: "Primary Care" } });
  const srr = await prisma.person.create({ data: { name: "SRR", status: "ACTIVE" } });
  const cycle = await prisma.recruitmentCycle.create({
    data: {
      track: "VOLUNTEER",
      termId: term.id,
      title: "Fall volunteers",
      publicSlug: "fa26-vol",
      departments: ["SRHD", "PCAR"],
      createdById: srr.id,
      status: "OPEN",
    },
  });
  return { term, dept, other, srr, cycle };
}

type ApplicantOpts = {
  cycleId: string;
  approvedById: string;
  name: string;
  departmentCode?: string;
  personId?: string;
  availability?: string[];
  applicationStatus?: "SUBMITTED" | "WITHDRAWN";
  contractStatus?: "PENDING" | "SUBMITTED" | "PROMOTED";
  accepted?: boolean;
};

async function seedApplicant(opts: ApplicantOpts) {
  const email = `${opts.name.replace(/\s+/g, ".").toLowerCase()}@yale.edu`;
  const [firstName, lastName] = opts.name.split(" ");
  const applicant = await prisma.applicant.create({
    data: {
      cycleId: opts.cycleId,
      firstName,
      lastName: lastName ?? "",
      email,
      emailLower: email,
      applicantPersonId: opts.personId ?? null,
    },
  });
  const application = await prisma.application.create({
    data: {
      cycleId: opts.cycleId,
      applicantId: applicant.id,
      answers: opts.availability ? { availability: opts.availability } : {},
      departmentChoices: [opts.departmentCode ?? "SRHD"],
      status: opts.applicationStatus ?? "SUBMITTED",
    },
  });
  if (opts.accepted === false) return { applicant, application, acceptance: null };
  const acceptance = await prisma.acceptance.create({
    data: {
      applicationId: application.id,
      departmentCode: opts.departmentCode ?? "SRHD",
      approvedById: opts.approvedById,
    },
  });
  if (opts.contractStatus) {
    await prisma.onboardingContract.create({
      data: {
        acceptanceId: acceptance.id,
        token: `t-${acceptance.id}`,
        status: opts.contractStatus,
        firstName,
        lastName: lastName ?? "",
        email,
      },
    });
  }
  return { applicant, application, acceptance };
}

beforeEach(async () => {
  await resetDb();
});

// ---------------------------------------------------------------------------
// listIncomingMembers
// ---------------------------------------------------------------------------

describe("listIncomingMembers", () => {
  it("returns an accepted applicant with their availability narrowed to the clinic calendar", async () => {
    const { term, srr, cycle } = await seed();
    await seedApplicant({
      cycleId: cycle.id,
      approvedById: srr.id,
      name: "Ada Lovelace",
      // 2026-09-06 is a Sunday, not on the term calendar: a stale option from a
      // cycle built before the calendar was finalized.
      availability: ["2026-09-05", "2026-09-06", "2026-09-19"],
    });

    const rows = await listIncomingMembers({
      termId: term.id,
      departmentCode: "SRHD",
      clinicDates: CLINIC_DATES,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Ada Lovelace");
    expect(rows[0].kind).toBe("VOLUNTEER");
    expect(rows[0].stage).toBe("ACCEPTED");
    expect(rows[0].availabilityDates.map((d) => d.toISOString())).toEqual([
      "2026-09-05T00:00:00.000Z",
      "2026-09-19T00:00:00.000Z",
    ]);
  });

  // Only an applicant who was signed in when they applied carries the link, which
  // in practice means a returning member renewing. That is the whole population a
  // director can actually draft with, so the distinction has to survive the read.
  it("carries the Person link for a returner and null for a first-time applicant", async () => {
    const { term, srr, cycle } = await seed();
    const returner = await prisma.person.create({
      data: { name: "Grace Hopper", status: "ACTIVE", licensedRN: true },
    });
    await seedApplicant({
      cycleId: cycle.id,
      approvedById: srr.id,
      name: "Grace Hopper",
      personId: returner.id,
    });
    await seedApplicant({ cycleId: cycle.id, approvedById: srr.id, name: "New Person" });

    const rows = await listIncomingMembers({
      termId: term.id,
      departmentCode: "SRHD",
      clinicDates: CLINIC_DATES,
    });

    const byName = new Map(rows.map((r) => [r.name, r]));
    expect(byName.get("Grace Hopper")?.personId).toBe(returner.id);
    // The Person name wins over the application's, and the Person flags come with it.
    expect(byName.get("Grace Hopper")?.licensedRN).toBe(true);
    expect(byName.get("New Person")?.personId).toBeNull();
    expect(byName.get("New Person")?.licensedRN).toBe(false);
  });

  it("reports the onboarding stage from the contract", async () => {
    const { term, srr, cycle } = await seed();
    await seedApplicant({ cycleId: cycle.id, approvedById: srr.id, name: "No Contract" });
    await seedApplicant({
      cycleId: cycle.id, approvedById: srr.id, name: "Open Contract", contractStatus: "PENDING",
    });
    await seedApplicant({
      cycleId: cycle.id, approvedById: srr.id, name: "Done Contract", contractStatus: "SUBMITTED",
    });

    const rows = await listIncomingMembers({
      termId: term.id,
      departmentCode: "SRHD",
      clinicDates: CLINIC_DATES,
    });
    expect(new Map(rows.map((r) => [r.name, r.stage]))).toEqual(
      new Map([
        ["No Contract", "ACCEPTED"],
        ["Open Contract", "ONBOARDING"],
        ["Done Contract", "SUBMITTED"],
      ]),
    );
  });

  // Roster build writes the membership and the PROMOTED status in one transaction,
  // so a promoted contract means they arrive through the roster read instead. Two
  // rows for one person on the same board is the failure this prevents.
  it("excludes a promoted contract", async () => {
    const { term, srr, cycle } = await seed();
    await seedApplicant({
      cycleId: cycle.id, approvedById: srr.id, name: "Already Promoted", contractStatus: "PROMOTED",
    });
    expect(
      await listIncomingMembers({ termId: term.id, departmentCode: "SRHD", clinicDates: CLINIC_DATES }),
    ).toEqual([]);
  });

  // Withdrawal deliberately leaves the acceptance and contract intact, so the
  // acceptance still looks live and nothing else here would catch it.
  it("excludes a withdrawn application even though its acceptance survives", async () => {
    const { term, srr, cycle } = await seed();
    await seedApplicant({
      cycleId: cycle.id,
      approvedById: srr.id,
      name: "Withdrew Later",
      applicationStatus: "WITHDRAWN",
      contractStatus: "SUBMITTED",
    });
    expect(
      await listIncomingMembers({ termId: term.id, departmentCode: "SRHD", clinicDates: CLINIC_DATES }),
    ).toEqual([]);
  });

  it("excludes an applicant who has not been accepted at all", async () => {
    const { term, srr, cycle } = await seed();
    await seedApplicant({
      cycleId: cycle.id, approvedById: srr.id, name: "Still Waiting", accepted: false,
    });
    expect(
      await listIncomingMembers({ termId: term.id, departmentCode: "SRHD", clinicDates: CLINIC_DATES }),
    ).toEqual([]);
  });

  it("scopes to the department and to the term", async () => {
    const { term, srr, cycle } = await seed();
    await seedApplicant({
      cycleId: cycle.id, approvedById: srr.id, name: "Other Dept", departmentCode: "PCAR",
    });
    await seedApplicant({ cycleId: cycle.id, approvedById: srr.id, name: "Right Dept" });

    const mine = await listIncomingMembers({
      termId: term.id, departmentCode: "SRHD", clinicDates: CLINIC_DATES,
    });
    expect(mine.map((r) => r.name)).toEqual(["Right Dept"]);

    const otherTerm = await prisma.term.create({
      data: {
        code: "SP27", name: "Spring 2027",
        startDate: new Date("2027-01-01"), endDate: new Date("2027-05-31"),
        status: "PLANNING", clinicDates: [],
      },
    });
    expect(
      await listIncomingMembers({ termId: otherTerm.id, departmentCode: "SRHD", clinicDates: [] }),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// findIncomingMember
// ---------------------------------------------------------------------------

describe("findIncomingMember", () => {
  // The write-side guard must agree with the list, or the builder would render a
  // cell that the assignment write then refuses.
  it("finds a returner the list also returns, and reports the inbound kind", async () => {
    const { term, srr, cycle } = await seed();
    const person = await prisma.person.create({ data: { name: "Grace Hopper", status: "ACTIVE" } });
    await seedApplicant({
      cycleId: cycle.id, approvedById: srr.id, name: "Grace Hopper", personId: person.id,
    });

    const found = await findIncomingMember({
      personId: person.id, termId: term.id, departmentCode: "SRHD",
    });
    expect(found?.kind).toBe("VOLUNTEER");
  });

  it("reports DIRECTOR for an acceptance off a director-track cycle", async () => {
    const { term, dept: _dept, srr } = await seed();
    const person = await prisma.person.create({ data: { name: "Dir Elect", status: "ACTIVE" } });
    const dirCycle = await prisma.recruitmentCycle.create({
      data: {
        track: "DIRECTOR", termId: term.id, title: "Fall directors", publicSlug: "fa26-dir",
        departments: ["SRHD"], createdById: srr.id, status: "OPEN",
      },
    });
    await seedApplicant({
      cycleId: dirCycle.id, approvedById: srr.id, name: "Dir Elect", personId: person.id,
    });

    expect(
      (await findIncomingMember({ personId: person.id, termId: term.id, departmentCode: "SRHD" }))?.kind,
    ).toBe("DIRECTOR");
  });

  it("returns null for a withdrawn, promoted, other-department, or unknown person", async () => {
    const { term, srr, cycle } = await seed();
    const withdrew = await prisma.person.create({ data: { name: "With Drew", status: "ACTIVE" } });
    const promoted = await prisma.person.create({ data: { name: "Pro Moted", status: "ACTIVE" } });
    const elsewhere = await prisma.person.create({ data: { name: "Else Where", status: "ACTIVE" } });
    const stranger = await prisma.person.create({ data: { name: "Stran Ger", status: "ACTIVE" } });
    await seedApplicant({
      cycleId: cycle.id, approvedById: srr.id, name: "With Drew",
      personId: withdrew.id, applicationStatus: "WITHDRAWN",
    });
    await seedApplicant({
      cycleId: cycle.id, approvedById: srr.id, name: "Pro Moted",
      personId: promoted.id, contractStatus: "PROMOTED",
    });
    await seedApplicant({
      cycleId: cycle.id, approvedById: srr.id, name: "Else Where",
      personId: elsewhere.id, departmentCode: "PCAR",
    });

    for (const p of [withdrew, promoted, elsewhere, stranger]) {
      expect(
        await findIncomingMember({ personId: p.id, termId: term.id, departmentCode: "SRHD" }),
      ).toBeNull();
    }
  });
});
