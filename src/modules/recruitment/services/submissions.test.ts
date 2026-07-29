import path from "node:path";
import { promises as fs } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { config } from "@/platform/config";
import { createCycle, publishCycle } from "./cycles";
import { addSection, addField } from "./form-builder";
import {
  submitApplication, getApplication,
  CycleNotOpenError, DuplicateApplicationError, SubmissionValidationError,
} from "./submissions";
import { saveDraft, uploadDraftFile, getDraft } from "./drafts";
import { getObject } from "@/platform/storage";

async function openVolunteerCycle() {
  const person = await prisma.person.create({ data: { name: "Lead", status: "ACTIVE" } });
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall 2026", startDate: new Date(), endDate: new Date() } });
  const cycle = await createCycle({ track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "apply-v", departments: ["SRHD", "MDIC"], acceptsRenewals: true, createdById: person.id });
  const idSection = (await prisma.formSection.findFirstOrThrow({ where: { cycleId: cycle.id }, orderBy: { order: "asc" } }));
  await addField(idSection.id, { label: "1st choice department", type: "DEPARTMENT_CHOICE", required: true });
  await addField(idSection.id, { label: "Resume", type: "FILE", required: false });
  const srhd = await addSection(cycle.id, { title: "SRHD Supplement", appliesTo: "NEW", departmentCode: "SRHD" });
  await addField(srhd.id, { label: "SRHD essay", type: "LONG_TEXT", required: true });
  const renew = await addSection(cycle.id, { title: "Renewal", appliesTo: "RENEWAL", departmentCode: null });
  await addField(renew.id, { label: "Continue reason", type: "LONG_TEXT", required: true });
  await publishCycle(cycle.id, person.id);
  return { person, cycle };
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("accepts a valid NEW submission, dedups, and queues a confirmation email", async () => {
  await openVolunteerCycle();
  const app = await submitApplication("apply-v", {
    applicantType: "NEW",
    answers: { first_name: "Ann", last_name: "Lee", email: "ann@yale.edu", "1st_choice_department": "SRHD", srhd_essay: "because" },
    files: {},
  });
  expect(app.applicantType).toBe("NEW");
  expect(app.departmentChoices).toEqual(["SRHD"]);
  const emails = await prisma.emailLog.findMany();
  expect(emails).toHaveLength(1);
  expect(emails[0].toEmail).toBe("ann@yale.edu");

  await expect(
    submitApplication("apply-v", { applicantType: "NEW", answers: { first_name: "Ann", last_name: "Lee", email: "ANN@yale.edu", "1st_choice_department": "SRHD", srhd_essay: "x" }, files: {} })
  ).rejects.toBeInstanceOf(DuplicateApplicationError);
});

it("uses the verified identity email for a NEW submission, ignoring a spoofed form email (audit H1)", async () => {
  const { cycle } = await openVolunteerCycle();
  await submitApplication("apply-v", {
    applicantType: "NEW",
    answers: { first_name: "Eve", last_name: "X", email: "attacker-typed@evil.com", "1st_choice_department": "MDIC" },
    files: {},
    identityEmail: "verified@yale.edu",
  });
  // The owner/dedup key and the confirmation email use the verified identity,
  // never the spoofable client form value.
  const emails = await prisma.emailLog.findMany();
  expect(emails.map((e) => e.toEmail)).toEqual(["verified@yale.edu"]);
  const owner = await prisma.applicant.findUnique({ where: { cycleId_emailLower: { cycleId: cycle.id, emailLower: "verified@yale.edu" } } });
  expect(owner).not.toBeNull();
  const spoofed = await prisma.applicant.findUnique({ where: { cycleId_emailLower: { cycleId: cycle.id, emailLower: "attacker-typed@evil.com" } } });
  expect(spoofed).toBeNull();
});

it("does not require the SRHD supplement when MDIC is chosen", async () => {
  await openVolunteerCycle();
  const app = await submitApplication("apply-v", {
    applicantType: "NEW",
    answers: { first_name: "Bo", last_name: "Ng", email: "bo@yale.edu", "1st_choice_department": "MDIC" },
    files: {},
  });
  expect(app.departmentChoices).toEqual(["MDIC"]);
});

it("routes a RENEWAL submission and stores renewalDepartment", async () => {
  await openVolunteerCycle();
  const person = await makeVolunteer("SRHD");
  const app = await submitApplication("apply-v", {
    applicantType: "RENEWAL",
    renewalDepartment: "SRHD",
    answers: { first_name: "Cy", last_name: "Oz", email: "cy@yale.edu", continue_reason: "yes" },
    files: {},
    sessionPersonId: person.id,
    sessionEmail: "cy@yale.edu",
  });
  expect(app.applicantType).toBe("RENEWAL");
  expect(app.renewalDepartment).toBe("SRHD");
  expect(app.departmentChoices).toEqual(["SRHD"]);
  expect(Object.keys(app.answers as object)).not.toContain("1st_choice_department");
  // A returning volunteer skips the committee: auto-routed to their department so
  // its director sees + decides directly (no SRR routing step).
  expect(app.routedDepartmentCode).toBe("SRHD");
  expect(app.routedAt).not.toBeNull();
});

it("does NOT auto-route a TRANSFER (it goes through the committee like a new applicant)", async () => {
  await openVolunteerCycle();
  const person = await makeVolunteer("SRHD"); // currently in SRHD, transferring to MDIC
  const app = await submitApplication("apply-v", {
    applicantType: "TRANSFER",
    answers: { first_name: "Tr", last_name: "An", email: "tr@yale.edu", "1st_choice_department": "MDIC", srhd_essay: "n/a" },
    files: {},
    sessionPersonId: person.id,
    sessionEmail: "tr@yale.edu",
  });
  expect(app.applicantType).toBe("TRANSFER");
  expect(app.departmentChoices).toEqual(["MDIC"]);
  expect(app.routedDepartmentCode).toBeNull(); // committee routes it, not auto
});

// DEPARTMENT_CHOICE validation: toSectionDefs (submissions.ts) has always built
// the schema's z.enum from cycle.departments (see 167c587f2), independent of
// the read-time display labels the apply page now injects (department-options.ts).
// The two never shared a code path, so populating display options for the
// dropdown does not touch this. Pinned here in both directions per the task
// spec, which called this out as a change worth a regression test even though
// it predates this change.
it("accepts a 1st_choice_department code that IS in the cycle's departments", async () => {
  await openVolunteerCycle();
  const app = await submitApplication("apply-v", {
    applicantType: "NEW",
    answers: { first_name: "Kai", last_name: "Nguyen", email: "kai@yale.edu", "1st_choice_department": "MDIC" },
    files: {},
  });
  expect(app.departmentChoices).toEqual(["MDIC"]);
});

it("rejects a 1st_choice_department code that is NOT in the cycle's departments", async () => {
  await openVolunteerCycle();
  const err = await submitApplication("apply-v", {
    applicantType: "NEW",
    answers: { first_name: "Zed", last_name: "Q", email: "zed@yale.edu", "1st_choice_department": "ZZZZ" },
    files: {},
  }).catch((e) => e);
  expect(err).toBeInstanceOf(SubmissionValidationError);
  expect((err as SubmissionValidationError).fieldErrors).toHaveProperty("1st_choice_department");
});

it("rejects a renewalDepartment outside the cycle departments", async () => {
  await openVolunteerCycle();
  const person = await makeVolunteer("SRHD");
  await expect(
    submitApplication("apply-v", { applicantType: "RENEWAL", renewalDepartment: "ZZZ", answers: { first_name: "D", last_name: "E", continue_reason: "x" }, files: {}, sessionPersonId: person.id, sessionEmail: "d@yale.edu" })
  ).rejects.toBeInstanceOf(SubmissionValidationError);
});

it("rejects a renewal into an in-cycle department the person does not belong to", async () => {
  await openVolunteerCycle();
  // The person is a current SRHD volunteer; MDIC is in the cycle but not theirs.
  const person = await makeVolunteer("SRHD");
  await expect(
    submitApplication("apply-v", { applicantType: "RENEWAL", renewalDepartment: "MDIC", answers: { first_name: "D", last_name: "E", continue_reason: "x" }, files: {}, sessionPersonId: person.id, sessionEmail: "d@yale.edu" })
  ).rejects.toBeInstanceOf(SubmissionValidationError);
});

it("preserves a RENEWAL answer for a field conditioned on the department (server mirrors the client department merge) [audit #1]", async () => {
  const lead = await prisma.person.create({ data: { name: "Lead", status: "ACTIVE" } });
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall 2026", startDate: new Date(), endDate: new Date() } });
  const cycle = await createCycle({ track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "apply-rv", departments: ["SRHD", "MDIC"], acceptsRenewals: true, createdById: lead.id });
  const idSection = await prisma.formSection.findFirstOrThrow({ where: { cycleId: cycle.id }, orderBy: { order: "asc" } });
  const deptField = await addField(idSection.id, { label: "1st choice department", type: "DEPARTMENT_CHOICE", required: true });
  const renew = await addSection(cycle.id, { title: "Renewal", appliesTo: "RENEWAL", departmentCode: null });
  await addField(renew.id, { label: "Continue reason", type: "LONG_TEXT", required: true });
  // A renewal-section field shown only when the (renewal) department is SRHD.
  const srhdOnly = await addField(renew.id, { label: "SRHD renewal note", type: "LONG_TEXT", required: false });
  await prisma.formField.update({ where: { id: srhdOnly.id }, data: { visibleWhen: { field: deptField.key, op: "is", value: "SRHD" } } });
  await publishCycle(cycle.id, lead.id);

  const person = await makeVolunteer("SRHD");
  const app = await submitApplication("apply-rv", {
    applicantType: "RENEWAL",
    renewalDepartment: "SRHD",
    // The renewal never renders/submits the DEPARTMENT_CHOICE field, so the
    // server must merge renewalDepartment before evaluating field visibility.
    // Without that merge the condition is checked against an empty department and
    // this answer -- shown to and provided by the applicant -- is silently dropped.
    answers: { first_name: "Re", last_name: "New", email: "srhd@yale.edu", continue_reason: "yes", srhd_renewal_note: "kept" },
    files: {},
    sessionPersonId: person.id,
    sessionEmail: "srhd@yale.edu",
  });
  expect((app.answers as Record<string, unknown>).srhd_renewal_note).toBe("kept");
});

// #57: a FILE field can gate another field via visibleWhen, but the file lands in
// `files`, not `answers`. Without marking uploaded file keys present, the server
// evaluated the gate as unanswered and silently dropped the dependent's answer.
it("keeps a field gated on an uploaded FILE controller", async () => {
  const lead = await prisma.person.create({ data: { name: "Lead", status: "ACTIVE" } });
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall 2026", startDate: new Date(), endDate: new Date() } });
  const cycle = await createCycle({ track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "apply-fc", departments: ["SRHD"], acceptsRenewals: false, createdById: lead.id });
  const idSection = await prisma.formSection.findFirstOrThrow({ where: { cycleId: cycle.id }, orderBy: { order: "asc" } });
  await addField(idSection.id, { label: "1st choice department", type: "DEPARTMENT_CHOICE", required: true });
  const resume = await addField(idSection.id, { label: "Resume", type: "FILE", required: false });
  const afterUpload = await addField(idSection.id, { label: "Why this resume", type: "SHORT_TEXT", required: false });
  await prisma.formField.update({ where: { id: afterUpload.id }, data: { visibleWhen: { field: resume.key, op: "isAnswered" } } });
  await publishCycle(cycle.id, lead.id);

  const app = await submitApplication("apply-fc", {
    applicantType: "NEW",
    answers: { first_name: "F", last_name: "C", email: "fc@yale.edu", "1st_choice_department": "SRHD", why_this_resume: "kept" },
    files: { resume: { fileName: "r.pdf", mimeType: "application/pdf", bytes: Buffer.from("pdf") } },
  });
  expect((app.answers as Record<string, unknown>).why_this_resume).toBe("kept");
});

it("drops a FILE-gated answer when no file was provided (gate correctly unanswered)", async () => {
  const lead = await prisma.person.create({ data: { name: "Lead", status: "ACTIVE" } });
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall 2026", startDate: new Date(), endDate: new Date() } });
  const cycle = await createCycle({ track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "apply-fc2", departments: ["SRHD"], acceptsRenewals: false, createdById: lead.id });
  const idSection = await prisma.formSection.findFirstOrThrow({ where: { cycleId: cycle.id }, orderBy: { order: "asc" } });
  await addField(idSection.id, { label: "1st choice department", type: "DEPARTMENT_CHOICE", required: true });
  const resume = await addField(idSection.id, { label: "Resume", type: "FILE", required: false });
  const afterUpload = await addField(idSection.id, { label: "Why this resume", type: "SHORT_TEXT", required: false });
  await prisma.formField.update({ where: { id: afterUpload.id }, data: { visibleWhen: { field: resume.key, op: "isAnswered" } } });
  await publishCycle(cycle.id, lead.id);

  const app = await submitApplication("apply-fc2", {
    applicantType: "NEW",
    answers: { first_name: "F", last_name: "C", email: "fc2@yale.edu", "1st_choice_department": "SRHD", why_this_resume: "should drop" },
    files: {},
  });
  expect((app.answers as Record<string, unknown>).why_this_resume).toBeUndefined();
});

it("rejects a missing required answer", async () => {
  await openVolunteerCycle();
  await expect(
    submitApplication("apply-v", { applicantType: "NEW", answers: { first_name: "F", last_name: "G", email: "f@yale.edu", "1st_choice_department": "SRHD" }, files: {} })
  ).rejects.toBeInstanceOf(SubmissionValidationError);
});

// Regression for the TestSprite TC030 finding ("incomplete application accepted").
// openVolunteerCycle marks 1st_choice_department as required; omitting it must be
// rejected with a field error. (TC030 was a false positive: it applied as a
// signed-in user whose identity fields were pre-filled, against a fixture cycle
// whose department field was optional, so that submission was genuinely complete.)
it("rejects a NEW submission that omits the required department choice", async () => {
  await openVolunteerCycle();
  const err = await submitApplication("apply-v", {
    applicantType: "NEW",
    answers: { first_name: "No", last_name: "Dept", email: "nodept@yale.edu" },
    files: {},
  }).catch((e) => e);
  expect(err).toBeInstanceOf(SubmissionValidationError);
  expect((err as SubmissionValidationError).fieldErrors).toHaveProperty("1st_choice_department");
});

it("rejects submissions to a non-OPEN cycle", async () => {
  const person = await prisma.person.create({ data: { name: "L", status: "ACTIVE" } });
  const term = await prisma.term.create({ data: { code: "X", name: "X", startDate: new Date(), endDate: new Date() } });
  await createCycle({ track: "VOLUNTEER", termId: term.id, title: "Draft", publicSlug: "draft-x", departments: [], acceptsRenewals: false, createdById: person.id });
  await expect(
    submitApplication("draft-x", { applicantType: "NEW", answers: { first_name: "A", last_name: "B", email: "a@b.edu" }, files: {} })
  ).rejects.toBeInstanceOf(CycleNotOpenError);
});

it("rejects an oversize file upload", async () => {
  const { cycle } = await openVolunteerCycle();
  const oversizeBytes = Buffer.alloc(config.MAX_UPLOAD_MB * 1024 * 1024 + 1);
  await expect(
    submitApplication("apply-v", {
      applicantType: "NEW",
      answers: { first_name: "X", last_name: "Y", email: "x@yale.edu", "1st_choice_department": "MDIC" },
      files: { resume: { fileName: "big.pdf", mimeType: "application/pdf", bytes: oversizeBytes } },
    })
  ).rejects.toBeInstanceOf(SubmissionValidationError);
  void cycle;
});

it("rejects a file uploaded under an unknown/path-traversal field key", async () => {
  await openVolunteerCycle();
  await expect(
    submitApplication("apply-v", {
      applicantType: "NEW",
      answers: { first_name: "P", last_name: "T", email: "pt@yale.edu", "1st_choice_department": "MDIC" },
      files: { "../../../../tmp/evil": { fileName: "evil.sh", mimeType: "text/x-sh", bytes: Buffer.from("x") } },
    })
  ).rejects.toBeInstanceOf(SubmissionValidationError);
});

it("deletes the superseded draft file blob when a new file replaces it on submit", async () => {
  // A draft holds an uploaded file; at submit the applicant supplies a fresh
  // file for the same field. The new blob wins, so the old one must be deleted
  // rather than left orphaned in storage.
  const { cycle } = await openVolunteerCycle();
  const identity = { email: "ann@yale.edu", personId: null, firstName: null };
  await saveDraft("apply-v", identity, { answers: {} });
  await uploadDraftFile("apply-v", identity, "resume", { fileName: "old.pdf", mimeType: "application/pdf", bytes: Buffer.from("old") });
  const draft = await getDraft("apply-v", identity);
  const oldStored = (draft!.answers.resume as { storedName: string }).storedName;
  expect(await getObject(`recruitment/${cycle.id}/${oldStored}`)).not.toBeNull();

  const app = await submitApplication("apply-v", {
    applicantType: "NEW",
    answers: { first_name: "Ann", last_name: "Lee", email: "ann@yale.edu", "1st_choice_department": "MDIC" },
    files: { resume: { fileName: "new.pdf", mimeType: "application/pdf", bytes: Buffer.from("new") } },
  });
  const newStored = (app.answers as { resume: { storedName: string } }).resume.storedName;
  expect(newStored).not.toBe(oldStored);
  expect(await getObject(`recruitment/${cycle.id}/${newStored}`)).not.toBeNull();
  expect(await getObject(`recruitment/${cycle.id}/${oldStored}`)).toBeNull();
});

it("ignores QUIZ sections when validating the public application", async () => {
  const { cycle } = await openVolunteerCycle();
  const quiz = await prisma.formSection.create({ data: { cycleId: cycle.id, title: "Quiz", order: 99, appliesTo: "BOTH", purpose: "QUIZ" } });
  await prisma.formField.create({ data: { sectionId: quiz.id, cycleId: cycle.id, key: "secret_q", label: "Q", type: "SINGLE_SELECT", required: true, order: 0, options: [{ value: "a", label: "A" }], correctValue: "a" } });
  // Submitting WITHOUT secret_q must still succeed: quiz fields are not enforced on the public form.
  const app = await submitApplication("apply-v", {
    applicantType: "NEW",
    answers: { first_name: "Cy", last_name: "Q", email: "cy@yale.edu", "1st_choice_department": "MDIC" },
    files: {},
  });
  expect(app).toBeTruthy();
});

it("getApplication excludes QUIZ sections from the loaded cycle form", async () => {
  const { cycle } = await openVolunteerCycle();
  const quiz = await prisma.formSection.create({ data: { cycleId: cycle.id, title: "Quiz", order: 99, appliesTo: "BOTH", purpose: "QUIZ" } });
  await prisma.formField.create({ data: { sectionId: quiz.id, cycleId: cycle.id, key: "graded_q", label: "Q", type: "SINGLE_SELECT", required: false, order: 0, options: [{ value: "a", label: "A" }], correctValue: "a" } });
  const app = await submitApplication("apply-v", { applicantType: "NEW", answers: { first_name: "Di", last_name: "T", email: "di@yale.edu", "1st_choice_department": "MDIC" }, files: {} });
  const loaded = await getApplication(app.id);
  const titles = loaded!.cycle.sections.map((s) => s.title);
  expect(titles).not.toContain("Quiz");
});

async function openCycleWithRanking() {
  const person = await prisma.person.create({ data: { name: "Lead", status: "ACTIVE" } });
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall 2026", startDate: new Date(), endDate: new Date() } });
  const a = await prisma.subcommittee.create({ data: { name: "Outreach", order: 0 } });
  const b = await prisma.subcommittee.create({ data: { name: "Events", order: 1 } });
  const c = await prisma.subcommittee.create({ data: { name: "Fundraising", order: 2 } });
  const d = await prisma.subcommittee.create({ data: { name: "Health Fairs", order: 3 } });
  const cycle = await createCycle({ track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "apply-rank", departments: ["SRHD"], acceptsRenewals: false, createdById: person.id });
  const section = await prisma.formSection.findFirstOrThrow({ where: { cycleId: cycle.id }, orderBy: { order: "asc" } });
  await addField(section.id, { label: "1st choice department", type: "DEPARTMENT_CHOICE", required: true });
  await addField(section.id, { label: "Subcommittee preferences", type: "SUBCOMMITTEE_RANK", required: true, validation: { rankCount: 3 } });
  await publishCycle(cycle.id, person.id);
  return { person, cycle, subs: { a, b, c, d } };
}

it("hoists ranked subcommittee IDs into subcommitteeRanking in order", async () => {
  const { subs } = await openCycleWithRanking();
  const app = await submitApplication("apply-rank", {
    applicantType: "NEW",
    answers: {
      first_name: "Ann", last_name: "Lee", email: "ann@yale.edu",
      "1st_choice_department": "SRHD",
      subcommittee_preferences: [subs.b.id, subs.a.id],
    },
    files: {},
  });
  expect(app.subcommitteeRanking).toEqual([subs.b.id, subs.a.id]);
  const stored = (app.answers ?? {}) as Record<string, unknown>;
  expect(stored.subcommittee_preferences).toBeUndefined();
});

it("does not require a SUBCOMMITTEE_RANK field in a section the applicant cannot see (#56)", async () => {
  const lead = await prisma.person.create({ data: { name: "Lead", status: "ACTIVE" } });
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall 2026", startDate: new Date(), endDate: new Date() } });
  const cycle = await createCycle({ track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "apply-rank-scope", departments: ["SRHD", "MDIC"], acceptsRenewals: true, createdById: lead.id });
  const renew = await addSection(cycle.id, { title: "Renewal", appliesTo: "RENEWAL", departmentCode: null });
  await addField(renew.id, { label: "Continue reason", type: "LONG_TEXT", required: true });
  // A REQUIRED subcommittee-rank field in a NEW-only section: a renewing applicant
  // never sees it, so requiring it dead-ends them with an error on no rendered step.
  const rankSection = await addSection(cycle.id, { title: "Subcommittee preference", appliesTo: "NEW", departmentCode: null });
  await addField(rankSection.id, { label: "Subcommittee preferences", type: "SUBCOMMITTEE_RANK", required: true, validation: { rankCount: 3 } });
  await prisma.subcommittee.create({ data: { name: "Outreach", order: 0 } });
  await publishCycle(cycle.id, lead.id);

  const person = await makeVolunteer("SRHD");
  const app = await submitApplication("apply-rank-scope", {
    applicantType: "RENEWAL",
    renewalDepartment: "SRHD",
    answers: { first_name: "Re", last_name: "New", email: "srhd@yale.edu", continue_reason: "yes" },
    files: {},
    sessionPersonId: person.id,
    sessionEmail: "srhd@yale.edu",
  });
  // The submit succeeds (previously threw "Please rank at least one subcommittee.")
  expect(app.subcommitteeRanking).toEqual([]);
});

it("rejects a required ranking left empty", async () => {
  await openCycleWithRanking();
  await expect(submitApplication("apply-rank", {
    applicantType: "NEW",
    answers: { first_name: "Ann", last_name: "Lee", email: "ann@yale.edu", "1st_choice_department": "SRHD", subcommittee_preferences: [] },
    files: {},
  })).rejects.toBeInstanceOf(SubmissionValidationError);
});

it("rejects duplicate or unknown subcommittee IDs and over-count", async () => {
  const { subs } = await openCycleWithRanking();
  await expect(submitApplication("apply-rank", {
    applicantType: "NEW",
    answers: { first_name: "B", last_name: "B", email: "b@yale.edu", "1st_choice_department": "SRHD", subcommittee_preferences: [subs.a.id, subs.a.id] },
    files: {},
  })).rejects.toBeInstanceOf(SubmissionValidationError);

  await expect(submitApplication("apply-rank", {
    applicantType: "NEW",
    answers: { first_name: "C", last_name: "C", email: "c@yale.edu", "1st_choice_department": "SRHD", subcommittee_preferences: ["nope"] },
    files: {},
  })).rejects.toBeInstanceOf(SubmissionValidationError);

  // Over-count: four distinct active IDs trips the `> rankCount` branch (rankCount is 3),
  // since the distinct check passes.
  await expect(submitApplication("apply-rank", {
    applicantType: "NEW",
    answers: { first_name: "D", last_name: "D", email: "d@yale.edu", "1st_choice_department": "SRHD", subcommittee_preferences: [subs.a.id, subs.b.id, subs.c.id, subs.d.id] },
    files: {},
  })).rejects.toBeInstanceOf(SubmissionValidationError);
});

// The wizard renders `fieldErrors[key]` verbatim as the red text under the field
// (field-preview.tsx) and `message` as the banner above the form. A terse code like
// "duplicate choice" therefore reaches the applicant as a second, garbled error next
// to the readable banner. Field errors must carry the readable sentence; the banner
// stays generic, matching the schema-validation path.
it("puts a readable sentence in fieldErrors for ranking problems, not a machine code", async () => {
  const { subs } = await openCycleWithRanking();
  const base = {
    applicantType: "NEW" as const,
    answers: { first_name: "E", last_name: "E", email: "e@yale.edu", "1st_choice_department": "SRHD" },
    files: {},
  };
  const cases: [unknown, string][] = [
    [[subs.a.id, subs.a.id], "Each subcommittee can be ranked only once."],
    [[], "Please rank at least one subcommittee."],
    [[subs.a.id, subs.b.id, subs.c.id, subs.d.id], "Rank at most 3 subcommittees."],
    [["nope"], "That subcommittee is not available."],
  ];
  for (const [ranking, expected] of cases) {
    const err = await submitApplication("apply-rank", {
      ...base,
      answers: { ...base.answers, subcommittee_preferences: ranking },
    }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(SubmissionValidationError);
    const v = err as SubmissionValidationError;
    expect(v.fieldErrors.subcommittee_preferences).toBe(expected);
    expect(v.message).toBe("Please fix the highlighted fields.");
  }
});

it("finalizes an existing draft into a submission (no duplicate Applicant)", async () => {
  await openVolunteerCycle();
  const ID = { email: "ann@yale.edu", personId: null, firstName: null };
  await saveDraft("apply-v", ID, { answers: { first_name: "Ann", last_name: "Lee", email: "ann@yale.edu" } });
  const app = await submitApplication("apply-v", {
    applicantType: "NEW",
    answers: { first_name: "Ann", last_name: "Lee", email: "ann@yale.edu", "1st_choice_department": "SRHD", srhd_essay: "because" },
    files: {},
  });
  expect(app.status).toBe("SUBMITTED");
  expect(app.submittedAt).not.toBeNull();
  const applicants = await prisma.applicant.count({ where: { emailLower: "ann@yale.edu" } });
  expect(applicants).toBe(1); // the draft applicant was finalized, not duplicated
});

it("rejects submitting when the application is already SUBMITTED", async () => {
  await openVolunteerCycle();
  const args = { applicantType: "NEW" as const, answers: { first_name: "Bo", last_name: "Ng", email: "bo@yale.edu", "1st_choice_department": "MDIC" }, files: {} };
  await submitApplication("apply-v", args);
  await expect(submitApplication("apply-v", args)).rejects.toBeInstanceOf(DuplicateApplicationError);
});

it("two concurrent submits of the same draft flip it once and queue one confirmation email (audit3 L9)", async () => {
  await openVolunteerCycle();
  const ID = { email: "race@yale.edu", personId: null, firstName: null };
  await saveDraft("apply-v", ID, { answers: { first_name: "Ray", last_name: "Sun", email: "race@yale.edu" } });
  const args = { applicantType: "NEW" as const, answers: { first_name: "Ray", last_name: "Sun", email: "race@yale.edu", "1st_choice_department": "MDIC" }, files: {} };
  // Fire two submits at once. The atomic status: "DRAFT" claim (mirroring
  // submitContract) means only one flips DRAFT->SUBMITTED; the loser throws
  // DuplicateApplicationError instead of double-sending the confirmation email.
  const settled = await Promise.allSettled([submitApplication("apply-v", args), submitApplication("apply-v", args)]);
  const fulfilled = settled.filter((s) => s.status === "fulfilled");
  const rejected = settled.filter((s) => s.status === "rejected") as PromiseRejectedResult[];
  expect(fulfilled).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  expect(rejected[0].reason).toBeInstanceOf(DuplicateApplicationError);

  expect(await prisma.application.count({ where: { applicant: { emailLower: "race@yale.edu" } } })).toBe(1);
  const app = await prisma.application.findFirstOrThrow({ where: { applicant: { emailLower: "race@yale.edu" } } });
  expect(app.status).toBe("SUBMITTED");
  expect(await prisma.emailLog.count({ where: { template: "recruitment.application_received", toEmail: "race@yale.edu" } })).toBe(1);
});

it("drops the losing concurrent submit's freshly-uploaded blob instead of orphaning it (audit3 L9)", async () => {
  const { cycle } = await openVolunteerCycle();
  const ID = { email: "racef@yale.edu", personId: null, firstName: null };
  await saveDraft("apply-v", ID, { answers: { first_name: "Ray", last_name: "Sun", email: "racef@yale.edu" } });
  const mkArgs = () => ({
    applicantType: "NEW" as const,
    answers: { first_name: "Ray", last_name: "Sun", email: "racef@yale.edu", "1st_choice_department": "MDIC" },
    files: { resume: { fileName: "resume.pdf", mimeType: "application/pdf", bytes: Buffer.from(`r-${Math.random()}`) } },
  });
  // Each submit persists its own blob before the transaction; the loser's blob
  // must be cleaned up on DuplicateApplicationError, not left orphaned.
  const settled = await Promise.allSettled([submitApplication("apply-v", mkArgs()), submitApplication("apply-v", mkArgs())]);
  expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);

  const files = await fs.readdir(path.join(config.UPLOAD_DIR, "recruitment", cycle.id));
  expect(files).toHaveLength(1); // only the winning submission's blob survives
  const app = await prisma.application.findFirstOrThrow({ where: { applicant: { emailLower: "racef@yale.edu" } } });
  const stored = (app.answers as { resume: { storedName: string } }).resume.storedName;
  expect(files[0]).toBe(stored);
});

async function openCycleWithConditionalField() {
  const person = await prisma.person.create({ data: { name: "Lead", status: "ACTIVE" } });
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall 2026", startDate: new Date(), endDate: new Date() } });
  const cycle = await createCycle({ track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "apply-cond", departments: ["SRHD"], acceptsRenewals: false, createdById: person.id });
  const idSection = (await prisma.formSection.findFirstOrThrow({ where: { cycleId: cycle.id }, orderBy: { order: "asc" } }));
  await addField(idSection.id, { label: "1st choice department", type: "DEPARTMENT_CHOICE", required: true });
  const gate = await addField(idSection.id, { label: "Do you speak other languages?", type: "SINGLE_SELECT", required: false, options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }] });
  const detail = await addField(idSection.id, { label: "Which languages?", type: "SHORT_TEXT", required: true });
  // form-builder.ts::addField does not yet accept visibleWhen (that lands in a later
  // task), so this test writes the condition directly onto the created field.
  await prisma.formField.update({ where: { id: detail.id }, data: { visibleWhen: { field: gate.key, op: "is", value: "yes" } } });
  await publishCycle(cycle.id, person.id);
  return { person, cycle, gateKey: gate.key, detailKey: detail.key };
}

