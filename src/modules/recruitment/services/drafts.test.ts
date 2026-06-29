import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { getDraft, saveDraft, DraftError, uploadDraftFile, sweepAbandonedDrafts } from "./drafts";

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

const DAYS_AGO = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

/** Create an applicant + (back-dated) application in a cycle, for sweep tests. */
async function seedDraft(cycleId: string, email: string, status: "DRAFT" | "SUBMITTED", updatedAt: Date) {
  const ap = await prisma.applicant.create({ data: { cycleId, firstName: "", lastName: "", email, emailLower: email } });
  await prisma.application.create({ data: { cycleId, applicantId: ap.id, answers: {}, applicantType: "NEW", departmentChoices: [], subcommitteeRanking: [], status, submittedAt: status === "SUBMITTED" ? new Date() : null } });
  await prisma.application.updateMany({ where: { applicantId: ap.id }, data: { updatedAt } });
  return ap;
}

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

it("uploads a draft file and records the ref in answers", async () => {
  const cycle = await openCycle("file-cyc");
  // The cycle needs a FILE field for the key to be allowed.
  const idSection = await prisma.formSection.create({ data: { cycleId: cycle.id, title: "Main", order: 0, appliesTo: "BOTH", purpose: "APPLICATION" } });
  await prisma.formField.create({ data: { sectionId: idSection.id, cycleId: cycle.id, key: "resume", label: "Resume", type: "FILE", required: false, order: 0 } });
  await saveDraft("file-cyc", ID, { answers: {} });
  const res = await uploadDraftFile("file-cyc", ID, "resume", { fileName: "cv.pdf", mimeType: "application/pdf", bytes: Buffer.from("hi") });
  expect(res.fileName).toBe("cv.pdf");
  const d = await getDraft("file-cyc", ID);
  expect((d?.answers.resume as { fileName: string }).fileName).toBe("cv.pdf");
});

it("rejects a draft upload to an unknown field key", async () => {
  await openCycle("file-cyc2");
  await saveDraft("file-cyc2", ID, { answers: {} });
  await expect(uploadDraftFile("file-cyc2", ID, "not_a_field", { fileName: "x.pdf", mimeType: "application/pdf", bytes: Buffer.from("x") })).rejects.toBeInstanceOf(DraftError);
});

it("preserves an uploaded file reference when a later autosave omits it", async () => {
  // A file input cannot round-trip through the form's FormData, so the next
  // autosave serializes answers without the file. The save must not wipe it.
  const cycle = await openCycle("file-keep-cyc");
  const sec = await prisma.formSection.create({ data: { cycleId: cycle.id, title: "Main", order: 0, appliesTo: "BOTH", purpose: "APPLICATION" } });
  await prisma.formField.create({ data: { sectionId: sec.id, cycleId: cycle.id, key: "resume", label: "Resume", type: "FILE", required: false, order: 0 } });
  await saveDraft("file-keep-cyc", ID, { answers: { first_name: "Reed" } });
  await uploadDraftFile("file-keep-cyc", ID, "resume", { fileName: "cv.pdf", mimeType: "application/pdf", bytes: Buffer.from("hi") });
  await saveDraft("file-keep-cyc", ID, { answers: { first_name: "Reed", last_name: "R" } });
  const d = await getDraft("file-keep-cyc", ID);
  expect((d?.answers.resume as { fileName: string } | undefined)?.fileName).toBe("cv.pdf");
  expect(d?.answers.first_name).toBe("Reed");
  expect(d?.answers.last_name).toBe("R");
});

it("does not resurrect a non-file answer that a later save clears", async () => {
  // Unchecking a checkbox / clearing a select drops it from the serialized form.
  // The merge must only protect file refs, never stale choice values.
  await openCycle("clear-cyc");
  await saveDraft("clear-cyc", ID, { answers: { dept: "SRHD", note: "x" } });
  await saveDraft("clear-cyc", ID, { answers: { note: "x" } });
  const d = await getDraft("clear-cyc", ID);
  expect(d?.answers.dept).toBeUndefined();
  expect(d?.answers.note).toBe("x");
});

it("in a closed cycle, sweeps drafts older than the cutoff, leaving recent and submitted ones", async () => {
  const cycle = await openCycle("sweep-cyc");
  await prisma.recruitmentCycle.update({ where: { id: cycle.id }, data: { status: "CLOSED" } });
  await seedDraft(cycle.id, "oldraft@yale.edu", "DRAFT", DAYS_AGO(40));
  await seedDraft(cycle.id, "newdraft@yale.edu", "DRAFT", new Date());
  await seedDraft(cycle.id, "oldsub@yale.edu", "SUBMITTED", DAYS_AGO(40));
  const res = await sweepAbandonedDrafts(30);
  expect(res.deleted).toBe(1);
  expect(await prisma.applicant.findFirst({ where: { emailLower: "oldraft@yale.edu" } })).toBeNull();
  expect(await prisma.applicant.findFirst({ where: { emailLower: "newdraft@yale.edu" } })).not.toBeNull();
  expect(await prisma.applicant.findFirst({ where: { emailLower: "oldsub@yale.edu" } })).not.toBeNull();
});

it("does not sweep an abandoned draft while its cycle is still open", async () => {
  // A long-running open cycle: the applicant can still submit, so their draft
  // (and uploaded files) must survive the inactivity purge.
  const cycle = await openCycle("open-keep-cyc");
  await seedDraft(cycle.id, "stillopen@yale.edu", "DRAFT", DAYS_AGO(40));
  const res = await sweepAbandonedDrafts(30);
  expect(res.deleted).toBe(0);
  expect(await prisma.applicant.findFirst({ where: { emailLower: "stillopen@yale.edu" } })).not.toBeNull();
});

it("sweeps an abandoned draft once the cycle's closesAt has passed (even if still marked OPEN)", async () => {
  const cycle = await openCycle("expired-cyc");
  await prisma.recruitmentCycle.update({ where: { id: cycle.id }, data: { closesAt: DAYS_AGO(5) } });
  await seedDraft(cycle.id, "expired@yale.edu", "DRAFT", DAYS_AGO(40));
  const res = await sweepAbandonedDrafts(30);
  expect(res.deleted).toBe(1);
  expect(await prisma.applicant.findFirst({ where: { emailLower: "expired@yale.edu" } })).toBeNull();
});
