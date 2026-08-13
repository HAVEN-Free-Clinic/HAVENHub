import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { assertSafeToolOutput, collectSchemaKeys, FORBIDDEN_OUTPUT_PATTERN, IDENTITY_ARGUMENT_PATTERN } from "./index";
import { departmentRosterTool, memberStatusTool } from "./roster";

/**
 * These are real-DB tests, not mocked-service ones like compliance.test.ts and
 * training.test.ts. That is deliberate: the risk these tools exist to guard
 * against lives inside permissionDepartmentIds' actual assignment-scope logic
 * (kind-targeted vs person-targeted vs department-targeted), and mocking the
 * RBAC engine would hide exactly the bug this suite is written to catch --
 * see "directs one department, volunteers in another" below.
 */

async function fixture() {
  const term = await prisma.term.create({
    data: {
      code: "SU26",
      name: "Summer 2026",
      startDate: new Date("2026-05-30"),
      endDate: new Date("2026-09-26"),
      status: "ACTIVE",
    },
  });
  const nursing = await prisma.department.create({ data: { code: "NURS", name: "Nursing" } });
  const triage = await prisma.department.create({ data: { code: "TRIA", name: "Triage" } });

  // Mirrors the real baseline: Director gets volunteers.view through a
  // kind-targeted assignment (system-roles.ts); Volunteer does not.
  const directorRole = await prisma.role.create({
    data: { name: "Director", isSystem: true, grants: { create: [{ permission: "volunteers.view" }] } },
  });
  const volunteerRole = await prisma.role.create({
    data: { name: "Volunteer", isSystem: true, grants: { create: [{ permission: "schedule.view" }] } },
  });
  const peopleAdminRole = await prisma.role.create({
    data: { name: "People Admin", grants: { create: [{ permission: "admin.manage_people" }] } },
  });
  await prisma.roleAssignment.create({ data: { roleId: directorRole.id, kind: "DIRECTOR", termId: null } });
  await prisma.roleAssignment.create({ data: { roleId: volunteerRole.id, kind: "VOLUNTEER", termId: null } });

  return { term, nursing, triage, peopleAdminRole };
}

function createPerson(name: string, opts?: { netId?: string; contactEmail?: string; phone?: string }) {
  return prisma.person.create({
    data: { name, netId: opts?.netId, contactEmail: opts?.contactEmail, phone: opts?.phone },
  });
}

function addMembership(personId: string, termId: string, departmentId: string, kind: "DIRECTOR" | "VOLUNTEER") {
  return prisma.termMembership.create({ data: { personId, termId, departmentId, kind, status: "ACTIVE" } });
}

beforeEach(resetDb);

