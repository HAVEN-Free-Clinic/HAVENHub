/**
 * TDD tests for the volunteers disciplinary service.
 *
 * issueAction(actorPersonId, input):
 *   - Director issues for own-dept member; action created; audit row exists.
 *   - Delegation edge: PCAR director managing dept B via DepartmentDelegation can issue.
 *   - Cross-dept director gets DisciplinaryForbiddenError.
 *   - Central (issue_disciplinary) can issue for anyone.
 *   - Validation: bad category -> DisciplinaryValidationError.
 *   - Validation: blank description -> DisciplinaryValidationError.
 *   - Validation: future occurredAt -> DisciplinaryValidationError.
 *   - Missing person -> DisciplinaryNotFoundError.
 *   - No active term, no permission -> DisciplinaryForbiddenError.
 *
 * deleteAction(actorPersonId, id):
 *   - Central can delete; audit before snapshot present.
 *   - Director cannot delete -> DisciplinaryForbiddenError.
 *   - Missing row -> DisciplinaryNotFoundError.
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
 * issuablePeople(actorPersonId):
 *   - Central -> { all: true, people: [] }.
 *   - Director -> deduped members with departmentNames, sorted by name.
 *   - Delegation: delegated-dept members included.
 *   - No directorships -> { all: false, people: [] }.
 *
 * strikeCount(personId):
 *   - Person with 3 actions shows strikeCount 3.
 *   - Rows' strikes field matches strikeCount.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  issueAction,
  deleteAction,
  listActions,
  issuablePeople,
  strikeCount,
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

// ---------------------------------------------------------------------------
// issueAction
// ---------------------------------------------------------------------------

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

  it("central holder of volunteers.issue_disciplinary can issue for anyone", async () => {
    const term = await createTerm();
    const dept = await createDepartment("SRR");
    const actor = await createPerson("Central", "ctr001");
    const target = await createPerson("Anyone", "any001");

    await grantPermission(actor.id, "volunteers.issue_disciplinary");
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
});

// ---------------------------------------------------------------------------
// deleteAction
// ---------------------------------------------------------------------------

describe("deleteAction", () => {
  it("central can delete; audit before snapshot matches the full row", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const central = await createPerson("Central", "ctr001");
    const target = await createPerson("Volunteer", "vol001");

    await grantPermission(central.id, "volunteers.issue_disciplinary");
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
    expect(before.description).toBe("Serious incident");
    expect(before.personId).toBe(target.id);
  });

  it("director cannot delete -> DisciplinaryForbiddenError", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const central = await createPerson("Central", "ctr001");
    const director = await createPerson("Director", "dir001");
    const target = await createPerson("Volunteer", "vol001");

    await grantPermission(central.id, "volunteers.issue_disciplinary");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(target.id, term.id, dept.id, "VOLUNTEER");

    const action = await issueCentral(central.id, target.id);

    await expect(deleteAction(director.id, action.id)).rejects.toBeInstanceOf(
      DisciplinaryForbiddenError
    );
  });

  it("missing action -> DisciplinaryNotFoundError", async () => {
    const central = await createPerson("Central", "ctr001");
    await grantPermission(central.id, "volunteers.issue_disciplinary");

    await expect(deleteAction(central.id, "nonexistent-id")).rejects.toBeInstanceOf(
      DisciplinaryNotFoundError
    );
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

    await grantPermission(central.id, "volunteers.issue_disciplinary");
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

    await grantPermission(central.id, "volunteers.issue_disciplinary");
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

    await grantPermission(central.id, "volunteers.issue_disciplinary");
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

    await grantPermission(central.id, "volunteers.issue_disciplinary");
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

    await grantPermission(central.id, "volunteers.issue_disciplinary");
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

    await grantPermission(central.id, "volunteers.issue_disciplinary");
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

  it("pagination: 26 rows -> page 1 has 25, page 2 has 1", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const central = await createPerson("Central", "ctr001");

    await grantPermission(central.id, "volunteers.issue_disciplinary");

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

// ---------------------------------------------------------------------------
// strikes
// ---------------------------------------------------------------------------

describe("strikes", () => {
  it("person with 3 actions shows strikes=3 in listActions rows and strikeCount", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const central = await createPerson("Central", "ctr001");
    const target = await createPerson("Repeat Offender", "ro001");

    await grantPermission(central.id, "volunteers.issue_disciplinary");
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
});

// ---------------------------------------------------------------------------
// issuablePeople
// ---------------------------------------------------------------------------

describe("issuablePeople", () => {
  it("central -> { all: true, people: [] }", async () => {
    const actor = await createPerson("Central", "ctr001");
    await grantPermission(actor.id, "volunteers.issue_disciplinary");

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
