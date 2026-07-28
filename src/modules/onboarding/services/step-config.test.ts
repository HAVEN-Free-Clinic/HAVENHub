import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  loadEffectiveSteps,
  setStepConfig,
  StepConfigError,
  STEP_DEFAULTS,
} from "./step-config";
import { getOnboardingStatus } from "./onboarding";

beforeEach(resetDb);

async function activeTerm() {
  return prisma.term.create({
    data: {
      code: "SU26",
      name: "Summer 2026",
      startDate: new Date("2026-05-01"),
      endDate: new Date("2026-09-26"),
      status: "ACTIVE",
    },
  });
}

async function grant(personId: string, permission: string) {
  const role = await prisma.role.create({
    data: { name: `R-${permission}-${personId}`, isSystem: false, grants: { create: [{ permission }] } },
  });
  await prisma.roleAssignment.create({ data: { roleId: role.id, personId, termId: null } });
}

async function volunteer(name: string, termId: string) {
  const dept = await prisma.department.create({ data: { code: `D${Math.floor(Math.random() * 1e6)}`, name } });
  const person = await prisma.person.create({
    data: { name, contactEmail: `${name}@x.edu`, phone: "555-0100", status: "ACTIVE" },
  });
  await prisma.termMembership.create({
    data: { personId: person.id, termId, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" },
  });
  return person;
}

describe("loadEffectiveSteps", () => {
  it("returns all six defaults when no overrides exist", async () => {
    const t = await activeTerm();
    const map = await loadEffectiveSteps(t.id);
    expect(map.size).toBe(6);
    expect(map.get("hipaa")).toMatchObject({
      enabled: true,
      label: STEP_DEFAULTS.hipaa.label,
      blocking: true,
      order: 1,
      hasOverride: false,
    });
    expect(map.get("ehs")).toMatchObject({ blocking: false, order: 5 });
  });

  it("merges a per-term override over the default", async () => {
    const t = await activeTerm();
    await prisma.termOnboardingStep.create({
      data: { termId: t.id, kind: "hipaa", enabled: false, label: "HIPAA (custom)", order: 9 },
    });
    const map = await loadEffectiveSteps(t.id);
    expect(map.get("hipaa")).toMatchObject({ enabled: false, label: "HIPAA (custom)", order: 9, hasOverride: true });
    // description was not overridden -> falls back to the default
    expect(map.get("hipaa")!.description).toBe(STEP_DEFAULTS.hipaa.description);
  });
});

describe("setStepConfig", () => {
  it("requires admin.manage_terms", async () => {
    const t = await activeTerm();
    const outsider = await prisma.person.create({ data: { name: "Outsider" } });
    await expect(setStepConfig(outsider.id, t.id, "learning", { enabled: false })).rejects.toBeInstanceOf(StepConfigError);
    expect(await prisma.termOnboardingStep.count()).toBe(0);
  });

  it("upserts an override for a manager, leaving undefined fields unchanged", async () => {
    const t = await activeTerm();
    const mgr = await prisma.person.create({ data: { name: "Manager" } });
    await grant(mgr.id, "admin.manage_terms");

    await setStepConfig(mgr.id, t.id, "learning", { enabled: false, label: "Courses" });
    let row = await prisma.termOnboardingStep.findUniqueOrThrow({
      where: { termId_kind: { termId: t.id, kind: "learning" } },
    });
    expect(row.enabled).toBe(false);
    expect(row.label).toBe("Courses");

    await setStepConfig(mgr.id, t.id, "learning", { enabled: true });
    row = await prisma.termOnboardingStep.findUniqueOrThrow({
      where: { termId_kind: { termId: t.id, kind: "learning" } },
    });
    expect(row.enabled).toBe(true);
    expect(row.label).toBe("Courses"); // undefined label patch left the prior value
  });
});

describe("getOnboardingStatus respects step config", () => {
  it("includes HIPAA (blocking) by default, so an uncertified volunteer is not onboarded", async () => {
    const t = await activeTerm();
    const person = await volunteer("DefaultVol", t.id);
    // No cert -> HIPAA incomplete; HIPAA is blocking by default.
    const status = await getOnboardingStatus(person.id);
    expect(status.tasks.map((x) => x.key)).toContain("hipaa");
    expect(status.onboarded).toBe(false);
  });

  it("drops a disabled step for the term (uncertified volunteer becomes onboarded)", async () => {
    const t = await activeTerm();
    // Disable the HIPAA step for this term BEFORE computing status.
    await prisma.termOnboardingStep.create({
      data: { termId: t.id, kind: "hipaa", enabled: false, order: STEP_DEFAULTS.hipaa.order },
    });
    const person = await volunteer("NoHipaaVol", t.id);
    const status = await getOnboardingStatus(person.id);
    expect(status.tasks.map((x) => x.key)).not.toContain("hipaa");
    // profile complete, no cert required now, no courses/ehs/training-cycle -> onboarded
    expect(status.onboarded).toBe(true);
  });
});

describe("reviewable", () => {
  it("marks only the learning step reviewable", async () => {
    const term = await activeTerm();
    const steps = await loadEffectiveSteps(term.id);
    expect(steps.get("learning")?.reviewable).toBe(true);
    for (const kind of ["profile", "hipaa", "training", "directorTraining", "ehs"] as const) {
      expect(steps.get(kind)?.reviewable).toBeUndefined();
    }
  });

  it("keeps reviewable when a term override row exists for the step", async () => {
    const term = await activeTerm();
    const admin = await prisma.person.create({
      data: { name: "Term Admin", contactEmail: "term-admin-reviewable@x.edu", status: "ACTIVE" },
    });
    await grant(admin.id, "admin.manage_terms");
    await setStepConfig(admin.id, term.id, "learning", { label: "Assigned trainings", order: 1 });

    const steps = await loadEffectiveSteps(term.id);
    expect(steps.get("learning")?.label).toBe("Assigned trainings");
    expect(steps.get("learning")?.reviewable).toBe(true);
  });
});
