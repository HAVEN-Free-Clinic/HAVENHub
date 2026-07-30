import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { findReturningMember } from "./returning-member";
import type { ApplicantIdentity } from "./portal-auth";

const identity = (over: Partial<ApplicantIdentity> = {}): ApplicantIdentity => ({
  email: "jc999@yale.edu",
  personId: null,
  firstName: null,
  ...over,
});

async function seedAlum(over: Partial<Prisma.PersonCreateInput> = {}) {
  return prisma.person.create({
    data: {
      name: "Jack Carney",
      netId: "jc999",
      contactEmail: "j.carney@yale.edu",
      status: "OFFBOARDED",
      ...over,
    },
  });
}

async function seedTerm(code: string, name: string, startDate: string) {
  return prisma.term.create({
    data: {
      code,
      name,
      startDate: new Date(startDate),
      endDate: new Date(startDate),
      status: "ARCHIVED",
    },
  });
}

describe("findReturningMember", () => {
  beforeEach(resetDb);

  it("returns null when the session already resolved to a member", async () => {
    const person = await seedAlum({ status: "ACTIVE" });
    expect(await findReturningMember(identity({ personId: person.id }))).toBeNull();
  });

  it("returns null when the claim names nobody", async () => {
    expect(await findReturningMember(identity({ email: "nobody@yale.edu" }))).toBeNull();
  });

  it("recognizes an OFFBOARDED alum by NetID-shaped Yale address", async () => {
    await seedAlum();
    const found = await findReturningMember(identity({ email: "jc999@yale.edu" }));

    expect(found).toMatchObject({ name: "Jack Carney", isFormerMember: true, lastTerm: null });
  });

  it("recognizes an alum by Yale-asserted alias email", async () => {
    await seedAlum();
    const found = await findReturningMember(identity({ email: "j.carney@yale.edu" }));

    expect(found?.name).toBe("Jack Carney");
  });

  it("reports the most recent term served, with departments", async () => {
    const person = await seedAlum();
    const sp26 = await seedTerm("SP26", "Spring 2026", "2026-01-12T12:00:00Z");
    const fa25 = await seedTerm("FA25", "Fall 2025", "2025-09-01T12:00:00Z");
    const pham = await prisma.department.create({ data: { code: "PHAM", name: "Pharmacy" } });
    const itcm = await prisma.department.create({ data: { code: "ITCM", name: "IT" } });

    for (const [termId, departmentId] of [
      [sp26.id, pham.id],
      [sp26.id, itcm.id],
      [fa25.id, pham.id],
    ] as const) {
      await prisma.termMembership.create({
        data: { personId: person.id, termId, departmentId, kind: "VOLUNTEER", status: "ACTIVE" },
      });
    }

    const found = await findReturningMember(identity());
    expect(found?.lastTerm).toEqual({
      code: "SP26",
      name: "Spring 2026",
      departments: ["IT", "Pharmacy"],
    });
  });

  it("ignores REMOVED memberships when picking the last term served", async () => {
    const person = await seedAlum();
    const sp26 = await seedTerm("SP26", "Spring 2026", "2026-01-12T12:00:00Z");
    const dept = await prisma.department.create({ data: { code: "PHAM", name: "Pharmacy" } });
    await prisma.termMembership.create({
      data: { personId: person.id, termId: sp26.id, departmentId: dept.id, kind: "VOLUNTEER", status: "REMOVED" },
    });

    const found = await findReturningMember(identity());
    expect(found?.lastTerm).toBeNull();
  });

  it("marks an ACTIVE person as not a former member", async () => {
    await seedAlum({ status: "ACTIVE" });
    const found = await findReturningMember(identity());

    expect(found?.isFormerMember).toBe(false);
  });

  // Trust boundary: the lookup runs sign-in's gate, so a non-Yale claim must not
  // surface a Person via their stored personal email. Otherwise anyone who could
  // get a portal link for an address could confirm that address belongs to a
  // member and learn their name and departments.
  it("does not surface a record from a non-Yale claim matching a personal contactEmail", async () => {
    await seedAlum({ netId: null, contactEmail: "someone@gmail.com" });
    expect(await findReturningMember(identity({ email: "someone@gmail.com" }))).toBeNull();
  });

  it("does not match a NetID-shaped local part on a non-Yale domain", async () => {
    await seedAlum();
    expect(await findReturningMember(identity({ email: "jc999@gmail.com" }))).toBeNull();
  });
});
