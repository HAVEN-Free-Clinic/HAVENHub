import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  getCredential,
  getCredentialByToken,
  issueServiceCredential,
  publishCredential,
  unpublishCredential,
} from "./credential";

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

    const second = await prisma.term.create({
      data: {
        code: "FA26",
        name: "Fall 2026",
        startDate: new Date("2026-09-01T12:00:00Z"),
        endDate: new Date("2026-12-20T12:00:00Z"),
        status: "ACTIVE",
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
