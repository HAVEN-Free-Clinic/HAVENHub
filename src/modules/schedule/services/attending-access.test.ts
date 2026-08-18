import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { SYSTEM_ROLES } from "@/platform/rbac/system-roles";
import { getEffectivePermissions } from "@/platform/rbac/engine";
import {
  hubAccessState,
  enableHubAccess,
  disableHubAccess,
  enableHubAccessForActiveRoster,
} from "./attending-access";
import { AttendingForbiddenError } from "./attendings";

const FCRL = "fcrl-1";

/** Seed the Attending role the migration ships, so grants can be made. */
async function seedAttendingRole() {
  const def = SYSTEM_ROLES.find((r) => r.name === "Attending")!;
  await prisma.role.create({
    data: {
      name: def.name,
      description: def.description,
      isSystem: true,
      grants: { create: def.grants.map((permission) => ({ permission })) },
    },
  });
}

async function grantManageAttendings(personId = FCRL) {
  await prisma.person.upsert({
    where: { id: personId },
    update: {},
    create: { id: personId, name: "FCRL Director" },
  });
  const role = await prisma.role.create({
    data: {
      name: `r-${personId}`,
      isSystem: false,
      grants: { create: [{ permission: "schedule.manage_attendings" }] },
    },
  });
  await prisma.roleAssignment.create({ data: { roleId: role.id, personId, termId: null } });
}

async function attending(name: string, email: string | null, isActive = true) {
  return prisma.attending.create({ data: { scheduleName: name, fullName: name, email, isActive } });
}

beforeEach(async () => {
  await resetDb();
  await seedAttendingRole();
  await grantManageAttendings();
});

describe("hubAccessState", () => {
  it("routes a Yale address to SSO and anything else to the emailed link", () => {
    expect(hubAccessState({ id: "a", email: "pb@yale.edu", isActive: true, personId: null }).signInMethod).toBe(
      "yale-sso",
    );
    expect(hubAccessState({ id: "a", email: "pb@ynhh.org", isActive: true, personId: null }).signInMethod).toBe(
      "email-link",
    );
  });

  it("blocks on a missing email or an inactive roster row", () => {
    expect(hubAccessState({ id: "a", email: null, isActive: true, personId: null }).blockedReason).toMatch(/email/i);
    expect(hubAccessState({ id: "a", email: "x@yale.edu", isActive: false, personId: null }).blockedReason).toMatch(
      /inactive/i,
    );
  });

  /**
   * An already-linked attending is never "blocked": deactivating someone who has
   * an account is a roster decision, not a reason to report their existing
   * access as impossible.
   */
  it("never blocks an attending who already has an account", () => {
    expect(hubAccessState({ id: "a", email: null, isActive: false, personId: "p1" }).blockedReason).toBeNull();
  });
});

