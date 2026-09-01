import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { resolveAudience } from "./resolve";

beforeEach(resetDb);

async function person(name: string, email: string | null) {
  return prisma.person.create({ data: { name, contactEmail: email, status: "ACTIVE" } });
}

/**
 * Builds a cycle (unless one is passed), an Applicant, and a submitted
 * Application, mirroring `cycleWithApplicant` in resolve.test.ts -- the fixture
 * the appliedToCycle tests already rely on for the email/NetID fallback. Any
 * extras (subcommittee assignment, acceptance) are layered on afterward by the
 * caller so this stays a single shared builder rather than three near-copies.
 */
async function cycleWithApplication(opts: {
  personId?: string;
  email: string;
  netId?: string;
  cycleId?: string;
  assignedSubcommitteeId?: string;
}) {
  let cycleId = opts.cycleId;
  if (!cycleId) {
    const t = await prisma.term.create({
      data: {
        code: `T${Math.random().toString(36).slice(2, 8)}`,
        name: "T",
        startDate: new Date("2026-08-25"),
        endDate: new Date("2026-12-20"),
        status: "PLANNING",
      },
    });
    const creator = await person(
      "Cycle Creator",
      `creator-${Math.random().toString(36).slice(2, 8)}@example.com`,
    );
    const c = await prisma.recruitmentCycle.create({
      data: {
        track: "VOLUNTEER",
        term: { connect: { id: t.id } },
        createdBy: { connect: { id: creator.id } },
        title: "Fall 2026",
        publicSlug: `slug-${Math.random().toString(36).slice(2, 8)}`,
      },
    });
    cycleId = c.id;
  }
  const applicant = await prisma.applicant.create({
    data: {
      cycleId,
      applicantPersonId: opts.personId ?? null,
      firstName: "A",
      lastName: "B",
      email: opts.email,
      emailLower: opts.email.toLowerCase(),
      netId: opts.netId ?? null,
    },
  });
  const application = await prisma.application.create({
    data: {
      cycleId,
      applicantId: applicant.id,
      answers: {},
      assignedSubcommitteeId: opts.assignedSubcommitteeId ?? null,
    },
  });
  return { cycleId, applicationId: application.id };
}

async function acceptFor(applicationId: string, approvedById: string) {
  return prisma.acceptance.create({
    data: {
      applicationId,
      departmentCode: "CARDIO",
      approvedById,
    },
  });
}

describe("resolveAudience acceptedInCycle", () => {
  it("matches a signed-in applicant (linked via applicantPersonId) once an Acceptance exists", async () => {
    const p = await person("Renewer", "renew@example.com");
    const approver = await person("Approver", "approver@example.com");
    const { cycleId, applicationId } = await cycleWithApplication({
      personId: p.id,
      email: "renew@example.com",
    });
    await acceptFor(applicationId, approver.id);

    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "acceptedInCycle", op: "in", value: [cycleId] }],
    });
    expect(res.recipients.map((r) => r.email)).toEqual(["renew@example.com"]);
  });

  it("matches an ANONYMOUS applicant, linked only by lowercased email", async () => {
    // applicantPersonId is null for anyone who applied anonymously. Matching
    // only the link would UNDER-match: a regression that drops the email
    // fallback must fail this test.
    await person("Anon", "Anon.Applicant@Example.com");
    const approver = await person("Approver", "approver2@example.com");
    const { cycleId, applicationId } = await cycleWithApplication({
      email: "anon.applicant@example.com",
    });
    await acceptFor(applicationId, approver.id);

    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "acceptedInCycle", op: "in", value: [cycleId] }],
    });
    expect(res.recipients.map((r) => r.email)).toEqual(["Anon.Applicant@Example.com"]);
  });

  it("does NOT match a person whose application has no Acceptance", async () => {
    const p = await person("Pending", "pending@example.com");
    const { cycleId } = await cycleWithApplication({
      personId: p.id,
      email: "pending@example.com",
    });

    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "acceptedInCycle", op: "in", value: [cycleId] }],
    });
    expect(res.recipients).toEqual([]);
  });

  it("matches nobody for a deleted/unknown cycle id rather than throwing", async () => {
    const p = await person("Someone", "someone@example.com");
    const approver = await person("Approver", "approver3@example.com");
    const { applicationId } = await cycleWithApplication({
      personId: p.id,
      email: "someone@example.com",
    });
    await acceptFor(applicationId, approver.id);

    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "acceptedInCycle", op: "in", value: ["does-not-exist"] }],
    });
    expect(res.recipients).toEqual([]);
  });
});

describe("resolveAudience subcommittee", () => {
  it("matches via the assigned application", async () => {
    const p = await person("Assigned", "assigned@example.com");
    const sub = await prisma.subcommittee.create({ data: { name: "Fundraising" } });
    await cycleWithApplication({
      personId: p.id,
      email: "assigned@example.com",
      assignedSubcommitteeId: sub.id,
    });

    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "subcommittee", op: "in", value: [sub.id] }],
    });
    expect(res.recipients.map((r) => r.email)).toEqual(["assigned@example.com"]);
  });

  it("matches an ANONYMOUS applicant's subcommittee assignment, linked only by lowercased email", async () => {
    await person("Anon Sub", "Anon.Sub@Example.com");
    const sub = await prisma.subcommittee.create({ data: { name: "Events" } });
    await cycleWithApplication({
      email: "anon.sub@example.com",
      assignedSubcommitteeId: sub.id,
    });

    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "subcommittee", op: "in", value: [sub.id] }],
    });
    expect(res.recipients.map((r) => r.email)).toEqual(["Anon.Sub@Example.com"]);
  });

  it("does not match a person whose application was never assigned a subcommittee", async () => {
    const p = await person("Unassigned", "unassigned@example.com");
    const sub = await prisma.subcommittee.create({ data: { name: "Outreach" } });
    await cycleWithApplication({ personId: p.id, email: "unassigned@example.com" });

    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "subcommittee", op: "in", value: [sub.id] }],
    });
    expect(res.recipients).toEqual([]);
  });

  it("matches nobody for a deleted/unknown subcommittee id rather than throwing", async () => {
    const p = await person("Someone Else", "else@example.com");
    const sub = await prisma.subcommittee.create({ data: { name: "Real" } });
    await cycleWithApplication({
      personId: p.id,
      email: "else@example.com",
      assignedSubcommitteeId: sub.id,
    });

    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "subcommittee", op: "in", value: ["deleted-subcommittee-id"] }],
    });
    expect(res.recipients).toEqual([]);
  });
});
