import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { assertSafeToolOutput, collectSchemaKeys, FORBIDDEN_OUTPUT_PATTERN, IDENTITY_ARGUMENT_PATTERN } from "./index";
import { myEpicStatusTool } from "./epic";

/**
 * Real-DB tests, like roster.test.ts and recruitment.test.ts, unlike
 * compliance.test.ts's mocked-service style: the risk here lives in Prisma
 * queries (the "most relevant request" selection, the department-guidance
 * join, the epicId presence check), not in a service this file could mock away.
 */

function createPerson(name: string, opts?: { epicId?: string | null }) {
  return prisma.person.create({ data: { name, epicId: opts?.epicId ?? null } });
}

let deptCounter = 0;
function createDepartment(name: string, opts?: { epicGuidance?: string | null }) {
  deptCounter += 1;
  return prisma.department.create({
    data: { code: `D${deptCounter}`, name, epicGuidance: opts?.epicGuidance ?? null },
  });
}

async function activeTerm(code = "FA26") {
  return prisma.term.create({
    data: { code, name: "Fall 2026", startDate: new Date("2026-08-01"), endDate: new Date("2026-12-01"), status: "ACTIVE" },
  });
}

function addMembership(personId: string, termId: string, departmentId: string, kind: "DIRECTOR" | "VOLUNTEER" = "VOLUNTEER") {
  return prisma.termMembership.create({ data: { personId, termId, departmentId, kind, status: "ACTIVE" } });
}

type RequestStatus = "PENDING" | "SUBMITTED" | "COMPLETED" | "CANCELLED" | "REJECTED";

function createEpicRequest(
  personId: string,
  requestedById: string,
  status: RequestStatus,
  opts?: { createdAt?: Date }
) {
  return prisma.epicRequest.create({
    data: {
      personId,
      requestedById,
      kind: "NEW",
      status,
      ...(opts?.createdAt ? { createdAt: opts.createdAt } : {}),
    },
  });
}

beforeEach(resetDb);