it("submits successfully when a condition-hidden required field is left unanswered", async () => {
  const { gateKey } = await openCycleWithConditionalField();
  const app = await submitApplication("apply-cond", {
    applicantType: "NEW",
    // The gate says "no", so the dependent required "detail" field stays hidden
    // and unanswered; validation must not block on it.
    answers: { first_name: "Ann", last_name: "Lee", email: "ann@yale.edu", "1st_choice_department": "SRHD", [gateKey]: "no" },
    files: {},
  });
  expect(app.status).toBe("SUBMITTED");
});

it("strips a condition-hidden field's stale answer from the persisted Application.answers", async () => {
  const { gateKey, detailKey } = await openCycleWithConditionalField();
  const app = await submitApplication("apply-cond", {
    applicantType: "NEW",
    // Submit the hidden field's key anyway (e.g. a stale value from before the
    // applicant flipped the gate back to "no"); it must not persist.
    answers: {
      first_name: "Bo", last_name: "Ng", email: "bo@yale.edu", "1st_choice_department": "SRHD",
      [gateKey]: "no", [detailKey]: "Spanish, French",
    },
    files: {},
  });
  expect(Object.keys(app.answers as object)).not.toContain(detailKey);
});

it("keeps a visible conditional field's answer in the persisted Application.answers", async () => {
  const { gateKey, detailKey } = await openCycleWithConditionalField();
  const app = await submitApplication("apply-cond", {
    applicantType: "NEW",
    answers: {
      first_name: "Cy", last_name: "Oz", email: "cy@yale.edu", "1st_choice_department": "SRHD",
      [gateKey]: "yes", [detailKey]: "Spanish, French",
    },
    files: {},
  });
  expect((app.answers as Record<string, unknown>)[detailKey]).toBe("Spanish, French");
});

