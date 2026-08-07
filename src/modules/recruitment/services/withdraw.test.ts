import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

/** A published volunteer cycle with one applicant holding one application.
 *  Later tasks append their tests to THIS file and reuse this fixture rather
 *  than writing their own, so it stays module-private (no export). */
async function seedCycle(
  slug: string,
  email: string,
  opts: { appStatus?: "DRAFT" | "SUBMITTED" | "WITHDRAWN"; cycleStatus?: "OPEN" | "CLOSED" } = {},
) {
  const appStatus = opts.appStatus ?? "SUBMITTED";
  const srr = await prisma.person.create({ data: { name: "SRR", status: "ACTIVE" } });
  const role = await prisma.role.create({
    data: { name: "RA " + slug, grants: { create: [{ permission: "recruitment.review_all" }] } },
  });
  await prisma.roleAssignment.create({ data: { personId: srr.id, roleId: role.id } });
  const term = await prisma.term.create({
    data: { code: "FA26", name: "Fall 2026", startDate: new Date(), endDate: new Date(), status: "ACTIVE" },
  });
  const dept = await prisma.department.create({ data: { code: "SRHD", name: "Student Run Health Dept" } });
  const cycle = await prisma.recruitmentCycle.create({
    data: {
      track: "VOLUNTEER", termId: term.id, title: "Volunteer 2026", publicSlug: slug,
      departments: ["SRHD"], createdById: srr.id, status: opts.cycleStatus ?? "OPEN",
    },
  });
  const applicant = await prisma.applicant.create({
    data: { cycleId: cycle.id, firstName: "Reed", lastName: "Rivers", email, emailLower: email.toLowerCase() },
  });
  const app = await prisma.application.create({
    data: {
      cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW",
      departmentChoices: ["SRHD"], status: appStatus,
      submittedAt: appStatus === "DRAFT" ? null : new Date(),
    },
  });
  return { srr, term, dept, cycle, applicant, app };
}

/** The portal identity shape (email is always already lowercased). */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- reserved for Tasks 2-9's tests appended below
const ID = (email: string) => ({ email: email.toLowerCase(), personId: null, firstName: null });

it("stores a WITHDRAWN application with a withdrawnAt stamp", async () => {
  const { app } = await seedCycle("w-schema", "reed@yale.edu", { appStatus: "WITHDRAWN" });
  const stamped = await prisma.application.update({
    where: { id: app.id },
    data: { withdrawnAt: new Date() },
  });
  expect(stamped.status).toBe("WITHDRAWN");
  expect(stamped.withdrawnAt).toBeInstanceOf(Date);
});
