import { beforeEach, afterEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { createCycle } from "@/modules/recruitment/services/cycles";
import { renderCycleEmail, resolveCycleEmail, CYCLE_EMAIL_KEYS } from "./render";

// createCycle is the canonical cycle factory used by the other recruitment
// service tests (see subcommittees.test.ts); it sets required defaults.
async function makeCycle() {
  const person = await prisma.person.create({ data: { name: "Lead", status: "ACTIVE" } });
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall 2026", startDate: new Date(), endDate: new Date() } });
  return createCycle({ track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "rc-render", departments: ["SRHD"], acceptsRenewals: false, createdById: person.id });
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("renders the descriptor default wrapped in the layout when there is no override", async () => {
  const cycle = await makeCycle();
  const { subject, html } = await renderCycleEmail(cycle.id, "recruitment.acceptance", { firstName: "Ann", cycleTitle: "V", departmentName: "SRHD" });
  expect(subject).toBe("You've been accepted to HAVEN: SRHD");
  expect(html).toContain("Congratulations Ann,");
  expect(html).toContain("<!DOCTYPE html>"); // layout wrapper applied
});

it("prefers a cycle override over the global default", async () => {
  const cycle = await makeCycle();
  await prisma.recruitmentCycleEmail.create({ data: { cycleId: cycle.id, key: "recruitment.acceptance", subject: "Welcome {{ firstName }}", body: "<p>Custom {{ departmentName }}</p>" } });
  const { subject, html } = await renderCycleEmail(cycle.id, "recruitment.acceptance", { firstName: "Ann", cycleTitle: "V", departmentName: "SRHD" });
  expect(subject).toBe("Welcome Ann");
  expect(html).toContain("Custom SRHD");
});

it("falls back to the global EmailTemplate override when there is no cycle override", async () => {
  const cycle = await makeCycle();
  await prisma.emailTemplate.create({ data: { key: "recruitment.acceptance", subject: "Global {{ firstName }}", body: "<p>Global body</p>" } });
  const { subject, html } = await renderCycleEmail(cycle.id, "recruitment.acceptance", { firstName: "Ann", cycleTitle: "V", departmentName: "SRHD" });
  expect(subject).toBe("Global Ann");
  expect(html).toContain("Global body");
});

it("cycle override beats global override", async () => {
  const cycle = await makeCycle();
  await prisma.emailTemplate.create({ data: { key: "recruitment.acceptance", subject: "Global", body: "<p>Global</p>" } });
  await prisma.recruitmentCycleEmail.create({ data: { cycleId: cycle.id, key: "recruitment.acceptance", subject: "Cycle", body: "<p>Cycle</p>" } });
  const { subject } = await renderCycleEmail(cycle.id, "recruitment.acceptance", { firstName: "Ann", cycleTitle: "V", departmentName: "SRHD" });
  expect(subject).toBe("Cycle");
});

it("rejects a non-cycle key and an unknown key", async () => {
  const cycle = await makeCycle();
  // @ts-expect-error portal_link is global-only, not a CycleEmailKey
  await expect(resolveCycleEmail(cycle.id, "recruitment.portal_link")).rejects.toThrow();
  // @ts-expect-error unknown key
  await expect(resolveCycleEmail(cycle.id, "nope")).rejects.toThrow();
});

it("exposes exactly the four cycle-scoped keys", () => {
  expect([...CYCLE_EMAIL_KEYS].sort()).toEqual([
    "recruitment.acceptance",
    "recruitment.application_received",
    "recruitment.interview_invite",
    "recruitment.onboarding",
  ]);
});
