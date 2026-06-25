import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { getDraft, saveDraft, DraftError } from "./drafts";

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("can create a DRAFT application with a null submittedAt", async () => {
  const person = await prisma.person.create({ data: { name: "Lead", status: "ACTIVE" } });
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall 2026", startDate: new Date(), endDate: new Date() } });
  const cycle = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "d", departments: ["SRHD"], createdById: person.id, status: "OPEN" } });
  const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "", lastName: "", email: "a@yale.edu", emailLower: "a@yale.edu" } });
  const app = await prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: [], subcommitteeRanking: [], status: "DRAFT" } });
  expect(app.status).toBe("DRAFT");
  expect(app.submittedAt).toBeNull();
});

async function openCycle(slug = "draft-cyc") {
  const lead = await prisma.person.create({ data: { name: "Lead", status: "ACTIVE" } });
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall 2026", startDate: new Date(), endDate: new Date() } });
  return prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: slug, departments: ["SRHD"], createdById: lead.id, status: "OPEN" } });
}
const ID = { email: "reed@yale.edu", personId: null };

it("creates a draft on first save and updates it on the next", async () => {
  await openCycle();
  expect(await getDraft("draft-cyc", ID)).toBeNull();
  await saveDraft("draft-cyc", ID, { answers: { first_name: "Reed" } });
  const d1 = await getDraft("draft-cyc", ID);
  expect(d1?.status).toBe("DRAFT");
  expect(d1?.answers).toEqual({ first_name: "Reed" });
  await saveDraft("draft-cyc", ID, { answers: { first_name: "Reed", last_name: "R" } });
  const d2 = await getDraft("draft-cyc", ID);
  expect(d2?.applicationId).toBe(d1?.applicationId); // same row, no duplicate
  expect(d2?.answers).toEqual({ first_name: "Reed", last_name: "R" });
  const count = await prisma.applicant.count({ where: { cycleId: (await prisma.recruitmentCycle.findFirstOrThrow({ where: { publicSlug: "draft-cyc" } })).id } });
  expect(count).toBe(1);
});

it("rejects saving when the application is already submitted", async () => {
  const cycle = await openCycle("sub-cyc");
  const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "R", lastName: "R", email: "reed@yale.edu", emailLower: "reed@yale.edu" } });
  await prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: [], subcommitteeRanking: [], status: "SUBMITTED", submittedAt: new Date() } });
  await expect(saveDraft("sub-cyc", ID, { answers: { x: "y" } })).rejects.toBeInstanceOf(DraftError);
});

it("rejects saving when the cycle is not open", async () => {
  const cycle = await openCycle("closed-cyc");
  await prisma.recruitmentCycle.update({ where: { id: cycle.id }, data: { status: "CLOSED" } });
  await expect(saveDraft("closed-cyc", ID, { answers: {} })).rejects.toBeInstanceOf(DraftError);
});

it("scopes a draft to the identity (other identity sees nothing)", async () => {
  await openCycle("iso-cyc");
  await saveDraft("iso-cyc", ID, { answers: { a: 1 } });
  expect(await getDraft("iso-cyc", { email: "other@yale.edu", personId: null })).toBeNull();
});
