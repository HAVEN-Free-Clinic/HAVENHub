import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { getDraft, saveDraft, DraftError, uploadDraftFile, sweepAbandonedDrafts } from "./drafts";
import * as uploadModule from "./upload";
import { setApplicationWindow } from "./cycles";

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
const ID = { email: "reed@yale.edu", personId: null, firstName: null };

/** A cycle with one FILE field "resume" carrying the given validation rules
 *  (maxFileMB / acceptedTypes), plus a draft to upload into. */
async function fileFieldCycle(slug: string, validation: Record<string, unknown> | null) {
  const cycle = await openCycle(slug);
  const sec = await prisma.formSection.create({ data: { cycleId: cycle.id, title: "Main", order: 0, appliesTo: "BOTH", purpose: "APPLICATION" } });
  await prisma.formField.create({ data: { sectionId: sec.id, cycleId: cycle.id, key: "resume", label: "Resume", type: "FILE", required: false, order: 0, ...(validation ? { validation: validation as never } : {}) } });
  await saveDraft(slug, ID, { answers: {} });
  return cycle;
}

const DAYS_AGO = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

/** Create an applicant + (back-dated) application in a cycle, for sweep tests. */
async function seedDraft(cycleId: string, email: string, status: "DRAFT" | "SUBMITTED", updatedAt: Date) {
  const ap = await prisma.applicant.create({ data: { cycleId, firstName: "", lastName: "", email, emailLower: email } });
  await prisma.application.create({ data: { cycleId, applicantId: ap.id, answers: {}, applicantType: "NEW", departmentChoices: [], subcommitteeRanking: [], status, submittedAt: status === "SUBMITTED" ? new Date() : null } });
  await prisma.application.updateMany({ where: { applicantId: ap.id }, data: { updatedAt } });
  return ap;
}

it("blocks saveDraft once the cycle's closesAt has passed, even while OPEN", async () => {
  const cycle = await openCycle("win-past-close");
  await setApplicationWindow(cycle.id, { opensAt: null, closesAt: DAYS_AGO(1) }, cycle.createdById);
  await expect(saveDraft("win-past-close", ID, { answers: { first_name: "Reed" } })).rejects.toBeInstanceOf(DraftError);
});

it("blocks saveDraft before the cycle's opensAt, even while OPEN", async () => {
  const cycle = await openCycle("win-future-open");
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await setApplicationWindow(cycle.id, { opensAt: tomorrow, closesAt: null }, cycle.createdById);
  await expect(saveDraft("win-future-open", ID, { answers: { first_name: "Reed" } })).rejects.toBeInstanceOf(DraftError);
});

it("allows saveDraft inside the window", async () => {
  const cycle = await openCycle("win-inside");
  await setApplicationWindow(cycle.id, { opensAt: DAYS_AGO(1), closesAt: new Date(Date.now() + 24 * 60 * 60 * 1000) }, cycle.createdById);
  await saveDraft("win-inside", ID, { answers: { first_name: "Reed" } });
  expect((await getDraft("win-inside", ID))?.answers).toEqual({ first_name: "Reed" });
});

it("surfaces a WITHDRAWN row as WITHDRAWN, not as a resumable draft", async () => {
  // DraftView.status used to be typed "DRAFT" | "SUBMITTED" and getDraft cast to
  // it, so the third enum value reached /apply/[slug] disguised as one of the two
  // the wizard can act on, and the page handed a withdrawn applicant their old
  // answers back. The status the page branches on is the real column value.
  await openCycle("withdrawn-cyc");
  await saveDraft("withdrawn-cyc", ID, { answers: { first_name: "Reed" } });
  const draft = await getDraft("withdrawn-cyc", ID);
  await prisma.application.update({
    where: { id: draft!.applicationId },
    data: { status: "WITHDRAWN", withdrawnAt: new Date() },
  });

  expect((await getDraft("withdrawn-cyc", ID))?.status).toBe("WITHDRAWN");
});

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

// --- Bounds on what an autosave may persist (audit 14, UNAUTH-03) ---

it("refuses an oversized draft, and writes nothing", async () => {
  await openCycle("huge-cyc");
  const oneMegabyte = "x".repeat(1024 * 1024);
  await expect(
    saveDraft("huge-cyc", ID, { answers: { essay: oneMegabyte } }),
  ).rejects.toBeInstanceOf(DraftError);
  // Not merely refused: nothing about the applicant was created either.
  expect(await getDraft("huge-cyc", ID)).toBeNull();
  expect(await prisma.applicant.count()).toBe(0);
});

it("refuses a draft with thousands of keys", async () => {
  await openCycle("wide-cyc");
  const answers = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`k${i}`, "v"]));
  await expect(saveDraft("wide-cyc", ID, { answers })).rejects.toBeInstanceOf(DraftError);
});

it("refuses a nested structure no form control can emit", async () => {
  await openCycle("deep-cyc");
  await expect(
    saveDraft("deep-cyc", ID, { answers: { nested: { a: { b: { c: "deep" } } } } }),
  ).rejects.toBeInstanceOf(DraftError);
});

