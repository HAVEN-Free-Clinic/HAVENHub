/**
 * TDD tests for the volunteers disciplinary service.
 *
 * issueAction(actorPersonId, input):
 *   - Director issues for own-dept member; action created; audit row exists.
 *   - Delegation edge: PCAR director managing dept B via DepartmentDelegation can issue.
 *   - Cross-dept director gets DisciplinaryForbiddenError.
 *   - Central (incidents.manage) can issue for anyone.
 *   - Validation: bad category -> DisciplinaryValidationError.
 *   - Validation: blank description -> DisciplinaryValidationError.
 *   - Validation: future occurredAt -> DisciplinaryValidationError.
 *   - Missing person -> DisciplinaryNotFoundError.
 *   - No active term, no permission -> DisciplinaryForbiddenError.
 *   - reportId already carrying a strike for this person -> readable
 *     DisciplinaryValidationError, not a raw 500 (composite unique collision).
 *   - Nonexistent reportId -> DisciplinaryNotFoundError.
 *
 * deleteAction(actorPersonId, id):
 *   - Central can delete; audit before snapshot present.
 *   - Director cannot delete -> DisciplinaryForbiddenError.
 *   - Missing row -> DisciplinaryNotFoundError.
 *   - Deleting a strike linked to a DECLINED-request report leaves that
 *     subject row untouched (no resurrection).
 *   - Deleting a strike linked to an APPROVED-request report resets that
 *     subject row to PENDING so it can be re-approved.
 *
 * listActions(viewerPersonId, q):
 *   - Central sees ALL rows (canManageAll true), including confidential of others.
 *   - Issuing director sees own confidential row.
 *   - Second director of SAME department does NOT see first director's confidential row
 *     but DOES see non-confidential rows.
 *   - No-directorship viewer -> DisciplinaryForbiddenError.
 *   - Unrelated-dept director -> 0 rows (empty, no error).
 *   - departmentId filter (central allowed, non-central allowed for own dept, forbidden for other dept).
 *   - category filter exact match.
 *   - q name search case-insensitive.
 *   - Pagination: 26 rows -> page 2 has 1 row.
 *
 * strikeCount(personId):
 *   - Person with 3 actions shows strikeCount 3.
 *   - Central rows' strikes field matches strikeCount (all actions).
 *   - Director rows' strikes field counts only actions visible to that
 *     director (non-confidential OR issued by them) so confidential records
 *     raised by others do not leak via the count.
 *
 * visibleStrikeCount(personId, viewerPersonId):
 *   - Counts non-confidential rows plus confidential rows the viewer issued
 *     themselves.
 *   - Excludes a confidential row issued by someone else.
 *
 * issuablePeople(actorPersonId):
 *   - Central -> { all: true, people: [] }.
 *   - Director -> deduped members with departmentNames, sorted by name.
 *   - Delegation: delegated-dept members included.
 *   - No directorships -> { all: false, people: [] }.
 *
 * strikeablePeople(actorPersonId):
 *   - Non-central actor -> [].
 *   - Includes OFFBOARDED people so a strike can still be recorded against them.
 *   - Sorts ACTIVE people before OFFBOARDED ones, then by name.
 *   - Hints the active-term department code and volunteer/director kind.
 *
 * linkActionToReport(actorPersonId, actionId, reportId):
 *   - Links a strike to a report; audit row recorded.
 *   - Unlinks when passed null.
 *   - Unlinking a report-derived strike reverts its APPROVED subject row to
 *     PENDING so it can be re-approved.
 *   - Relinking to a different report reverts the PREVIOUS report's APPROVED
 *     subject row to PENDING the same way.
 *   - Rejects an actor without incidents.manage -> DisciplinaryForbiddenError.
 *   - Unknown action or report -> DisciplinaryNotFoundError.
 *   - Composite-unique collision -> readable DisciplinaryValidationError.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  issueAction,
  deleteAction,
  listActions,
  issuablePeople,
  strikeablePeople,
  strikeCount,
  visibleStrikeCount,
  listMyStrikes,
  subjectFacingDetail,
  setDoNotRehire,
  getRehireFlag,
  linkActionToReport,
  DISCIPLINARY_CATEGORIES,
  DisciplinaryForbiddenError,
  DisciplinaryNotFoundError,
  DisciplinaryValidationError,
} from "./disciplinary";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createPerson(name: string, netId?: string) {
  return prisma.person.create({ data: { name, netId } });
}

async function createTerm(
  status: "ACTIVE" | "ARCHIVED" | "PLANNING" = "ACTIVE",
  code = "SU26"
) {
  return prisma.term.create({
    data: {
      code,
      name: `Term ${code}`,
      startDate: new Date("2026-05-01"),
      endDate: new Date("2026-09-26"),
      status,
    },
  });
}

async function createDepartment(code: string) {
  return prisma.department.upsert({
    where: { code },
    update: {},
    create: { code, name: `${code} Dept` },
  });
}

async function createMembership(
  personId: string,
  termId: string,
  departmentId: string,
  kind: "VOLUNTEER" | "DIRECTOR",
  status: "ACTIVE" | "REMOVED" = "ACTIVE"
) {
  return prisma.termMembership.create({
    data: { personId, termId, departmentId, kind, status },
  });
}

async function grantPermission(personId: string, permission: string) {
  const role = await prisma.role.create({
    data: {
      name: `Role-${permission}-${Date.now()}-${Math.random()}`,
      isSystem: false,
      grants: { create: [{ permission }] },
    },
  });
  await prisma.roleAssignment.create({ data: { roleId: role.id, personId, termId: null } });
}

async function delegate(managerDepartmentId: string, managedDepartmentId: string) {
  return prisma.departmentDelegation.create({
    data: { managerDepartmentId, managedDepartmentId },
  });
}

/** Convenience: issue an action as a central actor bypassing scope */
async function issueCentral(
  actorId: string,
  targetId: string,
  overrides: Partial<{
    category: string;
    description: string;
    occurredAt: Date;
    confidential: boolean;
  }> = {}
) {
  return issueAction(actorId, {
    personId: targetId,
    occurredAt: overrides.occurredAt ?? new Date("2026-04-01"),
    category: overrides.category ?? DISCIPLINARY_CATEGORIES[0],
    description: overrides.description ?? "Test incident",
    confidential: overrides.confidential ?? false,
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(resetDb);

describe("issueAction", () => {
  it("director issues for own-dept member; action created; audit row exists", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const actor = await createPerson("Director", "dir001");
    const target = await createPerson("Volunteer", "vol001");

    await createMembership(actor.id, term.id, dept.id, "DIRECTOR");
    await createMembership(target.id, term.id, dept.id, "VOLUNTEER");

    const action = await issueAction(actor.id, {
      personId: target.id,
      occurredAt: new Date("2026-04-15"),
      category: "Attendance",
      description: "Missed shift without notice",
      confidential: true,
      patientInvolved: false,
    });

    expect(action.personId).toBe(target.id);
    expect(action.issuedById).toBe(actor.id);
    expect(action.category).toBe("Attendance");
    expect(action.confidential).toBe(true);
    expect(action.patientInvolved).toBe(false);

    const auditRow = await prisma.auditLog.findFirst({
      where: { action: "disciplinary.issue", entityId: action.id },
    });
    expect(auditRow).not.toBeNull();
    expect(auditRow?.actorPersonId).toBe(actor.id);
    const after = auditRow?.after as Record<string, unknown>;
    expect(after.personId).toBe(target.id);
    expect(after.category).toBe("Attendance");
    expect(after.confidential).toBe(true);
  });

  it("delegation edge: PCAR director can issue for member of delegated dept", async () => {
    const term = await createTerm();
    const pcar = await createDepartment("PCAR");
    const sctp = await createDepartment("SCTP");
    await delegate(pcar.id, sctp.id);

    const actor = await createPerson("PCAR Dir", "pcd01");
    const target = await createPerson("SCTP Vol", "sv01");

    await createMembership(actor.id, term.id, pcar.id, "DIRECTOR");
    await createMembership(target.id, term.id, sctp.id, "VOLUNTEER");

    const action = await issueAction(actor.id, {
      personId: target.id,
      occurredAt: new Date("2026-04-01"),
      category: "Professionalism",
      description: "Delegated dept test",
    });

    expect(action.personId).toBe(target.id);
  });

  it("cross-dept director cannot issue for unrelated dept member", async () => {
    const term = await createTerm();
    const deptA = await createDepartment("ITCM");
    const deptB = await createDepartment("SRR");

    const actor = await createPerson("DirA", "dira01");
    const target = await createPerson("VolB", "volb01");

    await createMembership(actor.id, term.id, deptA.id, "DIRECTOR");
    await createMembership(target.id, term.id, deptB.id, "VOLUNTEER");

    await expect(
      issueAction(actor.id, {
        personId: target.id,
        occurredAt: new Date("2026-04-01"),
        category: "Attendance",
        description: "Test",
      })
    ).rejects.toBeInstanceOf(DisciplinaryForbiddenError);
  });

  it("central holder of incidents.manage can issue for anyone", async () => {
    const term = await createTerm();
    const dept = await createDepartment("SRR");
    const actor = await createPerson("Central", "ctr001");
    const target = await createPerson("Anyone", "any001");

    await grantPermission(actor.id, "incidents.manage");
    await createMembership(target.id, term.id, dept.id, "VOLUNTEER");

    const action = await issueCentral(actor.id, target.id);
    expect(action.personId).toBe(target.id);
  });

  it("no active term and no permission -> DisciplinaryForbiddenError", async () => {
    await createTerm("ARCHIVED");
    const actor = await createPerson("Director", "dir001");
    const target = await createPerson("Volunteer", "vol001");

    await expect(
      issueAction(actor.id, {
        personId: target.id,
        occurredAt: new Date("2026-04-01"),
        category: "Attendance",
        description: "Test",
      })
    ).rejects.toBeInstanceOf(DisciplinaryForbiddenError);
  });

  it("validation: category not in DISCIPLINARY_CATEGORIES -> DisciplinaryValidationError", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const actor = await createPerson("Director", "dir001");
    const target = await createPerson("Volunteer", "vol001");

    await createMembership(actor.id, term.id, dept.id, "DIRECTOR");
    await createMembership(target.id, term.id, dept.id, "VOLUNTEER");

    await expect(
      issueAction(actor.id, {
        personId: target.id,
        occurredAt: new Date("2026-04-01"),
        category: "NotACategory",
        description: "Test",
      })
    ).rejects.toBeInstanceOf(DisciplinaryValidationError);
  });

  it("validation: blank description -> DisciplinaryValidationError", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const actor = await createPerson("Director", "dir001");
    const target = await createPerson("Volunteer", "vol001");

    await createMembership(actor.id, term.id, dept.id, "DIRECTOR");
    await createMembership(target.id, term.id, dept.id, "VOLUNTEER");

    await expect(
      issueAction(actor.id, {
        personId: target.id,
        occurredAt: new Date("2026-04-01"),
        category: "Attendance",
        description: "   ",
      })
    ).rejects.toBeInstanceOf(DisciplinaryValidationError);
  });

  it("validation: future occurredAt -> DisciplinaryValidationError", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const actor = await createPerson("Director", "dir001");
    const target = await createPerson("Volunteer", "vol001");

    await createMembership(actor.id, term.id, dept.id, "DIRECTOR");
    await createMembership(target.id, term.id, dept.id, "VOLUNTEER");

    const futureDate = new Date(Date.now() + 86400_000 * 2);

    await expect(
      issueAction(actor.id, {
        personId: target.id,
        occurredAt: futureDate,
        category: "Attendance",
        description: "Test",
      })
    ).rejects.toBeInstanceOf(DisciplinaryValidationError);
  });

  it("missing person -> DisciplinaryNotFoundError", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const actor = await createPerson("Director", "dir001");
    await createMembership(actor.id, term.id, dept.id, "DIRECTOR");

    await expect(
      issueAction(actor.id, {
        personId: "nonexistent-person-id",
        occurredAt: new Date("2026-04-01"),
        category: "Attendance",
        description: "Test",
      })
    ).rejects.toBeInstanceOf(DisciplinaryNotFoundError);
  });

  it("defaults confidential and patientInvolved to false when omitted", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const actor = await createPerson("Director", "dir001");
    const target = await createPerson("Volunteer", "vol001");

    await createMembership(actor.id, term.id, dept.id, "DIRECTOR");
    await createMembership(target.id, term.id, dept.id, "VOLUNTEER");

    const action = await issueAction(actor.id, {
      personId: target.id,
      occurredAt: new Date("2026-04-01"),
      category: "Attendance",
      description: "Test defaults",
    });

    expect(action.confidential).toBe(false);
    expect(action.patientInvolved).toBe(false);
  });

  it("reportId that already has a strike for this person -> readable DisciplinaryValidationError, not a raw 500", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const central = await createPerson("Central", "ia-dup-c");
    const subject = await createPerson("Subject", "ia-dup-s");
    const reporter = await createPerson("Reporter", "ia-dup-r");
    await grantPermission(central.id, "incidents.manage");
    await createMembership(subject.id, term.id, dept.id, "VOLUNTEER");

    const report = await prisma.incidentReport.create({
      data: {
        number: Math.floor(Math.random() * 100000) + 10000,
        reporterId: reporter.id,
        concernTypes: ["OTHER"],
        description: "Report already carrying a strike for this person.",
      },
    });

    await issueAction(central.id, {
      personId: subject.id,
      occurredAt: new Date("2026-07-01"),
      category: "Attendance",
      description: "First strike, linked directly to the report on issue.",
      reportId: report.id,
    });

    await expect(
      issueAction(central.id, {
        personId: subject.id,
        occurredAt: new Date("2026-07-02"),
        category: "Professionalism",
        description: "A second strike for the same person, same report.",
        reportId: report.id,
      })
    ).rejects.toBeInstanceOf(DisciplinaryValidationError);
  });

  it("a nonexistent reportId -> DisciplinaryNotFoundError", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const central = await createPerson("Central", "ia-404-c");
    const subject = await createPerson("Subject", "ia-404-s");
    await grantPermission(central.id, "incidents.manage");
    await createMembership(subject.id, term.id, dept.id, "VOLUNTEER");

    await expect(
      issueAction(central.id, {
        personId: subject.id,
        occurredAt: new Date("2026-07-01"),
        category: "Attendance",
        description: "Test",
        reportId: "no-such-report",
      })
    ).rejects.toBeInstanceOf(DisciplinaryNotFoundError);
  });
});