describe("phase 3 roster tools -- authorization", () => {
  /**
   * The load-bearing test. A naive gate (can(caller, "volunteers.view")) would
   * pass for this caller on EITHER department, because the Director kind-target
   * assignment makes volunteers.view reach them department-blind. Only
   * permissionDepartmentIds' per-assignment scoping tells Nursing (where their
   * membership is DIRECTOR) apart from Triage (where it is merely VOLUNTEER).
   */
  it("lets a caller read the roster of a department they direct, but refuses one where they only volunteer", async () => {
    const f = await fixture();
    const caller = await createPerson("Multi-Hat Caller");
    await addMembership(caller.id, f.term.id, f.nursing.id, "DIRECTOR");
    await addMembership(caller.id, f.term.id, f.triage.id, "VOLUNTEER");

    const nursingVolunteer = await createPerson("Alice Nursing");
    await addMembership(nursingVolunteer.id, f.term.id, f.nursing.id, "VOLUNTEER");
    const triageVolunteer = await createPerson("Bob Triage");
    await addMembership(triageVolunteer.id, f.term.id, f.triage.id, "VOLUNTEER");

    const nursingText = await departmentRosterTool.run({ personId: caller.id }, { department: "Nursing" });
    expect(nursingText).toContain("Alice Nursing");
    expect(nursingText).not.toMatch(/do not have access/i);

    const triageText = await departmentRosterTool.run({ personId: caller.id }, { department: "Triage" });
    expect(triageText).toMatch(/do not have access/i);
    expect(triageText).not.toContain("Bob Triage");
  });

  /** Same scoping shape, exercised through member_status instead of department_roster. */
  it("confirms a person's membership in a department the caller directs, and stays silent about one they only volunteer in", async () => {
    const f = await fixture();
    const caller = await createPerson("Multi-Hat Caller 2");
    await addMembership(caller.id, f.term.id, f.nursing.id, "DIRECTOR");
    await addMembership(caller.id, f.term.id, f.triage.id, "VOLUNTEER");

    const inNursing = await createPerson("Carol InNursing");
    await addMembership(inNursing.id, f.term.id, f.nursing.id, "VOLUNTEER");
    const inTriage = await createPerson("Dave InTriage");
    await addMembership(inTriage.id, f.term.id, f.triage.id, "VOLUNTEER");

    const nursingAnswer = await memberStatusTool.run({ personId: caller.id }, { name: "Carol InNursing" });
    expect(nursingAnswer).toContain("Carol InNursing");
    expect(nursingAnswer).toContain("Nursing");

    const triageAnswer = await memberStatusTool.run({ personId: caller.id }, { name: "Dave InTriage" });
    expect(triageAnswer).not.toContain("Dave InTriage");
    expect(triageAnswer).not.toContain("Triage");
  });

  it("returns byte-identical refusal text for a real person outside the caller's scope and a person who does not exist", async () => {
    const f = await fixture();
    const caller = await createPerson("Scoped Director");
    await addMembership(caller.id, f.term.id, f.nursing.id, "DIRECTOR");

    const outOfScope = await createPerson("Erin OutOfScope");
    await addMembership(outOfScope.id, f.term.id, f.triage.id, "VOLUNTEER");

    const realButHiddenText = await memberStatusTool.run({ personId: caller.id }, { name: "Erin OutOfScope" });
    const nonexistentText = await memberStatusTool.run({ personId: caller.id }, { name: "Nobody Real Zzyzx" });

    expect(realButHiddenText).toBe(nonexistentText);
  });

  it("denies department_roster to a caller with no departmental standing at all, rather than an empty roster", async () => {
    const f = await fixture();
    const outsider = await createPerson("No Standing");
    const realVolunteer = await createPerson("Real Volunteer");
    await addMembership(realVolunteer.id, f.term.id, f.nursing.id, "VOLUNTEER");

    const text = await departmentRosterTool.run({ personId: outsider.id }, { department: "Nursing" });

    expect(text).toMatch(/do not have access/i);
    expect(text).not.toContain("Real Volunteer");
  });

  it("denies member_status to a caller with no departmental standing at all", async () => {
    const f = await fixture();
    const outsider = await createPerson("No Standing 2");
    const realVolunteer = await createPerson("Real Volunteer 2");
    await addMembership(realVolunteer.id, f.term.id, f.nursing.id, "VOLUNTEER");

    const text = await memberStatusTool.run({ personId: outsider.id }, { name: "Real Volunteer 2" });

    expect(text).toMatch(/could not confirm/i);
    expect(text).not.toContain("Real Volunteer 2");
  });

  it("a plain volunteer (no volunteers.view grant) is denied their own department's roster", async () => {
    // Confirms the baseline Volunteer role really does not carry volunteers.view --
    // if it ever did, this and the "denies with no standing" tests would start failing loudly rather
    // than silently widening access.
    const f = await fixture();
    const volunteer = await createPerson("Plain Volunteer");
    await addMembership(volunteer.id, f.term.id, f.nursing.id, "VOLUNTEER");

    const text = await departmentRosterTool.run({ personId: volunteer.id }, { department: "Nursing" });

    expect(text).toMatch(/do not have access/i);
  });
});