async function openCycleWithConditionalFileField() {
  const person = await prisma.person.create({ data: { name: "Lead", status: "ACTIVE" } });
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall 2026", startDate: new Date(), endDate: new Date() } });
  const cycle = await createCycle({ track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "apply-condfile", departments: ["SRHD"], acceptsRenewals: false, createdById: person.id });
  const idSection = (await prisma.formSection.findFirstOrThrow({ where: { cycleId: cycle.id }, orderBy: { order: "asc" } }));
  await addField(idSection.id, { label: "1st choice department", type: "DEPARTMENT_CHOICE", required: true });
  const gate = await addField(idSection.id, { label: "Do you have proof of certification?", type: "SINGLE_SELECT", required: false, options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }] });
  const proof = await addField(idSection.id, { label: "Upload proof", type: "FILE", required: false });
  // form-builder.ts::addField does not yet accept visibleWhen (a later task), so this
  // test writes the condition directly onto the created field, mirroring the sibling
  // scalar conditional-field fixture above.
  await prisma.formField.update({ where: { id: proof.id }, data: { visibleWhen: { field: gate.key, op: "is", value: "yes" } } });
  await publishCycle(cycle.id, person.id);
  return { person, cycle, gateKey: gate.key, proofKey: proof.key };
}

it("does not persist a file uploaded under a condition-hidden FILE field's key (no orphaned blob)", async () => {
  const { cycle, gateKey, proofKey } = await openCycleWithConditionalFileField();
  const app = await submitApplication("apply-condfile", {
    applicantType: "NEW",
    // The gate says "no", so the "proof" FILE field is hidden. DOM unmounting of
    // hidden fields is a later task, so a hidden file input can still submit its
    // FormData entry today -- the server must not persist it.
    answers: { first_name: "Ann", last_name: "Lee", email: "ann@yale.edu", "1st_choice_department": "SRHD", [gateKey]: "no" },
    files: { [proofKey]: { fileName: "cert.pdf", mimeType: "application/pdf", bytes: Buffer.from("cert") } },
  });
  expect(app.status).toBe("SUBMITTED");
  expect(Object.keys(app.answers as object)).not.toContain(proofKey);
  // No blob was ever written for this cycle: the hidden field's file must be
  // dropped before persistFiles, not persisted-then-orphaned.
  let entries: string[] = [];
  try {
    entries = await fs.readdir(path.join(config.UPLOAD_DIR, "recruitment", cycle.id));
  } catch {
    // dir may not exist yet -- fine, means nothing was ever written
  }
  expect(entries).toHaveLength(0);
});

