import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const e = Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;${url}` });
    throw e;
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/platform/auth/session", () => ({ requirePersonSession: vi.fn() }));
// The error path bounces before any capture fires; stub the posthog calls so
// importing the action never reaches the real client.
vi.mock("@/platform/posthog/capture", () => ({ captureEvent: vi.fn(), GROUP_DEPARTMENT: "department" }));
vi.mock("@/platform/posthog/groups", () => ({ termGroupForCycle: vi.fn().mockResolvedValue({}) }));

import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { requirePersonSession } from "@/platform/auth/session";
import { routeApplication, decideRoutedApplication } from "@/modules/recruitment/services/routing";
import { routeAction } from "./actions";

async function seed() {
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  await prisma.department.create({ data: { code: "EDUC", name: "Education" } });
  await prisma.department.create({ data: { code: "MDIC", name: "Medical" } });
  const lead = await prisma.person.create({ data: { name: "Lead", status: "ACTIVE" } });
  const role = await prisma.role.create({ data: { name: "SRR", grants: { create: [{ permission: "recruitment.review_all" }] } } });
  await prisma.roleAssignment.create({ data: { personId: lead.id, roleId: role.id } });
  const cycle = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "v", departments: ["EDUC", "MDIC"], createdById: lead.id, status: "OPEN" } });
  const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "A", lastName: "B", email: "a@y.edu", emailLower: "a@y.edu" } });
  const application = await prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: ["EDUC"] } });
  vi.mocked(requirePersonSession).mockResolvedValue({ personId: lead.id } as never);
  return { lead, cycle, application };
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("bounces to a friendly error (not a 500) when re-routing an already-emailed acceptance", async () => {
  const { lead, cycle, application } = await seed();
  await routeApplication(application.id, "EDUC", lead.id);
  await decideRoutedApplication(application.id, "ACCEPT", lead.id, null);
  await prisma.acceptance.updateMany({ where: { applicationId: application.id, departmentCode: "EDUC" }, data: { emailedAt: new Date() } });

  // The re-route trips AcceptanceError inside routeApplication's transaction. The
  // action must catch it and redirect with the message, never re-throw it as an
  // unhandled server-action exception.
  const err = await routeAction(cycle.id, application.id, form({ departmentCode: "MDIC" })).catch((e) => e);
  expect(err.digest).toContain(`/recruitment/cycles/${cycle.id}/applicants/${application.id}?error=`);
  expect(decodeURIComponent(err.digest)).toContain("Rescind it before re-routing");
  // The original routing is untouched.
  const app = await prisma.application.findUniqueOrThrow({ where: { id: application.id } });
  expect(app.routedDepartmentCode).toBe("EDUC");
});