describe("phase 3 roster tools -- platform-scope widening", () => {
  /**
   * THE load-bearing test for this change. Same shape as "directs A,
   * volunteers in B" above, run again now that hasPlatformScope exists,
   * to prove the new OR-branch never fires for a department/kind-scoped
   * grant. If hasPlatformScope had been implemented as
   * can(caller, "volunteers.view") (department-blind) instead of "reaches
   * them via a personId-targeted RoleAssignment", this test would fail:
   * can() returns true for this caller on volunteers.view purely because of
   * the kind-targeted Director assignment, and Triage would wrongly open up
   * -- exactly the leak permissionDepartmentIds exists to prevent, and
   * exactly the failure mode this test exists to catch.
   */
  it("does not widen a caller who directs A and only volunteers in B -- their volunteers.view is entirely kind-targeted, never person-targeted", async () => {
    const f = await fixture();
    const caller = await createPerson("Not Platform Scoped");
    await addMembership(caller.id, f.term.id, f.nursing.id, "DIRECTOR");
    await addMembership(caller.id, f.term.id, f.triage.id, "VOLUNTEER");

    const nursingVolunteer = await createPerson("Nell Nursing");
    await addMembership(nursingVolunteer.id, f.term.id, f.nursing.id, "VOLUNTEER");
    const triageVolunteer = await createPerson("Tia Triage");
    await addMembership(triageVolunteer.id, f.term.id, f.triage.id, "VOLUNTEER");

    const nursingText = await departmentRosterTool.run({ personId: caller.id }, { department: "Nursing" });
    expect(nursingText).toContain("Nell Nursing");
    expect(nursingText).not.toMatch(/do not have access/i);

    const triageText = await departmentRosterTool.run({ personId: caller.id }, { department: "Triage" });
    expect(triageText).toMatch(/do not have access/i);
    expect(triageText).not.toContain("Tia Triage");

    const triageStatus = await memberStatusTool.run({ personId: caller.id }, { name: "Tia Triage" });
    const nonexistentStatus = await memberStatusTool.run({ personId: caller.id }, { name: "Nobody Real Zzyzx3" });
    expect(triageStatus).not.toContain("Tia Triage");
    expect(triageStatus).toBe(nonexistentStatus);
  });

  it("grants clinic-wide reach to a platform-scoped admin with no departmental membership at all (the reported gap)", async () => {
    const f = await fixture();
    // Mirrors the real shape described in the bug report: an IT/super-admin
    // holding a role assigned directly to them (a personId-targeted
    // RoleAssignment), never a TermMembership of their own. Under the old
    // permissionDepartmentIds-only check this person got nothing, because
    // its "memberships.length === 0 -> []" guard fires before it even looks
    // at assignments.
    const platformRole = await prisma.role.create({
      data: {
        name: "IT Admin",
        grants: { create: [{ permission: "volunteers.view" }, { permission: "admin.manage_people" }] },
      },
    });
    const admin = await createPerson("IT Admin Caller");
    await prisma.roleAssignment.create({ data: { roleId: platformRole.id, personId: admin.id, termId: null } });

    const nursingVolunteer = await createPerson("Nia Nursing");
    await addMembership(nursingVolunteer.id, f.term.id, f.nursing.id, "VOLUNTEER");

    const rosterText = await departmentRosterTool.run({ personId: admin.id }, { department: "Nursing" });
    expect(rosterText).toContain("Nia Nursing");
    expect(rosterText).not.toMatch(/do not have access/i);

    const statusText = await memberStatusTool.run({ personId: admin.id }, { name: "Nia Nursing" });
    expect(statusText).toContain("Nia Nursing");
    expect(statusText).toContain("Nursing");
  });

  it("gives a clinic-wide role holder reach beyond their own department, unlike a plain director with the same memberships", async () => {
    const f = await fixture();
    // Compliance-Manager-shaped: volunteers.view granted via a
    // person-targeted assignment (the real system role is assigned to
    // individuals the same way), and this particular holder also happens to
    // direct Nursing -- the exact "clinic-wide role holder" shape from the
    // bug report. A plain Nursing director in this fixture cannot see
    // Triage's roster (see the non-widening test above); this caller must.
    const complianceRole = await prisma.role.create({
      data: {
        name: "Compliance Manager Test Role",
        grants: { create: [{ permission: "volunteers.view" }, { permission: "volunteers.manage_compliance" }] },
      },
    });
    const manager = await createPerson("Compliance Manager Caller");
    await prisma.roleAssignment.create({ data: { roleId: complianceRole.id, personId: manager.id, termId: null } });
    await addMembership(manager.id, f.term.id, f.nursing.id, "DIRECTOR");

    const triageVolunteer = await createPerson("Toby Triage");
    await addMembership(triageVolunteer.id, f.term.id, f.triage.id, "VOLUNTEER");

    const triageText = await departmentRosterTool.run({ personId: manager.id }, { department: "Triage" });
    expect(triageText).toContain("Toby Triage");
    expect(triageText).not.toMatch(/do not have access/i);
  });

  it("still refuses a caller with a person-targeted grant of an unrelated permission and no departmental reach, not an empty list", async () => {
    const f = await fixture();
    const admin = await createPerson("People Admin Only, No Roster Access");
    await prisma.roleAssignment.create({ data: { roleId: f.peopleAdminRole.id, personId: admin.id, termId: null } });
    // No TermMembership at all, and admin.manage_people never implies
    // volunteers.view -- hasPlatformScope is checked against the specific
    // permission the roster tools need, not "holds some person-targeted
    // grant of anything".

    const realVolunteer = await createPerson("Real Volunteer 3");
    await addMembership(realVolunteer.id, f.term.id, f.nursing.id, "VOLUNTEER");

    const rosterText = await departmentRosterTool.run({ personId: admin.id }, { department: "Nursing" });
    expect(rosterText).toMatch(/do not have access/i);
    expect(rosterText).not.toContain("Real Volunteer 3");

    const statusText = await memberStatusTool.run({ personId: admin.id }, { name: "Real Volunteer 3" });
    expect(statusText).toMatch(/could not confirm/i);
    expect(statusText).not.toContain("Real Volunteer 3");
  });
});

