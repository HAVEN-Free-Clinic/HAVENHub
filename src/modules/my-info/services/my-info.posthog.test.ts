import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";

vi.mock("@/platform/posthog/capture", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/platform/posthog/capture")>();
  return { ...actual, captureEvent: vi.fn() };
});
vi.mock("@/platform/posthog/groups", () => ({
  activeTermGroup: vi.fn(async (extra?: Record<string, string>) => ({ term: "term-1", ...extra })),
}));

import { captureEvent } from "@/platform/posthog/capture";
import { withdrawFromTerm } from "./my-info";

type Captured = Parameters<typeof captureEvent>[0];
const calls = () => vi.mocked(captureEvent).mock.calls.map((c) => c[0] as Captured);
const events = () => calls().map((c) => c.event);

async function createPerson(name = "Test Person") {
  return prisma.person.create({ data: { name, status: "ACTIVE" } });
}

async function createTerm(status: "PLANNING" | "ACTIVE" = "ACTIVE") {
  return prisma.term.create({
    data: {
      code: "SU26",
      name: "Summer 2026",
      startDate: new Date("2026-05-01"),
      endDate: new Date("2026-08-31"),
      status,
    },
  });
}

async function createDepartment(code: string) {
  return prisma.department.upsert({
    where: { code },
    update: {},
    create: { code, name: `${code} Department` },
  });
}

async function createMembership(
  personId: string,
  termId: string,
  departmentId: string,
  kind: "VOLUNTEER" | "DIRECTOR" = "VOLUNTEER",
) {
  return prisma.termMembership.create({
    data: { personId, termId, departmentId, kind, status: "ACTIVE" },
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  await resetDb();
});

describe("withdrawFromTerm PostHog event", () => {
  it("fires volunteer_self_withdrew with the department group when one department is left", async () => {
    const person = await createPerson();
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    await createMembership(person.id, term.id, dept.id);

    await withdrawFromTerm(person.id, "Graduating");

    expect(events()).toEqual(["volunteer_self_withdrew"]);
    const [event] = calls();
    expect(event.distinctId).toBe(person.id);
    expect(event.properties).toMatchObject({
      membership_count: 1,
      department_count: 1,
      departments: "ITCM",
      has_reason: true,
    });
    // Exactly one department leaving, so it is unambiguous enough to group on.
    expect(event.groups).toMatchObject({ term: "term-1", department: "ITCM" });
  });

  it("reports every department and omits the department group when several are left", async () => {
    const person = await createPerson();
    const term = await createTerm();
    const itcm = await createDepartment("ITCM");
    const exec = await createDepartment("EXEC");
    await createMembership(person.id, term.id, itcm.id);
    await createMembership(person.id, term.id, exec.id);

    await withdrawFromTerm(person.id);

    const [event] = calls();
    expect(event.properties).toMatchObject({
      membership_count: 2,
      department_count: 2,
      departments: "EXEC,ITCM",
      has_reason: false,
    });
    expect(event.groups).not.toHaveProperty("department");
  });

  it("never sends the free-text reason, only whether one was given", async () => {
    const person = await createPerson();
    const term = await createTerm();
    const dept = await createDepartment("SRR");
    await createMembership(person.id, term.id, dept.id);

    await withdrawFromTerm(person.id, "Moving away, my email is me@example.com");

    const [event] = calls();
    expect(event.properties).toMatchObject({ has_reason: true });
    expect(JSON.stringify(event)).not.toContain("me@example.com");
  });

  it("stays silent when nothing was withdrawn", async () => {
    const person = await createPerson();
    const term = await createTerm();
    const dept = await createDepartment("SRR");
    // DIRECTOR memberships are deliberately untouched, so this is a no-op click.
    await createMembership(person.id, term.id, dept.id, "DIRECTOR");

    await expect(withdrawFromTerm(person.id)).resolves.toBe(0);
    expect(events()).toEqual([]);
  });

  it("stays silent when there is no active term", async () => {
    const person = await createPerson();
    const term = await createTerm("PLANNING");
    const dept = await createDepartment("ITCM");
    await createMembership(person.id, term.id, dept.id);

    await expect(withdrawFromTerm(person.id)).resolves.toBe(0);
    expect(events()).toEqual([]);
  });
});
