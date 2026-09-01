/**
 * Tests for the people-directory CSV export.
 *
 * One row per PERSON, never one per seat: this file is a mailing list, and the
 * same address twice because its owner sits in two departments is the defect
 * the row builder exists to prevent. Also pins the formula-injection guard,
 * which is the one thing here that is a security property rather than a
 * formatting preference.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { buildDirectoryCsv } from "./directory-export";

const NOW = new Date("2026-09-01T12:00:00Z");

async function createTerm() {
  return prisma.term.create({
    data: {
      code: "FA26",
      name: "Term FA26",
      startDate: new Date("2026-08-01"),
      endDate: new Date("2026-12-20"),
      status: "ACTIVE",
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

/** Splits the CSV into lines. toCsv joins with CRLF per RFC 4180. */
function lines(csv: string): string[] {
  return csv.split("\r\n");
}

beforeEach(resetDb);

describe("buildDirectoryCsv, people scope", () => {
  it("writes one row per person with their departments collapsed", async () => {
    const term = await createTerm();
    const nurs = await createDepartment("NURS");
    const tria = await createDepartment("TRIA");
    const both = await prisma.person.create({
      data: { name: "Bo Both", netId: "bb333", contactEmail: "bo@example.com", phone: "203-555-0101" },
    });
    await prisma.termMembership.create({
      data: { personId: both.id, termId: term.id, departmentId: nurs.id, kind: "DIRECTOR", status: "ACTIVE" },
    });
    await prisma.termMembership.create({
      data: { personId: both.id, termId: term.id, departmentId: tria.id, kind: "VOLUNTEER", status: "ACTIVE" },
    });

    const { csv, rowCount } = await buildDirectoryCsv(
      { scope: "people" },
      { termId: term.id, termCode: "FA26", departmentCode: null },
      NOW,
    );

    expect(rowCount).toBe(1);
    const body = lines(csv);
    expect(body[0]).toBe("Name,Email,NetID,Contact email,Phone,Departments,Role");
    // Yale address from the NetID, both departments in one cell, and DIRECTOR
    // winning the role tie-break.
    expect(body[1]).toBe(
      "Bo Both,bb333@yale.edu,bb333,bo@example.com,203-555-0101,NURS;TRIA,DIRECTOR",
    );
  });

  it("falls back to the contact address, then to blank, keeping the row", async () => {
    const term = await createTerm();
    const dept = await createDepartment("NURS");
    const noNetId = await prisma.person.create({
      data: { name: "No NetId", contactEmail: "reachme@example.com" },
    });
    const unreachable = await prisma.person.create({ data: { name: "Zed Unreachable" } });
    for (const p of [noNetId, unreachable]) {
      await prisma.termMembership.create({
        data: { personId: p.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" },
      });
    }

    const { csv, rowCount } = await buildDirectoryCsv(
      { scope: "people" },
      { termId: term.id, termCode: "FA26", departmentCode: null },
      NOW,
    );

    expect(rowCount).toBe(2);
    const body = lines(csv);
    expect(body[1]).toContain("No NetId,reachme@example.com,,reachme@example.com,");
    // A person we cannot reach stays in the file with a visible gap rather than
    // silently vanishing from a list someone is about to work.
    expect(body[2]).toBe("Zed Unreachable,,,,,NURS,VOLUNTEER");
  });

  it("exports exactly the filtered rows, not the whole clinic", async () => {
    const term = await createTerm();
    const nurs = await createDepartment("NURS");
    const tria = await createDepartment("TRIA");
    const a = await prisma.person.create({ data: { name: "In Scope" } });
    const b = await prisma.person.create({ data: { name: "Out Of Scope" } });
    await prisma.termMembership.create({
      data: { personId: a.id, termId: term.id, departmentId: nurs.id, kind: "VOLUNTEER", status: "ACTIVE" },
    });
    await prisma.termMembership.create({
      data: { personId: b.id, termId: term.id, departmentId: tria.id, kind: "VOLUNTEER", status: "ACTIVE" },
    });

    const { csv, rowCount, filename } = await buildDirectoryCsv(
      { scope: "people", departmentId: nurs.id },
      { termId: term.id, termCode: "FA26", departmentCode: "NURS" },
      NOW,
    );

    expect(rowCount).toBe(1);
    expect(csv).toContain("In Scope");
    expect(csv).not.toContain("Out Of Scope");
    // The filename says what is in the file, so three pulls in a row are
    // tellable apart in ~/Downloads.
    expect(filename).toBe("haven-directory-fa26-nurs-2026-09-01.csv");
  });

  it("names the file after the role filter too", async () => {
    const term = await createTerm();

    const { filename } = await buildDirectoryCsv(
      { scope: "people", kind: "DIRECTOR" },
      { termId: term.id, termCode: "FA26", departmentCode: null },
      NOW,
    );

    expect(filename).toBe("haven-directory-fa26-directors-2026-09-01.csv");
  });

  it("neutralizes a name that would open as a live formula in Excel", async () => {
    const term = await createTerm();
    const dept = await createDepartment("NURS");
    // Person.name is user-supplied: the apply wizard takes it from anonymous
    // applicants and /my-info lets members edit their own record.
    const attacker = await prisma.person.create({
      data: { name: "=HYPERLINK(\"http://evil.test\",\"click\")", contactEmail: "x@example.com" },
    });
    await prisma.termMembership.create({
      data: { personId: attacker.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" },
    });

    const { csv } = await buildDirectoryCsv(
      { scope: "people" },
      { termId: term.id, termCode: "FA26", departmentCode: null },
      NOW,
    );

    // Prefixed with an apostrophe, so Excel and Sheets read it as text.
    expect(csv).toContain("\"'=HYPERLINK");
    expect(csv).not.toContain("\r\n=HYPERLINK");
  });

  it("ships a header-only file when no term is active", async () => {
    const { csv, rowCount, filename } = await buildDirectoryCsv(
      { scope: "people" },
      { termId: null, termCode: null, departmentCode: null },
      NOW,
    );

    expect(rowCount).toBe(0);
    expect(lines(csv)).toEqual(["Name,Email,NetID,Contact email,Phone,Departments,Role"]);
    expect(filename).toBe("haven-directory-no-term-2026-09-01.csv");
  });
});

describe("buildDirectoryCsv, attendings scope", () => {
  it("exports active attendings and ignores the roster filters entirely", async () => {
    const specialty = await prisma.attendingSpecialty.create({
      data: { code: "RHD", name: "Reproductive Health", order: 1 },
    });
    await prisma.attending.create({
      data: {
        scheduleName: "Dr. Chen",
        fullName: "Dr. Casey Chen",
        credentials: "MD, MPH",
        specialtyId: specialty.id,
        email: "casey@example.com",
        phone: "203-555-0199",
        isActive: true,
      },
    });
    await prisma.attending.create({
      data: { scheduleName: "Dr. Gone", fullName: "Dr. Gone Away", isActive: false },
    });

    const { csv, rowCount, filename } = await buildDirectoryCsv(
      { scope: "attendings" },
      { termId: null, termCode: null, departmentCode: null },
      NOW,
    );

    expect(rowCount).toBe(1);
    const body = lines(csv);
    expect(body[0]).toBe("Name,Credentials,Specialty,Email,Phone");
    // "MD, MPH" holds a comma, so RFC 4180 quoting has to survive the round trip.
    expect(body[1]).toBe(
      'Dr. Casey Chen,"MD, MPH",Reproductive Health,casey@example.com,203-555-0199',
    );
    expect(filename).toBe("haven-attendings-2026-09-01.csv");
  });
});
