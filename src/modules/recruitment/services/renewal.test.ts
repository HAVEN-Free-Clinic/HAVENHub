import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { getRenewalContext, resolveRenewalPrefill } from "./renewal";

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

async function volunteerIn(deptCode: string, termCode: string, termStart: Date, kind: "VOLUNTEER" | "DIRECTOR" = "VOLUNTEER", status: "ACTIVE" | "REMOVED" = "ACTIVE") {
  const person = await prisma.person.create({ data: { name: "Reed Renew", netId: "rr99", phone: "203-555-0100", status: "ACTIVE" } });
  const term = await prisma.term.create({ data: { code: termCode, name: termCode, startDate: termStart, endDate: termStart } });
  const dept = await prisma.department.create({ data: { code: deptCode, name: deptCode } });
  await prisma.termMembership.create({ data: { personId: person.id, termId: term.id, departmentId: dept.id, kind, status } });
  return person;
}

it("is eligible with an active volunteer membership and returns its department", async () => {
  const person = await volunteerIn("SRHD", "FA25", new Date("2025-08-01"));
  const ctx = await getRenewalContext(person.id, "reed@yale.edu", "VOLUNTEER");
  expect(ctx.eligible).toBe(true);
  expect(ctx.currentDepartments).toEqual(["SRHD"]);
  expect(ctx.email).toBe("reed@yale.edu"); // session email, verbatim
  expect(ctx.name).toBe("Reed Renew");
  expect(ctx.netId).toBe("rr99");
  expect(ctx.phone).toBe("203-555-0100");
});

it("is not eligible without an active volunteer membership", async () => {
  const person = await prisma.person.create({ data: { name: "No Member", status: "ACTIVE" } });
  const ctx = await getRenewalContext(person.id, "no@yale.edu", "VOLUNTEER");
  expect(ctx.eligible).toBe(false);
  expect(ctx.currentDepartments).toEqual([]);
});

it("filters memberships by the requested kind and ignores REMOVED", async () => {
  // A director is eligible on a DIRECTOR cycle but not on a VOLUNTEER cycle.
  const dir = await volunteerIn("EXEC", "FA25", new Date("2025-08-01"), "DIRECTOR");
  expect((await getRenewalContext(dir.id, "d@yale.edu", "VOLUNTEER")).eligible).toBe(false);
  const dirCtx = await getRenewalContext(dir.id, "d@yale.edu", "DIRECTOR");
  expect(dirCtx.eligible).toBe(true);
  expect(dirCtx.currentDepartments).toEqual(["EXEC"]);
  await resetDb();
  const removed = await volunteerIn("SRHD", "FA25", new Date("2025-08-01"), "VOLUNTEER", "REMOVED");
  expect((await getRenewalContext(removed.id, "r@yale.edu", "VOLUNTEER")).eligible).toBe(false);
});

it("returns currentDepartments from the most-recent term only when memberships span two terms", async () => {
  const person = await prisma.person.create({ data: { name: "Multi Term", status: "ACTIVE" } });
  const termOld = await prisma.term.create({ data: { code: "FA24", name: "FA24", startDate: new Date("2024-08-01"), endDate: new Date("2024-08-01") } });
  const termNew = await prisma.term.create({ data: { code: "FA25", name: "FA25", startDate: new Date("2025-08-01"), endDate: new Date("2025-08-01") } });
  const deptSrhd = await prisma.department.create({ data: { code: "SRHD", name: "SRHD" } });
  const deptExec = await prisma.department.create({ data: { code: "EXEC", name: "EXEC" } });
  await prisma.termMembership.create({ data: { personId: person.id, termId: termOld.id, departmentId: deptSrhd.id, kind: "VOLUNTEER", status: "ACTIVE" } });
  await prisma.termMembership.create({ data: { personId: person.id, termId: termNew.id, departmentId: deptExec.id, kind: "VOLUNTEER", status: "ACTIVE" } });
  const ctx = await getRenewalContext(person.id, "mt@yale.edu", "VOLUNTEER");
  expect(ctx.eligible).toBe(true);
  expect(ctx.currentDepartments).toEqual(["EXEC"]);
});

it("resolveRenewalPrefill splits name, locks email by type, maps phone/netid, skips off-convention keys", async () => {
  const ctx = { personId: "p1", name: "Mary Jane Watson", email: "mjw@yale.edu", netId: "mjw1", phone: "555", currentDepartments: ["SRHD"], eligible: true };
  const { values, lockedKeys } = resolveRenewalPrefill(
    [{ key: "first_name", type: "SHORT_TEXT" }, { key: "last_name", type: "SHORT_TEXT" }, { key: "email", type: "EMAIL" }, { key: "phone", type: "PHONE" }, { key: "netid", type: "SHORT_TEXT" }, { key: "favorite_color", type: "SHORT_TEXT" }],
    ctx,
  );
  expect(values.first_name).toBe("Mary");
  expect(values.last_name).toBe("Jane Watson");
  expect(values.email).toBe("mjw@yale.edu");
  expect(values.phone).toBe("555");
  expect(values.netid).toBe("mjw1");
  expect(values.favorite_color).toBeUndefined();
  expect(lockedKeys).toEqual(["email"]);
});