it("persists a file uploaded under a visible FILE field's key (control)", async () => {
  const { cycle, gateKey, proofKey } = await openCycleWithConditionalFileField();
  const app = await submitApplication("apply-condfile", {
    applicantType: "NEW",
    answers: { first_name: "Bo", last_name: "Ng", email: "bo@yale.edu", "1st_choice_department": "SRHD", [gateKey]: "yes" },
    files: { [proofKey]: { fileName: "cert.pdf", mimeType: "application/pdf", bytes: Buffer.from("cert") } },
  });
  const stored = (app.answers as Record<string, { storedName: string }>)[proofKey];
  expect(stored).toBeTruthy();
  expect(await getObject(`recruitment/${cycle.id}/${stored.storedName}`)).not.toBeNull();
});

it("cleans up a draft-uploaded file's blob when its FILE field becomes condition-hidden before submit", async () => {
  const { cycle, gateKey, proofKey } = await openCycleWithConditionalFileField();
  const identity = { email: "orphan@yale.edu", personId: null, firstName: null };
  // Draft while the gate says "yes" (the proof field is visible) and upload a
  // file to it, the way an applicant would mid-form before backtracking.
  await saveDraft("apply-condfile", identity, {
    answers: { first_name: "Or", last_name: "Fan", email: "orphan@yale.edu", "1st_choice_department": "SRHD", [gateKey]: "yes" },
  });
  await uploadDraftFile("apply-condfile", identity, proofKey, { fileName: "cert.pdf", mimeType: "application/pdf", bytes: Buffer.from("cert") });
  const draft = await getDraft("apply-condfile", identity);
  const storedName = (draft!.answers as Record<string, { storedName: string }>)[proofKey].storedName;
  expect(await getObject(`recruitment/${cycle.id}/${storedName}`)).not.toBeNull();

  // Flip the gate to "no" before submitting, hiding the proof field. The strip
  // loop removes its answer key; the earlier draft blob must not be left behind.
  const app = await submitApplication("apply-condfile", {
    applicantType: "NEW",
    answers: { first_name: "Or", last_name: "Fan", email: "orphan@yale.edu", "1st_choice_department": "SRHD", [gateKey]: "no" },
    files: {},
  });
  expect(app.status).toBe("SUBMITTED");
  expect(Object.keys(app.answers as object)).not.toContain(proofKey);
  expect(await getObject(`recruitment/${cycle.id}/${storedName}`)).toBeNull();
});

