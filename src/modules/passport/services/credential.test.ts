import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  CredentialForbiddenError,
  getCredential,
  getCredentialByToken,
  issueServiceCredential,
  publishCredential,
  restoreServiceCredential,
  revokeServiceCredential,
  unpublishCredential,
} from "./credential";

/** A person holding a role that grants exactly `permission`. */
async function actorWith(permission: string) {
  const person = await prisma.person.create({ data: { name: "Grace Hopper" } });
  const role = await prisma.role.create({
    data: { name: `role_${permission}`, grants: { create: [{ permission }] } },
  });
  await prisma.roleAssignment.create({ data: { personId: person.id, roleId: role.id } });
  return person;
}

async function seedMember() {
  const person = await prisma.person.create({ data: { name: "Ada Lovelace" } });
  const dept = await prisma.department.upsert({
    where: { code: "ITCM" },
    update: {},
    create: { code: "ITCM", name: "Internal Medicine" },
  });
  const term = await prisma.term.create({
    data: {
      code: "SU26",
      name: "Summer 2026",
      startDate: new Date("2026-05-01T12:00:00Z"),
      endDate: new Date("2026-08-31T12:00:00Z"),
      status: "ACTIVE",
    },
  });
  await prisma.termMembership.create({
    data: { personId: person.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER" },
  });
  return { person, term, dept };
}

describe("issueServiceCredential", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("stores the computed record and returns it", async () => {
    const { person } = await seedMember();

    const issued = await issueServiceCredential(person.id);

    expect(issued.record.name).toBe("Ada Lovelace");
    expect(issued.record.terms).toHaveLength(1);
    expect(issued.publicToken).toBeNull();
    expect(issued.revokedAt).toBeNull();

    const row = await prisma.serviceCredential.findUnique({ where: { personId: person.id } });
    expect(row).not.toBeNull();
  });

  it("re-issues in place rather than creating a second row", async () => {
    const { person, dept } = await seedMember();
    await issueServiceCredential(person.id);

    // A term that has already STARTED. computeServiceRecord excludes terms whose
    // start date is still in the future, because this clinic rosters the next
    // term ahead of the flip and unserved time is not service.
    const second = await prisma.term.create({
      data: {
        code: "FA25",
        name: "Fall 2025",
        startDate: new Date("2025-09-01T12:00:00Z"),
        endDate: new Date("2025-12-20T12:00:00Z"),
        status: "ARCHIVED",
      },
    });
    await prisma.termMembership.create({
      data: { personId: person.id, termId: second.id, departmentId: dept.id, kind: "DIRECTOR" },
    });

    const reissued = await issueServiceCredential(person.id);

    expect(reissued.record.terms).toHaveLength(2);
    expect(await prisma.serviceCredential.count()).toBe(1);
  });

  it("preserves the public token across a re-issue", async () => {
    const { person } = await seedMember();
    await issueServiceCredential(person.id);
    await prisma.serviceCredential.update({
      where: { personId: person.id },
      data: { publicToken: "tok_existing" },
    });

    const reissued = await issueServiceCredential(person.id);

    expect(reissued.publicToken).toBe("tok_existing");
  });

  it("returns JSON-safe data", async () => {
    const { person } = await seedMember();

    const issued = await issueServiceCredential(person.id);

    expect(JSON.parse(JSON.stringify(issued))).toEqual(issued);
  });
});

describe("getCredential", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("returns null when nothing has been issued", async () => {
    const { person } = await seedMember();
    expect(await getCredential(person.id)).toBeNull();
  });

  it("returns the issued credential", async () => {
    const { person } = await seedMember();
    await issueServiceCredential(person.id);

    const found = await getCredential(person.id);

    expect(found!.record.name).toBe("Ada Lovelace");
  });
});

