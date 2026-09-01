import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";

/**
 * These constraints live in raw SQL (Prisma cannot model them) and were once
 * silently dropped by a generated migration. These tests exist so that can
 * never happen again without CI noticing.
 */
describe("db-level schema guards", () => {
  beforeEach(resetDb);

  async function fixture() {
    const role = await prisma.role.create({ data: { name: "R" } });
    const person = await prisma.person.create({ data: { name: "P" } });
    return { role, person };
  }

  it("rejects duplicate role assignments including NULL termId (unique_grant)", async () => {
    const { role, person } = await fixture();
    await prisma.roleAssignment.create({ data: { roleId: role.id, personId: person.id, termId: null } });
    await expect(
      prisma.roleAssignment.create({ data: { roleId: role.id, personId: person.id, termId: null } })
    ).rejects.toThrow();
  });

  it("rejects assignments violating the person/department XOR", async () => {
    const { role } = await fixture();
    await expect(
      prisma.roleAssignment.create({ data: { roleId: role.id } }) // neither target set
    ).rejects.toThrow();
  });

  it("rejects case-variant duplicate person emails (ci-unique)", async () => {
    await prisma.person.create({ data: { name: "A", contactEmail: "x@yale.edu" } });
    await expect(
      prisma.person.create({ data: { name: "B", contactEmail: "X@YALE.EDU" } })
    ).rejects.toThrow();
  });

  // Person carries two of these case-insensitive indexes and only contactEmail
  // was guarded above (audit 14, DM-4). netId is the one that matters more:
  // sign-in matches on lower(netId), so two rows differing only in case would
  // make which account you land in depend on row order. schema.prisma declares
  // a plain @unique on both, so a `migrate diff` that regenerates them drops the
  // LOWER() expression with no visible change to the schema file at all --
  // nothing but these tests would notice.
  it("rejects case-variant duplicate NetIDs (ci-unique)", async () => {
    await prisma.person.create({ data: { name: "A", netId: "abc123" } });
    await expect(
      prisma.person.create({ data: { name: "B", netId: "ABC123" } })
    ).rejects.toThrow();
  });

  it("rejects assignments with two targets set (3-way XOR)", async () => {
    const { role, person } = await fixture();
    const dept = await prisma.department.create({ data: { code: "XOR", name: "X" } });
    await expect(
      prisma.roleAssignment.create({
        data: { roleId: role.id, personId: person.id, departmentId: dept.id },
      })
    ).rejects.toThrow();
  });

  it("rejects assignments with a kind and a person target both set (3-way XOR)", async () => {
    const { role, person } = await fixture();
    await expect(
      prisma.roleAssignment.create({
        data: { roleId: role.id, personId: person.id, kind: "VOLUNTEER" },
      })
    ).rejects.toThrow();
  });

  it("rejects duplicate kind-target assignments (unique_grant spans kind)", async () => {
    const { role } = await fixture();
    await prisma.roleAssignment.create({ data: { roleId: role.id, kind: "VOLUNTEER", termId: null } });
    await expect(
      prisma.roleAssignment.create({ data: { roleId: role.id, kind: "VOLUNTEER", termId: null } })
    ).rejects.toThrow();
  });

  // The newest raw-SQL CHECK in the schema (20260813211610_incident_forward_trail)
  // and, until audit 14 (DM-4), the only one with no test. It is the record that a
  // report or a strike was disclosed outside the clinic: a row attached to
  // neither shows on no trail at all (a disclosure with no record), and a row
  // attached to both is counted twice. Prisma models the two FKs as independently
  // optional, so only the constraint keeps this true.
  it("rejects an incident forward attached to neither a report nor a strike", async () => {
    const { person } = await fixture();
    await expect(
      prisma.incidentForward.create({
        data: { toEmail: "dean@example.edu", forwardedById: person.id },
      })
    ).rejects.toThrow();
  });

  it("rejects an incident forward attached to both a report and a strike", async () => {
    const { person } = await fixture();
    const report = await prisma.incidentReport.create({
      data: { reporterId: person.id, description: "d" },
    });
    const action = await prisma.disciplinaryAction.create({
      data: {
        personId: person.id,
        issuedById: person.id,
        occurredAt: new Date("2026-07-01T12:00:00Z"),
        category: "Professionalism",
        description: "d",
      },
    });
    await expect(
      prisma.incidentForward.create({
        data: {
          reportId: report.id,
          actionId: action.id,
          toEmail: "dean@example.edu",
          forwardedById: person.id,
        },
      })
    ).rejects.toThrow();
  });
});

/**
 * The two facts that made `prisma migrate dev` emit drift into every unrelated
 * migration for months.
 *
 * When schema.prisma and a database built by replaying the migration history
 * disagree, migrate dev tries to reconcile the difference inside whatever
 * migration you happened to be generating. At least seven migrations carry a
 * comment about trimming these exact statements back out by hand, and one that
 * was not trimmed would have shipped a constraint rename that aborts
 * `migrate deploy` on a database where it had already been applied.
 *
 * Asserted against the live catalog rather than by shelling out to
 * `prisma migrate diff`, which needs a spare shadow database and the CLI. These
 * two queries cost nothing and cover both halves of the drift that actually
 * happened. If a third kind ever appears, the general check is
 * `prisma migrate diff --from-migrations prisma/migrations
 * --to-schema-datamodel prisma/schema.prisma --shadow-database-url <spare>`,
 * which must print "No difference detected."
 */
describe("schema and migration history agree", () => {
  it("names the Training constraints after the table they are on", async () => {
    // The table was renamed from VolunteerTraining in
    // 20260624000000_generalize_training_to_track, which renamed its indexes but
    // not its constraints; Postgres does not do that automatically.
    const rows = await prisma.$queryRaw<Array<{ conname: string }>>`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'public."Training"'::regclass
      ORDER BY conname
    `;
    const names = rows.map((r) => r.conname);
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((n) => n.startsWith("VolunteerTraining_"))).toEqual([]);
    expect(names).toContain("Training_pkey");
  });

  it("keeps the Application.subcommitteeRanking default the schema now declares", async () => {
    // The column has carried DEFAULT ARRAY[]::TEXT[] since it was added, but the
    // schema did not declare it, so every diff wanted to drop it. The schema
    // declares @default([]) now; this pins the DB side of that agreement.
    const rows = await prisma.$queryRaw<Array<{ column_default: string | null }>>`
      SELECT column_default FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'Application'
        AND column_name = 'subcommitteeRanking'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].column_default).toContain("ARRAY[]");
  });
});
