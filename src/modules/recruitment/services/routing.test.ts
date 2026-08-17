import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { RecruitmentAuthError, AcceptanceError } from "./review";
import * as review from "./review";
import { routeApplication, decideRoutedApplication, returnToRouting, rejectApplication, reopenDecision, applyTierRoutes, applyTierRejects, RoutingError } from "./routing";

async function seed() {
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  await prisma.department.create({ data: { code: "EDUC", name: "Education" } });
  await prisma.department.create({ data: { code: "MDIC", name: "Medical" } });
  const lead = await prisma.person.create({ data: { name: "Lead", status: "ACTIVE" } });
  const other = await prisma.person.create({ data: { name: "Other", status: "ACTIVE" } });
  const role = await prisma.role.create({ data: { name: "SRR", grants: { create: [{ permission: "recruitment.review_all" }] } } });
  await prisma.roleAssignment.create({ data: { personId: lead.id, roleId: role.id } });
  const cycle = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "v", departments: ["EDUC", "MDIC"], createdById: lead.id, status: "OPEN" } });
  const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "A", lastName: "B", email: "a@y.edu", emailLower: "a@y.edu" } });
  const application = await prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: ["EDUC"] } });
  return { lead, other, application };
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

describe("routeApplication", () => {
  it("lets a lead route to any cycle department (even off-choice) and audits", async () => {
    const { lead, application } = await seed();
    const routed = await routeApplication(application.id, "MDIC", lead.id); // MDIC not in departmentChoices
    expect(routed.routedDepartmentCode).toBe("MDIC");
    expect(routed.routedById).toBe(lead.id);
    const audit = await prisma.auditLog.findFirst({ where: { action: "recruitment.route" } });
    expect(audit).not.toBeNull();
  });

  it("rejects a non-lead", async () => {
    const { other, application } = await seed();
    await expect(routeApplication(application.id, "EDUC", other.id)).rejects.toBeInstanceOf(RecruitmentAuthError);
  });

  it("rejects a department not in the cycle", async () => {
    const { lead, application } = await seed();
    await expect(routeApplication(application.id, "NOPE", lead.id)).rejects.toBeInstanceOf(RoutingError);
  });

  it("refuses to route an applicant back to the department that handed them back (audit 14, REC-2)", async () => {
    const { lead, application } = await seed();
    await routeApplication(application.id, "EDUC", lead.id);
    await returnToRouting(application.id, lead.id, "not a fit for us");

    // EDUC is the applicant's first ranked choice, which is what the speed-route
    // modal's "1" key and the tier table's default both propose.
    await expect(routeApplication(application.id, "EDUC", lead.id)).rejects.toBeInstanceOf(RoutingError);

    // The applicant is still waiting for a real re-routing decision, not silently
    // re-queued at EDUC.
    const app = await prisma.application.findUniqueOrThrow({ where: { id: application.id } });
    expect(app.routedDepartmentCode).toBeNull();
    expect(app.returnedFromDepartmentCode).toBe("EDUC");

    // Any OTHER department is still fine, including a later route back to EDUC
    // once MDIC has had them (the return marker is cleared by that routing).
    await routeApplication(application.id, "MDIC", lead.id);
    const rerouted = await routeApplication(application.id, "EDUC", lead.id);
    expect(rerouted.routedDepartmentCode).toBe("EDUC");
  });

  it("skips a returned applicant in a batch tier route instead of aborting the batch (audit 14, REC-2)", async () => {
    const { lead, application } = await seed();
    await routeApplication(application.id, "EDUC", lead.id);
    await returnToRouting(application.id, lead.id, "not a fit for us");

    const res = await applyTierRoutes([{ applicationId: application.id, departmentCode: "EDUC" }], lead.id);
    expect(res.applied).toBe(0);
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0].reason).toContain("EDUC");
  });

  it("re-routing after a not-yet-emailed ACCEPT clears the old acceptance and resets the decision", async () => {
    const { lead, application } = await seed();
    await routeApplication(application.id, "EDUC", lead.id);
    await decideRoutedApplication(application.id, "ACCEPT", lead.id, "accepted for EDUC");
    // Re-route to MDIC: the EDUC acceptance is now stale and must not survive.
    const rerouted = await routeApplication(application.id, "MDIC", lead.id);
    expect(rerouted.routedDepartmentCode).toBe("MDIC");
    expect(rerouted.decision).toBe("PENDING");
    expect(rerouted.decidedAt).toBeNull();
    expect(rerouted.decisionNotes).toBeNull();
    expect(await prisma.acceptance.findMany({ where: { applicationId: application.id } })).toHaveLength(0);
  });

  it("blocks re-routing once the acceptance was emailed (must be rescinded first)", async () => {
    const { lead, application } = await seed();
    await routeApplication(application.id, "EDUC", lead.id);
    await decideRoutedApplication(application.id, "ACCEPT", lead.id, null);
    await prisma.acceptance.updateMany({ where: { applicationId: application.id, departmentCode: "EDUC" }, data: { emailedAt: new Date() } });
    await expect(routeApplication(application.id, "MDIC", lead.id)).rejects.toBeInstanceOf(AcceptanceError);
    // The original routing + acceptance are untouched.
    const app = await prisma.application.findUniqueOrThrow({ where: { id: application.id } });
    expect(app.routedDepartmentCode).toBe("EDUC");
    expect(await prisma.acceptance.count({ where: { applicationId: application.id, departmentCode: "EDUC" } })).toBe(1);
  });

  it("re-routing to the SAME department preserves the existing decision + acceptance", async () => {
    const { lead, application } = await seed();
    await routeApplication(application.id, "EDUC", lead.id);
    await decideRoutedApplication(application.id, "ACCEPT", lead.id, "keep me");
    const again = await routeApplication(application.id, "EDUC", lead.id);
    expect(again.decision).toBe("ACCEPT");
    expect(again.decisionNotes).toBe("keep me");
    expect(await prisma.acceptance.count({ where: { applicationId: application.id, departmentCode: "EDUC" } })).toBe(1);
  });

  it("rejects routing a director-track application (routing is volunteer-only)", async () => {
    const { lead } = await seed();
    // The director track keeps its ranked-choice flow; it must never be routed.
    const term = await prisma.term.findFirstOrThrow();
    const cycle = await prisma.recruitmentCycle.create({ data: { track: "DIRECTOR", termId: term.id, title: "D", publicSlug: "d", departments: ["EDUC", "MDIC"], createdById: lead.id, status: "OPEN" } });
    const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "D", lastName: "R", email: "dr@y.edu", emailLower: "dr@y.edu" } });
    const application = await prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: ["EDUC"] } });
    await expect(routeApplication(application.id, "EDUC", lead.id)).rejects.toBeInstanceOf(RoutingError);
  });
});