it("still saves a real draft: long text, a checkbox group, and a signature data URL", async () => {
  await openCycle("real-cyc");
  await saveDraft("real-cyc", ID, {
    answers: {
      // Comfortably longer than any honest essay answer.
      why_haven: "words ".repeat(4000),
      // A checkbox group serializes to an array of strings.
      languages: ["English", "Spanish", "Mandarin"],
      // A drawn signature rides along as a PNG data URL until submit converts it.
      sig__agreement: `data:image/png;base64,${"A".repeat(60_000)}`,
      consent: true,
      years: 2,
      unset: null,
    },
  });
  const draft = await getDraft("real-cyc", ID);
  expect(draft?.answers.languages).toEqual(["English", "Spanish", "Mandarin"]);
  expect(String(draft?.answers.sig__agreement)).toContain("data:image/png;base64,");
});

it("scopes a draft to the identity (other identity sees nothing)", async () => {
  await openCycle("iso-cyc");
  await saveDraft("iso-cyc", ID, { answers: { a: 1 } });
  expect(await getDraft("iso-cyc", { email: "other@yale.edu", personId: null, firstName: null })).toBeNull();
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

it("rejects a draft upload that exceeds the field's size cap", async () => {
  // The submit path enforces uploads.maxMb / the field cap; the draft upload
  // must too, or an oversize file slips in and is carried into the submission.
  await fileFieldCycle("file-big-cyc", { maxFileMB: 1 });
  const tooBig = Buffer.alloc(1 * 1024 * 1024 + 1);
  await expect(
    uploadDraftFile("file-big-cyc", ID, "resume", { fileName: "cv.pdf", mimeType: "application/pdf", bytes: tooBig }),
  ).rejects.toBeInstanceOf(DraftError);
});

it("rejects a draft upload whose type is not in the field's acceptedTypes", async () => {
  await fileFieldCycle("file-type-cyc", { acceptedTypes: [".pdf"] });
  await expect(
    uploadDraftFile("file-type-cyc", ID, "resume", { fileName: "evil.exe", mimeType: "application/octet-stream", bytes: Buffer.from("x") }),
  ).rejects.toBeInstanceOf(DraftError);
});

it("accepts a draft upload that satisfies the field's size and type rules", async () => {
  await fileFieldCycle("file-ok-cyc", { acceptedTypes: [".pdf"], maxFileMB: 5 });
  const res = await uploadDraftFile("file-ok-cyc", ID, "resume", { fileName: "cv.pdf", mimeType: "application/pdf", bytes: Buffer.from("hi") });
  expect(res.fileName).toBe("cv.pdf");
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

it("uploadDraftFile does not overwrite an application submitted during the blob upload (#103)", async () => {
  // The submit lands in the window between findRow and the answers write. persistFiles
  // is that window (a slow object-storage round trip); the spy flips the row to
  // SUBMITTED with server-built answers before returning, exactly as submitApplication
  // would. The transactional re-read must see SUBMITTED and refuse, not clobber it.
  const cycle = await fileFieldCycle("race-submit", null);
  const draft = await getDraft("race-submit", ID);
  const spy = vi
    .spyOn(uploadModule, "persistFiles")
    .mockImplementation(async (cycleId: string) => {
      await prisma.application.update({
        where: { id: draft!.applicationId },
        data: { status: "SUBMITTED", submittedAt: new Date(), answers: { server: "authoritative" } as never },
      });
      return {
        answerPatch: { resume: { storedName: "resume-x.pdf", fileName: "cv.pdf", mimeType: "application/pdf", size: 2 } },
        storageKeys: [`recruitment/${cycleId}/resume-x.pdf`],
      };
    });
  try {
    await expect(
      uploadDraftFile("race-submit", ID, "resume", { fileName: "cv.pdf", mimeType: "application/pdf", bytes: Buffer.from("hi") }),
    ).rejects.toBeInstanceOf(DraftError);
  } finally {
    spy.mockRestore();
  }
  // The submitted answers were NOT clobbered with the stale draft + file ref.
  const app = await prisma.application.findFirstOrThrow({ where: { cycleId: cycle.id } });
  expect(app.status).toBe("SUBMITTED");
  expect(app.answers).toEqual({ server: "authoritative" });
});

it("uploadDraftFile preserves an answer written by a concurrent autosave during the upload (#101/#103)", async () => {
  // A debounced saveDraft commits typed answers while the blob upload is in flight.
  // The old whole-object write merged the file ref onto a pre-upload snapshot and
  // reverted the typing; the transactional re-read must keep both.
  await fileFieldCycle("race-sibling", null);
  const draft = await getDraft("race-sibling", ID);
  const spy = vi
    .spyOn(uploadModule, "persistFiles")
    .mockImplementation(async () => {
      await prisma.application.update({
        where: { id: draft!.applicationId },
        data: { answers: { typed: "during-upload" } as never },
      });
      return {
        answerPatch: { resume: { storedName: "resume-y.pdf", fileName: "cv.pdf", mimeType: "application/pdf", size: 2 } },
        storageKeys: [],
      };
    });
  try {
    await uploadDraftFile("race-sibling", ID, "resume", { fileName: "cv.pdf", mimeType: "application/pdf", bytes: Buffer.from("hi") });
  } finally {
    spy.mockRestore();
  }
  const d = await getDraft("race-sibling", ID);
  expect(d?.answers.typed).toBe("during-upload"); // concurrent autosave not lost
  expect((d?.answers.resume as { fileName: string }).fileName).toBe("cv.pdf"); // file ref added
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
