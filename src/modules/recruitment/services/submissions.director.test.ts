import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { createCycle, publishCycle } from "./cycles";
import { addSection, addField } from "./form-builder";
import { submitApplication, SubmissionValidationError } from "./submissions";
import { loadHavenHistory } from "./haven-history";

// A director cycle shaped like the default director template where it matters
// here: a two-slot ranked department choice, a supplement for each ranked
// department, and the two HAVEN-history questions answered from the record.
async function openDirectorCycle() {
  const lead = await prisma.person.create({ data: { name: "Lead", status: "ACTIVE" } });
  const term = await prisma.term.create({ data: { code: "SP27", name: "Spring 2027", startDate: new Date("2027-01-10"), endDate: new Date("2027-05-10") } });
  const cycle = await createCycle({
    track: "DIRECTOR", termId: term.id, title: "Directors", publicSlug: "apply-d",
    departments: ["SRHD", "SCTP", "MDIC"], acceptsRenewals: true, createdById: lead.id,
  });
  const first = await prisma.formSection.findFirstOrThrow({ where: { cycleId: cycle.id }, orderBy: { order: "asc" } });
  await addField(first.id, {
    key: "prev_volunteered", label: "Have you previously volunteered at HAVEN?", type: "SINGLE_SELECT", required: true,
    options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }],
    validation: { derive: "haven_volunteer_history" },
  });
  await addField(first.id, {
    key: "returning_board", label: "Have you previously been on the Board?", type: "SINGLE_SELECT", required: true,
    options: [
      { value: "yes_term_extension", label: "Yes - Term Extension" },
      { value: "yes_new_position", label: "Yes - New Position" },
      { value: "no", label: "No" },
    ],
    validation: { derive: "haven_board_history" },
  });
  const dept = await addSection(cycle.id, { title: "Department preferences", appliesTo: "NEW", departmentCode: null });
  await addField(dept.id, {
    key: "department_choice", label: "Department preference", type: "DEPARTMENT_CHOICE", required: true,
    validation: { rankCount: 2 },
  });
  const sctp = await addSection(cycle.id, { title: "SCTP questions", appliesTo: "NEW", departmentCode: "SCTP" });
  await addField(sctp.id, { key: "sctp_essay", label: "SCTP essay", type: "LONG_TEXT", required: true });
  const srhd = await addSection(cycle.id, { title: "SRHD questions", appliesTo: "NEW", departmentCode: "SRHD" });
  await addField(srhd.id, { key: "srhd_essay", label: "SRHD essay", type: "LONG_TEXT", required: true });
  await publishCycle(cycle.id, lead.id);
  return { cycle, term };
}

async function personWith(memberships: { kind: "VOLUNTEER" | "DIRECTOR"; status?: "ACTIVE" | "REMOVED"; termCode: string; dept: string; archived?: boolean }[]) {
  const person = await prisma.person.create({ data: { name: "Pat Person", contactEmail: "pat@yale.edu", status: "ACTIVE" } });
  for (const m of memberships) {
    const term = await prisma.term.upsert({
      where: { code: m.termCode },
      update: {},
      create: {
        code: m.termCode, name: m.termCode, startDate: new Date("2025-01-01"), endDate: new Date("2025-05-01"),
        status: m.archived ? "ARCHIVED" : "ACTIVE",
      },
    });
    const dept = await prisma.department.upsert({ where: { code: m.dept }, update: {}, create: { code: m.dept, name: m.dept } });
    await prisma.termMembership.create({ data: { personId: person.id, termId: term.id, departmentId: dept.id, kind: m.kind, status: m.status ?? "ACTIVE" } });
  }
  return person;
}

const BASE = { first_name: "Pat", last_name: "Person", email: "pat@yale.edu" };

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("stores two ranked departments in order and asks both departments' supplements", async () => {
  await openDirectorCycle();
  const app = await submitApplication("apply-d", {
    applicantType: "NEW",
    answers: { ...BASE, prev_volunteered: "no", returning_board: "no", department_choice: ["SCTP", "SRHD"], sctp_essay: "a", srhd_essay: "b" },
    files: {},
  });
  expect(app.departmentChoices).toEqual(["SCTP", "SRHD"]);
  const answers = app.answers as Record<string, unknown>;
  expect(answers.department_choice).toEqual(["SCTP", "SRHD"]);
  expect(answers.sctp_essay).toBe("a");
  expect(answers.srhd_essay).toBe("b");
});