async function makeVolunteer(deptCode: string) {
  const person = await prisma.person.create({ data: { name: "Reed Renew", contactEmail: "reed-old@yale.edu", status: "ACTIVE" } });
  const term = await prisma.term.create({ data: { code: "SP26", name: "Spring 2026", startDate: new Date("2026-01-01"), endDate: new Date("2026-05-01") } });
  const dept = await prisma.department.create({ data: { code: deptCode, name: deptCode } });
  await prisma.termMembership.create({ data: { personId: person.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" } });
  return person;
}

const RENEWAL_ANSWERS = { first_name: "Reed", last_name: "Renew", email: "tampered@evil.com", continue_reason: "I want to keep volunteering." };

// Every separation-of-duties guard in recruitment keys on applicantPersonId and
// short-circuits on `applicantPersonId && ...`. A NEW application from a
// signed-in person used to store null there, so a sitting director could pick
// "New applicant" in the wizard and then score and accept their own application.
it("links a NEW submission to the signed-in person so the self-dealing guards can fire", async () => {
  await openVolunteerCycle();
  const person = await makeVolunteer("SRHD");
  const app = await submitApplication("apply-v", {
    applicantType: "NEW",
    answers: { first_name: "Reed", last_name: "Renew", email: "reed@yale.edu", "1st_choice_department": "SRHD", srhd_essay: "because" },
    files: {},
    sessionPersonId: person.id,
    identityEmail: "reed@yale.edu",
  });
  const applicant = await prisma.applicant.findFirstOrThrow({ where: { id: app.applicantId } });
  expect(app.applicantType).toBe("NEW");
  expect(applicant.applicantPersonId).toBe(person.id);
});

it("leaves applicantPersonId null for a NEW submission with no session (a true outside applicant)", async () => {
  await openVolunteerCycle();
  const app = await submitApplication("apply-v", {
    applicantType: "NEW",
    answers: { first_name: "Ann", last_name: "Lee", email: "ann@yale.edu", "1st_choice_department": "SRHD", srhd_essay: "because" },
    files: {},
  });
  const applicant = await prisma.applicant.findFirstOrThrow({ where: { id: app.applicantId } });
  expect(applicant.applicantPersonId).toBeNull();
});

it("does not erase a link the draft already established", async () => {
  const { cycle } = await openVolunteerCycle();
  const person = await makeVolunteer("SRHD");
  // A draft saved while signed in already carries the link (drafts.ts).
  await prisma.applicant.create({
    data: {
      cycleId: cycle.id, applicantPersonId: person.id,
      firstName: "Reed", lastName: "Renew", email: "reed@yale.edu", emailLower: "reed@yale.edu",
    },
  });
  const app = await submitApplication("apply-v", {
    applicantType: "NEW",
    answers: { first_name: "Reed", last_name: "Renew", email: "reed@yale.edu", "1st_choice_department": "SRHD", srhd_essay: "because" },
    files: {},
    identityEmail: "reed@yale.edu",
  });
  const applicant = await prisma.applicant.findFirstOrThrow({ where: { id: app.applicantId } });
  expect(applicant.applicantPersonId).toBe(person.id);
});

it("rejects a renewal submit with no session", async () => {
  await openVolunteerCycle();
  await expect(
    submitApplication("apply-v", { applicantType: "RENEWAL", renewalDepartment: "SRHD", answers: RENEWAL_ANSWERS, files: {} })
  ).rejects.toBeInstanceOf(SubmissionValidationError);
});

it("links an eligible renewal to the person and stores the verified email (not the tampered one)", async () => {
  await openVolunteerCycle();
  const person = await makeVolunteer("SRHD");
  const app = await submitApplication("apply-v", {
    applicantType: "RENEWAL", renewalDepartment: "SRHD", answers: RENEWAL_ANSWERS, files: {},
    sessionPersonId: person.id, sessionEmail: "reed@yale.edu",
  });
  const applicant = await prisma.applicant.findFirstOrThrow({ where: { id: app.applicantId } });
  expect(applicant.applicantPersonId).toBe(person.id);
  expect(applicant.email).toBe("reed@yale.edu");
  expect(app.applicantType).toBe("RENEWAL");
  expect(app.departmentChoices).toEqual(["SRHD"]);
});

it("accepts a renewal with a missing email in answers and stores the verified session email", async () => {
  await openVolunteerCycle();
  const person = await makeVolunteer("SRHD");
  // Omit 'email' from answers entirely - it would normally fail schema validation.
  // The server must inject the verified session email before validation runs.
  const app = await submitApplication("apply-v", {
    applicantType: "RENEWAL",
    renewalDepartment: "SRHD",
    answers: { first_name: "Reed", last_name: "Renew", continue_reason: "I want to keep volunteering." },
    files: {},
    sessionPersonId: person.id,
    sessionEmail: "reed@yale.edu",
  });
  const applicant = await prisma.applicant.findFirstOrThrow({ where: { id: app.applicantId } });
  expect(applicant.email).toBe("reed@yale.edu");
});

it("rejects a second renewal by the same person", async () => {
  await openVolunteerCycle();
  const person = await makeVolunteer("SRHD");
  const args = { applicantType: "RENEWAL" as const, renewalDepartment: "SRHD", answers: RENEWAL_ANSWERS, files: {}, sessionPersonId: person.id, sessionEmail: "reed@yale.edu" };
  await submitApplication("apply-v", args);
  await expect(submitApplication("apply-v", args)).rejects.toBeInstanceOf(DuplicateApplicationError);
});

it("rejects a renewal when the signed-in person has no active volunteer membership", async () => {
  await openVolunteerCycle();
  const person = await prisma.person.create({ data: { name: "Lapsed", status: "ACTIVE" } });
  await expect(
    submitApplication("apply-v", { applicantType: "RENEWAL", renewalDepartment: "SRHD", answers: RENEWAL_ANSWERS, files: {}, sessionPersonId: person.id, sessionEmail: "lapsed@yale.edu" })
  ).rejects.toBeInstanceOf(SubmissionValidationError);
});

it("uses the cycle's application-received override when present", async () => {
  const { cycle } = await openVolunteerCycle();
  await prisma.recruitmentCycleEmail.create({
    data: { cycleId: cycle.id, key: "recruitment.application_received", subject: "Got it {{ firstName }}", body: "<p>Re {{ cycleTitle }}</p>" },
  });
  await submitApplication("apply-v", { applicantType: "NEW", answers: { first_name: "Ann", last_name: "Lee", email: "ann@yale.edu", "1st_choice_department": "MDIC" }, files: {} });
  const mail = await prisma.emailLog.findFirstOrThrow({ where: { template: "recruitment.application_received" } });
  expect(mail.subject).toBe("Got it Ann");
  expect(mail.html).toContain("Re V");
  expect(mail.html).toContain("<!DOCTYPE html>");
});

it("binds a NEW submission to the resolved identity email, ignoring a tampered form email", async () => {
  await openVolunteerCycle();
  const app = await submitApplication("apply-v", {
    applicantType: "NEW",
    answers: { first_name: "Ann", last_name: "Lee", email: "tampered@evil.com", "1st_choice_department": "SRHD", srhd_essay: "x" },
    files: {},
    identityEmail: "ann@yale.edu",
  });
  const applicant = await prisma.applicant.findFirstOrThrow({ where: { id: app.applicantId } });
  expect(applicant.email).toBe("ann@yale.edu"); // identity wins, not the form value
});

it("routes a TRANSFER into a different in-cycle department and snapshots the origin", async () => {
  await openVolunteerCycle();
  const person = await makeVolunteer("SRHD");
  const app = await submitApplication("apply-v", {
    applicantType: "TRANSFER",
    answers: { first_name: "Tess", last_name: "Fer", email: "tess@yale.edu", "1st_choice_department": "MDIC" },
    files: {},
    sessionPersonId: person.id,
    sessionEmail: "tess@yale.edu",
  });
  expect(app.applicantType).toBe("TRANSFER");
  expect(app.departmentChoices).toEqual(["MDIC"]);
  expect(app.transferFromDepartments).toEqual(["SRHD"]);
  expect(app.renewalDepartment).toBeNull();
  const applicant = await prisma.applicant.findFirstOrThrow({ where: { id: app.applicantId } });
  expect(applicant.applicantPersonId).toBe(person.id);
  expect(applicant.email).toBe("tess@yale.edu");
});

it("allows a TRANSFER from a department not offered by this cycle (broader eligibility)", async () => {
  await openVolunteerCycle();
  const person = await makeVolunteer("EXEC"); // EXEC is not one of the cycle's ["SRHD","MDIC"]
  const app = await submitApplication("apply-v", {
    applicantType: "TRANSFER",
    answers: { first_name: "Ned", last_name: "Ew", email: "ned@yale.edu", "1st_choice_department": "SRHD", srhd_essay: "ready to switch" },
    files: {},
    sessionPersonId: person.id,
    sessionEmail: "ned@yale.edu",
  });
  expect(app.applicantType).toBe("TRANSFER");
  expect(app.departmentChoices).toEqual(["SRHD"]);
  expect(app.transferFromDepartments).toEqual(["EXEC"]);
});

it("rejects a TRANSFER that omits the target department's new-applicant supplement", async () => {
  await openVolunteerCycle();
  const person = await makeVolunteer("EXEC"); // origin outside the cycle
  const err = await submitApplication("apply-v", {
    applicantType: "TRANSFER",
    answers: { first_name: "Ned", last_name: "Ew", email: "ned@yale.edu", "1st_choice_department": "SRHD" }, // srhd_essay deliberately omitted
    files: {},
    sessionPersonId: person.id,
    sessionEmail: "ned@yale.edu",
  }).catch((e) => e);
  expect(err).toBeInstanceOf(SubmissionValidationError);
  expect((err as SubmissionValidationError).fieldErrors).toHaveProperty("srhd_essay");
});

it("rejects a TRANSFER whose target is the person's current department (nudge to renew)", async () => {
  await openVolunteerCycle();
  const person = await makeVolunteer("SRHD");
  const err = await submitApplication("apply-v", {
    applicantType: "TRANSFER",
    answers: { first_name: "Sam", last_name: "Stay", email: "sam@yale.edu", "1st_choice_department": "SRHD", srhd_essay: "x" },
    files: {},
    sessionPersonId: person.id,
    sessionEmail: "sam@yale.edu",
  }).catch((e) => e);
  expect(err).toBeInstanceOf(SubmissionValidationError);
  expect((err as SubmissionValidationError).fieldErrors).toHaveProperty("1st_choice_department");
});

it("rejects a TRANSFER when the signed-in person has no active membership", async () => {
  await openVolunteerCycle();
  const person = await prisma.person.create({ data: { name: "Stranger", status: "ACTIVE" } });
  await expect(
    submitApplication("apply-v", {
      applicantType: "TRANSFER",
      answers: { first_name: "St", last_name: "Ranger", email: "stranger@yale.edu", "1st_choice_department": "MDIC" },
      files: {},
      sessionPersonId: person.id,
      sessionEmail: "stranger@yale.edu",
    })
  ).rejects.toBeInstanceOf(SubmissionValidationError);
});

it("rejects a TRANSFER with no session", async () => {
  await openVolunteerCycle();
  await expect(
    submitApplication("apply-v", {
      applicantType: "TRANSFER",
      answers: { first_name: "An", last_name: "On", email: "anon@yale.edu", "1st_choice_department": "MDIC" },
      files: {},
    })
  ).rejects.toBeInstanceOf(SubmissionValidationError);
});

it("links an applicant to a person and blocks a second per cycle, but allows anonymous applicants", async () => {
  const { cycle } = await openVolunteerCycle();
  const person = await prisma.person.create({ data: { name: "Reed", status: "ACTIVE" } });

  await prisma.applicant.create({
    data: { cycleId: cycle.id, applicantPersonId: person.id, firstName: "Reed", lastName: "R", email: "reed@yale.edu", emailLower: "reed@yale.edu" },
  });

  // Same person, same cycle -> unique violation (P2002).
  await expect(
    prisma.applicant.create({
      data: { cycleId: cycle.id, applicantPersonId: person.id, firstName: "Reed", lastName: "R", email: "reed2@yale.edu", emailLower: "reed2@yale.edu" },
    })
  ).rejects.toMatchObject({ code: "P2002" });

  // Two anonymous applicants (null personId) in the same cycle are fine.
  await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "A", lastName: "A", email: "a@yale.edu", emailLower: "a@yale.edu" } });
  await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "B", lastName: "B", email: "b@yale.edu", emailLower: "b@yale.edu" } });
  const anon = await prisma.applicant.count({ where: { cycleId: cycle.id, applicantPersonId: null } });
  expect(anon).toBe(2);
});

