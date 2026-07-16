import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";

vi.mock("@/platform/posthog/capture", () => ({ captureEvent: vi.fn() }));
vi.mock("@/platform/posthog/groups", () => ({
  activeTermGroup: vi.fn(async () => ({ term: "term-1" })),
}));

import { captureEvent } from "@/platform/posthog/capture";
import { markEhsComplete } from "./completion";
import { createTraining } from "./trainings";

const events = () =>
  vi.mocked(captureEvent).mock.calls.map((c) => (c[0] as { event: string }).event);

beforeEach(async () => {
  vi.clearAllMocks();
  await resetDb();
});
afterEach(resetDb);

describe("markEhsComplete PostHog event", () => {
  it("fires ehs_training_completed on the first completion but not on a repeat", async () => {
    const actor = await prisma.person.create({ data: { name: "Actor", status: "ACTIVE" } });
    const person = await prisma.person.create({ data: { name: "Vol", status: "ACTIVE" } });
    const training = await createTraining({ name: "Bloodborne" }, actor.id);

    await markEhsComplete(person.id, training.id, actor.id, new Date("2026-03-01"));
    expect(events()).toEqual(["ehs_training_completed"]);

    vi.clearAllMocks();
    // A later date correction is not a new completion.
    await markEhsComplete(person.id, training.id, actor.id, new Date("2026-03-02"));
    expect(events()).toEqual([]);
  });
});
