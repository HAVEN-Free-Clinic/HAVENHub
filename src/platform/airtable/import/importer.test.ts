import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { ALL_PEOPLE_FIELDS as F, SU26_ROSTER_FIELDS as R } from "../fields";
import { runImport, type AirtableReader } from "./importer";

function fakeReader(): AirtableReader {
  return {
    async listAll(_base: string, table: string) {
      if (table === "people-table") {
        return [
          { id: "recJack", fields: { [F.name]: "Jack Carney", [F.netId]: "jc999", [F.contactEmail]: "j.carney@yale.edu" } },
          { id: "recVol", fields: { [F.name]: "Vol One", [F.netId]: "vo111", [F.contactEmail]: "vol.one@yale.edu" } },
          { id: "recDup", fields: { [F.name]: "Vol Dupe", [F.netId]: "VO111", [F.contactEmail]: "dupe@yale.edu" } },
        ];
      }
      return [
        {
          id: "recITCM",
          fields: { [R.departmentName]: "ITCM", [R.directors]: ["recJack"], [R.volunteers]: ["recVol"] },
        },
      ];
    },
  };
}

const OPTS = {
  baseId: "base",
  peopleTableId: "people-table",
  rosterTableId: "roster-table",
};

describe("runImport", () => {
  beforeEach(resetDb);

  it("dry-run reports without writing", async () => {
    const report = await runImport(fakeReader(), { ...OPTS, dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.people.created).toBe(2); // recDup collides with recVol on netId
    expect(report.people.skipped).toHaveLength(1);
    expect(await prisma.person.count()).toBe(0);
  });

  it("imports people, departments, term, and memberships idempotently", async () => {
    // Pre-existing unlinked person (like the dev seed): must be linked, not duplicated.
    await prisma.person.create({
      data: { name: "Jack Carney", contactEmail: "j.carney@yale.edu" },
    });

    const first = await runImport(fakeReader(), { ...OPTS, dryRun: false });
    expect(first.people.linked).toBe(1); // jack matched by email, stamped with recJack
    expect(first.people.created).toBe(1); // vol one
    expect(first.people.skipped).toHaveLength(1); // the case-variant dupe
    expect(first.departments).toBe(1);
    expect(first.memberships).toBe(2);

    const jack = await prisma.person.findUniqueOrThrow({ where: { airtableRecordId: "recJack" } });
    expect(jack.netId).toBe("jc999");
    const term = await prisma.term.findUniqueOrThrow({ where: { code: "SU26" } });
    expect(term.status).toBe("ACTIVE");
    expect(await prisma.termMembership.count()).toBe(2);

    const second = await runImport(fakeReader(), { ...OPTS, dryRun: false });
    expect(second.people.created).toBe(0);
    expect(second.people.updated + second.people.linked).toBeGreaterThanOrEqual(0); // no throw, no dupes
    expect(await prisma.person.count()).toBe(2);
    expect(await prisma.termMembership.count()).toBe(2);
  });

  it("#89: re-running the import does not resurrect SU26 once a later term is active", async () => {
    // A people-only reader (no roster rows): exercises the term upsert + activation
    // path without creating memberships, keeping the test focused on the term
    // lifecycle that #89 is about.
    const peopleOnlyReader: AirtableReader = {
      async listAll(_base, table) {
        if (table === "people-table") {
          return [{ id: "recA", fields: { [F.name]: "A Person", [F.netId]: "ap1" } }];
        }
        return [];
      },
    };

    // Fresh cutover: the first import sets up SU26 as the active term.
    await runImport(peopleOnlyReader, { ...OPTS, dryRun: false });
    expect((await prisma.term.findUniqueOrThrow({ where: { code: "SU26" } })).status).toBe(
      "ACTIVE"
    );

    // Staff later activate FA26 through /admin/terms, whose single-active-term
    // swap archives SU26. Reproduce that resulting state directly (the importer's
    // behavior depends only on the state, not on how it was reached).
    const su26 = await prisma.term.findUniqueOrThrow({ where: { code: "SU26" } });
    await prisma.term.update({ where: { id: su26.id }, data: { status: "ARCHIVED" } });
    await prisma.term.create({
      data: {
        code: "FA26",
        name: "Fall 2026",
        startDate: new Date("2026-09-27T12:00:00Z"),
        endDate: new Date("2027-01-15T12:00:00Z"),
        status: "ACTIVE",
      },
    });

    // Re-running the importer must NOT flip SU26 back to ACTIVE: that would leave
    // two ACTIVE terms and corrupt the single-active invariant.
    await runImport(peopleOnlyReader, { ...OPTS, dryRun: false });

    const active = await prisma.term.findMany({ where: { status: "ACTIVE" } });
    expect(active).toHaveLength(1);
    expect(active[0].code).toBe("FA26");
    expect((await prisma.term.findUniqueOrThrow({ where: { code: "SU26" } })).status).toBe(
      "ARCHIVED"
    );
  });

  it("does not split one human across two airtable rows (cross-key duplicate)", async () => {
    await prisma.person.create({
      data: { name: "Real Person", netId: "rp123", contactEmail: "real.person@yale.edu" },
    });
    const reader: AirtableReader = {
      async listAll(_b: string, table: string) {
        if (table === "people-table") {
          return [
            { id: "recNet", fields: { [F.name]: "Real Person", [F.netId]: "rp123" } },
            { id: "recMail", fields: { [F.name]: "Real Person", [F.contactEmail]: "real.person@yale.edu" } },
          ];
        }
        return [];
      },
    };
    const report = await runImport(reader, { ...OPTS, dryRun: false });
    expect(report.people.skipped).toHaveLength(1);
    expect(report.people.skipped[0].reason).toMatch(/already imported this run/);
    expect(await prisma.person.count()).toBe(1);
    const person = await prisma.person.findFirstOrThrow();
    expect(person.contactEmail).toBe("real.person@yale.edu"); // not erased by the netId-only row
  });

  it("dry-run reports the same cross-key skip instead of masking it", async () => {
    await prisma.person.create({
      data: { name: "Real Person", netId: "rp123", contactEmail: "real.person@yale.edu" },
    });
    const reader: AirtableReader = {
      async listAll(_b: string, table: string) {
        if (table === "people-table") {
          return [
            { id: "recNet", fields: { [F.name]: "Real Person", [F.netId]: "rp123" } },
            { id: "recMail", fields: { [F.name]: "Real Person", [F.contactEmail]: "real.person@yale.edu" } },
          ];
        }
        return [];
      },
    };
    const report = await runImport(reader, { ...OPTS, dryRun: true });
    expect(report.people.skipped).toHaveLength(1);
    expect(await prisma.person.count()).toBe(1); // dry-run wrote nothing
  });

  it("reports unique conflicts with a readable reason", async () => {
    // Owner holds the contactEmail. Claimer is matched by netId (a different person)
    // but the import wants to move the already-taken email onto Claimer -> P2002.
    await prisma.person.create({ data: { name: "Owner", contactEmail: "shared@yale.edu" } });
    await prisma.person.create({ data: { name: "Claimer", netId: "claimer1" } });
    const reader: AirtableReader = {
      async listAll(_b: string, table: string) {
        if (table === "people-table") {
          return [
            { id: "recY", fields: { [F.name]: "Claimer", [F.netId]: "claimer1", [F.contactEmail]: "shared@yale.edu" } },
          ];
        }
        return [];
      },
    };
    const report = await runImport(reader, { ...OPTS, dryRun: false });
    expect(report.people.skipped).toHaveLength(1);
    expect(report.people.skipped[0].reason).toMatch(/unique constraint conflict/);
  });
});
