import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { activationReadiness } from "./term-readiness";
import { displacedStatusFor } from "./terms";

/**
 * The activation checklist's reads, against the shapes the SU26 to FA26 flip
 * actually had: an outgoing term whose end date falls on its own last clinic,
 * a term-scoped baseline role, and a promoted roster that was not yet cleared.
 */

beforeEach(resetDb);

const DAY = 24 * 60 * 60 * 1000;
const noon = (iso: string) => new Date(`${iso}T12:00:00Z`);

async function terms(opts: { outgoingEnd?: Date; clinicDates?: Date[] } = {}) {
  const outgoing = await prisma.term.create({
    data: {
      code: "SU26", name: "Summer 2026", status: "ACTIVE",
      startDate: noon("2026-05-30"),
      endDate: opts.outgoingEnd ?? new Date("2026-09-26T00:00:00Z"),
      clinicDates: opts.clinicDates ?? [],
    },
  });
  const incoming = await prisma.term.create({
    data: {
      code: "FA26", name: "Fall 2026", status: "PLANNING",
      startDate: noon("2026-09-01"), endDate: noon("2027-01-01"), clinicDates: [],
    },
  });
  return { outgoing, incoming };
}

async function membership(personId: string, termId: string, departmentId: string, kind: "VOLUNTEER" | "DIRECTOR" = "VOLUNTEER") {
  return prisma.termMembership.create({ data: { personId, termId, departmentId, kind, status: "ACTIVE" } });
}

describe("displacedStatusFor", () => {
  it("demotes a term that has not ended and archives one that has", () => {
    const su26 = { endDate: new Date("2026-09-26T00:00:00Z") };
    expect(displacedStatusFor(su26, new Date("2026-09-25T23:59:59Z"))).toBe("PLANNING");
    expect(displacedStatusFor(su26, new Date("2026-09-26T00:00:00Z"))).toBe("ARCHIVED");
  });
});

describe("the outgoing term", () => {
  it("reports an early flip: demoted, with its remaining clinic dates and pending requests", async () => {
    const { outgoing, incoming } = await terms({
      clinicDates: [noon("2026-09-05"), noon("2026-09-12"), noon("2026-09-26")],
    });
    const dept = await prisma.department.create({ data: { code: "PCAR", name: "Primary Care" } });
    const requester = await prisma.person.create({ data: { name: "Req", status: "ACTIVE" } });
    await prisma.shiftRequest.create({
      data: { termId: outgoing.id, departmentId: dept.id, requesterId: requester.id, requesterDate: noon("2026-09-12"), status: "PENDING" },
    });

    const r = await activationReadiness(incoming.id, new Date("2026-09-10T15:00:00Z"));

    expect(r.outgoing?.becomes).toBe("PLANNING");
    expect(r.outgoing?.remainingClinicDates.map((d) => d.toISOString().slice(0, 10))).toEqual(["2026-09-12", "2026-09-26"]);
    expect(r.outgoing?.pendingRequests).toBe(1);
  });

  it("reports a normal handoff once the outgoing term's last clinic has passed", async () => {
    const { incoming } = await terms({ clinicDates: [noon("2026-09-26")] });

    const r = await activationReadiness(incoming.id, new Date("2026-09-27T15:00:00Z"));

    expect(r.outgoing?.becomes).toBe("ARCHIVED");
    expect(r.outgoing?.remainingClinicDates).toEqual([]);
  });

  it("counts people with no place next term once, leaving out continuing and offboarded people", async () => {
    const { outgoing, incoming } = await terms();
    const [pcar, srhd] = await Promise.all([
      prisma.department.create({ data: { code: "PCAR", name: "Primary Care" } }),
      prisma.department.create({ data: { code: "SRHD", name: "SRHD" } }),
    ]);
    const continuing = await prisma.person.create({ data: { name: "Continuing", status: "ACTIVE" } });
    const leaving = await prisma.person.create({ data: { name: "Leaving", status: "ACTIVE" } });
    const offboarded = await prisma.person.create({ data: { name: "Gone", status: "OFFBOARDED" } });
    for (const p of [continuing, leaving, offboarded]) await membership(p.id, outgoing.id, pcar.id);
    // Two departments in the old term are still one person.
    await membership(leaving.id, outgoing.id, srhd.id);
    await membership(continuing.id, incoming.id, pcar.id);

    const r = await activationReadiness(incoming.id, noon("2026-09-27"));

    expect(r.outgoing?.notContinuing).toBe(1);
  });

  it("names role assignments scoped to the outgoing term, and not global ones", async () => {
    const { outgoing, incoming } = await terms();
    const volunteer = await prisma.role.create({ data: { name: "Volunteer" } });
    const director = await prisma.role.create({ data: { name: "Director" } });
    // Production's shape before the FA26 flip: the Volunteer baseline scoped to
    // SU26, which the engine stops honoring the moment FA26 is active.
    await prisma.roleAssignment.create({ data: { roleId: volunteer.id, kind: "VOLUNTEER", termId: outgoing.id } });
    await prisma.roleAssignment.create({ data: { roleId: director.id, kind: "DIRECTOR", termId: null } });

    const r = await activationReadiness(incoming.id, noon("2026-09-27"));

    expect(r.outgoing?.termScopedRoles).toEqual([{ roleName: "Volunteer", count: 1 }]);
  });
});

