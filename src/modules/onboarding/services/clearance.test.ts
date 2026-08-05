import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { loadClearanceMap } from "./clearance";
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

async function memberWithProfile(name: string, deptId: string, termId: string) {
  const person = await prisma.person.create({
    data: { name, status: "ACTIVE", contactEmail: `${name}@x.edu`, phone: "555-0100" },
  });
  await prisma.termMembership.create({
    data: { personId: person.id, termId, departmentId: deptId, kind: "VOLUNTEER", status: "ACTIVE" },
  });
  return person;
}

async function validCert(personId: string) {
  await prisma.hipaaCertificate.create({
    data: {
      personId,
      fileName: "c.pdf",
      storedName: `c-${personId}.pdf`,
      size: 100,
      mimeType: "application/pdf",
      completionDate: new Date(), // valid ~365d, well past term end + 30d
      verifiedAt: new Date(),
      uploadedAt: new Date(),
    },
  });
}

describe("loadClearanceMap", () => {
  it("marks a person with profile + valid HIPAA and no other requirements as cleared", async () => {
    const term = await activeTerm();
    const dept = await prisma.department.create({ data: { code: "PCAR", name: "Primary Care" } });
    const person = await memberWithProfile("Ada", dept.id, term.id);
    await validCert(person.id);

    const map = await loadClearanceMap([person.id], term.id);
    const summary = map.get(person.id)!;
    expect(summary.cleared).toBe(true);
    expect(summary.onboarded).toBe(true);
    expect(summary.missing).toEqual([]);
  });

  it("flags a missing profile (no phone) as not cleared, with profile in missing", async () => {
    const term = await activeTerm();
    const dept = await prisma.department.create({ data: { code: "PCAR", name: "Primary Care" } });
    const person = await prisma.person.create({
      data: { name: "Noe", status: "ACTIVE", contactEmail: "noe@x.edu" }, // no phone
    });
    await prisma.termMembership.create({
      data: { personId: person.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" },
    });
    await validCert(person.id);

    const map = await loadClearanceMap([person.id], term.id);
    const summary = map.get(person.id)!;
    expect(summary.cleared).toBe(false);
    expect(summary.missing).toContain("profile");
  });

  it("flags a required-but-incomplete EHS training in missing (and not cleared)", async () => {
    const term = await activeTerm();
    const dept = await prisma.department.create({ data: { code: "PCAR", name: "Primary Care" } });
    const person = await memberWithProfile("Ivy", dept.id, term.id);
    await validCert(person.id);
    // A required-for-all active EHS training the person has not completed.
    await prisma.ehsTraining.create({ data: { name: "BBP", requiredForAll: true, isActive: true } });

    const map = await loadClearanceMap([person.id], term.id);
    const summary = map.get(person.id)!;
    expect(summary.missing).toContain("ehs");
    expect(summary.cleared).toBe(false);
    // EHS is non-blocking, so the app-gate flag stays true even though not fully cleared.
    expect(summary.onboarded).toBe(true);
  });

  it("agrees with getOnboardingStatus on cleared/onboarded", async () => {
    const term = await activeTerm();
    const dept = await prisma.department.create({ data: { code: "PCAR", name: "Primary Care" } });
    const person = await memberWithProfile("Rio", dept.id, term.id);
    await validCert(person.id);

    const [batch, single] = await Promise.all([
      loadClearanceMap([person.id], term.id),
      getOnboardingStatus(person.id),
    ]);
    const summary = batch.get(person.id)!;
    expect(summary.cleared).toBe(single.cleared);
    expect(summary.onboarded).toBe(single.onboarded);
  });

  it("honors a per-term disabled step so batch clearance still agrees with getOnboardingStatus", async () => {
    const term = await activeTerm();
    const dept = await prisma.department.create({ data: { code: "PCAR", name: "Primary Care" } });
    const person = await memberWithProfile("Ned", dept.id, term.id);
    // No HIPAA cert -> the (blocking) hipaa step would keep them un-cleared. Disable
    // the step for this term; getOnboardingStatus drops it, and the batch path must too.
    await prisma.termOnboardingStep.create({ data: { termId: term.id, kind: "hipaa", enabled: false, order: 1 } });

    const [batch, single] = await Promise.all([
      loadClearanceMap([person.id], term.id),
      getOnboardingStatus(person.id),
    ]);
    const summary = batch.get(person.id)!;
    expect(summary.tasks.map((t) => t.key)).not.toContain("hipaa");
    expect(summary.cleared).toBe(true);
    expect(summary.cleared).toBe(single.cleared);
    expect(summary.onboarded).toBe(single.onboarded);
  });

  it("agrees with getOnboardingStatus on the learning task for a ONCE and a PER_TERM course completed in a prior term", async () => {
    // This is the cross-check the whole per-term-recurrence change exists for:
    // loadClearanceMap feeds the schedule builder's clearance banner, and
    // getOnboardingStatus feeds the member's own checklist. If one becomes
    // term-aware and the other does not, a volunteer ends up cleared on one
    // screen and blocked on the other, which is exactly the contradiction this
    // change is supposed to remove. So this asserts the two against each other
    // for the SAME person and term, not two independent tests that happen to
    // agree today.
    const termA = await prisma.term.create({
      data: { code: "SU25", name: "Prior", startDate: new Date("2025-01-01"), endDate: new Date("2025-06-30"), status: "ARCHIVED" },
    });
    const term = await activeTerm();
    const dept = await prisma.department.create({ data: { code: "PCAR", name: "Primary Care" } });
    const person = await memberWithProfile("Lee", dept.id, term.id);
    await validCert(person.id);

    const onceCourse = await prisma.course.create({
      data: { title: "Intro", recurrence: "ONCE", assignToAll: true, scormEntryHref: "index.html", position: 0 },
    });
    const perTermCourse = await prisma.course.create({
      data: { title: "Annual Safety", recurrence: "PER_TERM", assignToAll: true, scormEntryHref: "index.html", position: 1 },
    });

    // Both courses were completed in a PRIOR term, not this one.
    for (const course of [onceCourse, perTermCourse]) {
      await prisma.courseProgress.create({
        data: {
          personId: person.id,
          courseId: course.id,
          termId: termA.id,
          status: "COMPLETE",
          lessonStatus: "completed",
          completedAt: new Date("2025-03-01"),
        },
      });
    }

    const [batch, single] = await Promise.all([
      loadClearanceMap([person.id], term.id),
      getOnboardingStatus(person.id),
    ]);

    const batchSummary = batch.get(person.id)!;
    const batchLearning = batchSummary.tasks.find((t) => t.key === "learning")!;
    const singleLearning = single.tasks.find((t) => t.key === "learning")!;

    // The two readers must land on the identical answer for this term...
    expect(batchLearning.state).toBe(singleLearning.state);
    expect(batchSummary.cleared).toBe(single.cleared);
    expect(batchSummary.onboarded).toBe(single.onboarded);

    // ...and that shared answer must actually be correct: the ONCE completion still
    // counts (the regression bar for the whole branch, since ONCE is every existing
    // course's default), while the PER_TERM completion from a prior term does not,
    // so with one of two assigned courses counted the combined learning task can
    // only be IN_PROGRESS, never COMPLETE, and never un-cleared to INCOMPLETE either.
    expect(singleLearning.state).toBe("IN_PROGRESS");
  });

  it("honors the `now` argument for HIPAA cert expiry", async () => {
    const term = await activeTerm();
    const dept = await prisma.department.create({ data: { code: "PCAR", name: "Primary Care" } });
    const person = await memberWithProfile("Tex", dept.id, term.id);
    // Completed 2026-01-01 -> valid through ~2027-01-01, verified.
    await prisma.hipaaCertificate.create({
      data: {
        personId: person.id,
        fileName: "c.pdf",
        storedName: `c2-${person.id}.pdf`,
        size: 100,
        mimeType: "application/pdf",
        completionDate: new Date("2026-01-01T12:00:00Z"),
        verifiedAt: new Date("2026-01-02T12:00:00Z"),
        uploadedAt: new Date("2026-01-01T12:00:00Z"),
      },
    });

    const near = await loadClearanceMap([person.id], term.id, new Date("2026-06-01T12:00:00Z"));
    expect(near.get(person.id)!.cleared).toBe(true);

    const far = await loadClearanceMap([person.id], term.id, new Date("2027-06-01T12:00:00Z"));
    const farSummary = far.get(person.id)!;
    expect(farSummary.cleared).toBe(false);
    expect(farSummary.missing).toContain("hipaa");
  });
});