describe("returnToRouting", () => {
  it("hands the applicant back: clears routing, records the department and reason, leaves the decision PENDING", async () => {
    const { lead, application } = await seed();
    await routeApplication(application.id, "EDUC", lead.id);

    const returned = await returnToRouting(application.id, lead.id, "Better suited to a clinical team.");

    // The declining department drops out of their own review queue, which gates
    // volunteer rows on routedDepartmentCode.
    expect(returned.routedDepartmentCode).toBeNull();
    expect(returned.returnedFromDepartmentCode).toBe("EDUC");
    expect(returned.returnedReason).toBe("Better suited to a clinical team.");
    expect(returned.returnedById).toBe(lead.id);
    expect(returned.returnedToRoutingAt).not.toBeNull();
    // Crucially NOT a rejection: the application is still live.
    expect(returned.decision).toBe("PENDING");

    const audit = await prisma.auditLog.findFirst({ where: { action: "recruitment.return_to_routing" } });
    expect(audit).not.toBeNull();
  });

  it("re-routing clears the returned marker so the applicant leaves the lead's queue", async () => {
    const { lead, application } = await seed();
    await routeApplication(application.id, "EDUC", lead.id);
    await returnToRouting(application.id, lead.id, "not us");

    const rerouted = await routeApplication(application.id, "MDIC", lead.id);

    expect(rerouted.routedDepartmentCode).toBe("MDIC");
    expect(rerouted.returnedToRoutingAt).toBeNull();
    expect(rerouted.returnedFromDepartmentCode).toBeNull();
    expect(rerouted.returnedReason).toBeNull();
    expect(rerouted.returnedById).toBeNull();
  });

  it("tears down a not-yet-emailed acceptance so releaseDecisions can't email it", async () => {
    const { lead, application } = await seed();
    await routeApplication(application.id, "EDUC", lead.id);
    await decideRoutedApplication(application.id, "ACCEPT", lead.id, null);

    await returnToRouting(application.id, lead.id, "changed our minds");

    expect(await prisma.acceptance.count({ where: { applicationId: application.id } })).toBe(0);
  });

  it("blocks the return once the acceptance was emailed (must be rescinded first)", async () => {
    const { lead, application } = await seed();
    await routeApplication(application.id, "EDUC", lead.id);
    await decideRoutedApplication(application.id, "ACCEPT", lead.id, null);
    await prisma.acceptance.updateMany({ where: { applicationId: application.id }, data: { emailedAt: new Date() } });

    await expect(returnToRouting(application.id, lead.id, null)).rejects.toBeInstanceOf(AcceptanceError);

    // Nothing moved: the applicant is still routed and still accepted.
    const app = await prisma.application.findUniqueOrThrow({ where: { id: application.id } });
    expect(app.routedDepartmentCode).toBe("EDUC");
    expect(app.returnedToRoutingAt).toBeNull();
  });

  it("rejects a return from someone outside the routed department's scope", async () => {
    const { lead, other, application } = await seed();
    await routeApplication(application.id, "EDUC", lead.id);
    await expect(returnToRouting(application.id, other.id, null)).rejects.toBeInstanceOf(RecruitmentAuthError);
  });

  it("rejects a return on an application that was never routed", async () => {
    const { lead, application } = await seed();
    await expect(returnToRouting(application.id, lead.id, null)).rejects.toBeInstanceOf(RoutingError);
  });

  it("normalizes a blank reason to null rather than storing whitespace", async () => {
    const { lead, application } = await seed();
    await routeApplication(application.id, "EDUC", lead.id);
    const returned = await returnToRouting(application.id, lead.id, "   ");
    expect(returned.returnedReason).toBeNull();
  });

  it("resets a non-PENDING decision, so the applicant leaves the waitlist they were handed back from (audit 14, REC-6)", async () => {
    const { lead, application } = await seed();
    await routeApplication(application.id, "EDUC", lead.id);
    await decideRoutedApplication(application.id, "WAITLIST", lead.id, "hold for capacity");

    const returned = await returnToRouting(application.id, lead.id, "not our fit after all");

    // Left at WAITLIST the applicant stayed on the waitlist page with a null
    // department and a Promote button that could only ever throw, because
    // decideRoutedApplication requires a routed department and the return just
    // cleared it.
    expect(returned.decision).toBe("PENDING");
    expect(returned.decidedAt).toBeNull();
    expect(returned.decidedById).toBeNull();
    expect(returned.decisionNotes).toBeNull();
    expect(returned.routedDepartmentCode).toBeNull();
  });
});

