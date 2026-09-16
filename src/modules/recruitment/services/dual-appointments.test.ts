import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { listIncomingMembers } from "@/platform/recruitment/incoming-roster";
import { RecruitmentAuthError, listApplicantsForReview, revokeAcceptance } from "./review";
import { listConflicts, releaseDecisions, releaseSummary } from "./decisions";
import { contractDepartmentContext, createOrResendContract, listOnboardingRows } from "./onboarding";
import { promoteContracts } from "./promotion";
import { RoutingError, rejectApplication, routeApplication } from "./routing";
import {
  DualAppointmentError,
  approveDualAppointment,
  cancelDualAppointment,
  declineDualAppointment,
  listDualAppointmentSuggestions,
  listDualAppointments,
  requestDualAppointment,
} from "./dual-appointments";

/**
 * Dual appointments end to end at the service layer: a request and its approval,
 * and then every surface that used to treat two departments as a conflict --
 * release, onboarding, promotion, routing, the review scope, and the schedule
 * builder's incoming roster.
 *
 * The seed is the case ops actually has: a volunteer serving in two departments
 * renewed into one (FOOD), and the other (QAQI) wants to keep them.
 */
async function seed() {
  const term = await prisma.term.create({
    data: {
      code: "FA26", name: "Fall 2026", startDate: new Date(), endDate: new Date(Date.now() + 90 * 86_400_000),
      status: "ACTIVE", clinicDates: [],
    },
  });
  const food = await prisma.department.create({ data: { code: "FOOD", name: "Food Pantry" } });
  const qaqi = await prisma.department.create({ data: { code: "QAQI", name: "Quality Improvement" } });
  const jctp = await prisma.department.create({ data: { code: "JCTP", name: "Junior Clinicians" } });
  // A fourth department, for the cap: it is deliberately NOT one of the cycle's
  // own, because a second department need not be recruiting this cycle.
  const intp = await prisma.department.create({ data: { code: "INTP", name: "Interpreting" } });
  const manager = await prisma.person.create({ data: { name: "Morgan Manager", contactEmail: "manager@yale.edu", status: "ACTIVE" } });
  const role = await prisma.role.create({
    data: { name: "Volunteer Operations Manager", grants: { create: [{ permission: "recruitment.review_all" }] } },
  });
  await prisma.roleAssignment.create({ data: { personId: manager.id, roleId: role.id } });
  // A QAQI director: a DIRECTOR membership in the live term is a review scope.
  const director = await prisma.person.create({ data: { name: "Dana Director", contactEmail: "dana@yale.edu", status: "ACTIVE" } });
  await prisma.termMembership.create({ data: { personId: director.id, termId: term.id, departmentId: qaqi.id, kind: "DIRECTOR" } });
  const cycle = await prisma.recruitmentCycle.create({
    data: {
      track: "VOLUNTEER", termId: term.id, title: "Volunteer Fall 2026", publicSlug: `v-${Math.random()}`,
      departments: ["FOOD", "QAQI", "JCTP"], createdById: manager.id, status: "CLOSED",
    },
  });
  const applicant = await prisma.applicant.create({
    data: {
      cycleId: cycle.id, firstName: "Adrienne", lastName: "Nguyen",
      email: "adrienne@yale.edu", emailLower: "adrienne@yale.edu", netId: "an123",
    },
  });
  const app = await prisma.application.create({
    data: {
      cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "RENEWAL",
      departmentChoices: ["FOOD"], routedDepartmentCode: "FOOD", decision: "ACCEPT", submittedAt: new Date(),
    },
  });
  await prisma.acceptance.create({ data: { applicationId: app.id, departmentCode: "FOOD", approvedById: manager.id } });
  return { term, food, qaqi, jctp, intp, manager, director, cycle, applicant, app };
}

const acceptedCodes = async (applicationId: string) =>
  (await prisma.acceptance.findMany({ where: { applicationId }, select: { departmentCode: true } }))
    .map((a) => a.departmentCode)
    .sort();

beforeEach(async () => {
  await resetDb();
});
afterEach(async () => {
  await resetDb();
});