describe("the incoming term", () => {
  async function cycleOn(termId: string, opts: { isTermTraining?: boolean } = {}) {
    const lead = await prisma.person.create({ data: { name: "Lead", status: "ACTIVE" } });
    const cycle = await prisma.recruitmentCycle.create({
      data: {
        track: "VOLUNTEER", termId, title: "Volunteer Fall 2026 Recruitment", publicSlug: `fa26-${Math.random()}`,
        departments: ["PCAR"], createdById: lead.id, status: "OPEN", isTermTraining: opts.isTermTraining ?? false,
      },
    });
    return { cycle, lead };
  }

  async function accept(
    cycleId: string,
    approvedById: string,
    email: string,
    opts: { contract?: "SUBMITTED" | "PROMOTED"; withdrawn?: boolean } = {},
  ) {
    const applicant = await prisma.applicant.create({
      data: { cycleId, firstName: "A", lastName: email, email, emailLower: email },
    });
    const application = await prisma.application.create({
      data: {
        cycleId, applicantId: applicant.id, answers: {}, applicantType: "NEW",
        departmentChoices: ["PCAR"], status: opts.withdrawn ? "WITHDRAWN" : "SUBMITTED",
      },
    });
    const acceptance = await prisma.acceptance.create({
      data: { applicationId: application.id, departmentCode: "PCAR", approvedById },
    });
    if (opts.contract) {
      await prisma.onboardingContract.create({
        data: {
          acceptanceId: acceptance.id, token: `t-${email}`, status: opts.contract,
          firstName: "A", lastName: email, email,
          agreementSignature: "A", professionalismSignature: "A", trainingSignature: "A", initials: "A",
          epicNeeded: false, hasEpic: false,
        },
      });
    }
  }

  it("counts accepted applicants not yet on the roster, per cycle", async () => {
    const { incoming } = await terms();
    const { cycle, lead } = await cycleOn(incoming.id);
    await accept(cycle.id, lead.id, "a@yale.edu"); // no link sent yet
    await accept(cycle.id, lead.id, "b@yale.edu", { contract: "SUBMITTED" }); // waiting on promotion
    await accept(cycle.id, lead.id, "c@yale.edu", { contract: "PROMOTED" }); // on the roster
    await accept(cycle.id, lead.id, "d@yale.edu", { withdrawn: true }); // withdrew

    const r = await activationReadiness(incoming.id, noon("2026-09-27"));

    expect(r.incoming.unpromoted).toEqual([
      { cycleId: cycle.id, title: "Volunteer Fall 2026 Recruitment", count: 2 },
    ]);
  });

  it("counts members the gate would hold, by missing blocking step, leaving out exempt admins", async () => {
    const now = new Date();
    const incoming = await prisma.term.create({
      data: {
        code: "FA26", name: "Fall 2026", status: "PLANNING", clinicDates: [],
        startDate: new Date(now.getTime() + 5 * DAY), endDate: new Date(now.getTime() + 100 * DAY),
      },
    });
    const dept = await prisma.department.create({ data: { code: "PCAR", name: "Primary Care" } });
    // The designated training cycle is what makes the training step apply.
    const { cycle } = await cycleOn(incoming.id, { isTermTraining: true });
    // A complete profile (contact email + phone), so only HIPAA and training can hold anyone.
    const withProfile = (name: string) =>
      prisma.person.create({
        data: { name, status: "ACTIVE", contactEmail: `${name.toLowerCase()}@example.org`, phone: "2035550100" },
      });
    const held = await withProfile("Held");
    const cleared = await withProfile("Cleared");
    const admin = await withProfile("Admin");
    for (const p of [held, cleared, admin]) await membership(p.id, incoming.id, dept.id);

    await prisma.hipaaCertificate.create({
      data: {
        personId: cleared.id, fileName: "c.pdf", storedName: "c.pdf", size: 1, mimeType: "application/pdf",
        completionDate: new Date(now.getTime() - 10 * DAY), verifiedAt: now,
      },
    });
    await prisma.training.create({
      data: { personId: cleared.id, termId: incoming.id, cycleId: cycle.id, track: "VOLUNTEER", status: "COMPLETE" },
    });
    const adminRole = await prisma.role.create({
      data: { name: "Platform Admin", grants: { create: [{ permission: "admin.access" }] } },
    });
    await prisma.roleAssignment.create({ data: { roleId: adminRole.id, personId: admin.id } });

    const r = await activationReadiness(incoming.id, now);

    expect(r.incoming.members).toBe(3);
    expect(r.incoming.heldAtGate).toBe(1);
    expect(r.incoming.heldBySteps).toHaveLength(2);
    expect(r.incoming.heldBySteps).toEqual(
      expect.arrayContaining([{ key: "hipaa", count: 1 }, { key: "training", count: 1 }]),
    );
  });

  it("names departments with drafted shifts and no published schedule", async () => {
    const { incoming } = await terms();
    const [exec, pcar] = await Promise.all([
      prisma.department.create({ data: { code: "EXEC", name: "Executive" } }),
      prisma.department.create({ data: { code: "PCAR", name: "Primary Care" } }),
    ]);
    const p = await prisma.person.create({ data: { name: "P", status: "ACTIVE" } });
    await prisma.shiftAssignment.create({
      data: { termId: incoming.id, departmentId: exec.id, personId: p.id, clinicDate: noon("2026-10-03"), role: "VOLUNTEER" },
    });
    await prisma.shiftAssignment.create({
      data: { termId: incoming.id, departmentId: pcar.id, personId: p.id, clinicDate: noon("2026-10-10"), role: "VOLUNTEER" },
    });
    await prisma.schedulePublication.create({ data: { termId: incoming.id, departmentId: exec.id } });

    const r = await activationReadiness(incoming.id, noon("2026-09-27"));

    expect(r.incoming.unpublishedDepartments).toEqual(["PCAR"]);
  });
});