describe("deleteAction", () => {
  it("central can delete; audit before snapshot carries metadata but NOT the narrative", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const central = await createPerson("Central", "ctr001");
    const target = await createPerson("Volunteer", "vol001");

    await grantPermission(central.id, "incidents.manage");
    await createMembership(target.id, term.id, dept.id, "VOLUNTEER");

    const action = await issueCentral(central.id, target.id, { description: "Serious incident" });

    await deleteAction(central.id, action.id);

    // Row deleted.
    const row = await prisma.disciplinaryAction.findUnique({ where: { id: action.id } });
    expect(row).toBeNull();

    // Audit row with before snapshot.
    const auditRow = await prisma.auditLog.findFirst({
      where: { action: "disciplinary.delete", entityId: action.id },
    });
    expect(auditRow).not.toBeNull();
    const before = auditRow?.before as Record<string, unknown>;
    expect(before.personId).toBe(target.id);
    expect(before.category).toBeDefined();
    // /admin/audit renders payloads verbatim to any admin.view_audit holder, which
    // is a wider audience than directorVisibility allows for a confidential strike
    // and than subjectFacingDetail allows for its subject. Deleting a strike must
    // not publish its text to that audience (audit 14).
    expect(before.description).toBeUndefined();
    expect(before.notes).toBeUndefined();
    expect(before.followUpActions).toBeUndefined();
  });

  it("director cannot delete -> DisciplinaryForbiddenError", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const central = await createPerson("Central", "ctr001");
    const director = await createPerson("Director", "dir001");
    const target = await createPerson("Volunteer", "vol001");

    await grantPermission(central.id, "incidents.manage");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(target.id, term.id, dept.id, "VOLUNTEER");

    const action = await issueCentral(central.id, target.id);

    await expect(deleteAction(director.id, action.id)).rejects.toBeInstanceOf(
      DisciplinaryForbiddenError
    );
  });

  it("missing action -> DisciplinaryNotFoundError", async () => {
    const central = await createPerson("Central", "ctr001");
    await grantPermission(central.id, "incidents.manage");

    await expect(deleteAction(central.id, "nonexistent-id")).rejects.toBeInstanceOf(
      DisciplinaryNotFoundError
    );
  });

  it("leaves a non-APPROVED subject row untouched when deleting a strike linked to its report", async () => {
    const central = await createPerson("Central", "del-scope-c");
    const subject = await createPerson("Subject", "del-scope-s");
    const reporter = await createPerson("Reporter", "del-scope-r");
    await grantPermission(central.id, "incidents.manage");

    const report = await prisma.incidentReport.create({
      data: {
        number: 9001,
        reporterId: reporter.id,
        concernTypes: ["OTHER"],
        description: "Report with a declined strike request.",
      },
    });
    // The subject's request was DECLINED -- deleting a strike must not revive it.
    const subjectRow = await prisma.incidentReportSubject.create({
      data: { reportId: report.id, personId: subject.id, strikeDecision: "DECLINED" },
    });

    const action = await issueAction(central.id, {
      personId: subject.id,
      occurredAt: new Date("2026-07-01"),
      category: "Attendance",
      description: "Separately recorded strike, later linked to the report.",
      reportId: report.id,
    });

    await deleteAction(central.id, action.id);

    const after = await prisma.incidentReportSubject.findUniqueOrThrow({
      where: { id: subjectRow.id },
    });
    expect(after.strikeDecision).toBe("DECLINED");
    expect(after.strikeDecidedById).toBeNull();
  });

  it("still resets an APPROVED subject row to PENDING so the strike can be re-approved", async () => {
    const central = await createPerson("Central", "del-appr-c");
    const subject = await createPerson("Subject", "del-appr-s");
    const reporter = await createPerson("Reporter", "del-appr-r");
    await grantPermission(central.id, "incidents.manage");

    const report = await prisma.incidentReport.create({
      data: {
        number: 9002,
        reporterId: reporter.id,
        concernTypes: ["OTHER"],
        description: "Report with an approved strike.",
      },
    });
    const subjectRow = await prisma.incidentReportSubject.create({
      data: {
        reportId: report.id,
        personId: subject.id,
        strikeDecision: "APPROVED",
        strikeDecidedById: central.id,
        strikeDecidedAt: new Date(),
      },
    });

    const action = await issueAction(central.id, {
      personId: subject.id,
      occurredAt: new Date("2026-07-01"),
      category: "Attendance",
      description: "Approved off the report.",
      reportId: report.id,
    });

    await deleteAction(central.id, action.id);

    const after = await prisma.incidentReportSubject.findUniqueOrThrow({
      where: { id: subjectRow.id },
    });
    expect(after.strikeDecision).toBe("PENDING");
    expect(after.strikeDecidedById).toBeNull();
    expect(after.strikeDecidedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listActions - visibility matrix
// ---------------------------------------------------------------------------

describe("listActions - visibility", () => {
  it("central sees ALL rows including confidential of others; canManageAll is true", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const central = await createPerson("Central", "ctr001");
    const director = await createPerson("Director", "dir001");
    const target = await createPerson("Volunteer", "vol001");

    await grantPermission(central.id, "incidents.manage");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(target.id, term.id, dept.id, "VOLUNTEER");

    // Director issues a confidential row
    await issueAction(director.id, {
      personId: target.id,
      occurredAt: new Date("2026-04-01"),
      category: "Attendance",
      description: "Confidential row",
      confidential: true,
    });

    const result = await listActions(central.id, {});
    expect(result.canManageAll).toBe(true);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].action.confidential).toBe(true);
  });

  it("issuing director sees own confidential row", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const director = await createPerson("Director", "dir001");
    const target = await createPerson("Volunteer", "vol001");

    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(target.id, term.id, dept.id, "VOLUNTEER");

    await issueAction(director.id, {
      personId: target.id,
      occurredAt: new Date("2026-04-01"),
      category: "Attendance",
      description: "Own confidential row",
      confidential: true,
    });

    const result = await listActions(director.id, {});
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].action.confidential).toBe(true);
  });

  it("second director of SAME dept does NOT see first director's confidential row but DOES see non-confidential", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const director1 = await createPerson("Director1", "dir001");
    const director2 = await createPerson("Director2", "dir002");
    const target = await createPerson("Volunteer", "vol001");

    await createMembership(director1.id, term.id, dept.id, "DIRECTOR");
    await createMembership(director2.id, term.id, dept.id, "DIRECTOR");
    await createMembership(target.id, term.id, dept.id, "VOLUNTEER");

    // Director1 issues one confidential and one non-confidential
    await issueAction(director1.id, {
      personId: target.id,
      occurredAt: new Date("2026-04-01"),
      category: "Attendance",
      description: "Confidential by dir1",
      confidential: true,
    });
    await issueAction(director1.id, {
      personId: target.id,
      occurredAt: new Date("2026-03-01"),
      category: "Professionalism",
      description: "Non-confidential by dir1",
      confidential: false,
    });

    const result = await listActions(director2.id, {});

    // Director2 should see only the non-confidential row
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].action.confidential).toBe(false);
  });

  it("no-directorship viewer -> DisciplinaryForbiddenError", async () => {
    const viewer = await createPerson("NoRole", "nr001");

    await expect(listActions(viewer.id, {})).rejects.toBeInstanceOf(DisciplinaryForbiddenError);
  });

  it("unrelated-dept director -> empty rows (no error)", async () => {
    const term = await createTerm();
    const deptA = await createDepartment("ITCM");
    const deptB = await createDepartment("SRR");
    const central = await createPerson("Central", "ctr001");
    const directorB = await createPerson("DirB", "dirb001");
    const targetA = await createPerson("VolA", "vola001");

    await grantPermission(central.id, "incidents.manage");
    await createMembership(directorB.id, term.id, deptB.id, "DIRECTOR");
    await createMembership(targetA.id, term.id, deptA.id, "VOLUNTEER");

    // Issue action against targetA (in deptA)
    await issueCentral(central.id, targetA.id);

    // directorB manages deptB only; targetA is in deptA
    const result = await listActions(directorB.id, {});
    expect(result.rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// listActions - filters and pagination
// ---------------------------------------------------------------------------

describe("listActions - filters", () => {
  it("category filter returns only matching rows", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const central = await createPerson("Central", "ctr001");
    const target = await createPerson("Volunteer", "vol001");

    await grantPermission(central.id, "incidents.manage");
    await createMembership(target.id, term.id, dept.id, "VOLUNTEER");

    await issueAction(central.id, {
      personId: target.id,
      occurredAt: new Date("2026-04-01"),
      category: "Attendance",
      description: "Att row",
    });
    await issueAction(central.id, {
      personId: target.id,
      occurredAt: new Date("2026-04-02"),
      category: "Professionalism",
      description: "Prof row",
    });

    const result = await listActions(central.id, { category: "Attendance" });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].action.category).toBe("Attendance");
  });

  it("q name search is case-insensitive", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const central = await createPerson("Central", "ctr001");
    const targetA = await createPerson("Alice Smith", "alice001");
    const targetB = await createPerson("Bob Jones", "bob001");

    await grantPermission(central.id, "incidents.manage");
    await createMembership(targetA.id, term.id, dept.id, "VOLUNTEER");
    await createMembership(targetB.id, term.id, dept.id, "VOLUNTEER");

    await issueCentral(central.id, targetA.id);
    await issueCentral(central.id, targetB.id);

    const result = await listActions(central.id, { q: "alice" });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].personName).toMatch(/Alice/i);
  });

  it("departmentId filter (central allowed for any dept)", async () => {
    const term = await createTerm();
    const deptA = await createDepartment("ITCM");
    const deptB = await createDepartment("SRR");
    const central = await createPerson("Central", "ctr001");
    const targetA = await createPerson("VolA", "vola001");
    const targetB = await createPerson("VolB", "volb001");

    await grantPermission(central.id, "incidents.manage");
    await createMembership(targetA.id, term.id, deptA.id, "VOLUNTEER");
    await createMembership(targetB.id, term.id, deptB.id, "VOLUNTEER");

    await issueCentral(central.id, targetA.id);
    await issueCentral(central.id, targetB.id);

    const resultA = await listActions(central.id, { departmentId: deptA.id });
    expect(resultA.rows).toHaveLength(1);
    expect(resultA.rows[0].personName).toBe("VolA");
  });

  it("director can use departmentId filter for their own department; rows returned", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const director = await createPerson("Dir", "dir001");
    const target = await createPerson("Vol", "vol001");

    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(target.id, term.id, dept.id, "VOLUNTEER");

    await issueAction(director.id, {
      personId: target.id,
      occurredAt: new Date("2026-04-01"),
      category: "Attendance",
      description: "Row in own dept",
    });

    const result = await listActions(director.id, { departmentId: dept.id });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].personName).toBe("Vol");
  });

  it("departmentId filter outside viewer's manageable depts -> DisciplinaryForbiddenError", async () => {
    const term = await createTerm();
    const deptA = await createDepartment("ITCM");
    const deptB = await createDepartment("SRR");
    const director = await createPerson("DirA", "dira001");
    const target = await createPerson("VolA", "vola001");

    await createMembership(director.id, term.id, deptA.id, "DIRECTOR");
    await createMembership(target.id, term.id, deptA.id, "VOLUNTEER");

    // Director filters on deptB which is not their dept
    await expect(listActions(director.id, { departmentId: deptB.id })).rejects.toBeInstanceOf(
      DisciplinaryForbiddenError
    );
  });

  it("departmentId filter (central): person with only archived-term membership does NOT appear", async () => {
    // The active term and the archived term are separate.
    const activeTerm = await createTerm("ACTIVE", "SU26");
    const archivedTerm = await createTerm("ARCHIVED", "SP26");
    const dept = await createDepartment("ITCM");
    const central = await createPerson("Central", "ctr001");
    // archivedVol is a member of the dept only in the archived term.
    const archivedVol = await createPerson("Old Vol", "ov001");
    // activeVol is a member of the dept in the active term.
    const activeVol = await createPerson("Current Vol", "cv001");

    await grantPermission(central.id, "incidents.manage");
    await createMembership(archivedVol.id, archivedTerm.id, dept.id, "VOLUNTEER");
    await createMembership(activeVol.id, activeTerm.id, dept.id, "VOLUNTEER");

    // Issue actions against both via central (bypasses term check).
    await issueCentral(central.id, archivedVol.id, { description: "Archived term incident" });
    await issueCentral(central.id, activeVol.id, { description: "Active term incident" });

    // Filtering by dept should only include activeVol's action.
    const result = await listActions(central.id, { departmentId: dept.id });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].personName).toBe("Current Vol");
  });

  it("central with both q and departmentId returns only the matching person's actions in that department", async () => {
    const term = await createTerm();
    const deptA = await createDepartment("ITCM");
    const deptB = await createDepartment("SRR");
    const central = await createPerson("Central", "ctr001");
    // alice is in deptA only
    const alice = await createPerson("Alice Matching", "alice001");
    // bob is in deptA but name does not match the query
    const bob = await createPerson("Bob Other", "bob001");
    // carol is in deptB with a matching name -- should NOT appear (wrong dept)
    const carol = await createPerson("Alice Wrong Dept", "carol001");

    await grantPermission(central.id, "incidents.manage");
    await createMembership(alice.id, term.id, deptA.id, "VOLUNTEER");
    await createMembership(bob.id, term.id, deptA.id, "VOLUNTEER");
    await createMembership(carol.id, term.id, deptB.id, "VOLUNTEER");

    await issueCentral(central.id, alice.id, { description: "alice in deptA" });
    await issueCentral(central.id, bob.id, { description: "bob in deptA" });
    await issueCentral(central.id, carol.id, { description: "alice-name in deptB" });

    const result = await listActions(central.id, { q: "alice", departmentId: deptA.id });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].personName).toBe("Alice Matching");
  });

  it("pagination: 26 rows -> page 1 has 25, page 2 has 1", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const central = await createPerson("Central", "ctr001");

    await grantPermission(central.id, "incidents.manage");

    // Create 26 distinct targets with memberships and actions
    for (let i = 0; i < 26; i++) {
      const target = await createPerson(`Vol${i}`, `vol${i}`);
      await createMembership(target.id, term.id, dept.id, "VOLUNTEER");
      await issueCentral(central.id, target.id);
    }

    const page1 = await listActions(central.id, { page: 1 });
    const page2 = await listActions(central.id, { page: 2 });

    expect(page1.rows).toHaveLength(25);
    expect(page2.rows).toHaveLength(1);
    expect(page1.total).toBe(26);
  });
});