describe("department_roster", () => {
  it("says it could not find a department by an unrecognized name", async () => {
    const f = await fixture();
    const caller = await createPerson("Caller");
    await addMembership(caller.id, f.term.id, f.nursing.id, "DIRECTOR");

    const text = await departmentRosterTool.run({ personId: caller.id }, { department: "Not A Real Department" });

    expect(text).toMatch(/could not find a department/i);
  });

  it("resolves a department by its code, case-insensitively", async () => {
    const f = await fixture();
    const caller = await createPerson("Caller Code");
    await addMembership(caller.id, f.term.id, f.nursing.id, "DIRECTOR");

    const text = await departmentRosterTool.run({ personId: caller.id }, { department: "nurs" });

    expect(text).toContain("Nursing");
    expect(text).not.toMatch(/could not find/i);
  });

  it("says so plainly when there is no active clinic term", async () => {
    // No fixture() call: no ACTIVE term exists at all.
    const dept = await prisma.department.create({ data: { code: "NOTM", name: "No Term Dept" } });
    const caller = await prisma.person.create({ data: { name: "Caller" } });

    const text = await departmentRosterTool.run({ personId: caller.id }, { department: dept.name });

    expect(text).toMatch(/no active clinic term/i);
  });

  it("bounds a long roster instead of dumping every name", async () => {
    const f = await fixture();
    const caller = await createPerson("Director Of Big Dept");
    await addMembership(caller.id, f.term.id, f.nursing.id, "DIRECTOR");
    for (let i = 0; i < 30; i++) {
      const p = await createPerson(`Volunteer ${String(i).padStart(2, "0")}`);
      await addMembership(p.id, f.term.id, f.nursing.id, "VOLUNTEER");
    }

    const text = await departmentRosterTool.run({ personId: caller.id }, { department: "Nursing" });

    expect(text).toContain("30 volunteer(s)");
    expect(text).toContain("and 5 more"); // 30 volunteers, MAX_LISTED = 25
    expect(text).not.toContain("Volunteer 29"); // the truncated tail must not leak through
  });

  it("declares no identity-shaped input", () => {
    for (const key of collectSchemaKeys(departmentRosterTool.inputSchema)) {
      expect(IDENTITY_ARGUMENT_PATTERN.test(key)).toBe(false);
    }
    expect(Object.keys(departmentRosterTool.inputSchema.shape)).toEqual(["department"]);
  });
});