describe("publishing", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("mints an unguessable token and makes the credential findable by it", async () => {
    const { person } = await seedMember();
    await issueServiceCredential(person.id);

    const token = await publishCredential(person.id);

    expect(token.length).toBeGreaterThanOrEqual(32);
    const found = await getCredentialByToken(token);
    expect(found!.record.name).toBe("Ada Lovelace");
  });

  it("is idempotent: publishing twice keeps the same token", async () => {
    const { person } = await seedMember();
    await issueServiceCredential(person.id);

    const first = await publishCredential(person.id);
    const second = await publishCredential(person.id);

    expect(second).toBe(first);
  });

  it("issues the credential first when the member has never generated one", async () => {
    const { person } = await seedMember();

    const token = await publishCredential(person.id);

    expect(await getCredentialByToken(token)).not.toBeNull();
  });

  it("unpublishing makes the token stop resolving", async () => {
    const { person } = await seedMember();
    const token = await publishCredential(person.id);

    await unpublishCredential(person.id);

    expect(await getCredentialByToken(token)).toBeNull();
  });

  it("does not resolve a revoked credential", async () => {
    const { person } = await seedMember();
    const token = await publishCredential(person.id);
    await prisma.serviceCredential.update({
      where: { personId: person.id },
      data: { revokedAt: new Date() },
    });

    expect(await getCredentialByToken(token)).toBeNull();
  });
});

describe("admin revocation", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("takes a published credential off the public internet", async () => {
    // The control the schema documents and nothing wrote until audit 14. It is
    // also the ONLY retraction that reaches an offboarded member: unpublish
    // lives on /my-info, behind a sign-in they no longer have.
    const { person } = await seedMember();
    const token = await publishCredential(person.id);
    await prisma.person.update({ where: { id: person.id }, data: { status: "OFFBOARDED" } });
    const admin = await actorWith("admin.manage_people");

    await revokeServiceCredential(admin.id, person.id);

    expect(await getCredentialByToken(token)).toBeNull();
    expect((await getCredential(person.id))!.revokedAt).not.toBeNull();
  });

  it("refuses an actor without the permission, leaving the page up", async () => {
    const { person } = await seedMember();
    const token = await publishCredential(person.id);
    // A real, closely-related permission rather than a bare person: this must
    // gate on the named one, not merely on "holds something".
    const nosy = await actorWith("volunteers.view");

    await expect(revokeServiceCredential(nosy.id, person.id)).rejects.toThrow(
      CredentialForbiddenError,
    );
    expect(await getCredentialByToken(token)).not.toBeNull();
  });

  it("records who revoked it", async () => {
    const { person } = await seedMember();
    await publishCredential(person.id);
    const admin = await actorWith("admin.manage_people");

    await revokeServiceCredential(admin.id, person.id);

    const entry = await prisma.auditLog.findFirst({ where: { action: "passport.revoke" } });
    expect(entry!.actorPersonId).toBe(admin.id);
    expect(entry!.entityId).toBe(person.id);
  });

  it("keeps the original timestamp when revoked twice", async () => {
    // A second click must not rewrite when the retraction took effect.
    const { person } = await seedMember();
    await publishCredential(person.id);
    const admin = await actorWith("admin.manage_people");

    await revokeServiceCredential(admin.id, person.id);
    const first = (await getCredential(person.id))!.revokedAt;
    await revokeServiceCredential(admin.id, person.id);

    expect((await getCredential(person.id))!.revokedAt).toBe(first);
    expect(await prisma.auditLog.count({ where: { action: "passport.revoke" } })).toBe(1);
  });

  it("restores the credential at the SAME url it had before", async () => {
    // Revocation keeps the token, so undoing a wrong decision gives the member
    // back the link they already shared rather than a new one.
    const { person } = await seedMember();
    const token = await publishCredential(person.id);
    const admin = await actorWith("admin.manage_people");
    await revokeServiceCredential(admin.id, person.id);

    await restoreServiceCredential(admin.id, person.id);

    expect(await getCredentialByToken(token)).not.toBeNull();
  });

  it("refuses to restore without the permission", async () => {
    const { person } = await seedMember();
    const token = await publishCredential(person.id);
    const admin = await actorWith("admin.manage_people");
    await revokeServiceCredential(admin.id, person.id);
    const nosy = await actorWith("volunteers.view");

    await expect(restoreServiceCredential(nosy.id, person.id)).rejects.toThrow(
      CredentialForbiddenError,
    );
    expect(await getCredentialByToken(token)).toBeNull();
  });
});
