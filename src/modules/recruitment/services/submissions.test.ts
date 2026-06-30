import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { config } from "@/platform/config";
import { createCycle, publishCycle } from "./cycles";
import { addSection, addField } from "./form-builder";
import {
  submitApplication, listApplications, getApplication,
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
  const identity = { email: "ann@yale.edu", personId: null };
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

it("lists and gets applications", async () => {
  const { cycle } = await openVolunteerCycle();
  await submitApplication("apply-v", { applicantType: "NEW", answers: { first_name: "Ann", last_name: "Lee", email: "ann@yale.edu", "1st_choice_department": "MDIC" }, files: {} });
  const list = await listApplications(cycle.id);
  expect(list).toHaveLength(1);
  const one = await getApplication(list[0].id);
  expect(one?.applicant.email).toBe("ann@yale.edu");
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

it("finalizes an existing draft into a submission (no duplicate Applicant)", async () => {
  await openVolunteerCycle();
  const ID = { email: "ann@yale.edu", personId: null };
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

async function makeVolunteer(deptCode: string) {
  const person = await prisma.person.create({ data: { name: "Reed Renew", contactEmail: "reed-old@yale.edu", status: "ACTIVE" } });
  const term = await prisma.term.create({ data: { code: "SP26", name: "Spring 2026", startDate: new Date("2026-01-01"), endDate: new Date("2026-05-01") } });
  const dept = await prisma.department.create({ data: { code: deptCode, name: deptCode } });
  await prisma.termMembership.create({ data: { personId: person.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" } });
  return person;
}

const RENEWAL_ANSWERS = { first_name: "Reed", last_name: "Renew", email: "tampered@evil.com", continue_reason: "I want to keep volunteering." };

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

it("allows a TRANSFER from a department not offered by this cycle and enforces the new-applicant supplement", async () => {
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
