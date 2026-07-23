/**
 * TDD tests for notifyStrikeIssued.
 *
 * Recipients:
 *   - The subject always gets incidents.strike_issued.
 *   - Directors of the subject's ACTIVE departments in the ACTIVE term get
 *     incidents.strike_issued_directors.
 *   - A confidential strike notifies NO director (mirrors directorVisibility).
 *   - The subject is excluded from the director set.
 *   - The issuing actor is excluded from the director set.
 *   - A subject with no active membership notifies only the subject.
 *   - Delivery failure is swallowed, never thrown.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { notifyStrikeIssued } from "./strike-notifications";
import { issueAction } from "./disciplinary";

async function createPerson(name: string, netId?: string) {
  return prisma.person.create({ data: { name, netId, contactEmail: `${netId}@yale.edu` } });
}

async function createTerm(code = "SU26") {
  return prisma.term.create({
    data: {
      code,
      name: `Term ${code}`,
      startDate: new Date("2026-05-01"),
      endDate: new Date("2026-09-26"),
      status: "ACTIVE",
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
  kind: "VOLUNTEER" | "DIRECTOR"
) {
  return prisma.termMembership.create({
    data: { personId, termId, departmentId, kind, status: "ACTIVE" },
  });
}

async function grantPermission(personId: string, permission: string) {
  const role = await prisma.role.create({
    data: {
      name: `Role-${permission}-${Math.random()}`,
      isSystem: false,
      grants: { create: [{ permission }] },
    },
  });
  await prisma.roleAssignment.create({ data: { roleId: role.id, personId, termId: null } });
}

/** Issue a strike against `subjectId` as a central actor, bypassing the UI. */
async function strike(
  actorId: string,
  subjectId: string,
  opts: { confidential?: boolean } = {}
) {
  return issueAction(actorId, {
    personId: subjectId,
    occurredAt: new Date("2026-07-01"),
    category: "Attendance",
    description: "No-show to an assigned clinic shift.",
    confidential: opts.confidential ?? false,
  });
}

beforeEach(resetDb);

describe("notifyStrikeIssued", () => {
  it("notifies the subject and the directors of their department", async () => {
    const term = await createTerm();
    const dept = await createDepartment("SCTM");
    const central = await createPerson("Central", "sn-central");
    const subject = await createPerson("Subject", "sn-subject");
    const director = await createPerson("Director", "sn-director");
    await grantPermission(central.id, "incidents.manage");
    await createMembership(subject.id, term.id, dept.id, "VOLUNTEER");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");

    const action = await strike(central.id, subject.id);
    await notifyStrikeIssued({ action, actorPersonId: central.id });

    const subjectNotes = await prisma.notification.findMany({
      where: { personId: subject.id, type: "incidents.strike_issued" },
    });
    expect(subjectNotes).toHaveLength(1);

    const directorNotes = await prisma.notification.findMany({
      where: { personId: director.id, type: "incidents.strike_issued_directors" },
    });
    expect(directorNotes).toHaveLength(1);
    expect(directorNotes[0].body).toContain("Subject");
    expect(directorNotes[0].link).toMatch(/\/incidents\/strikes$/);
  });

  it("notifies no director when the strike is confidential", async () => {
    const term = await createTerm();
    const dept = await createDepartment("JCTM");
    const central = await createPerson("Central", "sn-conf-c");
    const subject = await createPerson("Subject", "sn-conf-s");
    const director = await createPerson("Director", "sn-conf-d");
    await grantPermission(central.id, "incidents.manage");
    await createMembership(subject.id, term.id, dept.id, "VOLUNTEER");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");

    const action = await strike(central.id, subject.id, { confidential: true });
    await notifyStrikeIssued({ action, actorPersonId: central.id });

    // The subject is still told.
    expect(
      await prisma.notification.count({
        where: { personId: subject.id, type: "incidents.strike_issued" },
      })
    ).toBe(1);
    // The director is not: directorVisibility would hide the row from them.
    expect(await prisma.notification.count({ where: { personId: director.id } })).toBe(0);
  });

  it("excludes the subject from the director set when the subject is themselves a director", async () => {
    const term = await createTerm();
    const dept = await createDepartment("PCAR");
    const central = await createPerson("Central", "sn-self-c");
    const subject = await createPerson("Director Subject", "sn-self-s");
    await grantPermission(central.id, "incidents.manage");
    await createMembership(subject.id, term.id, dept.id, "DIRECTOR");

    const action = await strike(central.id, subject.id);
    await notifyStrikeIssued({ action, actorPersonId: central.id });

    expect(
      await prisma.notification.count({
        where: { personId: subject.id, type: "incidents.strike_issued_directors" },
      })
    ).toBe(0);
    expect(
      await prisma.notification.count({
        where: { personId: subject.id, type: "incidents.strike_issued" },
      })
    ).toBe(1);
  });

  it("excludes the issuing actor from the director set", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const director = await createPerson("Issuing Director", "sn-act-d");
    const subject = await createPerson("Subject", "sn-act-s");
    await grantPermission(director.id, "incidents.manage");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(subject.id, term.id, dept.id, "VOLUNTEER");

    const action = await strike(director.id, subject.id);
    await notifyStrikeIssued({ action, actorPersonId: director.id });

    expect(await prisma.notification.count({ where: { personId: director.id } })).toBe(0);
  });

  it("notifies only the subject when they have no active membership", async () => {
    const central = await createPerson("Central", "sn-nomem-c");
    const subject = await createPerson("Subject", "sn-nomem-s");
    await grantPermission(central.id, "incidents.manage");

    const action = await strike(central.id, subject.id);
    await notifyStrikeIssued({ action, actorPersonId: central.id });

    expect(
      await prisma.notification.count({
        where: { personId: subject.id, type: "incidents.strike_issued" },
      })
    ).toBe(1);
    expect(
      await prisma.notification.count({ where: { type: "incidents.strike_issued_directors" } })
    ).toBe(0);
  });

  it("is a no-op, not a throw, when the subject no longer exists", async () => {
    const central = await createPerson("Central", "sn-throw-c");
    const subject = await createPerson("Subject", "sn-throw-s");
    await grantPermission(central.id, "incidents.manage");
    const action = await strike(central.id, subject.id);

    await prisma.disciplinaryAction.delete({ where: { id: action.id } });
    await prisma.person.delete({ where: { id: subject.id } });

    // The stale action object still resolves without throwing into the caller.
    await expect(
      notifyStrikeIssued({ action, actorPersonId: central.id })
    ).resolves.toBeUndefined();
    expect(await prisma.notification.count()).toBe(0);
  });
});