describe("member_status", () => {
  it("resolves a person by Yale NetID, case-insensitively", async () => {
    const f = await fixture();
    const caller = await createPerson("Caller NetId");
    await addMembership(caller.id, f.term.id, f.nursing.id, "DIRECTOR");
    const target = await createPerson("Net Id Target", { netId: "abc123" });
    await addMembership(target.id, f.term.id, f.nursing.id, "VOLUNTEER");

    const text = await memberStatusTool.run({ personId: caller.id }, { name: "ABC123" });

    expect(text).toContain("Net Id Target");
  });

  it("refuses rather than guesses when a name matches more than one active person", async () => {
    const f = await fixture();
    const caller = await createPerson("Caller Dup");
    await addMembership(caller.id, f.term.id, f.nursing.id, "DIRECTOR");
    await createPerson("Same Name");
    await createPerson("Same Name");

    const text = await memberStatusTool.run({ personId: caller.id }, { name: "Same Name" });

    expect(text).toMatch(/could not confirm/i);
  });

  it("says so plainly when there is no active clinic term", async () => {
    const caller = await prisma.person.create({ data: { name: "Caller" } });

    const text = await memberStatusTool.run({ personId: caller.id }, { name: "Anyone" });

    expect(text).toMatch(/no active clinic term/i);
  });

  it("does not reveal contact info to a caller who only holds departmental visibility", async () => {
    const f = await fixture();
    const caller = await createPerson("Director No Admin");
    await addMembership(caller.id, f.term.id, f.nursing.id, "DIRECTOR");
    const target = await createPerson("Contact Target", { contactEmail: "target@example.com", phone: "203-555-0100" });
    await addMembership(target.id, f.term.id, f.nursing.id, "VOLUNTEER");

    const text = await memberStatusTool.run({ personId: caller.id }, { name: "Contact Target" });

    expect(text).not.toContain("target@example.com");
    expect(text).not.toContain("203-555-0100");
    expect(text).not.toMatch(/contact:/i);
  });

  it("includes contact info only for a caller who holds admin.manage_people, matching what /admin/people shows them", async () => {
    const f = await fixture();
    const admin = await createPerson("People Admin Caller");
    await prisma.roleAssignment.create({ data: { roleId: f.peopleAdminRole.id, personId: admin.id, termId: null } });
    // admin.manage_people is additive only -- the caller still needs departmental
    // standing of their own for the primary check to pass at all (see the
    // file-level comment in roster.ts on why this is not a master key).
    await addMembership(admin.id, f.term.id, f.nursing.id, "DIRECTOR");
    const target = await createPerson("Contact Target 2", { contactEmail: "target2@example.com", phone: "203-555-0101" });
    await addMembership(target.id, f.term.id, f.nursing.id, "VOLUNTEER");

    const text = await memberStatusTool.run({ personId: admin.id }, { name: "Contact Target 2" });

    expect(text).toContain("target2@example.com");
    expect(text).toContain("203-555-0101");
    expect(FORBIDDEN_OUTPUT_PATTERN.test(text)).toBe(false);
    expect(() => assertSafeToolOutput(text)).not.toThrow();
  });

  it("declares no identity-shaped input", () => {
    for (const key of collectSchemaKeys(memberStatusTool.inputSchema)) {
      expect(IDENTITY_ARGUMENT_PATTERN.test(key)).toBe(false);
    }
    expect(Object.keys(memberStatusTool.inputSchema.shape)).toEqual(["name"]);
  });
});
