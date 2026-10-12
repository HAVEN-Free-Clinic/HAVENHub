import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { canManageSubcommittee, membershipBelongsTo } from "./subcommittee-lead-access";

beforeEach(resetDb);
afterEach(resetDb);

async function setup() {
  const crec = await prisma.subcommittee.create({ data: { name: "CREC" } });
  const cqa = await prisma.subcommittee.create({ data: { name: "CQA" } });
  const lead = await prisma.person.create({ data: { name: "Lead", status: "ACTIVE" } });
  const member = await prisma.person.create({ data: { name: "Member", status: "ACTIVE" } });
  const outsider = await prisma.person.create({ data: { name: "Outsider", status: "ACTIVE" } });
  await prisma.subcommitteeMembership.create({
    data: { subcommitteeId: crec.id, personId: lead.id, role: "LEAD", source: "STAFF" },
  });
  const memberRow = await prisma.subcommitteeMembership.create({
    data: { subcommitteeId: crec.id, personId: member.id, role: "MEMBER", source: "SIGNUP" },
  });
  const otherRow = await prisma.subcommitteeMembership.create({
    data: { subcommitteeId: cqa.id, personId: outsider.id, role: "MEMBER", source: "SIGNUP" },
  });
  return { crec, cqa, lead, member, outsider, memberRow, otherRow };
}

describe("canManageSubcommittee", () => {
  it("lets a lead manage the subcommittee they lead, and only that one", async () => {
    const { crec, cqa, lead } = await setup();
    expect(await canManageSubcommittee(lead.id, crec.id)).toBe(true);
    expect(await canManageSubcommittee(lead.id, cqa.id)).toBe(false);
  });

  it("refuses a plain member and someone not on it", async () => {
    const { crec, member, outsider } = await setup();
    expect(await canManageSubcommittee(member.id, crec.id)).toBe(false);
    expect(await canManageSubcommittee(outsider.id, crec.id)).toBe(false);
  });

  it("lets a recruitment manager manage any subcommittee", async () => {
    const { cqa, outsider } = await setup();
    const role = await prisma.role.create({
      data: { name: "Recruitment", grants: { create: [{ permission: "recruitment.manage_cycles" }] } },
    });
    await prisma.roleAssignment.create({ data: { roleId: role.id, personId: outsider.id, termId: null } });
    expect(await canManageSubcommittee(outsider.id, cqa.id)).toBe(true);
  });
});

describe("membershipBelongsTo", () => {
  it("rejects a membership from another subcommittee", async () => {
    const { crec, memberRow, otherRow } = await setup();
    expect(await membershipBelongsTo(memberRow.id, crec.id)).toBe(true);
    expect(await membershipBelongsTo(otherRow.id, crec.id)).toBe(false);
  });
});