describe("strikes", () => {
  it("person with 3 actions shows strikes=3 in listActions rows and strikeCount", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const central = await createPerson("Central", "ctr001");
    const target = await createPerson("Repeat Offender", "ro001");

    await grantPermission(central.id, "incidents.manage");
    await createMembership(target.id, term.id, dept.id, "VOLUNTEER");

    await issueCentral(central.id, target.id, { description: "Incident 1" });
    await issueCentral(central.id, target.id, { description: "Incident 2" });
    await issueCentral(central.id, target.id, { description: "Incident 3" });

    const count = await strikeCount(target.id);
    expect(count).toBe(3);

    const result = await listActions(central.id, {});
    for (const row of result.rows) {
      expect(row.strikes).toBe(3);
    }
  });

  it("director's strike count excludes confidential actions issued by others", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const central = await createPerson("Central", "ctr001");
    const director = await createPerson("Director", "dir001");
    const target = await createPerson("Repeat Vol", "rv001");

    await grantPermission(central.id, "incidents.manage");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(target.id, term.id, dept.id, "VOLUNTEER");

    // Central issues 2 confidential actions (director cannot see these)
    await issueCentral(central.id, target.id, {
      description: "Confidential 1",
      confidential: true,
    });
    await issueCentral(central.id, target.id, {
      description: "Confidential 2",
      confidential: true,
    });
    // Director issues 1 non-confidential action (director can see this one)
    await issueAction(director.id, {
      personId: target.id,
      occurredAt: new Date("2026-04-01"),
      category: DISCIPLINARY_CATEGORIES[0],
      description: "Visible row",
      confidential: false,
    });

    const result = await listActions(director.id, {});
    // Director sees only the 1 non-confidential row
    expect(result.rows).toHaveLength(1);
    // Strikes must reflect only the actions the director is permitted to see;
    // the 2 confidential rows raised by others must not leak into the count.
    expect(result.rows[0].strikes).toBe(1);
  });

  it("director's strike count includes confidential actions they issued themselves", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const central = await createPerson("Central", "ctr001");
    const director = await createPerson("Director", "dir001");
    const target = await createPerson("Repeat Vol", "rv001");

    await grantPermission(central.id, "incidents.manage");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(target.id, term.id, dept.id, "VOLUNTEER");

    // Central issues 1 confidential action the director cannot see.
    await issueCentral(central.id, target.id, {
      description: "Hidden from director",
      confidential: true,
    });
    // Director issues their own confidential + non-confidential (both visible to them).
    await issueAction(director.id, {
      personId: target.id,
      occurredAt: new Date("2026-04-02"),
      category: DISCIPLINARY_CATEGORIES[0],
      description: "My confidential",
      confidential: true,
    });
    await issueAction(director.id, {
      personId: target.id,
      occurredAt: new Date("2026-04-03"),
      category: DISCIPLINARY_CATEGORIES[0],
      description: "My non-confidential",
      confidential: false,
    });

    const result = await listActions(director.id, {});
    // Director sees their own 2 rows, not central's hidden confidential one.
    expect(result.rows).toHaveLength(2);
    // Strikes counts the 2 visible-to-director actions (including their own
    // confidential one), excluding the confidential row issued by central.
    for (const row of result.rows) {
      expect(row.strikes).toBe(2);
    }
  });
});

