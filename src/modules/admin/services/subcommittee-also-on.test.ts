import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { listMembers } from "./subcommittee-members";

beforeEach(resetDb);
afterEach(resetDb);

describe("listMembers otherSubcommittees", () => {
  it("names the other active subcommittees each person is on, marking leads", async () => {
    const crec = await prisma.subcommittee.create({ data: { name: "CREC" } });
    const cqa = await prisma.subcommittee.create({ data: { name: "CQA" } });
    const sd = await prisma.subcommittee.create({ data: { name: "S&D" } });
    const retired = await prisma.subcommittee.create({ data: { name: "Old", isActive: false } });

    const both = await prisma.person.create({ data: { name: "Both", status: "ACTIVE" } });
    const solo = await prisma.person.create({ data: { name: "Solo", status: "ACTIVE" } });

    await prisma.subcommitteeMembership.createMany({
      data: [
        { subcommitteeId: crec.id, personId: both.id, role: "MEMBER", source: "SIGNUP" },
        { subcommitteeId: cqa.id, personId: both.id, role: "MEMBER", source: "SIGNUP" },
        { subcommitteeId: sd.id, personId: both.id, role: "LEAD", source: "STAFF" },
        { subcommitteeId: retired.id, personId: both.id, role: "MEMBER", source: "SIGNUP" },
        { subcommitteeId: crec.id, personId: solo.id, role: "MEMBER", source: "SIGNUP" },
      ],
    });

    const rows = await listMembers(crec.id);
    const byName = Object.fromEntries(rows.map((r) => [r.name, r.otherSubcommittees]));

    // The subcommittee being viewed and inactive ones are left out.
    expect(byName.Both).toEqual(["CQA", "S&D (lead)"]);
    expect(byName.Solo).toEqual([]);
  });
});