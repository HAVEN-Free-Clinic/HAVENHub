import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { setPersonStatusField } from "@/platform/people";
import {
  bulkAddMembers,
  joinSubcommittee,
  leaveSubcommittee,
  listMembers,
  parseIdentifiers,
  signupOptions,
  SubcommitteeSignupError,
} from "./subcommittee-members";
import { createSubcommittee, updateSubcommittee, SubcommitteeValidationError } from "./subcommittees";

beforeEach(resetDb);

async function activeTerm() {
  return prisma.term.create({
    data: {
      code: `FA26-${Math.random()}`,
      name: "Fall 2026",
      startDate: new Date("2026-10-03T12:00:00Z"),
      endDate: new Date("2026-12-12T12:00:00Z"),
      status: "ACTIVE",
      clinicDates: [],
    },
  });
}

/** A person on the active term's roster, i.e. someone who may self sign up. */
async function rostered(name: string, netId: string, termId: string) {
  const dept = await prisma.department.upsert({
    where: { code: "MED" },
    update: {},
    create: { code: "MED", name: "Medicine" },
  });
  const person = await prisma.person.create({
    data: { name, netId, contactEmail: `${netId}@yale.edu`, status: "ACTIVE" },
  });
  await prisma.termMembership.create({
    data: {
      personId: person.id,
      termId,
      departmentId: dept.id,
      kind: "VOLUNTEER",
      status: "ACTIVE",
      baselineAvailability: [],
      selfAvailabilityDates: [],
      directorAvailabilityDates: [],
    },
  });
  return person;
}

async function staff() {
  return prisma.person.create({ data: { name: "Staff Person" } });
}

describe("parseIdentifiers", () => {
  it("splits on any separator, strips angle brackets, and dedupes case-insensitively", () => {
    expect(parseIdentifiers("abc123, Jane.Doe@yale.edu\n<xyz9@yale.edu>; ABC123  ")).toEqual([
      "abc123",
      "Jane.Doe@yale.edu",
      "xyz9@yale.edu",
    ]);
  });
});

describe("bulkAddMembers (director import)", () => {
  it("matches NetIDs and emails case-insensitively and reports misses", async () => {
    const term = await activeTerm();
    const ana = await rostered("Ana Diaz", "ad123", term.id);
    const ben = await rostered("Ben Ortiz", "bo456", term.id);
    const actor = await staff();
    const sc = await createSubcommittee(actor.id, { name: "CQA" });

    const result = await bulkAddMembers(actor.id, sc.id, ["AD123", "BO456@YALE.EDU", "nobody9"], "LEAD");
    expect(result.added.sort()).toEqual(["Ana Diaz", "Ben Ortiz"]);
    expect(result.notFound).toEqual(["nobody9"]);

    const members = await listMembers(sc.id);
    expect(members.map((m) => [m.personId, m.role, m.source])).toEqual(
      expect.arrayContaining([
        [ana.id, "LEAD", "IMPORT"],
        [ben.id, "LEAD", "IMPORT"],
      ]),
    );
  });

  it("promotes an existing member when re-added as lead, and leaves an identical role alone", async () => {
    const term = await activeTerm();
    await rostered("Ana Diaz", "ad123", term.id);
    const actor = await staff();
    const sc = await createSubcommittee(actor.id, { name: "CQA" });
    await bulkAddMembers(actor.id, sc.id, ["ad123"], "MEMBER");

    expect((await bulkAddMembers(actor.id, sc.id, ["ad123"], "LEAD")).updated).toEqual(["Ana Diaz"]);
    expect((await bulkAddMembers(actor.id, sc.id, ["ad123"], "LEAD")).unchanged).toEqual(["Ana Diaz"]);
    expect((await listMembers(sc.id))[0].role).toBe("LEAD");
  });

  it("is not refused by capacity", async () => {
    const term = await activeTerm();
    await rostered("Ana Diaz", "ad123", term.id);
    await rostered("Ben Ortiz", "bo456", term.id);
    const actor = await staff();
    const sc = await createSubcommittee(actor.id, { name: "CQA", capacity: 1, signupOpen: true });
    const result = await bulkAddMembers(actor.id, sc.id, ["ad123", "bo456"], "MEMBER");
    expect(result.added).toHaveLength(2);
  });
});

