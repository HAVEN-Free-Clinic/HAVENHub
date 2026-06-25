// src/modules/recruitment/services/portal-status.test.ts
import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { listApplicantApplications } from "./portal-status";

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("lists the identity's applications across cycles with status", async () => {
  const lead = await prisma.person.create({ data: { name: "L", status: "ACTIVE" } });
  const term = await prisma.term.create({ data: { code: "FA26", name: "F", startDate: new Date(), endDate: new Date() } });
  const cycle = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "Volunteer 2026", publicSlug: "v26", departments: ["SRHD"], createdById: lead.id, status: "OPEN" } });
  const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "", lastName: "", email: "reed@yale.edu", emailLower: "reed@yale.edu" } });
  await prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: [], subcommitteeRanking: [], status: "DRAFT" } });

  const rows = await listApplicantApplications({ email: "reed@yale.edu", personId: null });
  expect(rows).toEqual([{ slug: "v26", cycleTitle: "Volunteer 2026", status: "DRAFT" }]);
  expect(await listApplicantApplications({ email: "nobody@yale.edu", personId: null })).toEqual([]);
});