it("requires the 2nd choice's supplement too", async () => {
  await openDirectorCycle();
  await expect(
    submitApplication("apply-d", {
      applicantType: "NEW",
      answers: { ...BASE, prev_volunteered: "no", returning_board: "no", department_choice: ["SCTP", "SRHD"], sctp_essay: "a" },
      files: {},
    }),
  ).rejects.toMatchObject({ fieldErrors: { srhd_essay: expect.any(String) } });
});

it("accepts a 1st choice alone, leaving the 2nd slot empty", async () => {
  await openDirectorCycle();
  const app = await submitApplication("apply-d", {
    applicantType: "NEW",
    answers: { ...BASE, prev_volunteered: "no", returning_board: "no", department_choice: ["MDIC", ""] },
    files: {},
  });
  expect(app.departmentChoices).toEqual(["MDIC"]);
});

it("rejects the same department ranked twice", async () => {
  await openDirectorCycle();
  await expect(
    submitApplication("apply-d", {
      applicantType: "NEW",
      answers: { ...BASE, prev_volunteered: "no", returning_board: "no", department_choice: ["MDIC", "MDIC"] },
      files: {},
    }),
  ).rejects.toBeInstanceOf(SubmissionValidationError);
});

it("rejects a transfer that ranks its current department in any slot", async () => {
  await openDirectorCycle();
  const person = await personWith([{ kind: "DIRECTOR", termCode: "FA26", dept: "SRHD" }]);
  await expect(
    submitApplication("apply-d", {
      applicantType: "TRANSFER",
      answers: { ...BASE, department_choice: ["MDIC", "SRHD"], srhd_essay: "x" },
      files: {}, sessionPersonId: person.id, sessionEmail: "pat@yale.edu",
    }),
  ).rejects.toMatchObject({ fieldErrors: { department_choice: expect.stringContaining("SRHD") } });
});

it("loads history across every term and status", async () => {
  const volunteerOnly = await personWith([{ kind: "VOLUNTEER", status: "REMOVED", termCode: "FA23", dept: "SRHD", archived: true }]);
  expect(await loadHavenHistory(volunteerOnly.id)).toEqual({ volunteered: true, directed: false });
});

it("overwrites the HAVEN-history answers from the record at submit, whatever the client sent", async () => {
  await openDirectorCycle();
  // Volunteered in an imported, archived term; directed once, since removed.
  const person = await personWith([
    { kind: "VOLUNTEER", termCode: "FA23", dept: "SRHD", archived: true },
    { kind: "DIRECTOR", status: "REMOVED", termCode: "SP24", dept: "SCTP", archived: true },
  ]);
  const app = await submitApplication("apply-d", {
    applicantType: "NEW",
    // The applicant tampered with both locked answers.
    answers: { ...BASE, prev_volunteered: "no", returning_board: "no", department_choice: ["MDIC"] },
    files: {}, sessionPersonId: person.id, identityEmail: "pat@yale.edu",
  });
  const answers = app.answers as Record<string, unknown>;
  expect(answers.prev_volunteered).toBe("yes");
  expect(answers.returning_board).toBe("yes_new_position");
});

it("fills the answers in even when the client sent nothing for them", async () => {
  await openDirectorCycle();
  const person = await personWith([]);
  const app = await submitApplication("apply-d", {
    applicantType: "NEW",
    answers: { ...BASE, department_choice: ["MDIC"] },
    files: {}, sessionPersonId: person.id, identityEmail: "pat@yale.edu",
  });
  const answers = app.answers as Record<string, unknown>;
  expect(answers.prev_volunteered).toBe("no");
  expect(answers.returning_board).toBe("no");
});

it("answers a renewing director's board question as a term extension", async () => {
  await openDirectorCycle();
  const person = await personWith([{ kind: "DIRECTOR", termCode: "FA26", dept: "SRHD" }]);
  const app = await submitApplication("apply-d", {
    applicantType: "RENEWAL", renewalDepartment: "SRHD",
    answers: { ...BASE, prev_volunteered: "no", returning_board: "no" },
    files: {}, sessionPersonId: person.id, sessionEmail: "pat@yale.edu",
  });
  const answers = app.answers as Record<string, unknown>;
  expect(answers.returning_board).toBe("yes_term_extension");
  expect(answers.prev_volunteered).toBe("yes");
});

it("keeps the applicant's own answers when no Person is known", async () => {
  await openDirectorCycle();
  const app = await submitApplication("apply-d", {
    applicantType: "NEW",
    answers: { ...BASE, prev_volunteered: "yes", returning_board: "yes_new_position", department_choice: ["MDIC"] },
    files: {}, identityEmail: "pat@yale.edu",
  });
  const answers = app.answers as Record<string, unknown>;
  expect(answers.prev_volunteered).toBe("yes");
  expect(answers.returning_board).toBe("yes_new_position");
});