describe("decideRoutedApplication", () => {
  it("accepts a routed application: mints an Acceptance, sets Application.decision, audits", async () => {
    const { lead, application } = await seed();
    await routeApplication(application.id, "EDUC", lead.id);
    const decided = await decideRoutedApplication(application.id, "ACCEPT", lead.id, "great fit");
    expect(decided.decision).toBe("ACCEPT");
    const acc = await prisma.acceptance.findFirst({ where: { applicationId: application.id, departmentCode: "EDUC" } });
    expect(acc).not.toBeNull();
    const audit = await prisma.auditLog.findFirst({ where: { action: "recruitment.application_decide" } });
    expect(audit).not.toBeNull();
  });

  it("waitlist/reject sets the decision + notes without an Acceptance", async () => {
    const { lead, application } = await seed();
    await routeApplication(application.id, "EDUC", lead.id);
    const decided = await decideRoutedApplication(application.id, "WAITLIST", lead.id, "maybe next cycle");
    expect(decided.decision).toBe("WAITLIST");
    expect(decided.decisionNotes).toBe("maybe next cycle");
    expect(await prisma.acceptance.findMany({ where: { applicationId: application.id } })).toHaveLength(0);
  });

  it("removes a not-yet-emailed Acceptance when changing away from ACCEPT", async () => {
    const { lead, application } = await seed();
    await routeApplication(application.id, "EDUC", lead.id);
    await decideRoutedApplication(application.id, "ACCEPT", lead.id, null);
    await decideRoutedApplication(application.id, "REJECT", lead.id, null);
    expect(await prisma.acceptance.findMany({ where: { applicationId: application.id } })).toHaveLength(0);
  });

  it("aborts a decide whose read decision changed concurrently, leaving the winner intact (#106)", async () => {
    const { lead, application } = await seed();
    await routeApplication(application.id, "EDUC", lead.id);
    // Simulate a concurrent decide committing between the initial read and the
    // terminal write: flip the decision to ACCEPT during the decide's reviewScope.
    const spy = vi.spyOn(review, "reviewScope").mockImplementation(async () => {
      await prisma.application.update({
        where: { id: application.id },
        data: { decision: "ACCEPT", decidedById: lead.id, decidedAt: new Date() },
      });
      return { all: true, departmentCodes: [] };
    });
    try {
      await expect(decideRoutedApplication(application.id, "REJECT", lead.id, "no")).rejects.toBeInstanceOf(RoutingError);
    } finally {
      spy.mockRestore();
    }
    expect((await prisma.application.findUniqueOrThrow({ where: { id: application.id } })).decision).toBe("ACCEPT");
  });

  it("rejects deciding an application that hasn't been routed", async () => {
    const { lead, application } = await seed();
    await expect(decideRoutedApplication(application.id, "ACCEPT", lead.id, null)).rejects.toBeInstanceOf(RoutingError);
  });

  it("rejects a decider outside the routed department's scope", async () => {
    const { lead, other, application } = await seed();
    await routeApplication(application.id, "EDUC", lead.id);
    await expect(decideRoutedApplication(application.id, "ACCEPT", other.id, null)).rejects.toBeInstanceOf(RecruitmentAuthError);
  });

  it("rejects self-deciding (separation of duties)", async () => {
    const { lead, application } = await seed();
    await routeApplication(application.id, "EDUC", lead.id);
    await prisma.applicant.update({ where: { id: application.applicantId }, data: { applicantPersonId: lead.id } });
    await expect(decideRoutedApplication(application.id, "ACCEPT", lead.id, null)).rejects.toBeInstanceOf(RecruitmentAuthError);
  });
});

