import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";

// Assert the authoritative server-side learning events fire on the right
// transitions and never double-fire. Capture + group resolution are mocked so
// the test asserts the decision logic, not delivery. Factories are inline
// (no outer refs) to satisfy vi.mock hoisting; spies come back via vi.mocked.
vi.mock("@/platform/posthog/capture", () => ({
  captureEvent: vi.fn(),
  flushEvents: vi.fn(),
}));
vi.mock("@/platform/posthog/groups", () => ({
  activeTermGroup: vi.fn(async () => ({ term: "term-1" })),
}));

import { captureEvent } from "@/platform/posthog/capture";
import { persistScoCmi } from "./enrollment";

/** A learner assigned to one active, single-SCO course with a package. */
async function seed() {
  const dept = await prisma.department.create({ data: { code: "SRHD", name: "SRHD" } });
  const learner = await prisma.person.create({ data: { name: "Lee", status: "ACTIVE" } });
  const term = await prisma.term.create({
    data: { code: "SU26", name: "T1", status: "ACTIVE", startDate: new Date("2026-01-01"), endDate: new Date("2026-12-31") },
  });
  await prisma.termMembership.create({
    data: { personId: learner.id, termId: term.id, departmentId: dept.id, status: "ACTIVE", kind: "VOLUNTEER" },
  });
  const course = await prisma.course.create({
    data: {
      title: "Intro",
      scormEntryHref: "index.html",
      scormVersion: "1.2",
      scormScos: [{ id: "ITEM-A", title: "a", href: "index.html" }],
      departments: { create: [{ departmentId: dept.id }] },
    },
  });
  return { learner, course };
}

const cmi = (lessonStatus: string) => ({
  lessonStatus,
  scoreRaw: null,
  suspendData: null,
  lessonLocation: null,
});

const eventsFired = () =>
  vi.mocked(captureEvent).mock.calls.map((c) => (c[0] as { event: string }).event);

beforeEach(async () => {
  vi.clearAllMocks();
  await resetDb();
});
afterEach(async () => {
  await resetDb();
});

describe("persistScoCmi PostHog events", () => {
  it("fires course_started on first progress, without completion", async () => {
    const { learner, course } = await seed();
    await persistScoCmi(learner.id, course.id, "ITEM-A", cmi("incomplete"));
    expect(eventsFired()).toEqual(["course_started"]);
  });

  it("fires sco_completed and course_completed once when the course is completed", async () => {
    const { learner, course } = await seed();
    await persistScoCmi(learner.id, course.id, "ITEM-A", cmi("incomplete"));
    vi.clearAllMocks();
    await persistScoCmi(learner.id, course.id, "ITEM-A", cmi("completed"));
    expect(eventsFired().sort()).toEqual(["course_completed", "sco_completed"]);
  });

  it("does not re-fire completion events on a subsequent commit", async () => {
    const { learner, course } = await seed();
    await persistScoCmi(learner.id, course.id, "ITEM-A", cmi("completed"));
    vi.clearAllMocks();
    await persistScoCmi(learner.id, course.id, "ITEM-A", cmi("completed"));
    expect(eventsFired()).toEqual([]);
  });
});
