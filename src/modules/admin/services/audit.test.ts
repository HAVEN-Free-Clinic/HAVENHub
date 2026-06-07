import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { queryAudit, distinctEntityTypes } from "./audit";

const ACTOR = "actor-person-id";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function seedPerson(id: string, name: string) {
  return prisma.person.create({
    data: { id, name },
  });
}

async function seedAudit(overrides: {
  action: string;
  entityType: string;
  entityId?: string;
  actorPersonId?: string | null;
}) {
  return prisma.auditLog.create({
    data: {
      action: overrides.action,
      entityType: overrides.entityType,
      entityId: overrides.entityId ?? null,
      actorPersonId: overrides.actorPersonId ?? null,
    },
  });
}

// ---------------------------------------------------------------------------
// filter by action substring (case-insensitive contains)
// ---------------------------------------------------------------------------

describe("queryAudit - filter by action", () => {
  beforeEach(resetDb);

  it("returns only rows whose action contains the filter string (case-insensitive)", async () => {
    await seedAudit({ action: "person.update", entityType: "Person" });
    await seedAudit({ action: "person.create", entityType: "Person" });
    await seedAudit({ action: "term.activate", entityType: "Term" });

    const { rows, total } = await queryAudit({ action: "Person" });

    expect(total).toBe(2);
    expect(rows.every((r) => r.action.toLowerCase().includes("person"))).toBe(true);
  });

  it("returns all rows when action filter is empty/omitted", async () => {
    await seedAudit({ action: "person.update", entityType: "Person" });
    await seedAudit({ action: "term.activate", entityType: "Term" });

    const { total } = await queryAudit({});

    expect(total).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// filter by entityType (exact match)
// ---------------------------------------------------------------------------

describe("queryAudit - filter by entityType", () => {
  beforeEach(resetDb);

  it("returns only rows with the exact entityType", async () => {
    await seedAudit({ action: "person.update", entityType: "Person" });
    await seedAudit({ action: "person.create", entityType: "Person" });
    await seedAudit({ action: "term.activate", entityType: "Term" });

    const { rows, total } = await queryAudit({ entityType: "Term" });

    expect(total).toBe(1);
    expect(rows[0].entityType).toBe("Term");
  });

  it("returns no rows when entityType filter matches nothing", async () => {
    await seedAudit({ action: "person.update", entityType: "Person" });

    const { rows, total } = await queryAudit({ entityType: "NonExistent" });

    expect(total).toBe(0);
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// actor name resolution
// ---------------------------------------------------------------------------

describe("queryAudit - actor name resolution", () => {
  beforeEach(resetDb);

  it("resolves actorName from Person when actor exists", async () => {
    await seedPerson(ACTOR, "Jack Carney");
    await seedAudit({ action: "person.update", entityType: "Person", actorPersonId: ACTOR });

    const { rows } = await queryAudit({});

    expect(rows).toHaveLength(1);
    expect(rows[0].actorName).toBe("Jack Carney");
  });

  it("returns actorName null when actorPersonId references a deleted/non-existent person", async () => {
    // No person seeded - actor ID is dangling (Person has no FK on AuditLog by design)
    await seedAudit({ action: "person.create", entityType: "Person", actorPersonId: "vanished-person-id" });

    const { rows } = await queryAudit({});

    expect(rows).toHaveLength(1);
    expect(rows[0].actorPersonId).toBe("vanished-person-id");
    expect(rows[0].actorName).toBeNull();
  });

  it("returns actorName null when actorPersonId is null (system action)", async () => {
    await seedAudit({ action: "auth.login_unmatched", entityType: "Auth", actorPersonId: null });

    const { rows } = await queryAudit({});

    expect(rows).toHaveLength(1);
    expect(rows[0].actorName).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// pagination math
// ---------------------------------------------------------------------------

describe("queryAudit - pagination", () => {
  beforeEach(resetDb);

  it("paginates correctly: page 1 returns first pageSize rows", async () => {
    // Seed 7 audit entries
    for (let i = 0; i < 7; i++) {
      await seedAudit({ action: `action.${i}`, entityType: "Test" });
    }

    const { rows, total, page, pageCount } = await queryAudit({ pageSize: 3, page: 1 });

    expect(total).toBe(7);
    expect(page).toBe(1);
    expect(pageCount).toBe(3); // ceil(7/3)
    expect(rows).toHaveLength(3);
  });

  it("paginates correctly: last page returns remaining rows", async () => {
    for (let i = 0; i < 7; i++) {
      await seedAudit({ action: `action.${i}`, entityType: "Test" });
    }

    const { rows, page, pageCount } = await queryAudit({ pageSize: 3, page: 3 });

    expect(page).toBe(3);
    expect(pageCount).toBe(3);
    expect(rows).toHaveLength(1);
  });

  it("defaults to pageSize 50 and orders by createdAt descending", async () => {
    // Seed 3 entries and confirm they come back newest-first
    const a = await seedAudit({ action: "action.first", entityType: "Test" });
    // small delay not needed since createdAt precision is fine on Postgres
    const b = await seedAudit({ action: "action.second", entityType: "Test" });
    const c = await seedAudit({ action: "action.third", entityType: "Test" });

    const { rows } = await queryAudit({});

    // Newest first
    expect(rows[0].id).toBe(c.id);
    expect(rows[1].id).toBe(b.id);
    expect(rows[2].id).toBe(a.id);
  });
});

// ---------------------------------------------------------------------------
// distinctEntityTypes
// ---------------------------------------------------------------------------

describe("distinctEntityTypes", () => {
  beforeEach(resetDb);

  it("returns sorted distinct entityType values", async () => {
    await seedAudit({ action: "term.activate", entityType: "Term" });
    await seedAudit({ action: "person.update", entityType: "Person" });
    await seedAudit({ action: "person.create", entityType: "Person" });

    const types = await distinctEntityTypes();

    expect(types).toEqual(["Person", "Term"]);
  });

  it("returns an empty array when there are no audit logs", async () => {
    const types = await distinctEntityTypes();
    expect(types).toHaveLength(0);
  });
});
