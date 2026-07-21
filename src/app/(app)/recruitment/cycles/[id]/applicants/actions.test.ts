import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const e = Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;${url}` });
    throw e;
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/platform/auth/session", () => ({ requirePersonSession: vi.fn() }));
vi.mock("@/platform/posthog/capture", () => ({ captureEvent: vi.fn(), GROUP_DEPARTMENT: "department" }));
vi.mock("@/platform/posthog/groups", () => ({ termGroupForCycle: vi.fn().mockResolvedValue(undefined) }));

import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { requirePersonSession } from "@/platform/auth/session";
import { routeApplication, decideRoutedApplication } from "@/modules/recruitment/services/routing";
import { routeAction, decideRoutedAction, rescindAcceptanceAction } from "./actions";

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); vi.clearAllMocks(); });

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

async function seed() {
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  const educ = await prisma.department.create({ data: { code: "EDUC", name: "Education" } });
  await prisma.department.create({ data: { code: "MDIC", name: "Medical" } });
  const lead = await prisma.person.create({ data: { name: "Lead", status: "ACTIVE" } });
  const role = await prisma.role.create({ data: { name: "SRR", grants: { create: [{ permission: "recruitment.review_all" }] } } });
  await prisma.roleAssignment.create({ data: { personId: lead.id, roleId: role.id } });
  // A director scoped to EDUC but WITHOUT review_all: reviewScope reads an ACTIVE
  // DIRECTOR TermMembership, so this person is in scope for the department yet
  // revokeAcceptance still refuses them once the acceptance has been emailed.
  const director = await prisma.person.create({ data: { name: "Dir", status: "ACTIVE" } });
  await prisma.termMembership.create({ data: { personId: director.id, termId: term.id, departmentId: educ.id, kind: "DIRECTOR", status: "ACTIVE" } });
  const cycle = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "v", departments: ["EDUC", "MDIC"], createdById: lead.id, status: "OPEN" } });
  const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "A", lastName: "B", email: "a@y.edu", emailLower: "a@y.edu" } });
  const application = await prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: ["EDUC"] } });
  vi.mocked(requirePersonSession).mockResolvedValue({ personId: lead.id } as never);
  return { lead, director, cycle, application };
}

/** Route to EDUC, accept, and stamp the acceptance as emailed: the exact state
 *  that blocks both re-routing and a decision change. Returns the Acceptance row. */
async function seedEmailedAcceptance(applicationId: string, actorId: string) {
  await routeApplication(applicationId, "EDUC", actorId);
  await decideRoutedApplication(applicationId, "ACCEPT", actorId, null);
  await prisma.acceptance.updateMany({ where: { applicationId, departmentCode: "EDUC" }, data: { emailedAt: new Date() } });
  return prisma.acceptance.findFirstOrThrow({ where: { applicationId, departmentCode: "EDUC" } });
}

it("re-routing away from an emailed acceptance surfaces an inline error, not a render crash", async () => {
  const { cycle, application } = await seed();
  // Accept for EDUC, then email that acceptance -- re-routing is now blocked.
  await routeApplication(application.id, "EDUC", (await requirePersonSession()).personId);
  await decideRoutedApplication(application.id, "ACCEPT", (await requirePersonSession()).personId, null);
  await prisma.acceptance.updateMany({ where: { applicationId: application.id, departmentCode: "EDUC" }, data: { emailedAt: new Date() } });

  // routeApplication throws AcceptanceError here. The action must catch it and
  // redirect to a friendly ?error= rather than letting it escape (which Next
  // renders as a blank "Server Components render" crash).
  const err = await routeAction(cycle.id, application.id, form({ departmentCode: "MDIC" })).catch((e) => e);
  expect(err.digest).toContain(`/recruitment/cycles/${cycle.id}/applicants/${application.id}?error=`);
  expect(decodeURIComponent(err.digest)).toContain("Rescind it before re-routing");
  // The original routing is untouched.
  const app = await prisma.application.findUniqueOrThrow({ where: { id: application.id } });
  expect(app.routedDepartmentCode).toBe("EDUC");
});

it("lets an SRR rescind an emailed acceptance and redirects with saved=rescind", async () => {
  const { lead, cycle, application } = await seed();
  const acc = await seedEmailedAcceptance(application.id, lead.id);

  const err = await rescindAcceptanceAction(cycle.id, application.id, acc.id).catch((e) => e);
  expect(err.digest).toContain(`/recruitment/cycles/${cycle.id}/applicants/${application.id}?saved=rescind`);
  expect(await prisma.acceptance.findUnique({ where: { id: acc.id } })).toBeNull();
});

it("redirects a department director to an inline error rather than throwing", async () => {
  const { lead, director, cycle, application } = await seed();
  const acc = await seedEmailedAcceptance(application.id, lead.id);
  // Swap the session to the EDUC director: in scope for the department, but no
  // review_all, so revokeAcceptance refuses an already-emailed acceptance.
  vi.mocked(requirePersonSession).mockResolvedValue({ personId: director.id } as never);

  const err = await rescindAcceptanceAction(cycle.id, application.id, acc.id).catch((e) => e);
  expect(err.digest).toContain(`/recruitment/cycles/${cycle.id}/applicants/${application.id}?error=`);
  expect(decodeURIComponent(err.digest)).toContain("already notified");
  // The acceptance survives an unauthorized attempt.
  expect(await prisma.acceptance.findUnique({ where: { id: acc.id } })).not.toBeNull();
});

it("unblocks the decision change: REJECT is refused before the rescind and recorded after it", async () => {
  const { lead, cycle, application } = await seed();
  const acc = await seedEmailedAcceptance(application.id, lead.id);

  const blocked = await decideRoutedAction(cycle.id, application.id, form({ outcome: "REJECT" })).catch((e) => e);
  expect(decodeURIComponent(blocked.digest)).toContain("Rescind the acceptance before changing this decision");

  await rescindAcceptanceAction(cycle.id, application.id, acc.id).catch(() => {});

  const ok = await decideRoutedAction(cycle.id, application.id, form({ outcome: "REJECT" })).catch((e) => e);
  expect(ok.digest).toContain(`/recruitment/cycles/${cycle.id}/applicants/${application.id}?saved=decision`);
  const app = await prisma.application.findUniqueOrThrow({ where: { id: application.id } });
  expect(app.decision).toBe("REJECT");
});