describe("visibleStrikeCount", () => {
  it("counts non-confidential rows plus confidential rows the viewer issued themselves", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const central = await createPerson("Central", "vsc-c");
    const director = await createPerson("Director", "vsc-d");
    const target = await createPerson("Target", "vsc-t");

    await grantPermission(central.id, "incidents.manage");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(target.id, term.id, dept.id, "VOLUNTEER");

    // Non-confidential, issued by central: visible to the director.
    await issueCentral(central.id, target.id, { description: "Visible row" });
    // Confidential, issued by the director themselves: visible to them.
    await issueAction(director.id, {
      personId: target.id,
      occurredAt: new Date("2026-04-02"),
      category: DISCIPLINARY_CATEGORIES[0],
      description: "My own confidential row",
      confidential: true,
    });

    expect(await visibleStrikeCount(target.id, director.id)).toBe(2);
  });

  it("excludes a confidential row issued by someone else", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const central = await createPerson("Central", "vsc-ex-c");
    const director = await createPerson("Director", "vsc-ex-d");
    const target = await createPerson("Target", "vsc-ex-t");

    await grantPermission(central.id, "incidents.manage");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(target.id, term.id, dept.id, "VOLUNTEER");

    // Confidential, issued by central: hidden from the director.
    await issueCentral(central.id, target.id, {
      description: "Hidden from the director",
      confidential: true,
    });

    expect(await visibleStrikeCount(target.id, director.id)).toBe(0);
    // The unscoped total still counts it, confirming the row really exists.
    expect(await strikeCount(target.id)).toBe(1);
  });
});