describe("requests and approvals", () => {
  it("a director's request waits for a manager, and approval accepts them into both departments", async () => {
    const s = await seed();
    const req = await requestDualAppointment(s.director.id, {
      applicationId: s.app.id, departmentCode: "QAQI", reason: "Leads our intake audits.",
    });
    expect(req.status).toBe("PENDING");
    expect(await acceptedCodes(s.app.id)).toEqual(["FOOD"]);
    expect(
      await prisma.emailLog.count({ where: { template: "recruitment.dual_appointment_requested", toEmail: "manager@yale.edu" } }),
    ).toBe(1);

    const { roster } = await approveDualAppointment(s.manager.id, req.id, "Agreed.");
    expect(roster).toBe("at_promotion");
    expect(await acceptedCodes(s.app.id)).toEqual(["FOOD", "QAQI"]);
    expect(await listConflicts(s.cycle.id)).toEqual([]);
    expect(
      await prisma.emailLog.count({ where: { template: "recruitment.dual_appointment_decided", toEmail: "dana@yale.edu" } }),
    ).toBe(1);
  });

  it("a director must say why, may ask only for their own department, and cannot approve", async () => {
    const s = await seed();
    await expect(
      requestDualAppointment(s.director.id, { applicationId: s.app.id, departmentCode: "QAQI", reason: "  " }),
    ).rejects.toThrow(DualAppointmentError);
    await expect(
      requestDualAppointment(s.director.id, { applicationId: s.app.id, departmentCode: "JCTP", reason: "Please" }),
    ).rejects.toThrow(RecruitmentAuthError);
    const req = await requestDualAppointment(s.director.id, { applicationId: s.app.id, departmentCode: "QAQI", reason: "Please" });
    await expect(approveDualAppointment(s.director.id, req.id)).rejects.toThrow(RecruitmentAuthError);
  });

  it("a manager's add is approved at once, and a volunteer serves in three departments at most", async () => {
    const s = await seed();
    const added = await requestDualAppointment(s.manager.id, { applicationId: s.app.id, departmentCode: "QAQI" });
    expect(added.status).toBe("APPROVED");
    // FOOD (routed) + QAQI + JCTP is the cap, and none of it is a conflict.
    const third = await requestDualAppointment(s.manager.id, { applicationId: s.app.id, departmentCode: "JCTP" });
    expect(third.status).toBe("APPROVED");
    expect(await acceptedCodes(s.app.id)).toEqual(["FOOD", "JCTP", "QAQI"]);
    expect(await listConflicts(s.cycle.id)).toEqual([]);
    // A fourth is one too many.
    await expect(
      requestDualAppointment(s.manager.id, { applicationId: s.app.id, departmentCode: "INTP" }),
    ).rejects.toThrow(/3 departments at most/);
    await expect(
      requestDualAppointment(s.manager.id, { applicationId: s.app.id, departmentCode: "FOOD" }),
    ).rejects.toThrow(/already routed/);
  });

  it("applies to volunteer cycles only", async () => {
    const s = await seed();
    await prisma.recruitmentCycle.update({ where: { id: s.cycle.id }, data: { track: "DIRECTOR" } });
    await expect(
      requestDualAppointment(s.manager.id, { applicationId: s.app.id, departmentCode: "QAQI" }),
    ).rejects.toThrow(/volunteer cycles/);
  });

  it("a cancelled dual appointment frees its slot", async () => {
    const s = await seed();
    await requestDualAppointment(s.manager.id, { applicationId: s.app.id, departmentCode: "QAQI" });
    const second = await requestDualAppointment(s.manager.id, { applicationId: s.app.id, departmentCode: "JCTP" });
    await expect(
      requestDualAppointment(s.manager.id, { applicationId: s.app.id, departmentCode: "INTP" }),
    ).rejects.toThrow(/departments at most/);

    await cancelDualAppointment(s.manager.id, second.id, "Not this term after all");

    const replacement = await requestDualAppointment(s.manager.id, { applicationId: s.app.id, departmentCode: "INTP" });
    expect(replacement.status).toBe("APPROVED");
    expect(await acceptedCodes(s.app.id)).toEqual(["FOOD", "INTP", "QAQI"]);
  });

  it("counts a pending request against the cap, so two directors cannot both be waiting on a third slot", async () => {
    const s = await seed();
    await requestDualAppointment(s.director.id, { applicationId: s.app.id, departmentCode: "QAQI", reason: "Keep" });
    await requestDualAppointment(s.manager.id, { applicationId: s.app.id, departmentCode: "JCTP" });
    await expect(
      requestDualAppointment(s.manager.id, { applicationId: s.app.id, departmentCode: "INTP" }),
    ).rejects.toThrow(/3 departments at most/);
  });

  it("a declined request can be asked again, and the asking director can withdraw it", async () => {
    const s = await seed();
    const req = await requestDualAppointment(s.director.id, { applicationId: s.app.id, departmentCode: "QAQI", reason: "One" });
    await declineDualAppointment(s.manager.id, req.id, "Not this term");
    expect((await prisma.dualAppointment.findUniqueOrThrow({ where: { id: req.id } })).status).toBe("DECLINED");
    expect(await acceptedCodes(s.app.id)).toEqual(["FOOD"]);

    const again = await requestDualAppointment(s.director.id, { applicationId: s.app.id, departmentCode: "QAQI", reason: "Two" });
    expect(again.id).toBe(req.id);
    await cancelDualAppointment(s.director.id, again.id);
    expect((await prisma.dualAppointment.findUniqueOrThrow({ where: { id: req.id } })).status).toBe("CANCELLED");
  });

  it("cancelling an approval removes the acceptance it minted", async () => {
    const s = await seed();
    const added = await requestDualAppointment(s.manager.id, { applicationId: s.app.id, departmentCode: "QAQI" });
    await cancelDualAppointment(s.manager.id, added.id, "Changed our minds");
    expect(await acceptedCodes(s.app.id)).toEqual(["FOOD"]);
    expect((await prisma.dualAppointment.findUniqueOrThrow({ where: { id: added.id } })).status).toBe("CANCELLED");
  });

  it("revoking the second acceptance cancels the dual appointment behind it", async () => {
    const s = await seed();
    const added = await requestDualAppointment(s.manager.id, { applicationId: s.app.id, departmentCode: "QAQI" });
    const acc = await prisma.acceptance.findUniqueOrThrow({
      where: { applicationId_departmentCode: { applicationId: s.app.id, departmentCode: "QAQI" } },
    });
    await revokeAcceptance(acc.id, s.manager.id);
    expect((await prisma.dualAppointment.findUniqueOrThrow({ where: { id: added.id } })).status).toBe("CANCELLED");
  });
});