it("captures the applicant's NetID from the net_id answer key (NEW)", async () => {
  await openVolunteerCycle();
  await submitApplication("apply-v", {
    applicantType: "NEW",
    answers: { first_name: "Nel", last_name: "Idd", email: "nel@yale.edu", net_id: "ni42", "1st_choice_department": "MDIC" },
    files: {},
  });
  const applicant = await prisma.applicant.findFirstOrThrow({ where: { emailLower: "nel@yale.edu" } });
  expect(applicant.netId).toBe("ni42");
});

it("pins a NEW applicant's NetID to their matched record, ignoring a tampered form value", async () => {
  await openVolunteerCycle();
  // A signed-in applicant with an existing record who applies as NEW cannot
  // change their NetID: the server uses the record's value, not the form's.
  const person = await prisma.person.create({ data: { name: "Rec Ord", netId: "rec9", status: "ACTIVE" } });
  await submitApplication("apply-v", {
    applicantType: "NEW",
    answers: { first_name: "Rec", last_name: "Ord", email: "rec@yale.edu", net_id: "tampered", "1st_choice_department": "MDIC" },
    files: {},
    sessionPersonId: person.id,
  });
  const applicant = await prisma.applicant.findFirstOrThrow({ where: { emailLower: "rec@yale.edu" } });
  expect(applicant.netId).toBe("rec9");
});