describe("rejectApplication", () => {
  it("rejects an unrouted application: sets decision REJECT, no acceptance, audits", async () => {
    const { lead, application } = await seed();
    const rejected = await rejectApplication(application.id, lead.id, "not a fit");
    expect(rejected.decision).toBe("REJECT");
    expect(rejected.routedDepartmentCode).toBeNull();
    expect(rejected.decisionNotes).toBe("not a fit");
    expect(await prisma.acceptance.count({ where: { applicationId: application.id } })).toBe(0);
    const audit = await prisma.auditLog.findFirst({ where: { action: "recruitment.application_reject" } });
    expect(audit).not.toBeNull();
  });

  it("rejects a non-lead", async () => {
    const { other, application } = await seed();
    await expect(rejectApplication(application.id, other.id, null)).rejects.toBeInstanceOf(RecruitmentAuthError);
  });

  it("blocks self-reject (separation of duties)", async () => {
    const { lead, application } = await seed();
    await prisma.applicant.update({ where: { id: application.applicantId }, data: { applicantPersonId: lead.id } });
    await expect(rejectApplication(application.id, lead.id, null)).rejects.toBeInstanceOf(RecruitmentAuthError);
  });

  it("clears a stale not-emailed acceptance so release can't still email it", async () => {
    const { lead, application } = await seed();
    await routeApplication(application.id, "EDUC", lead.id);
    await decideRoutedApplication(application.id, "ACCEPT", lead.id, null);
    const rejected = await rejectApplication(application.id, lead.id, null);
    expect(rejected.decision).toBe("REJECT");
    expect(await prisma.acceptance.count({ where: { applicationId: application.id } })).toBe(0);
  });

  it("refuses to reject once an acceptance was emailed", async () => {
    const { lead, application } = await seed();
    await routeApplication(application.id, "EDUC", lead.id);
    await decideRoutedApplication(application.id, "ACCEPT", lead.id, null);
    await prisma.acceptance.updateMany({ where: { applicationId: application.id }, data: { emailedAt: new Date() } });
    await expect(rejectApplication(application.id, lead.id, null)).rejects.toBeInstanceOf(AcceptanceError);
  });

  it("rejects a director-track application (routing is volunteer-only)", async () => {
    const { lead } = await seed();
    const term = await prisma.term.findFirstOrThrow();
    const cycle = await prisma.recruitmentCycle.create({ data: { track: "DIRECTOR", termId: term.id, title: "D", publicSlug: "drej", departments: ["EDUC"], createdById: lead.id, status: "OPEN" } });
    const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "D", lastName: "R", email: "drej@y.edu", emailLower: "drej@y.edu" } });
    const app = await prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: ["EDUC"] } });
    await expect(rejectApplication(app.id, lead.id, null)).rejects.toBeInstanceOf(RoutingError);
  });
});