describe("self sign-up", () => {
  it("lets a rostered volunteer join several open subcommittees and leave", async () => {
    const term = await activeTerm();
    const ana = await rostered("Ana Diaz", "ad123", term.id);
    const actor = await staff();
    const cqa = await createSubcommittee(actor.id, { name: "CQA", signupOpen: true });
    const crec = await createSubcommittee(actor.id, { name: "CREC", signupOpen: true });

    await joinSubcommittee(ana.id, cqa.id);
    await joinSubcommittee(ana.id, crec.id);
    await joinSubcommittee(ana.id, crec.id); // idempotent
    const options = await signupOptions(ana.id);
    expect(options.filter((o) => o.myRole === "MEMBER").map((o) => o.name)).toEqual(["CQA", "CREC"]);

    await leaveSubcommittee(ana.id, cqa.id);
    expect((await listMembers(cqa.id))).toHaveLength(0);
  });

  it("refuses someone not on the current roster", async () => {
    await activeTerm();
    const alum = await prisma.person.create({ data: { name: "Alum", status: "ACTIVE" } });
    const actor = await staff();
    const sc = await createSubcommittee(actor.id, { name: "CQA", signupOpen: true });
    await expect(joinSubcommittee(alum.id, sc.id)).rejects.toBeInstanceOf(SubcommitteeSignupError);
  });

  it("refuses a closed or full subcommittee, counting members but not leads", async () => {
    const term = await activeTerm();
    const lead = await rostered("Lena Lead", "ll1", term.id);
    const first = await rostered("First Volunteer", "fv1", term.id);
    const second = await rostered("Second Volunteer", "sv2", term.id);
    const actor = await staff();
    const sc = await createSubcommittee(actor.id, { name: "CQA", capacity: 1, signupOpen: false });
    await bulkAddMembers(actor.id, sc.id, [lead.netId!], "LEAD");

    await expect(joinSubcommittee(first.id, sc.id)).rejects.toThrow(/closed/);
    await updateSubcommittee(actor.id, sc.id, { name: "CQA", isActive: true, capacity: 1, signupOpen: true });

    await joinSubcommittee(first.id, sc.id); // the lead does not take the one seat
    await expect(joinSubcommittee(second.id, sc.id)).rejects.toThrow(/full/);
  });

  it("gives the last seat to exactly one of two simultaneous joins", async () => {
    const term = await activeTerm();
    const a = await rostered("A Person", "ap1", term.id);
    const b = await rostered("B Person", "bp2", term.id);
    const actor = await staff();
    const sc = await createSubcommittee(actor.id, { name: "CQA", capacity: 1, signupOpen: true });

    const results = await Promise.allSettled([joinSubcommittee(a.id, sc.id), joinSubcommittee(b.id, sc.id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.subcommitteeMembership.count({ where: { subcommitteeId: sc.id } })).toBe(1);
  });

  it("does not let a lead remove themselves", async () => {
    const term = await activeTerm();
    const lead = await rostered("Lena Lead", "ll1", term.id);
    const actor = await staff();
    const sc = await createSubcommittee(actor.id, { name: "CQA", signupOpen: true });
    await bulkAddMembers(actor.id, sc.id, ["ll1"], "LEAD");
    await expect(leaveSubcommittee(lead.id, sc.id)).rejects.toBeInstanceOf(SubcommitteeSignupError);
  });

  it("shows the roster with emails to a lead and to nobody else", async () => {
    const term = await activeTerm();
    const lead = await rostered("Lena Lead", "ll1", term.id);
    const member = await rostered("Mo Member", "mm2", term.id);
    const actor = await staff();
    const sc = await createSubcommittee(actor.id, { name: "CQA", signupOpen: true });
    await bulkAddMembers(actor.id, sc.id, ["ll1"], "LEAD");
    await joinSubcommittee(member.id, sc.id);

    const [asLead] = await signupOptions(lead.id);
    expect(asLead.roster).toEqual([
      { name: "Lena Lead", email: "ll1@yale.edu", role: "LEAD" },
      { name: "Mo Member", email: "mm2@yale.edu", role: "MEMBER" },
    ]);
    const [asMember] = await signupOptions(member.id);
    expect(asMember.roster).toBeNull();
  });

  it("hides closed subcommittees the person is not on", async () => {
    const term = await activeTerm();
    const ana = await rostered("Ana Diaz", "ad123", term.id);
    const actor = await staff();
    await createSubcommittee(actor.id, { name: "Closed", signupOpen: false });
    const open = await createSubcommittee(actor.id, { name: "Open", signupOpen: true });
    expect((await signupOptions(ana.id)).map((o) => o.id)).toEqual([open.id]);
  });
});

describe("subcommittee settings", () => {
  it("rejects a capacity below 1", async () => {
    const actor = await staff();
    await expect(createSubcommittee(actor.id, { name: "CQA", capacity: 0 })).rejects.toBeInstanceOf(
      SubcommitteeValidationError,
    );
  });
});

describe("offboarding", () => {
  it("removes every subcommittee membership with the roster places", async () => {
    const term = await activeTerm();
    const ana = await rostered("Ana Diaz", "ad123", term.id);
    const actor = await staff();
    const sc = await createSubcommittee(actor.id, { name: "CQA", signupOpen: true });
    await joinSubcommittee(ana.id, sc.id);

    await setPersonStatusField(actor.id, ana.id, "OFFBOARDED");
    expect(await prisma.subcommitteeMembership.count({ where: { personId: ana.id } })).toBe(0);
  });
});
