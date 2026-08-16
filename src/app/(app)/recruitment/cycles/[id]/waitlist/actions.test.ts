/**
 * Audit 14 (REC-5): promoting off the waitlist is the one acceptance path that
 * does not go through "Release decisions", so it never inherited Release's
 * DRAFT/ARCHIVED gate. On an archived cycle it flipped the applicant to ACCEPT,
 * minted an Acceptance, and emailed the offer -- while createOrResendContract
 * refuses to send the onboarding link that offer promises for exactly that
 * status. The applicant was told they were in and could never be onboarded.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const e = Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;${url}` });
    throw e;
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/platform/auth/session", () => ({ requirePersonSession: vi.fn() }));

import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { requirePersonSession } from "@/platform/auth/session";
import { routeApplication, decideRoutedApplication } from "@/modules/recruitment/services/routing";
import { unarchiveCycle } from "@/modules/recruitment/services/cycles";
import { promoteFromWaitlistAction } from "./actions";

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); vi.clearAllMocks(); });

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

/** A waitlisted volunteer application on a CLOSED cycle, ready to promote. */
async function seed() {
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  await prisma.department.create({ data: { code: "EDUC", name: "Education" } });
  const lead = await prisma.person.create({ data: { name: "Lead", status: "ACTIVE" } });
  const role = await prisma.role.create({ data: { name: "SRR", grants: { create: [{ permission: "recruitment.review_all" }] } } });
  await prisma.roleAssignment.create({ data: { personId: lead.id, roleId: role.id } });
  const cycle = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "v", departments: ["EDUC"], createdById: lead.id, status: "OPEN" } });
  const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "Ada", lastName: "B", email: "ada@y.edu", emailLower: "ada@y.edu" } });
  const application = await prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: ["EDUC"] } });
  vi.mocked(requirePersonSession).mockResolvedValue({ personId: lead.id } as never);
  await routeApplication(application.id, "EDUC", lead.id);
  await decideRoutedApplication(application.id, "WAITLIST", lead.id, "hold for capacity");
  await prisma.recruitmentCycle.update({ where: { id: cycle.id }, data: { status: "CLOSED" } });
  return { lead, cycle, application };
}

it("refuses the promote on an archived cycle, leaving the applicant waitlisted rather than un-onboardable", async () => {
  const { cycle, application } = await seed();
  await prisma.recruitmentCycle.update({ where: { id: cycle.id }, data: { status: "ARCHIVED" } });

  const err = await promoteFromWaitlistAction(
    cycle.id,
    form({ applicationId: application.id, applicantName: "Ada B" }),
  ).catch((e) => e);

  expect(err.digest).toContain(`/recruitment/cycles/${cycle.id}/waitlist?error=`);
  expect(err.digest).toContain("archived");
  // Nothing moved: no acceptance minted, no email queued, still WAITLIST.
  const app = await prisma.application.findUniqueOrThrow({ where: { id: application.id } });
  expect(app.decision).toBe("WAITLIST");
  expect(await prisma.acceptance.count({ where: { applicationId: application.id } })).toBe(0);
  expect(await prisma.emailLog.count()).toBe(0);
});

it("promotes and emails once the cycle is un-archived, so the refusal is not a dead end", async () => {
  const { lead, cycle, application } = await seed();
  await prisma.recruitmentCycle.update({ where: { id: cycle.id }, data: { status: "ARCHIVED" } });
  await unarchiveCycle(cycle.id, lead.id);

  const err = await promoteFromWaitlistAction(
    cycle.id,
    form({ applicationId: application.id, applicantName: "Ada B" }),
  ).catch((e) => e);

  expect(err.digest).toContain("promoted=Ada+B");
  expect(err.digest).toContain("sent=1");
  const app = await prisma.application.findUniqueOrThrow({ where: { id: application.id } });
  expect(app.decision).toBe("ACCEPT");
  expect((await prisma.acceptance.findFirstOrThrow({ where: { applicationId: application.id } })).emailedAt).not.toBeNull();
  expect(await prisma.emailLog.count()).toBe(1);
});