describe("enableHubAccess", () => {
  it("creates the Person, links it, and grants only schedule.view", async () => {
    const a = await attending("Peggy Bia", "peggy.bia@yale.edu");
    const r = await enableHubAccess(FCRL, a.id, { notify: false });
    expect(r.outcome).toBe("enabled");

    const linked = await prisma.attending.findUniqueOrThrow({ where: { id: a.id }, select: { personId: true } });
    expect(linked.personId).not.toBeNull();

    const person = await prisma.person.findUniqueOrThrow({ where: { id: linked.personId! } });
    expect(person.contactEmail).toBe("peggy.bia@yale.edu");
    expect(person.name).toBe("Peggy Bia");
    // NEVER an address: netId is the Yale NetID, is shaped like one, and feeds
    // the YNHH Epic access PDF.
    expect(person.netId).toBeNull();

    expect([...(await getEffectivePermissions(person.id))]).toEqual(["schedule.view"]);
  });

  /**
   * The overlap case is real: an attending who once volunteered, a PA who is
   * also staff. A second Person would split their identity in half, and
   * contactEmail is unique so the create would fail outright.
   */
  it("links an EXISTING person with that address rather than creating a duplicate", async () => {
    const existing = await prisma.person.create({
      data: { name: "Peggy Bia", contactEmail: "peggy.bia@yale.edu" },
    });
    const a = await attending("Peggy Bia", "peggy.bia@yale.edu");

    const r = await enableHubAccess(FCRL, a.id, { notify: false });
    expect(r).toMatchObject({ outcome: "enabled", personId: existing.id, linkedExisting: true });
    expect(await prisma.person.count({ where: { contactEmail: "peggy.bia@yale.edu" } })).toBe(1);
  });

  it("matches an existing person case-insensitively", async () => {
    const existing = await prisma.person.create({
      data: { name: "Peggy Bia", contactEmail: "Peggy.Bia@Yale.edu" },
    });
    const a = await attending("Peggy Bia", "peggy.bia@YALE.EDU");
    const r = await enableHubAccess(FCRL, a.id, { notify: false });
    expect(r).toMatchObject({ outcome: "enabled", personId: existing.id });
  });

  /**
   * getActivePerson gates sign-in on Person.status, so linking an offboarded
   * account would hand out access that silently does not work.
   */
  it("skips an address whose Person is not ACTIVE, rather than linking it", async () => {
    await prisma.person.create({
      data: { name: "Old Account", contactEmail: "gone@ynhh.org", status: "OFFBOARDED" },
    });
    const a = await attending("Gone Doc", "gone@ynhh.org");
    const r = await enableHubAccess(FCRL, a.id, { notify: false });
    expect(r).toMatchObject({ outcome: "skipped" });
    expect((await prisma.attending.findUniqueOrThrow({ where: { id: a.id } })).personId).toBeNull();
  });

  /**
   * A shared practice inbox, or the same doctor entered twice under different
   * schedule names. Attending.personId is unique, so linking the second would
   * throw a raw P2002 and, in the bulk run, read as an unexplained failure.
   */
  it("skips a second roster row sharing an address, naming who already holds it", async () => {
    const first = await attending("Peggy Bia", "office@practice.org");
    const second = await attending("Frank Bia", "office@practice.org");
    await enableHubAccess(FCRL, first.id, { notify: false });

    const r = await enableHubAccess(FCRL, second.id, { notify: false });
    expect(r).toMatchObject({ outcome: "skipped" });
    expect((r as { reason: string }).reason).toContain("Peggy Bia");
    expect((await prisma.attending.findUniqueOrThrow({ where: { id: second.id } })).personId).toBeNull();
  });

  it("skips an attending with no email and one who is inactive", async () => {
    const noEmail = await attending("No Email", null);
    const inactive = await attending("Inactive Doc", "x@yale.edu", false);
    expect((await enableHubAccess(FCRL, noEmail.id, { notify: false })).outcome).toBe("skipped");
    expect((await enableHubAccess(FCRL, inactive.id, { notify: false })).outcome).toBe("skipped");
  });

  it("is idempotent and does not create a second role assignment", async () => {
    const a = await attending("Peggy Bia", "peggy.bia@yale.edu");
    await enableHubAccess(FCRL, a.id, { notify: false });
    const second = await enableHubAccess(FCRL, a.id, { notify: false });
    expect(second.outcome).toBe("already-enabled");

    const role = await prisma.role.findUniqueOrThrow({ where: { name: "Attending" } });
    expect(await prisma.roleAssignment.count({ where: { roleId: role.id } })).toBe(1);
  });

  /** Re-running heals a grant somebody removed by hand in Admin > Roles. */
  it("re-asserts the role grant when re-run on a linked attending", async () => {
    const a = await attending("Peggy Bia", "peggy.bia@yale.edu");
    const { personId } = (await enableHubAccess(FCRL, a.id, { notify: false })) as { personId: string };
    const role = await prisma.role.findUniqueOrThrow({ where: { name: "Attending" } });
    await prisma.roleAssignment.deleteMany({ where: { roleId: role.id, personId } });

    await enableHubAccess(FCRL, a.id, { notify: false });
    expect(await prisma.roleAssignment.count({ where: { roleId: role.id, personId } })).toBe(1);
  });

  it("queues the welcome email by default", async () => {
    const a = await attending("Peggy Bia", "peggy.bia@yale.edu");
    await enableHubAccess(FCRL, a.id);
    const mail = await prisma.emailLog.findFirst({ where: { template: "attending-hub-access" } });
    expect(mail?.toEmail).toBe("peggy.bia@yale.edu");
  });

  it("refuses a caller without schedule.manage_attendings", async () => {
    const outsider = await prisma.person.create({ data: { name: "Outsider" } });
    const a = await attending("Peggy Bia", "peggy.bia@yale.edu");
    await expect(enableHubAccess(outsider.id, a.id, { notify: false })).rejects.toThrow(AttendingForbiddenError);
  });
});

describe("disableHubAccess", () => {
  /**
   * The Person SURVIVES: it may carry membership history, incident reports, or
   * tickets that predate the attending record. Unlinked plus ungranted is the
   * whole revocation.
   */
  it("unlinks and revokes, keeping the Person and their other roles", async () => {
    const a = await attending("Peggy Bia", "peggy.bia@yale.edu");
    const { personId } = (await enableHubAccess(FCRL, a.id, { notify: false })) as { personId: string };

    // They also direct a department, which this must not touch.
    const otherRole = await prisma.role.create({
      data: { name: "Some Director Role", grants: { create: [{ permission: "volunteers.view" }] } },
    });
    await prisma.roleAssignment.create({ data: { roleId: otherRole.id, personId } });

    await disableHubAccess(FCRL, a.id);

    expect((await prisma.attending.findUniqueOrThrow({ where: { id: a.id } })).personId).toBeNull();
    expect(await prisma.person.findUnique({ where: { id: personId } })).not.toBeNull();
    expect([...(await getEffectivePermissions(personId))]).toEqual(["volunteers.view"]);
  });

  it("is a no-op for an attending with no account", async () => {
    const a = await attending("No Account", "x@yale.edu");
    await expect(disableHubAccess(FCRL, a.id)).resolves.toBeUndefined();
  });
});

describe("enableHubAccessForActiveRoster", () => {
  it("enables everyone eligible and reports the rest", async () => {
    await attending("Yale Doc", "yale.doc@yale.edu");
    await attending("Hospital Doc", "hosp.doc@ynhh.org");
    await attending("No Email Doc", null);
    await attending("Inactive Doc", "inactive@yale.edu", false);
    const already = await attending("Already Doc", "already@yale.edu");
    await enableHubAccess(FCRL, already.id, { notify: false });

    const r = await enableHubAccessForActiveRoster(FCRL, { notify: false });
    expect(r.enabled).toBe(2);
    expect(r.alreadyEnabled).toBe(1);
    // The no-email row. The inactive one is not in the roster query at all, so
    // it is neither enabled nor reported -- deactivating IS the way to take
    // someone out of the rollout.
    expect(r.skipped.map((s) => s.scheduleName)).toEqual(["No Email Doc"]);

    const linked = await prisma.attending.count({ where: { personId: { not: null } } });
    expect(linked).toBe(3);
  });

  it("refuses a caller without schedule.manage_attendings", async () => {
    const outsider = await prisma.person.create({ data: { name: "Outsider" } });
    await expect(enableHubAccessForActiveRoster(outsider.id)).rejects.toThrow(AttendingForbiddenError);
  });
});