describe("decisions", () => {
  it("without an approval two departments are still a conflict, and keeping both settles it", async () => {
    const s = await seed();
    await prisma.acceptance.create({ data: { applicationId: s.app.id, departmentCode: "QAQI", approvedById: s.manager.id } });
    const conflicts = await listConflicts(s.cycle.id);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].canBecomeDualAppointment).toBe(true);

    await requestDualAppointment(s.manager.id, { applicationId: s.app.id, departmentCode: "QAQI" });
    expect(await listConflicts(s.cycle.id)).toEqual([]);
    expect(await acceptedCodes(s.app.id)).toEqual(["FOOD", "QAQI"]);
  });

  it("release sends one acceptance email naming both departments", async () => {
    const s = await seed();
    await requestDualAppointment(s.manager.id, { applicationId: s.app.id, departmentCode: "QAQI" });
    const summary = await releaseSummary(s.cycle.id);
    expect(summary).toMatchObject({ acceptedApplications: 1, conflictedApplications: 0, unnotified: 1, dualAppointments: 1 });

    expect(await releaseDecisions(s.cycle.id, s.manager.id)).toEqual({ sent: 1, skippedConflicted: 0 });
    const emails = await prisma.emailLog.findMany({ where: { template: "recruitment.acceptance" } });
    expect(emails).toHaveLength(1);
    expect(emails[0].html).toContain("Food Pantry and Quality Improvement");
    expect(emails[0].subject).toContain("FOOD, QAQI");
    expect(await prisma.acceptance.count({ where: { applicationId: s.app.id, emailedAt: null } })).toBe(0);
  });

  it("three departments: one acceptance email naming all three, one contract, three rosters", async () => {
    const s = await seed();
    await requestDualAppointment(s.manager.id, { applicationId: s.app.id, departmentCode: "QAQI" });
    await requestDualAppointment(s.manager.id, { applicationId: s.app.id, departmentCode: "JCTP" });
    // The real QAQI is "Quality Assurance and Quality Improvement": a department
    // name with "and" inside it, which is what the comma fallback exists for.
    await prisma.department.update({
      where: { id: s.qaqi.id },
      data: { name: "Quality Assurance and Quality Improvement" },
    });
    expect(await acceptedCodes(s.app.id)).toEqual(["FOOD", "JCTP", "QAQI"]);
    expect(await listConflicts(s.cycle.id)).toEqual([]);

    // Release: ONE email, naming every department that accepted them.
    expect(await releaseDecisions(s.cycle.id, s.manager.id)).toEqual({ sent: 1, skippedConflicted: 0 });
    const emails = await prisma.emailLog.findMany({ where: { template: "recruitment.acceptance" } });
    expect(emails).toHaveLength(1);
    // Written out in the body, and separated by commas alone: "Food Pantry and
    // Quality Assurance and Quality Improvement" would read as two more departments.
    expect(emails[0].html).toContain("Food Pantry, Quality Assurance and Quality Improvement, Junior Clinicians");
    // Abbreviated in the subject, in the order the acceptances were claimed.
    expect(emails[0].subject).toContain("FOOD, QAQI, JCTP");
    expect(await prisma.acceptance.count({ where: { applicationId: s.app.id, emailedAt: null } })).toBe(0);

    // Onboarding: the two dual appointments ride on the routed department's form.
    const rows = await listOnboardingRows(s.cycle.id);
    expect(rows.filter((r) => r.state === "DUAL").map((r) => r.departmentCode).sort()).toEqual(["JCTP", "QAQI"]);
    const anchor = rows.find((r) => r.state !== "DUAL")!;
    expect(anchor.departmentCode).toBe("FOOD");

    const contract = await createOrResendContract(anchor.acceptanceId, s.manager.id, "https://hub.test");
    await prisma.onboardingContract.update({ where: { id: contract.id }, data: { status: "SUBMITTED", submittedAt: new Date() } });
    expect(await promoteContracts([contract.id], s.manager.id)).toMatchObject({ failed: 0, skipped: 0 });

    const person = await prisma.person.findFirstOrThrow({ where: { contactEmail: "adrienne@yale.edu" } });
    const memberships = await prisma.termMembership.findMany({
      where: { personId: person.id, termId: s.term.id, status: "ACTIVE" },
      select: { department: { select: { code: true } } },
    });
    expect(memberships.map((m) => m.department.code).sort()).toEqual(["FOOD", "JCTP", "QAQI"]);
    const welcome = await prisma.emailLog.findFirstOrThrow({ where: { template: "recruitment.roster_welcome" } });
    for (const name of ["Food Pantry", "Quality Assurance and Quality Improvement", "Junior Clinicians"]) {
      expect(welcome.html).toContain(name);
    }
  });

  it("rejecting the routed decision leaves the dual appointment's acceptance standing", async () => {
    const s = await seed();
    await requestDualAppointment(s.manager.id, { applicationId: s.app.id, departmentCode: "QAQI" });
    await rejectApplication(s.app.id, s.manager.id, null);
    expect(await acceptedCodes(s.app.id)).toEqual(["QAQI"]);
  });

  it("refuses to route the application to its dual appointment's department", async () => {
    const s = await seed();
    await requestDualAppointment(s.manager.id, { applicationId: s.app.id, departmentCode: "QAQI" });
    await expect(routeApplication(s.app.id, "QAQI", s.manager.id)).rejects.toThrow(RoutingError);
  });
});

