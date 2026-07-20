import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { setTrainingCycle } from "@/modules/recruitment/services/training";
import { getOnboardingStatus, getMyOnboarding } from "./onboarding";

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

async function seedTermWithTraining(code: string, name: string, status: "ACTIVE" | "PLANNING", srrId: string) {
  const term = await prisma.term.create({ data: { code, name, startDate: new Date(code === "FA26" ? "2026-09-01" : "2026-05-30"), endDate: new Date(code === "FA26" ? "2027-01-01" : "2026-09-26"), status } });
  const cycle = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: `${code} vol`, publicSlug: `${code}-vol`, departments: ["SRHD"], createdById: srrId, status: "OPEN" } });
  await setTrainingCycle(cycle.id, true, srrId);
  return term;
}

async function validCert(personId: string) {
  await prisma.hipaaCertificate.create({
    data: {
      personId,
      fileName: "c.pdf",
      storedName: `c-${personId}.pdf`,
      size: 100,
      mimeType: "application/pdf",
      completionDate: new Date(), // valid well past any term end + 30d
      verifiedAt: new Date(),
      uploadedAt: new Date(),
    },
  });
}

async function seed() {
  const dept = await prisma.department.create({ data: { code: "SRHD", name: "SRHD" } });
  const srr = await prisma.person.create({ data: { name: "SRR", status: "ACTIVE" } });
  const role = await prisma.role.create({ data: { name: "Rec", grants: { create: [{ permission: "recruitment.manage_cycles" }] } } });
  await prisma.roleAssignment.create({ data: { personId: srr.id, roleId: role.id } });
  const live = await seedTermWithTraining("SU26", "Summer", "ACTIVE", srr.id);
  const next = await seedTermWithTraining("FA26", "Fall", "PLANNING", srr.id);
  const vol = await prisma.person.create({ data: { name: "Vol", status: "ACTIVE" } });
  await prisma.termMembership.create({ data: { personId: vol.id, termId: live.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" } });
  await prisma.termMembership.create({ data: { personId: vol.id, termId: next.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" } });
  return { vol, live, next };
}

it("getOnboardingStatus (the gate) reflects only the live term", async () => {
  const { vol } = await seed();
  const status = await getOnboardingStatus(vol.id);
  expect(status.hasActiveTerm).toBe(true);
  // The gate's training task exists for the live term only; it does not fold in the next term.
  expect(status.tasks.some((t) => t.key === "training")).toBe(true);
});

it("getMyOnboarding returns one entry per term the member belongs to, live first", async () => {
  const { vol } = await seed();
  const mine = await getMyOnboarding(vol.id);
  expect(mine.map((m) => m.term.name)).toEqual(["Summer", "Fall"]);
  // Each term carries its own training requirement (both have a designated cycle).
  expect(mine.every((m) => m.status.tasks.some((t) => t.key === "training"))).toBe(true);
});

it("a next-term-only recruit is not gated (live gate empty) but sees next-term onboarding", async () => {
  const { next } = await seed();
  const dept = await prisma.department.findUniqueOrThrow({ where: { code: "SRHD" } });
  // Profile + HIPAA cert are person-level, not term-scoped, so they're satisfied
  // regardless of live-term membership; filling them in isolates the live gate's
  // training task (which IS term-scoped) as the only variable under test.
  const recruit = await prisma.person.create({
    data: { name: "Recruit", status: "ACTIVE", contactEmail: "recruit@x.edu", phone: "555-0100" },
  });
  await validCert(recruit.id);
  await prisma.termMembership.create({ data: { personId: recruit.id, termId: next.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" } });

  const gate = await getOnboardingStatus(recruit.id);
  expect(gate.onboarded).toBe(true); // no live-term membership -> no live training task -> not blocked

  const mine = await getMyOnboarding(recruit.id);
  expect(mine.map((m) => m.term.name)).toEqual(["Fall"]);
  expect(mine[0].status.onboarded).toBe(false); // their Fall training is still outstanding
});