describe("my_epic_status", () => {
  it("reports an account on file without ever printing the Epic id itself", async () => {
    const person = await createPerson("Has Account", { epicId: "EPIC-SECRET-999" });

    const text = await myEpicStatusTool.run({ personId: person.id }, {});

    expect(text).toMatch(/you have an epic account on file/i);
    expect(text).not.toContain("EPIC-SECRET-999");
    expect(FORBIDDEN_OUTPUT_PATTERN.test(text)).toBe(false);
    expect(() => assertSafeToolOutput(text)).not.toThrow();
  });

  it("tells a person with neither an account nor a request that nobody has raised one", async () => {
    const person = await createPerson("Nobody Raised");

    const text = await myEpicStatusTool.run({ personId: person.id }, {});

    expect(text).toMatch(/you do not have an epic account on file/i);
    expect(text).toMatch(/no epic access request has been raised/i);
  });

  it("reports a PENDING request as raised but not yet sent to the hospital", async () => {
    const person = await createPerson("Pending Person");
    const staff = await createPerson("ITCM Staff");
    await createEpicRequest(person.id, staff.id, "PENDING");

    const text = await myEpicStatusTool.run({ personId: person.id }, {});

    expect(text).toMatch(/has been raised but has not yet been sent to the hospital/i);
  });

  it("reports a SUBMITTED request as awaiting YNHH's action", async () => {
    const person = await createPerson("Submitted Person");
    const staff = await createPerson("ITCM Staff 2");
    await createEpicRequest(person.id, staff.id, "SUBMITTED");

    const text = await myEpicStatusTool.run({ personId: person.id }, {});

    expect(text).toMatch(/submitted to yale new haven hospital and is awaiting their action/i);
  });

  it("reports a COMPLETED request as completed", async () => {
    const person = await createPerson("Completed Person");
    const staff = await createPerson("ITCM Staff 3");
    await createEpicRequest(person.id, staff.id, "COMPLETED");

    const text = await myEpicStatusTool.run({ personId: person.id }, {});

    expect(text).toMatch(/your epic access request has been completed/i);
  });

  it("reports a REJECTED request as declined by YNHH", async () => {
    const person = await createPerson("Rejected Person");
    const staff = await createPerson("ITCM Staff 4");
    await createEpicRequest(person.id, staff.id, "REJECTED");

    const text = await myEpicStatusTool.run({ personId: person.id }, {});

    expect(text).toMatch(/yale new haven hospital declined your epic access request/i);
  });

  it("reads a CANCELLED-only request exactly like no request at all -- WE withdrew it, not YNHH", async () => {
    const person = await createPerson("Cancelled Only");
    const staff = await createPerson("ITCM Staff 5");
    await createEpicRequest(person.id, staff.id, "CANCELLED");

    const text = await myEpicStatusTool.run({ personId: person.id }, {});

    expect(text).toMatch(/no epic access request has been raised/i);
  });

  it("picks the most recently raised request as the relevant one, not the most recently created row order", async () => {
    const person = await createPerson("Multiple Requests");
    const staff = await createPerson("ITCM Staff 6");
    // An older REJECTED request superseded by a fresh PENDING one -- the
    // member should hear about the live one, not the stale rejection.
    await createEpicRequest(person.id, staff.id, "REJECTED", { createdAt: new Date("2026-01-01") });
    await createEpicRequest(person.id, staff.id, "PENDING", { createdAt: new Date("2026-06-01") });

    const text = await myEpicStatusTool.run({ personId: person.id }, {});

    expect(text).toMatch(/has not yet been sent to the hospital/i);
    expect(text).not.toMatch(/declined/i);
  });

  it("ignores a later CANCELLED row and falls back to the most recent non-cancelled one", async () => {
    const person = await createPerson("Cancelled After Submit");
    const staff = await createPerson("ITCM Staff 7");
    await createEpicRequest(person.id, staff.id, "SUBMITTED", { createdAt: new Date("2026-01-01") });
    await createEpicRequest(person.id, staff.id, "CANCELLED", { createdAt: new Date("2026-06-01") });

    const text = await myEpicStatusTool.run({ personId: person.id }, {});

    expect(text).toMatch(/awaiting their action/i);
  });

  it("includes a department's epicGuidance text when set", async () => {
    const term = await activeTerm();
    const dept = await createDepartment("Nursing Epic", { epicGuidance: "Nursing volunteers: raise a request only after your first shift." });
    const person = await createPerson("Guided Member");
    await addMembership(person.id, term.id, dept.id);

    const text = await myEpicStatusTool.run({ personId: person.id }, {});

    expect(text).toContain("Nursing volunteers: raise a request only after your first shift.");
  });

  it("omits any guidance line when the department has none set", async () => {
    const term = await activeTerm();
    const dept = await createDepartment("No Guidance Dept");
    const person = await createPerson("Unguided Member");
    await addMembership(person.id, term.id, dept.id);

    const text = await myEpicStatusTool.run({ personId: person.id }, {});

    expect(text).toBe("You do not have an Epic account on file. No Epic access request has been raised for you yet.");
  });

  it("includes guidance from both departments of a dual appointment, deduplicated", async () => {
    const term = await activeTerm();
    const deptA = await createDepartment("Dept A Epic", { epicGuidance: "Ask Dept A's director first." });
    const deptB = await createDepartment("Dept B Epic", { epicGuidance: "Ask Dept B's director first." });
    const person = await createPerson("Dual Appointment Member");
    await addMembership(person.id, term.id, deptA.id, "VOLUNTEER");
    await addMembership(person.id, term.id, deptB.id, "DIRECTOR");

    const text = await myEpicStatusTool.run({ personId: person.id }, {});

    expect(text).toContain("Ask Dept A's director first.");
    expect(text).toContain("Ask Dept B's director first.");
  });

  it("declares no identity-shaped input, and resolves identity from ctx.personId alone", () => {
    for (const key of collectSchemaKeys(myEpicStatusTool.inputSchema)) {
      expect(IDENTITY_ARGUMENT_PATTERN.test(key)).toBe(false);
    }
    expect(Object.keys(myEpicStatusTool.inputSchema.shape)).toEqual([]);
  });
});