describe("issuablePeople", () => {
  it("central -> { all: true, people: [] }", async () => {
    const actor = await createPerson("Central", "ctr001");
    await grantPermission(actor.id, "incidents.manage");

    const result = await issuablePeople(actor.id);
    expect(result.all).toBe(true);
    expect(result.people).toHaveLength(0);
  });

  it("director -> ACTIVE members of manageable depts, deduped, sorted by name with departmentNames", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const director = await createPerson("Director", "dir001");
    const vol1 = await createPerson("Zara Q", "zq001");
    const vol2 = await createPerson("Aaron B", "ab001");

    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(vol1.id, term.id, dept.id, "VOLUNTEER");
    await createMembership(vol2.id, term.id, dept.id, "VOLUNTEER");

    const result = await issuablePeople(director.id);
    expect(result.all).toBe(false);
    expect(result.people).toHaveLength(2);
    // sorted by name: Aaron before Zara
    expect(result.people[0].name).toBe("Aaron B");
    expect(result.people[1].name).toBe("Zara Q");
    for (const p of result.people) {
      expect(p.departmentNames).toContain("ITCM Dept");
    }
  });

  it("delegation: delegated-dept members included", async () => {
    const term = await createTerm();
    const pcar = await createDepartment("PCAR");
    const sctp = await createDepartment("SCTP");
    await delegate(pcar.id, sctp.id);

    const director = await createPerson("PCAR Dir", "pcd01");
    const vol = await createPerson("SCTP Vol", "sv01");

    await createMembership(director.id, term.id, pcar.id, "DIRECTOR");
    await createMembership(vol.id, term.id, sctp.id, "VOLUNTEER");

    const result = await issuablePeople(director.id);
    expect(result.all).toBe(false);
    const ids = result.people.map((p) => p.id);
    expect(ids).toContain(vol.id);
  });

  it("person in two managed depts is deduped with both dept names", async () => {
    const term = await createTerm();
    const deptA = await createDepartment("ITCM");
    const deptB = await createDepartment("SRR");
    const director = await createPerson("Director", "dir001");
    const vol = await createPerson("Dual Vol", "dv001");

    await createMembership(director.id, term.id, deptA.id, "DIRECTOR");
    await createMembership(director.id, term.id, deptB.id, "DIRECTOR");
    await createMembership(vol.id, term.id, deptA.id, "VOLUNTEER");
    await createMembership(vol.id, term.id, deptB.id, "VOLUNTEER");

    const result = await issuablePeople(director.id);
    const volEntry = result.people.find((p) => p.id === vol.id);
    expect(volEntry).toBeDefined();
    expect(volEntry?.departmentNames).toContain("ITCM Dept");
    expect(volEntry?.departmentNames).toContain("SRR Dept");
  });

  it("director who is an ACTIVE member of their own dept is excluded from their own picker", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const director = await createPerson("Director", "dir001");
    const vol = await createPerson("Vol", "vol001");

    // Director has BOTH a DIRECTOR and a VOLUNTEER membership in the same dept.
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(director.id, term.id, dept.id, "VOLUNTEER");
    await createMembership(vol.id, term.id, dept.id, "VOLUNTEER");

    const result = await issuablePeople(director.id);
    const ids = result.people.map((p) => p.id);
    expect(ids).not.toContain(director.id);
    expect(ids).toContain(vol.id);
  });

  it("no directorships -> { all: false, people: [] }", async () => {
    const actor = await createPerson("NonDirector", "nd001");
    const result = await issuablePeople(actor.id);
    expect(result.all).toBe(false);
    expect(result.people).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// listActions - pagination (#44): every strike from one incident report shares a
// UTC-midnight occurredAt, so occurredAt alone is a tie group with no stable order.
// The id tiebreaker must make offset pages partition the rows.
// ---------------------------------------------------------------------------

describe("listActions - pagination", () => {
  it("paginates deterministically when strikes share one occurredAt marker", async () => {
    const central = await createPerson("Central", "ctr-page");
    const target = await createPerson("Volunteer", "vol-page");
    await grantPermission(central.id, "incidents.manage");

    // 30 strikes all on the same calendar-day marker (as one incident report yields).
    const tie = new Date("2026-04-01T00:00:00.000Z");
    for (let i = 0; i < 30; i++) {
      await prisma.disciplinaryAction.create({
        data: { personId: target.id, issuedById: central.id, occurredAt: tie, category: "Attendance", description: `row ${i}` },
      });
    }

    const p1 = await listActions(central.id, { page: 1 });
    const p2 = await listActions(central.id, { page: 2 });
    expect(p1.rows).toHaveLength(25);
    expect(p2.rows).toHaveLength(5);

    const ids = [...p1.rows, ...p2.rows].map((r) => r.action.id);
    expect(new Set(ids).size).toBe(30); // no row repeated across pages, none dropped

    const idsDesc = [...ids].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    expect(ids).toEqual(idsDesc); // stable id-desc order within the tie group
  });
});

describe("strikeablePeople", () => {
  it("returns an empty list for a non-central actor", async () => {
    const director = await createPerson("Director", "sp-nc-d");
    expect(await strikeablePeople(director.id)).toEqual([]);
  });

  it("includes offboarded people so a strike can still be recorded against them", async () => {
    const central = await createPerson("Central", "sp-inact-c");
    await grantPermission(central.id, "incidents.manage");
    const gone = await prisma.person.create({
      data: { name: "Departed Volunteer", netId: "sp-gone", status: "OFFBOARDED" },
    });

    const people = await strikeablePeople(central.id);
    const row = people.find((p) => p.id === gone.id);
    expect(row).toBeDefined();
    expect(row!.hint).toContain("offboarded");
  });

  it("sorts active people before offboarded ones, then by name", async () => {
    const central = await createPerson("Central", "sp-sort-c");
    await grantPermission(central.id, "incidents.manage");
    await prisma.person.create({
      data: { name: "Aaron Inactive", netId: "sp-sort-a", status: "OFFBOARDED" },
    });
    const zoe = await prisma.person.create({
      data: { name: "Zoe Active", netId: "sp-sort-z", status: "ACTIVE" },
    });

    const people = await strikeablePeople(central.id);
    const zoeIdx = people.findIndex((p) => p.id === zoe.id);
    const aaronIdx = people.findIndex((p) => p.name === "Aaron Inactive");
    expect(zoeIdx).toBeLessThan(aaronIdx);
  });

  it("hints the active-term department and kind so same-named people are distinguishable", async () => {
    const term = await createTerm();
    const dept = await createDepartment("SCTM");
    const central = await createPerson("Central", "sp-hint-c");
    await grantPermission(central.id, "incidents.manage");
    const vol = await createPerson("Hinted Volunteer", "sp-hint-v");
    await createMembership(vol.id, term.id, dept.id, "VOLUNTEER");

    const people = await strikeablePeople(central.id);
    const row = people.find((p) => p.id === vol.id);
    expect(row!.hint).toContain("SCTM");
    expect(row!.hint).toContain("volunteer");
  });
});

// ---------------------------------------------------------------------------
// linkActionToReport
// ---------------------------------------------------------------------------

describe("linkActionToReport", () => {
  async function setup(prefix: string) {
    const central = await createPerson("Central", `${prefix}-c`);
    const subject = await createPerson("Subject", `${prefix}-s`);
    const reporter = await createPerson("Reporter", `${prefix}-r`);
    await grantPermission(central.id, "incidents.manage");
    const report = await prisma.incidentReport.create({
      data: {
        number: Math.floor(Math.random() * 100000) + 10000,
        reporterId: reporter.id,
        concernTypes: ["OTHER"],
        description: "A report to link against.",
      },
    });
    const action = await issueAction(central.id, {
      personId: subject.id,
      occurredAt: new Date("2026-07-01"),
      category: "Attendance",
      description: "Recorded directly on the ledger.",
    });
    return { central, subject, report, action };
  }

  it("links a strike to a report", async () => {
    const { central, report, action } = await setup("lat-ok");

    const linked = await linkActionToReport(central.id, action.id, report.id);
    expect(linked.reportId).toBe(report.id);

    const audit = await prisma.auditLog.findFirst({
      where: { action: "disciplinary.link_report", entityId: action.id },
    });
    expect(audit).not.toBeNull();
  });

  it("unlinks when passed null", async () => {
    const { central, report, action } = await setup("lat-unlink");
    await linkActionToReport(central.id, action.id, report.id);

    const unlinked = await linkActionToReport(central.id, action.id, null);
    expect(unlinked.reportId).toBeNull();
  });

  it("unlinking a report-derived strike reverts the APPROVED subject row to PENDING so it can be re-approved", async () => {
    const { central, subject, report, action } = await setup("lat-unlink-revert");
    const subjectRow = await prisma.incidentReportSubject.create({
      data: {
        reportId: report.id,
        personId: subject.id,
        strikeDecision: "APPROVED",
        strikeDecidedById: central.id,
        strikeDecidedAt: new Date(),
      },
    });
    await linkActionToReport(central.id, action.id, report.id);

    const unlinked = await linkActionToReport(central.id, action.id, null);
    expect(unlinked.reportId).toBeNull();

    const after = await prisma.incidentReportSubject.findUniqueOrThrow({
      where: { id: subjectRow.id },
    });
    expect(after.strikeDecision).toBe("PENDING");
    expect(after.strikeDecidedById).toBeNull();
    expect(after.strikeDecidedAt).toBeNull();
  });

  it("relinking to a different report reverts the previous report's APPROVED subject row to PENDING", async () => {
    const { central, subject, report, action } = await setup("lat-relink");
    const reporter2 = await createPerson("Reporter2", "lat-relink-r2");
    const otherReport = await prisma.incidentReport.create({
      data: {
        number: Math.floor(Math.random() * 100000) + 10000,
        reporterId: reporter2.id,
        concernTypes: ["OTHER"],
        description: "A second report to relink the strike to.",
      },
    });
    const subjectRow = await prisma.incidentReportSubject.create({
      data: {
        reportId: report.id,
        personId: subject.id,
        strikeDecision: "APPROVED",
        strikeDecidedById: central.id,
        strikeDecidedAt: new Date(),
      },
    });
    await linkActionToReport(central.id, action.id, report.id);

    const relinked = await linkActionToReport(central.id, action.id, otherReport.id);
    expect(relinked.reportId).toBe(otherReport.id);

    // The FIRST report's subject row must be reverted, exactly as an unlink
    // would revert it, so it does not silently stay "issued" with no ledger
    // row backing it.
    const after = await prisma.incidentReportSubject.findUniqueOrThrow({
      where: { id: subjectRow.id },
    });
    expect(after.strikeDecision).toBe("PENDING");
    expect(after.strikeDecidedById).toBeNull();
    expect(after.strikeDecidedAt).toBeNull();
  });

  it("rejects an actor without incidents.manage", async () => {
    const { report, action } = await setup("lat-forbid");
    const director = await createPerson("Director", "lat-forbid-d");

    await expect(
      linkActionToReport(director.id, action.id, report.id)
    ).rejects.toBeInstanceOf(DisciplinaryForbiddenError);
  });

  it("rejects an unknown action or report", async () => {
    const { central, action } = await setup("lat-404");

    await expect(
      linkActionToReport(central.id, "no-such-action", null)
    ).rejects.toBeInstanceOf(DisciplinaryNotFoundError);
    await expect(
      linkActionToReport(central.id, action.id, "no-such-report")
    ).rejects.toBeInstanceOf(DisciplinaryNotFoundError);
  });

  it("translates the composite-unique collision into a readable validation error", async () => {
    const { central, subject, report, action } = await setup("lat-dup");
    await linkActionToReport(central.id, action.id, report.id);

    // A second strike against the SAME person cannot also claim that report.
    const second = await issueAction(central.id, {
      personId: subject.id,
      occurredAt: new Date("2026-07-02"),
      category: "Professionalism",
      description: "A second strike for the same person.",
    });

    await expect(
      linkActionToReport(central.id, second.id, report.id)
    ).rejects.toBeInstanceOf(DisciplinaryValidationError);
  });
});

describe("do-not-rehire flag", () => {
  it("sets the flag with a note and records who set it", async () => {
    const central = await createPerson("Central", "cen-dnr");
    await grantPermission(central.id, "incidents.manage");
    const subject = await createPerson("Subject", "sub-dnr");

    await setDoNotRehire(central.id, subject.id, {
      doNotRehire: true,
      note: "Repeated no-shows after two conversations.",
    });

    const flag = await getRehireFlag(subject.id);
    expect(flag.doNotRehire).toBe(true);
    expect(flag.note).toBe("Repeated no-shows after two conversations.");
    expect(flag.setByName).toBe("Central");
    expect(flag.setAt).not.toBeNull();

    const audit = await prisma.auditLog.findFirst({ where: { action: "person.do_not_rehire_set" } });
    expect(audit).not.toBeNull();
  });

  // A cleared flag must not leave its reason behind: a stale justification for a
  // flag that no longer exists is worse than no record, and the audit log keeps
  // the history either way.
  it("clearing the flag wipes the note and attribution", async () => {
    const central = await createPerson("Central", "cen-clr");
    await grantPermission(central.id, "incidents.manage");
    const subject = await createPerson("Subject", "sub-clr");

    await setDoNotRehire(central.id, subject.id, { doNotRehire: true, note: "reason" });
    await setDoNotRehire(central.id, subject.id, { doNotRehire: false });

    const flag = await getRehireFlag(subject.id);
    expect(flag.doNotRehire).toBe(false);
    expect(flag.note).toBeNull();
    expect(flag.setByName).toBeNull();
    expect(flag.setAt).toBeNull();

    const row = await prisma.person.findUniqueOrThrow({ where: { id: subject.id } });
    expect(row.doNotRehireSetById).toBeNull();

    const audit = await prisma.auditLog.findFirst({ where: { action: "person.do_not_rehire_cleared" } });
    expect(audit).not.toBeNull();
  });

  // Deciding the clinic would not take someone back is a clinic-wide judgment,
  // not a departmental one. Mirrors deleteAction, which directors also cannot do.
  it("refuses a director without incidents.manage", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const director = await createPerson("Director", "dir-dnr");
    const subject = await createPerson("Subject", "sub-dnr2");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(subject.id, term.id, dept.id, "VOLUNTEER");

    await expect(
      setDoNotRehire(director.id, subject.id, { doNotRehire: true })
    ).rejects.toBeInstanceOf(DisciplinaryForbiddenError);

    expect((await getRehireFlag(subject.id)).doNotRehire).toBe(false);
  });

  it("rejects an unknown person", async () => {
    const central = await createPerson("Central", "cen-404");
    await grantPermission(central.id, "incidents.manage");
    await expect(
      setDoNotRehire(central.id, "nope", { doNotRehire: true })
    ).rejects.toBeInstanceOf(DisciplinaryNotFoundError);
  });

  // Unflagged and unknown both read as "no flag" so callers render one state
  // rather than having to tell the two apart.
  it("reports no flag for an unflagged or unknown person", async () => {
    const plain = await createPerson("Plain", "plain-dnr");
    expect((await getRehireFlag(plain.id)).doNotRehire).toBe(false);
    expect((await getRehireFlag("nobody")).doNotRehire).toBe(false);
  });

  it("normalizes a blank note to null", async () => {
    const central = await createPerson("Central", "cen-blank");
    await grantPermission(central.id, "incidents.manage");
    const subject = await createPerson("Subject", "sub-blank");
    await setDoNotRehire(central.id, subject.id, { doNotRehire: true, note: "   " });
    expect((await getRehireFlag(subject.id)).note).toBeNull();
  });

  // The flag is advisory. Nothing may use it to remove someone from a list: the
  // applicant is never told it exists and so cannot contest it, and a silent
  // filter would be undiscoverable when set in error.
  it("does not affect who appears in the strikeable-people picker", async () => {
    const central = await createPerson("Central", "cen-adv");
    await grantPermission(central.id, "incidents.manage");
    const subject = await createPerson("Flagged Person", "sub-adv");

    const before = await strikeablePeople(central.id);
    await setDoNotRehire(central.id, subject.id, { doNotRehire: true, note: "n/a" });
    const after = await strikeablePeople(central.id);

    expect(after.map((p) => p.id).sort()).toEqual(before.map((p) => p.id).sort());
    expect(after.some((p) => p.id === subject.id)).toBe(true);
  });
});

describe("listActions ordinal", () => {
  it("numbers each row by its position in that person's sequence, not the running total", async () => {
    const central = await createPerson("Central", "cen-ord");
    await grantPermission(central.id, "incidents.manage");
    const subject = await createPerson("Subject", "sub-ord");

    await issueCentral(central.id, subject.id, { occurredAt: new Date("2026-01-01") });
    await issueCentral(central.id, subject.id, { occurredAt: new Date("2026-02-01") });
    await issueCentral(central.id, subject.id, { occurredAt: new Date("2026-03-01") });

    const { rows } = await listActions(central.id, {});

    // Rows come back newest-first, so the newest is their 3rd.
    expect(rows.map((r) => r.ordinal)).toEqual([3, 2, 1]);
    // The total is the same on every row, which is exactly why the ordinal is
    // needed: on its own the total says nothing about which strike this was.
    expect(rows.every((r) => r.strikes === 3)).toBe(true);
  });

  it("numbers each person independently", async () => {
    const central = await createPerson("Central", "cen-two");
    await grantPermission(central.id, "incidents.manage");
    const a = await createPerson("Ann", "ann-two");
    const b = await createPerson("Bob", "bob-two");

    await issueCentral(central.id, a.id, { occurredAt: new Date("2026-01-01") });
    await issueCentral(central.id, b.id, { occurredAt: new Date("2026-01-15") });
    await issueCentral(central.id, a.id, { occurredAt: new Date("2026-02-01") });

    const { rows } = await listActions(central.id, {});
    const byPerson = new Map(rows.map((r) => [`${r.personName}:${r.ordinal}`, r]));

    expect(byPerson.has("Ann:1")).toBe(true);
    expect(byPerson.has("Ann:2")).toBe(true);
    expect(byPerson.has("Bob:1")).toBe(true);
    expect(byPerson.has("Bob:2")).toBe(false);
  });

  // The ordinal and the total must be computed over the SAME set of rows, or a
  // director sees nonsense like "3 of 2" where the extra row is a confidential
  // action they are not permitted to open.
  it("scopes the ordinal to what a director may see, matching the total", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const director = await createPerson("Director", "dir-ord");
    const other = await createPerson("Other", "oth-ord");
    const subject = await createPerson("Subject", "sub-conf-ord");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(subject.id, term.id, dept.id, "VOLUNTEER");
    await grantPermission(other.id, "incidents.manage");

    // A confidential strike issued by someone else: invisible to this director.
    await issueCentral(other.id, subject.id, { occurredAt: new Date("2026-01-01"), confidential: true });
    // Two they can see.
    await issueCentral(other.id, subject.id, { occurredAt: new Date("2026-02-01") });
    await issueCentral(other.id, subject.id, { occurredAt: new Date("2026-03-01") });

    const { rows } = await listActions(director.id, {});

    expect(rows).toHaveLength(2);
    // Numbered 1 and 2 over the visible set, NOT 2 and 3 over the true history.
    expect(rows.map((r) => r.ordinal).sort()).toEqual([1, 2]);
    // And never exceeding the total shown beside them.
    expect(rows.every((r) => r.ordinal <= r.strikes)).toBe(true);
  });
});