it("fills a RENEWAL applicant's identity from their matched record, not the (absent) NEW-only identity fields", async () => {
  await openVolunteerCycle();
  const person = await makeVolunteer("SRHD");
  await prisma.person.update({ where: { id: person.id }, data: { netId: "reed7", phone: "203-555-0100" } });
  // In the real default template the identity section is NEW-only, so a returning
  // applicant submits none of it. Here (a minimal test cycle whose identity
  // section is BOTH) we submit bogus identity to satisfy the schema and assert the
  // matched RECORD wins -- the same code path that fills it when answers are absent.
  await submitApplication("apply-v", {
    applicantType: "RENEWAL",
    renewalDepartment: "SRHD",
    answers: { first_name: "Ignored", last_name: "Ignored", net_id: "ignored", continue_reason: "still in" },
    files: {},
    sessionPersonId: person.id,
    sessionEmail: "reed@yale.edu",
  });
  const applicant = await prisma.applicant.findFirstOrThrow({ where: { emailLower: "reed@yale.edu" } });
  expect(applicant.firstName).toBe("Reed");
  expect(applicant.lastName).toBe("Renew");
  expect(applicant.netId).toBe("reed7");
  expect(applicant.phone).toBe("203-555-0100");
});

it("stores a drawn SIGNATURE answer as a private png blob with audit context", async () => {
  const { cycle } = await openVolunteerCycle();
  const idSection = await prisma.formSection.findFirstOrThrow({ where: { cycleId: cycle.id }, orderBy: { order: "asc" } });
  await addField(idSection.id, { label: "Signature", type: "SIGNATURE", required: true });

  const PNG_1x1 =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQAY3Y2wAAAAAElFTkSuQmCC";

  const app = await submitApplication("apply-v", {
    applicantType: "NEW",
    answers: {
      first_name: "Sig", last_name: "Ner", email: "sig@yale.edu", "1st_choice_department": "SRHD", srhd_essay: "x",
      signature: PNG_1x1, signature__method: "draw", signature__name: "Sig Ner",
    },
    files: {},
  });

  const answers = app.answers as Record<string, { storedName?: string; mimeType?: string; method?: string; name?: string; signedAt?: string; size?: number; fileName?: string }>;
  const sig = answers.signature;
  expect(sig.mimeType).toBe("image/png");
  expect(sig.method).toBe("draw");
  expect(sig.name).toBe("Sig Ner");
  expect(typeof sig.signedAt).toBe("string");
  expect(sig.fileName).toBe("signature.png");
  expect(sig.size).toBeGreaterThan(0);
  // The raw data URL and the companion keys must not linger in stored answers.
  expect(typeof answers.signature).toBe("object");
  expect((answers as Record<string, unknown>).signature__method).toBeUndefined();
  // The blob exists in storage, and size matches the decoded byte length.
  const bytes = await getObject(`recruitment/${cycle.id}/${sig.storedName}`);
  expect(bytes?.length).toBeGreaterThan(0);
  expect(sig.size).toBe(bytes!.length);
});

