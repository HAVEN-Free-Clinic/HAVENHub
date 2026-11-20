import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { returnerClearanceBlock } from "./returner-clearance";
import { createCycle, publishCycle } from "./cycles";
import { submitApplication, SubmissionValidationError } from "./submissions";

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

async function term(code: string, status: "ACTIVE" | "ARCHIVED" | "PLANNING", start: string, end: string) {
  return prisma.term.create({ data: { code, name: code, startDate: new Date(start), endDate: new Date(end), status } });
}

async function member(termId: string, opts: { phone?: string | null } = {}) {
  const dept = await prisma.department.upsert({ where: { code: "PCAR" }, update: {}, create: { code: "PCAR", name: "Primary Care" } });
  const person = await prisma.person.create({
    data: { name: "Ret Urner", status: "ACTIVE", contactEmail: "ret@yale.edu", phone: opts.phone === undefined ? "555-0100" : opts.phone },
  });
  await prisma.termMembership.create({ data: { personId: person.id, termId, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" } });
  return person;
}

async function validHipaa(personId: string) {
  await prisma.hipaaCertificate.create({
    data: {
      personId, fileName: "c.pdf", storedName: `c-${personId}.pdf`, size: 100, mimeType: "application/pdf",
      completionDate: new Date(), verifiedAt: new Date(), uploadedAt: new Date(),
    },
  });
}

it("blocks a current member who is missing HIPAA, listing what is left", async () => {
  const fa26 = await term("FA26", "ACTIVE", "2026-08-25", "2026-12-15");
  const p = await member(fa26.id);
  const block = await returnerClearanceBlock(p.id);
  expect(block).not.toBeNull();
  expect(block!.termName).toBe("FA26");
  expect(block!.keys).toContain("hipaa");
  expect(block!.items).toContain("Complete and upload your HIPAA certificate");
});

it("blocks for a required EHS training that is not done", async () => {
  const fa26 = await term("FA26", "ACTIVE", "2026-08-25", "2026-12-15");
  const p = await member(fa26.id);
  await validHipaa(p.id);
  await prisma.ehsTraining.create({ data: { name: "BBP", requiredForAll: true, isActive: true } });
  const block = await returnerClearanceBlock(p.id);
  expect(block?.keys).toEqual(["ehs"]);
});

it("lets a fully cleared current member through", async () => {
  const fa26 = await term("FA26", "ACTIVE", "2026-08-25", "2026-12-15");
  const p = await member(fa26.id);
  await validHipaa(p.id);
  expect(await returnerClearanceBlock(p.id)).toBeNull();
});

it("does not check people who are not members of the active term", async () => {
  await term("FA26", "ACTIVE", "2026-08-25", "2026-12-15");
  const sp26 = await term("SP26", "ARCHIVED", "2026-01-12", "2026-05-10");
  const alum = await member(sp26.id); // last seen in an archived term, no HIPAA on file
  expect(await returnerClearanceBlock(alum.id)).toBeNull();
  expect(await returnerClearanceBlock(null)).toBeNull();
  const stranger = await prisma.person.create({ data: { name: "New Person", status: "ACTIVE" } });
  expect(await returnerClearanceBlock(stranger.id)).toBeNull();
});

it("refuses the submission for an uncleared member even when they pick New applicant", async () => {
  const fa26 = await term("FA26", "ACTIVE", "2026-08-25", "2026-12-15");
  const sp27 = await term("SP27", "PLANNING", "2027-01-11", "2027-05-10");
  const lead = await prisma.person.create({ data: { name: "Lead", status: "ACTIVE" } });
  const cycle = await createCycle({
    track: "VOLUNTEER", termId: sp27.id, title: "Volunteers", publicSlug: "apply-v",
    departments: ["PCAR"], acceptsRenewals: true, createdById: lead.id,
  });
  await publishCycle(cycle.id, lead.id);
  const p = await member(fa26.id);

  const err = await submitApplication("apply-v", {
    applicantType: "NEW", answers: { first_name: "Ret", last_name: "Urner", email: "ret@yale.edu" },
    files: {}, sessionPersonId: p.id, sessionEmail: "ret@yale.edu",
  }).catch((e) => e);
  expect(err).toBeInstanceOf(SubmissionValidationError);
  expect((err as Error).message).toMatch(/must be fully cleared before applying again/);
  expect((err as Error).message).toMatch(/HIPAA/);
  expect(await prisma.application.count()).toBe(0);
});
