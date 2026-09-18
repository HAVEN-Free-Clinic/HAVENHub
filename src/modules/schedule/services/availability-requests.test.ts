/**
 * Integration tests for the availability-change request service.
 *
 * The "request" is not a row: it is the onboarding contract's own
 * availabilityChangeNeeded / availabilityChangeRequest answer. Pending means no
 * AvailabilityChangeDecision exists yet for that (contract, department), which is
 * why most of these fixtures create a contract and assert on what the service
 * derives rather than on stored request state.
 *
 * Scoping mirrors the shift-request service: list/apply/dismiss all require the
 * actor to manage requests for the department (director by ACTIVE membership,
 * delegated manager, schedule.manage_requests holder, or schedule.edit_all).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { isoDateKey } from "@/platform/dates";
import {
  listAvailabilityRequests,
  applyAvailabilityChange,
  dismissAvailabilityChange,
  countPendingAvailabilityRequests,
  AvailabilityRequestForbiddenError,
  AvailabilityRequestNotFoundError,
  AvailabilityRequestValidationError,
} from "./availability-requests";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function utcNoon(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
}

/** Four clinic Saturdays, noon-UTC anchored like every real term. */
const CLINIC_DATES = [
  utcNoon(2026, 9, 5),
  utcNoon(2026, 9, 12),
  utcNoon(2026, 9, 19),
  utcNoon(2026, 9, 26),
];

async function seed(termStatus: "ACTIVE" | "PLANNING" | "ARCHIVED" = "ACTIVE") {
  const term = await prisma.term.create({
    data: {
      code: `FA26-${Date.now()}-${Math.random()}`,
      name: "Fall 2026",
      startDate: utcNoon(2026, 8, 1),
      endDate: utcNoon(2026, 12, 31),
      status: termStatus,
      clinicDates: CLINIC_DATES,
    },
  });
  const dept = await prisma.department.create({ data: { code: "SRHD", name: "Sexual and Reproductive Health" } });
  const other = await prisma.department.create({ data: { code: "PCAR", name: "Primary Care" } });
  const srr = await prisma.person.create({ data: { name: "Riley Srr", status: "ACTIVE" } });
  const cycle = await prisma.recruitmentCycle.create({
    data: {
      track: "VOLUNTEER",
      termId: term.id,
      title: "Fall volunteers",
      publicSlug: `fa26-vol-${Date.now()}-${Math.random()}`,
      departments: ["SRHD", "PCAR"],
      createdById: srr.id,
      status: "OPEN",
    },
  });
  return { term, dept, other, srr, cycle };
}

/** A director of `departmentId`, which is what grants request authority. */
async function createDirector(name: string, termId: string, departmentId: string) {
  const person = await prisma.person.create({ data: { name, status: "ACTIVE" } });
  await prisma.termMembership.create({
    data: { personId: person.id, termId, departmentId, kind: "DIRECTOR", status: "ACTIVE" },
  });
  return person;
}

type ContractOpts = {
  cycleId: string;
  approvedById: string;
  name: string;
  departmentCodes?: string[];
  /** Availability the application itself carried (the BASELINE tier). */
  availability?: string[];
  needed?: boolean;
  request?: string | null;
  contractStatus?: "PENDING" | "SUBMITTED" | "PROMOTED";
  /** Set to put them on the roster: creates the Person and the membership. */
  promoteInto?: { termId: string; departmentIds: string[] };
};

/**
 * An applicant with an onboarding contract carrying an availability change
 * request. Optionally promoted onto the roster, which is what gives them the
 * TermMembership the applied override is written to.
 */