it("records a typed SIGNATURE's method and trims the printed name", async () => {
  const { cycle } = await openVolunteerCycle();
  const idSection = await prisma.formSection.findFirstOrThrow({ where: { cycleId: cycle.id }, orderBy: { order: "asc" } });
  await addField(idSection.id, { label: "Signature", type: "SIGNATURE", required: true });
  void cycle;

  const PNG_1x1 =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQAY3Y2wAAAAAElFTkSuQmCC";

  const app = await submitApplication("apply-v", {
    applicantType: "NEW",
    answers: {
      first_name: "Ty", last_name: "Ped", email: "typed@yale.edu", "1st_choice_department": "SRHD", srhd_essay: "x",
      signature: PNG_1x1, signature__method: "type", signature__name: "  Ty Ped  ",
    },
    files: {},
  });

  const sig = (app.answers as Record<string, { method?: string; name?: string }>).signature;
  expect(sig.method).toBe("type");
  expect(sig.name).toBe("Ty Ped"); // surrounding whitespace trimmed
});

it("cleans up the persisted FILE blob when signature persistence fails (no orphan)", async () => {
  // A required FILE and a required SIGNATURE both submit. The file is valid and is
  // persisted to a blob BEFORE the signature loop; the signature payload passes
  // zod's data-URL prefix check but fails the PNG magic-byte decode. The submit must
  // reject AND the already-uploaded FILE blob (potential PII) must be cleaned up,
  // not left orphaned in storage.
  const { cycle } = await openVolunteerCycle();
  const idSection = await prisma.formSection.findFirstOrThrow({ where: { cycleId: cycle.id }, orderBy: { order: "asc" } });
  await addField(idSection.id, { label: "Proof", type: "FILE", required: true });
  await addField(idSection.id, { label: "Signature", type: "SIGNATURE", required: true });

  await expect(
    submitApplication("apply-v", {
      applicantType: "NEW",
      answers: {
        first_name: "Or", last_name: "Phan", email: "orphan-sig@yale.edu", "1st_choice_department": "SRHD", srhd_essay: "x",
        // Passes zod's `startsWith("data:image/png;base64,")` but decodes to the bytes
        // of "hello" -- no PNG magic bytes -- so decodeSignaturePng throws.
        signature: "data:image/png;base64,aGVsbG8=", signature__method: "draw", signature__name: "Or Phan",
      },
      files: { proof: { fileName: "proof.pdf", mimeType: "application/pdf", bytes: Buffer.from("proof-bytes") } },
    }),
  ).rejects.toBeInstanceOf(SubmissionValidationError);

  // The FILE blob persisted before the failed signature loop must have been cleaned
  // up: nothing lingers under the cycle prefix.
  let entries: string[] = [];
  try {
    entries = await fs.readdir(path.join(config.UPLOAD_DIR, "recruitment", cycle.id));
  } catch {
    // dir may not exist -- fine, means nothing was ever written
  }
  expect(entries).toHaveLength(0);
  // And no application/applicant was created for this attempt.
  expect(await prisma.applicant.count({ where: { emailLower: "orphan-sig@yale.edu" } })).toBe(0);
});

it("rejects a required SIGNATURE that was not signed", async () => {
  const { cycle } = await openVolunteerCycle();
  const idSection = await prisma.formSection.findFirstOrThrow({ where: { cycleId: cycle.id }, orderBy: { order: "asc" } });
  await addField(idSection.id, { label: "Signature", type: "SIGNATURE", required: true });
  void cycle;
  await expect(
    submitApplication("apply-v", {
      applicantType: "NEW",
      answers: { first_name: "No", last_name: "Sign", email: "nosign@yale.edu", "1st_choice_department": "SRHD", srhd_essay: "x", signature: "" },
      files: {},
    }),
  ).rejects.toBeInstanceOf(SubmissionValidationError);
});

/** openVolunteerCycle plus an availability question and a clinic calendar. The
 *  stored options are deliberately stale: live resolution must ignore them. */
async function openCycleWithAvailability(clinicDates: Date[]) {
  const { person, cycle } = await openVolunteerCycle();
  const { termId } = await prisma.recruitmentCycle.findUniqueOrThrow({
    where: { id: cycle.id }, select: { termId: true },
  });
  await prisma.term.update({ where: { id: termId }, data: { clinicDates } });
  const section = await addSection(cycle.id, { title: "Availability", appliesTo: "BOTH", departmentCode: null });
  await prisma.formField.create({
    data: {
      sectionId: section.id, cycleId: cycle.id, key: "availability", label: "Clinic dates",
      type: "MULTI_SELECT", required: true, order: 0,
      options: [{ value: "2026-06-27", label: "Jun 27" }],
    },
  });
  return { person, cycle, termId };
}

const NEW_ANSWERS = {
  first_name: "Ann", last_name: "Lee", email: "ann@yale.edu",
  "1st_choice_department": "SRHD", srhd_essay: "because",
};

it("discards an availability date removed from the calendar after the draft was saved", async () => {
  // The applicant checked 2026-06-13 while it was still a clinic date; the admin
  // has since removed it. The remaining pick must still submit cleanly.
  await openCycleWithAvailability([new Date("2026-06-06T12:00:00.000Z")]);
  const app = await submitApplication("apply-v", {
    applicantType: "NEW",
    answers: { ...NEW_ANSWERS, availability: ["2026-06-06", "2026-06-13"] },
    files: {},
  });
  expect((app.answers as Record<string, unknown>).availability).toEqual(["2026-06-06"]);
});

it("reports the ordinary required error when every availability pick is gone", async () => {
  await openCycleWithAvailability([new Date("2026-06-06T12:00:00.000Z")]);
  const err = await submitApplication("apply-v", {
    applicantType: "NEW",
    answers: { ...NEW_ANSWERS, availability: ["2026-06-13"] },
    files: {},
  }).catch((e) => e);
  expect(err).toBeInstanceOf(SubmissionValidationError);
  // Must be the ordinary zod "required" (array min-length) message against the
  // refreshed option list, not the enum-rejection message a strict schema would
  // raise for an unknown choice (e.g. `Invalid input: expected "2026-06-06"`).
  // Asserting the exact issue text is what makes this test fail if the filter
  // block in submitApplication is ever removed: without it, the stale pick would
  // hit the zod enum directly and produce the "unknown choice" message instead.
  expect((err as SubmissionValidationError).fieldErrors.availability).toBe(
    "Too small: expected array to have >=1 items",
  );
});

it("does not enforce a required availability answer when the term has no clinic dates", async () => {
  // Empty calendar drops the field entirely, so its required-ness cannot block.
  await openCycleWithAvailability([]);
  const app = await submitApplication("apply-v", {
    applicantType: "NEW",
    answers: NEW_ANSWERS,
    files: {},
  });
  expect(app.id).toBeTruthy();
});
