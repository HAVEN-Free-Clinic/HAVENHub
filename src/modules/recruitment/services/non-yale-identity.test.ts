import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import type { CycleStatus } from "@prisma/client";
import { backfillNonYaleIdentity, reorderedFieldOrders } from "./non-yale-identity";

/** The identity section as cycles created before the fix carry it: NetID above
 *  the affiliation that should control it, no condition, "Yale email". */
const LEGACY_FIELDS = [
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
  omitKeys?: string[];
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
  const omit = new Set(opts.omitKeys ?? []);
  await prisma.formField.createMany({
    data: LEGACY_FIELDS.filter((f) => !omit.has(f.key)).map((f, order) => ({
      sectionId: cycle.sections[0].id,
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
  return { order: rows.map((f) => f.key), byKey: new Map(rows.map((f) => [f.key, f])) };
}

describe("reorderedFieldOrders", () => {
  const at = (key: string, order: number) => ({ id: key, key, order });

  it("lifts the affiliation pair to the NetID's slot, keeping everyone else in place", () => {
    const moved = reorderedFieldOrders(LEGACY_FIELDS.map((f, i) => at(f.key, i)));
    const final = LEGACY_FIELDS
      .map((f, i) => ({ key: f.key, order: moved.get(f.key) ?? i }))
      .sort((a, b) => a.order - b.order)
      .map((f) => f.key);
    expect(final).toEqual([
      "first_name", "last_name", "pronouns",
      "yale_affiliation", "yale_affiliation_other",
      "net_id", "email", "phone", "grad_year",
    ]);
  });

  it("is a no-op when the affiliation already sits above the NetID", () => {
    expect(reorderedFieldOrders([at("yale_affiliation", 0), at("net_id", 1)]).size).toBe(0);
  });

  it("is a no-op when either field is absent", () => {
    expect(reorderedFieldOrders([at("net_id", 0), at("email", 1)]).size).toBe(0);
    expect(reorderedFieldOrders([at("yale_affiliation", 1), at("email", 0)]).size).toBe(0);
  });
});

describe("backfillNonYaleIdentity", () => {
  beforeEach(async () => { await resetDb(); });

  it("reports every change without writing when dryRun", async () => {
    const cycleId = await seedLegacyCycle();

    const [report] = await backfillNonYaleIdentity({ dryRun: true });

    expect(report.changes).toHaveLength(3); // gate + relabel + reorder
    const { order, byKey } = await fieldsOf(cycleId);
    expect(order).toEqual(LEGACY_FIELDS.map((f) => f.key));
    expect(byKey.get("net_id")!.visibleWhen).toBeNull();
    expect(byKey.get("email")!.label).toBe("Yale email");
  });

  it("gates the NetID, relabels the email and reorders when applied", async () => {
    const cycleId = await seedLegacyCycle();

    await backfillNonYaleIdentity({ dryRun: false });

    const { order, byKey } = await fieldsOf(cycleId);
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
  });

  it("is idempotent -- a second apply reports nothing left to do", async () => {
    await seedLegacyCycle();

    await backfillNonYaleIdentity({ dryRun: false });
    const [second] = await backfillNonYaleIdentity({ dryRun: false });

    expect(second.changes).toEqual([]);
  });

  it("leaves ARCHIVED cycles alone", async () => {
    const cycleId = await seedLegacyCycle({ status: "ARCHIVED" });

    const reports = await backfillNonYaleIdentity({ dryRun: false });

    expect(reports).toEqual([]);
    const { order, byKey } = await fieldsOf(cycleId);
    expect(order).toEqual(LEGACY_FIELDS.map((f) => f.key));
    expect(byKey.get("email")!.label).toBe("Yale email");
  });

  it("keeps an admin's own label, help text and NetID condition", async () => {
    const ownCondition = { field: "grad_year", op: "is", value: "2027" };
    const cycleId = await seedLegacyCycle({
      emailLabel: "Your @yale.edu address",
      emailHelpText: "We only email you about your application.",
      netIdVisibleWhen: ownCondition,
    });

    const [report] = await backfillNonYaleIdentity({ dryRun: false });

    const { byKey } = await fieldsOf(cycleId);
    expect(byKey.get("email")!.label).toBe("Your @yale.edu address");
    expect(byKey.get("email")!.helpText).toBe("We only email you about your application.");
    expect(byKey.get("net_id")!.visibleWhen).toEqual(ownCondition);
    expect(report.skippedGateReason).toMatch(/already has its own condition/);
  });

  // A condition naming a field that does not exist resolves to "always visible",
  // so writing one would look done while changing nothing.
  it("refuses to gate the NetID when the cycle asks no affiliation question", async () => {
    const cycleId = await seedLegacyCycle({ omitKeys: ["yale_affiliation", "yale_affiliation_other"] });

    const [report] = await backfillNonYaleIdentity({ dryRun: false });

    const { byKey } = await fieldsOf(cycleId);
    expect(byKey.get("net_id")!.visibleWhen).toBeNull();
    expect(report.skippedGateReason).toMatch(/no yale_affiliation/);
    // The relabel is independent of the affiliation question, so it still lands.
    expect(byKey.get("email")!.label).toBe("Email address");
  });

  it("can be limited to named cycles", async () => {
    const target = await seedLegacyCycle();
    const other = await seedLegacyCycle();

    await backfillNonYaleIdentity({ dryRun: false, cycleIds: [target] });

    expect((await fieldsOf(target)).byKey.get("email")!.label).toBe("Email address");
    expect((await fieldsOf(other)).byKey.get("email")!.label).toBe("Yale email");
  });
});