describe("who sees what", () => {
  it("an approval opens the application to the second department's director; a pending request does not", async () => {
    const s = await seed();
    const req = await requestDualAppointment(s.director.id, { applicationId: s.app.id, departmentCode: "QAQI", reason: "Keep" });
    expect(await listApplicantsForReview(s.cycle.id, s.director.id)).toHaveLength(0);
    const mine = await listDualAppointments({ cycleId: s.cycle.id }, s.director.id);
    expect(mine.map((r) => [r.departmentCode, r.canDecide, r.canCancel, r.canOpenApplication])).toEqual([["QAQI", false, true, false]]);

    await approveDualAppointment(s.manager.id, req.id);
    expect((await listApplicantsForReview(s.cycle.id, s.director.id)).map((a) => a.id)).toEqual([s.app.id]);
  });

  it("suggests a director's current volunteers who applied to another department", async () => {
    const s = await seed();
    const volunteer = await prisma.person.create({ data: { name: "Adrienne Nguyen", contactEmail: "adrienne@yale.edu", status: "ACTIVE" } });
    await prisma.termMembership.create({ data: { personId: volunteer.id, termId: s.term.id, departmentId: s.qaqi.id, kind: "VOLUNTEER" } });
    await prisma.applicant.update({ where: { id: s.applicant.id }, data: { applicantPersonId: volunteer.id } });

    const suggestions = await listDualAppointmentSuggestions(s.cycle.id, s.director.id);
    expect(suggestions.map((x) => [x.applicationId, x.departmentCode, x.routedDepartmentCode])).toEqual([[s.app.id, "QAQI", "FOOD"]]);

    await requestDualAppointment(s.director.id, { applicationId: s.app.id, departmentCode: "QAQI", reason: "Keep" });
    expect(await listDualAppointmentSuggestions(s.cycle.id, s.director.id)).toEqual([]);
  });
});

