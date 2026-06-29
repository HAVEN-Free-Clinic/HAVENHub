import { beforeEach, afterEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { createCycle } from "./cycles";
import {
  listCycleEmails, getCycleEmailForEdit, saveCycleEmail, resetCycleEmail,
  CycleEmailValidationError, CycleEmailAuthError,
} from "./cycle-emails";

// Grant a permission via a role + a global (termId: null) person assignment,
// the proven pattern from subcommittees.test.ts / engine.test.ts.
async function manager() {
  const p = await prisma.person.create({ data: { name: "Mgr", status: "ACTIVE" } });
  const role = await prisma.role.create({ data: { name: "Mgr", isSystem: false, grants: { create: [{ permission: "recruitment.manage_cycles" }] } } });
  await prisma.roleAssignment.create({ data: { roleId: role.id, personId: p.id, termId: null } });
  return p;
}
async function outsider() {
  return prisma.person.create({ data: { name: "Out", status: "ACTIVE" } });
}
async function makeCycle(createdById: string) {
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall 2026", startDate: new Date(), endDate: new Date() } });
  return createCycle({ track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "rc-ce", departments: ["SRHD"], acceptsRenewals: false, createdById });
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("lists the four cycle-scoped emails with no overrides initially", async () => {
  const mgr = await manager();
  const cycle = await makeCycle(mgr.id);
  const list = await listCycleEmails(cycle.id);
  expect(list.map((e) => e.key).sort()).toEqual([
    "recruitment.acceptance", "recruitment.application_received", "recruitment.interview_invite", "recruitment.onboarding",
  ]);
  expect(list.every((e) => e.hasOverride === false)).toBe(true);
});

it("getCycleEmailForEdit returns the effective default when unset", async () => {
  const mgr = await manager();
  const cycle = await makeCycle(mgr.id);
  const e = await getCycleEmailForEdit(cycle.id, "recruitment.acceptance");
  expect(e.hasOverride).toBe(false);
  expect(e.subject).toBe("You've been accepted to HAVEN: {{ departmentName }}");
  expect(e.variables.map((v) => v.name)).toContain("departmentName");
  expect(e.layoutSource).toContain("{{{ body }}}");
});

it("saves a valid override, marks hasOverride, and records audit", async () => {
  const mgr = await manager();
  const cycle = await makeCycle(mgr.id);
  await saveCycleEmail(cycle.id, "recruitment.acceptance", { subject: "Hi {{ firstName }}", body: "<p>{{ departmentName }}</p>" }, mgr.id);
  const e = await getCycleEmailForEdit(cycle.id, "recruitment.acceptance");
  expect(e.hasOverride).toBe(true);
  expect(e.subject).toBe("Hi {{ firstName }}");
  const audit = await prisma.auditLog.findFirst({ where: { action: "recruitment.cycle_email_save" } });
  expect(audit).not.toBeNull();
});

it("rejects an unknown variable", async () => {
  const mgr = await manager();
  const cycle = await makeCycle(mgr.id);
  await expect(
    saveCycleEmail(cycle.id, "recruitment.acceptance", { subject: "Hi {{ bogus }}", body: "<p>x</p>" }, mgr.id)
  ).rejects.toBeInstanceOf(CycleEmailValidationError);
});

it("rejects a save by someone without manage_cycles", async () => {
  const mgr = await manager();
  const cycle = await makeCycle(mgr.id);
  const out = await outsider();
  await expect(
    saveCycleEmail(cycle.id, "recruitment.acceptance", { subject: "Hi", body: "<p>x</p>" }, out.id)
  ).rejects.toBeInstanceOf(CycleEmailAuthError);
});

it("resets an override and records audit", async () => {
  const mgr = await manager();
  const cycle = await makeCycle(mgr.id);
  await saveCycleEmail(cycle.id, "recruitment.acceptance", { subject: "Hi {{ firstName }}", body: "<p>x</p>" }, mgr.id);
  await resetCycleEmail(cycle.id, "recruitment.acceptance", mgr.id);
  const e = await getCycleEmailForEdit(cycle.id, "recruitment.acceptance");
  expect(e.hasOverride).toBe(false);
  const audit = await prisma.auditLog.findFirst({ where: { action: "recruitment.cycle_email_reset" } });
  expect(audit).not.toBeNull();
});
