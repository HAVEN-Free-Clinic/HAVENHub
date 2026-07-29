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

async function pendingCert(personId: string) {
  await prisma.hipaaCertificate.create({
    data: {
      personId,
      fileName: "c.pdf",
      storedName: `c-${personId}.pdf`,
      size: 100,
      mimeType: "application/pdf",
      completionDate: new Date(), // self-asserted date, not yet verified
      verifiedAt: null,
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
  const { vol, live, next } = await seed();
  const mine = await getMyOnboarding(vol.id);
  expect(mine.map((m) => m.term.name)).toEqual(["Summer", "Fall"]);
  // Each term carries its own training requirement (both have a designated cycle).
  expect(mine.every((m) => m.status.tasks.some((t) => t.key === "training"))).toBe(true);
  // Each entry carries its OWN term endDate, so the dashboard can compute HIPAA /
  // compliance copy per term rather than reusing the live term's (#87).
  expect(mine[0].term.endDate.getTime()).toBe(live.endDate.getTime());
  expect(mine[1].term.endDate.getTime()).toBe(next.endDate.getTime());
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

it("shows learning and EHS tasks on the next-term entry too, matching the builder banner", async () => {
  const { vol } = await seed();
  const mine = await getMyOnboarding(vol.id);
  const [liveEntry, nextEntry] = mine;
  expect(liveEntry.term.name).toBe("Summer");
  expect(nextEntry.term.name).toBe("Fall");

  // learning + ehs are now computed per term, so both entries carry them. The
  // next-term entry used to omit them, so a member with incomplete next-term
  // learning saw "cleared" while the schedule builder (which always counted them)
  // flagged the same person on the same next term.
  for (const entry of [liveEntry, nextEntry]) {
    expect(entry.status.tasks.some((t) => t.key === "learning")).toBe(true);
    expect(entry.status.tasks.some((t) => t.key === "ehs")).toBe(true);
  }
});

it("counts an assigned-but-unstarted course as outstanding on the next-term checklist", async () => {
  const { vol, next } = await seed();
  const dept = await prisma.department.findUniqueOrThrow({ where: { code: "SRHD" } });
  // A course assigned to the member's department. With no CourseProgress it is
  // NOT_STARTED, so the next-term learning task must read not-onboarded, exactly
  // what the builder's clearance banner would show for this member on this term.
  await prisma.course.create({
    data: {
      title: "HIPAA basics", scormEntryHref: "index.html", scormVersion: "1.2",
      scormScos: [{ id: "A", title: "a", href: "index.html" }],
      departments: { create: [{ departmentId: dept.id }] },
    },
  });

  const mine = await getMyOnboarding(vol.id);
  const nextEntry = mine.find((m) => m.term.id === next.id)!;
  const learning = nextEntry.status.tasks.find((t) => t.key === "learning");
  expect(learning).toBeDefined();
  expect(learning!.state).not.toBe("complete");
});

it("tells a member with a pending certificate that we have it, not to upload it", async () => {
  const { vol } = await seed();
  await pendingCert(vol.id);

  const status = await getOnboardingStatus(vol.id);
  const hipaa = status.tasks.find((t) => t.key === "hipaa");
  expect(hipaa?.state).toBe("IN_PROGRESS");
  expect(hipaa?.description).toBe("We have your certificate. A compliance manager is confirming the date.");
  expect(hipaa?.ctaLabel).toBe("View certificate");
  // The gate is unchanged: still not onboarded (live-term training is still outstanding).
  expect(status.onboarded).toBe(false);
});

it("the pending-verification copy wins over a term's own override of the HIPAA description", async () => {
  const { vol, live } = await seed();
  await pendingCert(vol.id);
  // An admin override describes what the step IS ("upload your certificate...").
  // It must not survive into the IN_PROGRESS state, or the checklist reproduces
  // the exact bug being fixed: asking for a re-upload of a cert already on file.
  await prisma.termOnboardingStep.create({
    data: {
      termId: live.id,
      kind: "hipaa",
      description: "Upload your current HIPAA certificate so we can verify it.",
      order: 1,
    },
  });

  const status = await getOnboardingStatus(vol.id);
  const hipaa = status.tasks.find((t) => t.key === "hipaa");
  expect(hipaa?.state).toBe("IN_PROGRESS");
  expect(hipaa?.description).toBe("We have your certificate. A compliance manager is confirming the date.");
  expect(hipaa?.ctaLabel).toBe("View certificate");
  expect(status.onboarded).toBe(false);
});