describe("onboarding and promotion", () => {
  it("the form covers both departments, and the stricter Epic rule applies", async () => {
    const s = await seed();
    await prisma.department.update({ where: { id: s.qaqi.id }, data: { requiresEpicVolunteer: "ALL" } });
    await requestDualAppointment(s.manager.id, { applicationId: s.app.id, departmentCode: "QAQI" });
    const ctx = await contractDepartmentContext({ applicationId: s.app.id, departmentCode: "FOOD" }, "VOLUNTEER");
    expect(ctx).toEqual({ department: "FOOD", additionalDepartments: ["QAQI"], epicRequirement: "ALL" });
  });

  it("onboards through one contract and promotes them onto both rosters with both departments' drafts", async () => {
    const s = await seed();
    await requestDualAppointment(s.manager.id, { applicationId: s.app.id, departmentCode: "QAQI" });
    const qaqiAcceptance = await prisma.acceptance.findUniqueOrThrow({
      where: { applicationId_departmentCode: { applicationId: s.app.id, departmentCode: "QAQI" } },
    });
    // QAQI drafted a shift against the acceptance before they existed as a person.
    const clinicDate = new Date("2026-10-03T12:00:00Z");
    await prisma.incomingShiftAssignment.create({
      data: { acceptanceId: qaqiAcceptance.id, termId: s.term.id, departmentId: s.qaqi.id, clinicDate, role: "VOLUNTEER" },
    });

    const rows = await listOnboardingRows(s.cycle.id);
    const foodRow = rows.find((r) => r.departmentCode === "FOOD")!;
    const qaqiRow = rows.find((r) => r.departmentCode === "QAQI")!;
    expect(foodRow.state).toBe("NO_CONTRACT");
    expect(qaqiRow).toMatchObject({ state: "DUAL", onboardsWith: "FOOD" });
    await expect(createOrResendContract(qaqiRow.acceptanceId, s.manager.id, "https://hub.test")).rejects.toThrow(/one form/);

    expect((await listIncomingMembers({ termId: s.term.id, departmentCode: "QAQI", clinicDates: [] })).map((m) => m.acceptanceId)).toEqual([
      qaqiAcceptance.id,
    ]);

    const contract = await createOrResendContract(foodRow.acceptanceId, s.manager.id, "https://hub.test");
    await prisma.onboardingContract.update({ where: { id: contract.id }, data: { status: "SUBMITTED", submittedAt: new Date() } });
    const result = await promoteContracts([contract.id], s.manager.id);
    expect(result).toMatchObject({ failed: 0, skipped: 0 });

    const person = await prisma.person.findFirstOrThrow({ where: { contactEmail: "adrienne@yale.edu" } });
    const memberships = await prisma.termMembership.findMany({
      where: { personId: person.id, termId: s.term.id, status: "ACTIVE" },
      select: { department: { select: { code: true } } },
    });
    expect(memberships.map((m) => m.department.code).sort()).toEqual(["FOOD", "QAQI"]);
    expect(await prisma.shiftAssignment.count({ where: { personId: person.id, departmentId: s.qaqi.id, clinicDate } })).toBe(1);
    expect(await prisma.incomingShiftAssignment.count()).toBe(0);
    // No longer incoming anywhere: they are a member of both departments now.
    expect(await listIncomingMembers({ termId: s.term.id, departmentCode: "QAQI", clinicDates: [] })).toEqual([]);

    const welcome = await prisma.emailLog.findFirstOrThrow({ where: { template: "recruitment.roster_welcome" } });
    expect(welcome.html).toContain("Food Pantry and Quality Improvement");
    const after = await listOnboardingRows(s.cycle.id);
    expect(after.find((r) => r.departmentCode === "QAQI")!.onRoster).toBe(true);
  });

  it("approving after promotion adds the second membership straight away, and cannot then be cancelled", async () => {
    const s = await seed();
    const foodAcceptance = await prisma.acceptance.findFirstOrThrow({ where: { applicationId: s.app.id } });
    const contract = await createOrResendContract(foodAcceptance.id, s.manager.id, "https://hub.test");
    await prisma.onboardingContract.update({ where: { id: contract.id }, data: { status: "SUBMITTED", submittedAt: new Date() } });
    await promoteContracts([contract.id], s.manager.id);

    const req = await requestDualAppointment(s.director.id, { applicationId: s.app.id, departmentCode: "QAQI", reason: "Keep" });
    const { roster } = await approveDualAppointment(s.manager.id, req.id);
    expect(roster).toBe("added");
    const person = await prisma.person.findFirstOrThrow({ where: { contactEmail: "adrienne@yale.edu" } });
    expect(
      await prisma.termMembership.count({ where: { personId: person.id, termId: s.term.id, departmentId: s.qaqi.id, status: "ACTIVE" } }),
    ).toBe(1);
    await expect(cancelDualAppointment(s.manager.id, req.id)).rejects.toThrow(/roster/);
  });
});