async function seedRequest(opts: ContractOpts) {
  const email = `${opts.name.replace(/\s+/g, ".").toLowerCase()}@yale.edu`;
  const [firstName, lastName] = opts.name.split(" ");
  const codes = opts.departmentCodes ?? ["SRHD"];

  let personId: string | null = null;
  if (opts.promoteInto) {
    const person = await prisma.person.create({ data: { name: opts.name, status: "ACTIVE" } });
    personId = person.id;
    for (const departmentId of opts.promoteInto.departmentIds) {
      await prisma.termMembership.create({
        data: {
          personId: person.id,
          termId: opts.promoteInto.termId,
          departmentId,
          kind: "VOLUNTEER",
          status: "ACTIVE",
          baselineAvailability: (opts.availability ?? []).map((k) => new Date(`${k}T00:00:00.000Z`)),
        },
      });
    }
  }

  const applicant = await prisma.applicant.create({
    data: {
      cycleId: opts.cycleId,
      firstName,
      lastName: lastName ?? "",
      email,
      emailLower: email,
      applicantPersonId: personId,
    },
  });
  const application = await prisma.application.create({
    data: {
      cycleId: opts.cycleId,
      applicantId: applicant.id,
      answers: opts.availability ? { availability: opts.availability } : {},
      departmentChoices: codes,
      status: "SUBMITTED",
    },
  });
  const acceptances = [];
  for (const code of codes) {
    acceptances.push(
      await prisma.acceptance.create({
        data: { applicationId: application.id, departmentCode: code, approvedById: opts.approvedById },
      }),
    );
  }
  // One contract for the application, hanging off the first acceptance -- a dual
  // appointment's second acceptance has none of its own.
  const contract = await prisma.onboardingContract.create({
    data: {
      acceptanceId: acceptances[0].id,
      token: `t-${acceptances[0].id}`,
      status: opts.contractStatus ?? "PROMOTED",
      firstName,
      lastName: lastName ?? "",
      email,
      promotedPersonId: opts.contractStatus === "PENDING" ? null : personId,
      availabilityChangeNeeded: opts.needed ?? true,
      availabilityChangeRequest: opts.request === undefined ? "Please drop me from Sep 12." : opts.request,
    },
  });
  return { contract, application, personId };
}

beforeEach(resetDb);

// ---------------------------------------------------------------------------
// listAvailabilityRequests
// ---------------------------------------------------------------------------

describe("listAvailabilityRequests", () => {
  it("returns a submitted contract's request as pending, with the member's current availability", async () => {
    const { term, dept, srr, cycle } = await seed();
    const director = await createDirector("Dana Director", term.id, dept.id);
    await seedRequest({
      cycleId: cycle.id,
      approvedById: srr.id,
      name: "Val Volunteer",
      availability: ["2026-09-05", "2026-09-12"],
      request: "Please drop me from Sep 12.",
      promoteInto: { termId: term.id, departmentIds: [dept.id] },
    });

    const rows = await listAvailabilityRequests(director.id, dept.id, term.id);

    expect(rows).toHaveLength(1);
    expect(rows[0].personName).toBe("Val Volunteer");
    expect(rows[0].request).toBe("Please drop me from Sep 12.");
    expect(rows[0].decision).toBeNull();
    expect(rows[0].membershipId).not.toBeNull();
    expect(rows[0].tier).toBe("BASELINE");
    expect(rows[0].currentDates.map(isoDateKey)).toEqual(["2026-09-05", "2026-09-12"]);
  });

  it("ignores a contract whose author did not ask for a change, or left the text blank", async () => {
    const { term, dept, srr, cycle } = await seed();
    const director = await createDirector("Dana Director", term.id, dept.id);
    await seedRequest({
      cycleId: cycle.id,
      approvedById: srr.id,
      name: "No Change",
      needed: false,
      request: "stray text from an earlier answer",
      promoteInto: { termId: term.id, departmentIds: [dept.id] },
    });
    await seedRequest({
      cycleId: cycle.id,
      approvedById: srr.id,
      name: "Blank Text",
      needed: true,
      request: "   ",
      promoteInto: { termId: term.id, departmentIds: [dept.id] },
    });

    expect(await listAvailabilityRequests(director.id, dept.id, term.id)).toEqual([]);
  });

  it("does not leak a request from another department", async () => {
    const { term, dept, other, srr, cycle } = await seed();
    const director = await createDirector("Dana Director", term.id, dept.id);
    await seedRequest({
      cycleId: cycle.id,
      approvedById: srr.id,
      name: "Other Dept",
      departmentCodes: ["PCAR"],
      promoteInto: { termId: term.id, departmentIds: [other.id] },
    });

    expect(await listAvailabilityRequests(director.id, dept.id, term.id)).toEqual([]);
  });

  it("refuses an actor with no authority over the department", async () => {
    const { term, dept, other, srr, cycle } = await seed();
    const outsider = await createDirector("Otto Outsider", term.id, other.id);
    await seedRequest({
      cycleId: cycle.id,
      approvedById: srr.id,
      name: "Val Volunteer",
      promoteInto: { termId: term.id, departmentIds: [dept.id] },
    });

    await expect(listAvailabilityRequests(outsider.id, dept.id, term.id)).rejects.toBeInstanceOf(
      AvailabilityRequestForbiddenError,
    );
  });

  it("still lists someone accepted but not yet on the roster, with no membership to write", async () => {
    const { term, dept, srr, cycle } = await seed();
    const director = await createDirector("Dana Director", term.id, dept.id);
    await seedRequest({
      cycleId: cycle.id,
      approvedById: srr.id,
      name: "Ivy Incoming",
      contractStatus: "SUBMITTED",
      availability: ["2026-09-19"],
    });

    const rows = await listAvailabilityRequests(director.id, dept.id, term.id);

    expect(rows).toHaveLength(1);
    expect(rows[0].membershipId).toBeNull();
    expect(rows[0].tier).toBe("BASELINE");
    // Read straight off the application, the way the builder shows an incoming row.
    expect(rows[0].currentDates.map(isoDateKey)).toEqual(["2026-09-19"]);
  });
});

