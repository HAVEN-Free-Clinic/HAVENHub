import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import type { CycleStatus } from "@prisma/client";

/**
 * The data migration that brings ALREADY-SEEDED cycles onto the non-Yale-affiliate
 * identity format. identitySection() only runs when a cycle is created, so without
 * this migration every cycle in production keeps demanding a Yale NetID and a
 * "Yale email" from an applicant who says they are not a Yale affiliate.
 *
 * Applied here to hand-seeded rows in the OLD shape, because that shape no longer
 * exists anywhere in the code to test against -- the template emits the new one.
 * Mirrors bootstrap-system-roles.migration.test.ts, which runs migration SQL the
 * same way and for the same reason.
 */
const MIGRATION_SQL = join(
  process.cwd(),
  "prisma/migrations/20260818140000_apply_non_yale_identity_fields/migration.sql",
);

// prisma.$executeRawUnsafe uses the extended protocol, which forbids multiple
// commands per call, so split the file into statements. Strip '--' comment lines
// FIRST (a comment can contain a ';'), then split: outside comments this migration
// uses ';' only as a statement terminator and has none in its string literals.
function statementsOf(sql: string): string[] {
  const withoutComments = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  return withoutComments
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function applyMigration() {
  for (const stmt of statementsOf(readFileSync(MIGRATION_SQL, "utf8"))) {
    await prisma.$executeRawUnsafe(stmt);
  }
}

/** The identity section exactly as cycles created before this change carry it:
 *  NetID above the affiliation that should control it, no condition, and an email
 *  labelled "Yale email". */
const LEGACY_IDENTITY_FIELDS = [
  { key: "first_name", label: "First name", type: "SHORT_TEXT" },
  { key: "last_name", label: "Last name", type: "SHORT_TEXT" },
  { key: "pronouns", label: "Pronouns", type: "SHORT_TEXT" },
  { key: "net_id", label: "Yale NetID", type: "SHORT_TEXT" },
  { key: "email", label: "Yale email", type: "EMAIL" },
  { key: "phone", label: "Phone number", type: "PHONE" },
  { key: "yale_affiliation", label: "Yale affiliation", type: "SINGLE_SELECT" },
  { key: "yale_affiliation_other", label: "If other or staff...", type: "SHORT_TEXT" },
  { key: "grad_year", label: "Graduation year", type: "SINGLE_SELECT" },
] as const;

async function seedLegacyCycle(opts: {
  status?: CycleStatus;
  emailLabel?: string;
  emailHelpText?: string | null;
  netIdVisibleWhen?: object;
} = {}) {
  const term = await prisma.term.upsert({
    where: { code: "FA26" },
    update: {},
    create: { code: "FA26", name: "Fall", startDate: new Date(), endDate: new Date(), status: "ACTIVE" },
  });
  const creator = await prisma.person.create({ data: { name: "Rec Admin", status: "ACTIVE" } });
  const cycle = await prisma.recruitmentCycle.create({
    data: {
      track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: `v-${randomUUID()}`,
      departments: ["SRHD"], createdById: creator.id, status: opts.status ?? "OPEN",
      sections: { create: { title: "Personal details", order: 0, appliesTo: "NEW" } },
    },
    include: { sections: true },
  });
  const section = cycle.sections[0];
  await prisma.formField.createMany({
    data: LEGACY_IDENTITY_FIELDS.map((f, order) => ({
      sectionId: section.id,
      cycleId: cycle.id,
      key: f.key,
      label: f.key === "email" ? opts.emailLabel ?? f.label : f.label,
      helpText: f.key === "email" ? opts.emailHelpText ?? null : null,
      type: f.type,
      required: true,
      order,
      ...(f.key === "net_id" && opts.netIdVisibleWhen ? { visibleWhen: opts.netIdVisibleWhen } : {}),
    })),
  });
  return cycle.id;
}

async function fieldsOf(cycleId: string) {
  const rows = await prisma.formField.findMany({ where: { cycleId }, orderBy: { order: "asc" } });
  return {
    order: rows.map((f) => f.key),
    byKey: new Map(rows.map((f) => [f.key, f])),
  };
}

describe("non-Yale identity migration", () => {
  beforeEach(async () => { await resetDb(); });

  it("gates the NetID, neutralises the email label, and lifts the affiliation above the NetID", async () => {
    const cycleId = await seedLegacyCycle();

    await applyMigration();

    const { order, byKey } = await fieldsOf(cycleId);
    // The affiliation pair now sits where the NetID was, and every other field
    // holds its relative position -- exactly what identitySection() emits.
    expect(order).toEqual([
      "first_name", "last_name", "pronouns",
      "yale_affiliation", "yale_affiliation_other",
      "net_id", "email", "phone", "grad_year",
    ]);
    expect(byKey.get("net_id")!.visibleWhen).toEqual({
      field: "yale_affiliation", op: "isNot", value: "non_yale",
    });
    expect(byKey.get("email")!.label).toBe("Email address");
    expect(byKey.get("email")!.helpText).toMatch(/yale/i);
    // The gate is the whole fix: `required` stays true, and it is the condition
    // that drops the field from validation for an unaffiliated applicant.
    expect(byKey.get("net_id")!.required).toBe(true);
  });

  it("is idempotent -- a second run changes nothing", async () => {
    const cycleId = await seedLegacyCycle();

    await applyMigration();
    const first = await fieldsOf(cycleId);
    await applyMigration();
    const second = await fieldsOf(cycleId);

    expect(second.order).toEqual(first.order);
    expect(second.byKey.get("net_id")!.visibleWhen).toEqual(first.byKey.get("net_id")!.visibleWhen);
    expect(second.byKey.get("email")!.label).toBe(first.byKey.get("email")!.label);
  });

  it("leaves an ARCHIVED cycle's form exactly as it was filled in", async () => {
    const cycleId = await seedLegacyCycle({ status: "ARCHIVED" });

    await applyMigration();

    const { order, byKey } = await fieldsOf(cycleId);
    expect(order).toEqual(LEGACY_IDENTITY_FIELDS.map((f) => f.key));
    expect(byKey.get("net_id")!.visibleWhen).toBeNull();
    expect(byKey.get("email")!.label).toBe("Yale email");
  });

  it("does not clobber an admin's own label, help text, or NetID condition", async () => {
    const ownCondition = { field: "grad_year", op: "is", value: "2027" };
    const cycleId = await seedLegacyCycle({
      emailLabel: "Your @yale.edu address",
      emailHelpText: "We only email you about your application.",
      netIdVisibleWhen: ownCondition,
    });

    await applyMigration();

    const { byKey } = await fieldsOf(cycleId);
    expect(byKey.get("email")!.label).toBe("Your @yale.edu address");
    expect(byKey.get("email")!.helpText).toBe("We only email you about your application.");
    expect(byKey.get("net_id")!.visibleWhen).toEqual(ownCondition);
  });

  it("skips a cycle with no affiliation question rather than pointing the gate at nothing", async () => {
    const cycleId = await seedLegacyCycle();
    await prisma.formField.deleteMany({ where: { cycleId, key: { startsWith: "yale_affiliation" } } });

    await applyMigration();

    const { byKey } = await fieldsOf(cycleId);
    expect(byKey.get("net_id")!.visibleWhen).toBeNull();
    // The email relabel is independent of the affiliation question, so it still lands.
    expect(byKey.get("email")!.label).toBe("Email address");
  });
});
