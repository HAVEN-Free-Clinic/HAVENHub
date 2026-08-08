/**
 * Tests for the offboarding CSV export.
 *
 * One row per person, never one per membership: the consumer is deduplicating a
 * Teams removal list. Email is netId@yale.edu when a netId exists, else the
 * contact address, else blank with the row still present.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { buildOffboardingCsv } from "./offboarding-export";

const NOW = new Date("2026-08-07T12:00:00Z");

async function createTerm(status: "ACTIVE" | "PLANNING" = "ACTIVE", code = "FA25") {
  return prisma.term.create({
    data: {
      code,
      name: `Term ${code}`,
      startDate: new Date("2025-08-01"),
      endDate: new Date("2025-12-20"),
      status,
    },
  });
}

async function createDepartment(code: string) {
  return prisma.department.upsert({
    where: { code },
    update: {},
    create: { code, name: `${code} Dept` },
  });
}

beforeEach(resetDb);

describe("buildOffboardingCsv", () => {
  it("exports the selection with a Yale address derived from the NetID", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const person = await prisma.person.create({
      data: { name: "Jane Doe", netId: "jd123", contactEmail: "jane@example.com" },
    });
    await prisma.termMembership.create({
      data: { personId: person.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" },
    });

    const result = await buildOffboardingCsv(
      { scope: "selection", personIds: [person.id] },
      NOW
    );

    expect(result.rowCount).toBe(1);
    expect(result.filename).toBe("haven-offboarding-FA25-2026-08-07.csv");
    const lines = result.csv.split("\r\n");
    expect(lines[0]).toBe("Name,Email,NetID,Contact email,Departments,Role");
    expect(lines[1]).toBe("Jane Doe,jd123@yale.edu,jd123,jane@example.com,ITCM,VOLUNTEER");
  });

  it("falls back to the contact address when there is no NetID, and exports a blank email when there is neither", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const withContact = await prisma.person.create({
      data: { name: "No NetId", contactEmail: "only@example.com" },
    });
    const withNeither = await prisma.person.create({ data: { name: "No Contact" } });
    for (const p of [withContact, withNeither]) {
      await prisma.termMembership.create({
        data: { personId: p.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" },
      });
    }

    const result = await buildOffboardingCsv(
      { scope: "selection", personIds: [withContact.id, withNeither.id] },
      NOW
    );

    expect(result.rowCount).toBe(2);
    expect(result.csv).toContain("No NetId,only@example.com,,only@example.com,ITCM,VOLUNTEER");
    expect(result.csv).toContain("No Contact,,,,ITCM,VOLUNTEER");
  });

  it("emits one row per person with departments joined and DIRECTOR winning the role", async () => {
    const term = await createTerm();
    const itcm = await createDepartment("ITCM");
    const srr = await createDepartment("SRR");
    const person = await prisma.person.create({ data: { name: "Two Hats", netId: "th01" } });
    await prisma.termMembership.create({
      data: { personId: person.id, termId: term.id, departmentId: itcm.id, kind: "VOLUNTEER", status: "ACTIVE" },
    });
    await prisma.termMembership.create({
      data: { personId: person.id, termId: term.id, departmentId: srr.id, kind: "DIRECTOR", status: "ACTIVE" },
    });

    const result = await buildOffboardingCsv(
      { scope: "selection", personIds: [person.id] },
      NOW
    );

    expect(result.rowCount).toBe(1);
    // toCsv (Task 1, src/platform/csv.ts) quotes a field only when it contains a
    // comma, double quote, CR, or LF (see its own test suite). A semicolon-joined
    // department list has none of those, so it is emitted unquoted.
    expect(result.csv).toContain("Two Hats,th01@yale.edu,th01,,ITCM;SRR,DIRECTOR");
  });

  it("exports offboarded people who held a place in the active term for the offboarded-term scope", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const gone = await prisma.person.create({
      data: { name: "Gone", netId: "gon01", status: "OFFBOARDED" },
    });
    const stillHere = await prisma.person.create({ data: { name: "Here", netId: "her01" } });
    await prisma.termMembership.create({
      data: { personId: gone.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER", status: "REMOVED" },
    });
    await prisma.termMembership.create({
      data: { personId: stillHere.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" },
    });

    const result = await buildOffboardingCsv({ scope: "offboarded-term" }, NOW);

    expect(result.rowCount).toBe(1);
    expect(result.csv).toContain("Gone,gon01@yale.edu");
    expect(result.csv).not.toContain("Here");
  });

  it("returns a headers-only file and a no-term filename when there is no active term", async () => {
    const result = await buildOffboardingCsv({ scope: "offboarded-term" }, NOW);

    expect(result.rowCount).toBe(0);
    expect(result.filename).toBe("haven-offboarding-no-term-2026-08-07.csv");
    expect(result.csv).toBe("Name,Email,NetID,Contact email,Departments,Role");
  });

  // No term is created in this test at all: this exercises the "selection with
  // no active term" branch, which has no membership relation to query (there is
  // no term to scope it to) and so builds its rows from bare person fields with
  // memberships defaulted to an empty array in code.
  it("exports a selection with blank departments and a VOLUNTEER role when there is no active term", async () => {
    const withNetId = await prisma.person.create({ data: { name: "No Term A", netId: "nta01" } });
    const withContact = await prisma.person.create({
      data: { name: "No Term B", contactEmail: "b@example.com" },
    });

    const result = await buildOffboardingCsv(
      { scope: "selection", personIds: [withNetId.id, withContact.id] },
      NOW
    );

    expect(result.rowCount).toBe(2);
    expect(result.filename).toBe("haven-offboarding-no-term-2026-08-07.csv");
    expect(result.csv).toContain("No Term A,nta01@yale.edu,nta01,,,VOLUNTEER");
    expect(result.csv).toContain("No Term B,b@example.com,,b@example.com,,VOLUNTEER");
  });
});