describe("reopenDecision", () => {
  it("reopens a reject back to PENDING and audits", async () => {
    const { lead, application } = await seed();
    await rejectApplication(application.id, lead.id, "no");
    const reopened = await reopenDecision(application.id, lead.id);
    expect(reopened.decision).toBe("PENDING");
    expect(reopened.decidedAt).toBeNull();
    expect(reopened.decisionNotes).toBeNull();
    const audit = await prisma.auditLog.findFirst({ where: { action: "recruitment.application_reopen" } });
    expect(audit).not.toBeNull();
  });

  it("rejects a non-lead", async () => {
    const { lead, other, application } = await seed();
    await rejectApplication(application.id, lead.id, null);
    await expect(reopenDecision(application.id, other.id)).rejects.toBeInstanceOf(RecruitmentAuthError);
  });

  it("is blocked after the cycle's decisions were released", async () => {
    const { lead, application } = await seed();
    await rejectApplication(application.id, lead.id, null);
    await prisma.recruitmentCycle.update({ where: { id: application.cycleId }, data: { decisionsReleasedAt: new Date() } });
    await expect(reopenDecision(application.id, lead.id)).rejects.toBeInstanceOf(AcceptanceError);
  });

  it("refuses to reopen an application that has no decision yet", async () => {
    const { lead, application } = await seed();
    await expect(reopenDecision(application.id, lead.id)).rejects.toBeInstanceOf(RoutingError);
  });

  it("reopening a routed ACCEPT tears down the not-emailed acceptance so release can't email it", async () => {
    const { lead, application } = await seed();
    await routeApplication(application.id, "EDUC", lead.id);
    await decideRoutedApplication(application.id, "ACCEPT", lead.id, null);
    expect(await prisma.acceptance.count({ where: { applicationId: application.id } })).toBe(1);
    const reopened = await reopenDecision(application.id, lead.id);
    expect(reopened.decision).toBe("PENDING");
    expect(await prisma.acceptance.count({ where: { applicationId: application.id } })).toBe(0);
  });
});

describe("applyTierRoutes / applyTierRejects", () => {
  async function twoApps(leadId: string, cycleId: string) {
    const mk = async (n: string) => {
      const applicant = await prisma.applicant.create({ data: { cycleId, firstName: n, lastName: "X", email: `${n}@y.edu`, emailLower: `${n}@y.edu` } });
      return prisma.application.create({ data: { cycleId, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: ["EDUC"] } });
    };
    return { a: await mk("one"), b: await mk("two") };
  }

  it("routes every entry and reports the count", async () => {
    const { lead, application } = await seed();
    const { a, b } = await twoApps(lead.id, application.cycleId);
    const res = await applyTierRoutes(
      [{ applicationId: a.id, departmentCode: "EDUC" }, { applicationId: b.id, departmentCode: "MDIC" }],
      lead.id,
    );
    expect(res.applied).toBe(2);
    expect(res.skipped).toEqual([]);
    expect((await prisma.application.findUniqueOrThrow({ where: { id: a.id } })).routedDepartmentCode).toBe("EDUC");
    expect((await prisma.application.findUniqueOrThrow({ where: { id: b.id } })).routedDepartmentCode).toBe("MDIC");
  });

  it("skips a bad entry with a reason and still routes the rest", async () => {
    const { lead, application } = await seed();
    const { a, b } = await twoApps(lead.id, application.cycleId);
    const res = await applyTierRoutes(
      [{ applicationId: a.id, departmentCode: "EDUC" }, { applicationId: b.id, departmentCode: "NOPE" }],
      lead.id,
    );
    expect(res.applied).toBe(1);
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0].applicationId).toBe(b.id);
  });

  it("rejects a whole batch of applicants and reports the count", async () => {
    const { lead, application } = await seed();
    const { a, b } = await twoApps(lead.id, application.cycleId);
    const res = await applyTierRejects([a.id, b.id], lead.id, null);
    expect(res.applied).toBe(2);
    expect((await prisma.application.findUniqueOrThrow({ where: { id: a.id } })).decision).toBe("REJECT");
  });

  it("fails fast for a non-lead (permission checked once)", async () => {
    const { lead, other, application } = await seed();
    const { a } = await twoApps(lead.id, application.cycleId);
    await expect(applyTierRoutes([{ applicationId: a.id, departmentCode: "EDUC" }], other.id)).rejects.toBeInstanceOf(RecruitmentAuthError);
    await expect(applyTierRejects([a.id], other.id, null)).rejects.toBeInstanceOf(RecruitmentAuthError);
  });
});