// ---------------------------------------------------------------------------
// applyAvailabilityChange
// ---------------------------------------------------------------------------

describe("applyAvailabilityChange", () => {
  it("writes the director override, records the decision, and drops the row out of pending", async () => {
    const { term, dept, srr, cycle } = await seed();
    const director = await createDirector("Dana Director", term.id, dept.id);
    const { contract } = await seedRequest({
      cycleId: cycle.id,
      approvedById: srr.id,
      name: "Val Volunteer",
      availability: ["2026-09-05", "2026-09-12"],
      promoteInto: { termId: term.id, departmentIds: [dept.id] },
    });

    await applyAvailabilityChange(director.id, {
      contractId: contract.id,
      departmentId: dept.id,
      dateKeys: ["2026-09-05", "2026-09-26"],
    });

    const membership = await prisma.termMembership.findFirstOrThrow({
      where: { termId: term.id, departmentId: dept.id, kind: "VOLUNTEER" },
    });
    expect(membership.directorAvailabilityDates.map(isoDateKey)).toEqual(["2026-09-05", "2026-09-26"]);
    expect(membership.directorAvailabilitySetAt).not.toBeNull();

    const decision = await prisma.availabilityChangeDecision.findFirstOrThrow({
      where: { contractId: contract.id, departmentId: dept.id },
    });
    expect(decision.outcome).toBe("APPLIED");
    expect(decision.decidedById).toBe(director.id);

    const rows = await listAvailabilityRequests(director.id, dept.id, term.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].decision?.outcome).toBe("APPLIED");
    expect(await countPendingAvailabilityRequests(director.id)).toBe(0);

    const audit = await prisma.auditLog.findFirst({
      where: { action: "schedule.availability_request_apply", entityId: contract.id },
    });
    expect(audit).not.toBeNull();
  });

  it("refuses a date that is not a clinic date of the term", async () => {
    const { term, dept, srr, cycle } = await seed();
    const director = await createDirector("Dana Director", term.id, dept.id);
    const { contract } = await seedRequest({
      cycleId: cycle.id,
      approvedById: srr.id,
      name: "Val Volunteer",
      promoteInto: { termId: term.id, departmentIds: [dept.id] },
    });

    await expect(
      applyAvailabilityChange(director.id, {
        contractId: contract.id,
        departmentId: dept.id,
        dateKeys: ["2026-09-06"],
      }),
    ).rejects.toBeInstanceOf(AvailabilityRequestValidationError);
  });

  it("refuses a second decision on the same request", async () => {
    const { term, dept, srr, cycle } = await seed();
    const director = await createDirector("Dana Director", term.id, dept.id);
    const { contract } = await seedRequest({
      cycleId: cycle.id,
      approvedById: srr.id,
      name: "Val Volunteer",
      promoteInto: { termId: term.id, departmentIds: [dept.id] },
    });

    await applyAvailabilityChange(director.id, {
      contractId: contract.id,
      departmentId: dept.id,
      dateKeys: ["2026-09-05"],
    });

    await expect(
      applyAvailabilityChange(director.id, {
        contractId: contract.id,
        departmentId: dept.id,
        dateKeys: ["2026-09-12"],
      }),
    ).rejects.toBeInstanceOf(AvailabilityRequestValidationError);
  });

  it("refuses to apply for someone who has no membership yet", async () => {
    const { term, dept, srr, cycle } = await seed();
    const director = await createDirector("Dana Director", term.id, dept.id);
    const { contract } = await seedRequest({
      cycleId: cycle.id,
      approvedById: srr.id,
      name: "Ivy Incoming",
      contractStatus: "SUBMITTED",
    });

    await expect(
      applyAvailabilityChange(director.id, {
        contractId: contract.id,
        departmentId: dept.id,
        dateKeys: ["2026-09-05"],
      }),
    ).rejects.toBeInstanceOf(AvailabilityRequestValidationError);
  });

  it("refuses an actor with no authority over the department", async () => {
    const { term, dept, other, srr, cycle } = await seed();
    const outsider = await createDirector("Otto Outsider", term.id, other.id);
    const { contract } = await seedRequest({
      cycleId: cycle.id,
      approvedById: srr.id,
      name: "Val Volunteer",
      promoteInto: { termId: term.id, departmentIds: [dept.id] },
    });

    await expect(
      applyAvailabilityChange(outsider.id, {
        contractId: contract.id,
        departmentId: dept.id,
        dateKeys: ["2026-09-05"],
      }),
    ).rejects.toBeInstanceOf(AvailabilityRequestForbiddenError);
  });

  it("refuses a contract that carries no request at all", async () => {
    const { term, dept, srr, cycle } = await seed();
    const director = await createDirector("Dana Director", term.id, dept.id);
    const { contract } = await seedRequest({
      cycleId: cycle.id,
      approvedById: srr.id,
      name: "No Change",
      needed: false,
      promoteInto: { termId: term.id, departmentIds: [dept.id] },
    });

    await expect(
      applyAvailabilityChange(director.id, {
        contractId: contract.id,
        departmentId: dept.id,
        dateKeys: ["2026-09-05"],
      }),
    ).rejects.toBeInstanceOf(AvailabilityRequestNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// dismissAvailabilityChange
// ---------------------------------------------------------------------------

describe("dismissAvailabilityChange", () => {
  it("records the dismissal and its note, and changes no availability", async () => {
    const { term, dept, srr, cycle } = await seed();
    const director = await createDirector("Dana Director", term.id, dept.id);
    const { contract } = await seedRequest({
      cycleId: cycle.id,
      approvedById: srr.id,
      name: "Val Volunteer",
      availability: ["2026-09-05", "2026-09-12"],
      promoteInto: { termId: term.id, departmentIds: [dept.id] },
    });

    await dismissAvailabilityChange(director.id, {
      contractId: contract.id,
      departmentId: dept.id,
      note: "Spoke to them, no change needed.",
    });

    const decision = await prisma.availabilityChangeDecision.findFirstOrThrow({
      where: { contractId: contract.id, departmentId: dept.id },
    });
    expect(decision.outcome).toBe("DISMISSED");
    expect(decision.note).toBe("Spoke to them, no change needed.");

    const membership = await prisma.termMembership.findFirstOrThrow({
      where: { termId: term.id, departmentId: dept.id, kind: "VOLUNTEER" },
    });
    expect(membership.directorAvailabilitySetAt).toBeNull();
    expect(membership.directorAvailabilityDates).toEqual([]);
    expect(await countPendingAvailabilityRequests(director.id)).toBe(0);
  });

  it("can dismiss for someone who is not on the roster yet", async () => {
    const { term, dept, srr, cycle } = await seed();
    const director = await createDirector("Dana Director", term.id, dept.id);
    const { contract } = await seedRequest({
      cycleId: cycle.id,
      approvedById: srr.id,
      name: "Ivy Incoming",
      contractStatus: "SUBMITTED",
    });

    await dismissAvailabilityChange(director.id, { contractId: contract.id, departmentId: dept.id });

    expect(await countPendingAvailabilityRequests(director.id)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Dual appointments: one contract, two departments deciding independently
// ---------------------------------------------------------------------------

describe("a dual appointment's two departments", () => {
  it("each decide the shared contract for themselves", async () => {
    const { term, dept, other, srr, cycle } = await seed();
    const deptDirector = await createDirector("Dana Director", term.id, dept.id);
    const otherDirector = await createDirector("Pat Primary", term.id, other.id);
    const { contract } = await seedRequest({
      cycleId: cycle.id,
      approvedById: srr.id,
      name: "Dee Dual",
      departmentCodes: ["SRHD", "PCAR"],
      availability: ["2026-09-05"],
      promoteInto: { termId: term.id, departmentIds: [dept.id, other.id] },
    });

    // Both see it before anyone decides.
    expect(await listAvailabilityRequests(deptDirector.id, dept.id, term.id)).toHaveLength(1);
    expect(await listAvailabilityRequests(otherDirector.id, other.id, term.id)).toHaveLength(1);

    await applyAvailabilityChange(deptDirector.id, {
      contractId: contract.id,
      departmentId: dept.id,
      dateKeys: ["2026-09-26"],
    });

    // The other department's copy is untouched: still pending, still its own
    // availability.
    expect(await countPendingAvailabilityRequests(deptDirector.id)).toBe(0);
    expect(await countPendingAvailabilityRequests(otherDirector.id)).toBe(1);

    const otherMembership = await prisma.termMembership.findFirstOrThrow({
      where: { termId: term.id, departmentId: other.id },
    });
    expect(otherMembership.directorAvailabilitySetAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// countPendingAvailabilityRequests
// ---------------------------------------------------------------------------

describe("countPendingAvailabilityRequests", () => {
  it("counts only the departments the actor can decide for", async () => {
    const { term, dept, other, srr, cycle } = await seed();
    const director = await createDirector("Dana Director", term.id, dept.id);
    await seedRequest({
      cycleId: cycle.id,
      approvedById: srr.id,
      name: "Mine Ours",
      promoteInto: { termId: term.id, departmentIds: [dept.id] },
    });
    await seedRequest({
      cycleId: cycle.id,
      approvedById: srr.id,
      name: "Theirs Alone",
      departmentCodes: ["PCAR"],
      promoteInto: { termId: term.id, departmentIds: [other.id] },
    });

    expect(await countPendingAvailabilityRequests(director.id)).toBe(1);
  });

  it("is zero for someone who manages nothing", async () => {
    const { term, dept, srr, cycle } = await seed();
    const nobody = await prisma.person.create({ data: { name: "Nona Body", status: "ACTIVE" } });
    await seedRequest({
      cycleId: cycle.id,
      approvedById: srr.id,
      name: "Val Volunteer",
      promoteInto: { termId: term.id, departmentIds: [dept.id] },
    });

    expect(await countPendingAvailabilityRequests(nobody.id)).toBe(0);
  });
});
