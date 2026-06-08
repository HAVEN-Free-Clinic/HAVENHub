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
  const app = await submitApplication("apply-v", {
    applicantType: "RENEWAL",
    renewalDepartment: "SRHD",
    answers: { first_name: "Cy", last_name: "Oz", email: "cy@yale.edu", continue_reason: "yes" },
    files: {},
  });
  expect(app.applicantType).toBe("RENEWAL");
  expect(app.renewalDepartment).toBe("SRHD");
  expect(app.departmentChoices).toEqual(["SRHD"]);
  expect(Object.keys(app.answers as object)).not.toContain("1st_choice_department");
});

it("rejects a renewalDepartment outside the cycle departments", async () => {
  await openVolunteerCycle();
  await expect(
    submitApplication("apply-v", { applicantType: "RENEWAL", renewalDepartment: "ZZZ", answers: { first_name: "D", last_name: "E", email: "d@yale.edu", continue_reason: "x" }, files: {} })
  ).rejects.toBeInstanceOf(SubmissionValidationError);
});

it("rejects a missing required answer", async () => {
  await openVolunteerCycle();
  await expect(
    submitApplication("apply-v", { applicantType: "NEW", answers: { first_name: "F", last_name: "G", email: "f@yale.edu", "1st_choice_department": "SRHD" }, files: {} })
  ).rejects.toBeInstanceOf(SubmissionValidationError);
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

it("lists and gets applications", async () => {
  const { cycle } = await openVolunteerCycle();
  await submitApplication("apply-v", { applicantType: "NEW", answers: { first_name: "Ann", last_name: "Lee", email: "ann@yale.edu", "1st_choice_department": "MDIC" }, files: {} });
  const list = await listApplications(cycle.id);
  expect(list).toHaveLength(1);
  const one = await getApplication(list[0].id);
  expect(one?.applicant.email).toBe("ann@yale.edu");
});