describe("subjectFacingDetail", () => {
  // Shared with the strike_issued email so the two surfaces that show a person
  // their own strike cannot drift. See the function's doc for why #45 matters.
  it("prefers the reviewer's notes, which were written to be read by the subject", () => {
    expect(
      subjectFacingDetail({ notes: "Discussed with the volunteer.", description: "raw narrative", confidential: false })
    ).toBe("Discussed with the volunteer.");
  });

  it("falls back to the description on a NON-confidential strike", () => {
    expect(subjectFacingDetail({ notes: null, description: "raw narrative", confidential: false })).toBe(
      "raw narrative"
    );
  });

  // The whole point: an anonymous report becomes a confidential strike, and the
  // reporter's first-person account would identify them to anyone who knows the
  // shift roster.
  it("NEVER exposes the description on a confidential strike", () => {
    const out = subjectFacingDetail({ notes: null, description: "I was on triage with him when he", confidential: true });
    expect(out).not.toContain("I was on triage");
    expect(out).toContain("Contact your department directors");
  });

  it("treats whitespace-only notes as absent", () => {
    expect(subjectFacingDetail({ notes: "   ", description: "raw narrative", confidential: false })).toBe(
      "raw narrative"
    );
  });
});

describe("listMyStrikes", () => {
  it("returns a person's own strikes oldest first, numbered 1st, 2nd, 3rd", async () => {
    const central = await createPerson("Central", "cen-ms");
    await grantPermission(central.id, "incidents.manage");
    const subject = await createPerson("Subject", "sub-ms");

    // Deliberately created out of chronological order: the ordinal must come
    // from occurredAt, not insertion order.
    await issueCentral(central.id, subject.id, { occurredAt: new Date("2026-03-01"), category: "Attendance" });
    await issueCentral(central.id, subject.id, { occurredAt: new Date("2026-01-01"), category: "Professionalism" });
    await issueCentral(central.id, subject.id, { occurredAt: new Date("2026-02-01"), category: "Patient Safety" });

    const rows = await listMyStrikes(subject.id);

    expect(rows.map((r) => r.ordinal)).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.category)).toEqual(["Professionalism", "Patient Safety", "Attendance"]);
  });

  // Confidentiality hides a strike from OTHER directors, not from the person it
  // is against, who was emailed about it when it was issued. Withholding it here
  // would leave them unable to see something that counts toward their standing.
  it("includes a confidential strike, with the narrative redacted", async () => {
    const central = await createPerson("Central", "cen-conf");
    await grantPermission(central.id, "incidents.manage");
    const subject = await createPerson("Subject", "sub-conf");

    await issueCentral(central.id, subject.id, {
      confidential: true,
      description: "I was on triage with him when he",
    });

    const rows = await listMyStrikes(subject.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].detail).not.toContain("I was on triage");
    expect(rows[0].detail).toContain("Contact your department directors");
  });

  it("returns nothing for a person with a clean record", async () => {
    const clean = await createPerson("Clean", "clean-ms");
    expect(await listMyStrikes(clean.id)).toEqual([]);
  });

  it("scopes strictly to the person asked for", async () => {
    const central = await createPerson("Central", "cen-scope");
    await grantPermission(central.id, "incidents.manage");
    const mine = await createPerson("Mine", "mine-scope");
    const theirs = await createPerson("Theirs", "theirs-scope");

    await issueCentral(central.id, theirs.id, { category: "Attendance" });

    expect(await listMyStrikes(mine.id)).toEqual([]);
    expect(await listMyStrikes(theirs.id)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Self-exclusion (audit 14)
//
// "A person linked as the subject of a report may never act on, or read, that
// report, even holding incidents.manage." report.ts enforced it on getReport,
// listReviewQueue, reviewReport and decideStrike; four sibling paths were missed.
// Every case below makes the VIEWER the subject, which is exactly the shape no
// pre-existing test used: they all act against a separate `target`, so this whole
// class was invisible to a green suite.
// ---------------------------------------------------------------------------

describe("self-exclusion: a subject may not act on their own record", () => {
  /** A central actor who is ALSO the subject of the strike returned. */
  async function selfStrike() {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const issuer = await createPerson("Issuer", "iss-self");
    const viewer = await createPerson("Viewer", "vw-self");
    await grantPermission(issuer.id, "incidents.manage");
    await grantPermission(viewer.id, "incidents.manage");
    await createMembership(viewer.id, term.id, dept.id, "VOLUNTEER");
    const action = await issueCentral(issuer.id, viewer.id, {
      description: "I was on triage with her Saturday morning when she left.",
      confidential: true,
    });
    return { viewer, issuer, action };
  }

  it("listActions redacts the narrative on the viewer's OWN row", async () => {
    const { viewer, action } = await selfStrike();

    const { rows } = await listActions(viewer.id, {});
    const own = rows.find((r) => r.action.id === action.id);

    expect(own).toBeDefined();
    // Still listed, so the ledger's counts and ordinals stay honest.
    expect(own!.action.description).not.toContain("triage");
    // Confidential, so they get the same pointer /my-info already shows them.
    expect(own!.action.description).toContain("Contact your department directors");
    expect(own!.action.notes).toBeNull();
    expect(own!.action.reportId).toBeNull();
  });

  it("listActions leaves OTHER people's rows untouched", async () => {
    const { viewer, issuer } = await selfStrike();
    const other = await createPerson("Other", "oth-self");
    const theirs = await issueCentral(issuer.id, other.id, {
      description: "Narrative about someone else.",
    });

    const { rows } = await listActions(viewer.id, {});
    const row = rows.find((r) => r.action.id === theirs.id);
    expect(row!.action.description).toBe("Narrative about someone else.");
  });

  it("deleteAction refuses a strike about the actor", async () => {
    const { viewer, action } = await selfStrike();
    await expect(deleteAction(viewer.id, action.id)).rejects.toBeInstanceOf(
      DisciplinaryForbiddenError
    );
    expect(
      await prisma.disciplinaryAction.findUnique({ where: { id: action.id } })
    ).not.toBeNull();
  });

  it("linkActionToReport refuses a strike about the actor", async () => {
    const { viewer, action } = await selfStrike();
    await expect(linkActionToReport(viewer.id, action.id, null)).rejects.toBeInstanceOf(
      DisciplinaryForbiddenError
    );
  });
});
