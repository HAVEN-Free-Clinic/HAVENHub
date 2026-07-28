/**
 * TDD tests for the permission-scoped entity search service.
 *
 * searchEntities(personId, query):
 *   - People: no result for a viewer with neither people permission, and none
 *     for a viewer holding the fine-grained permission WITHOUT access to the
 *     module whose layout wraps the destination; admin link for
 *     admin.access + admin.manage_people; compliance link for
 *     volunteers.view + volunteers.manage_compliance; admin link preferred
 *     when both tiers apply.
 *   - Requests: always the viewer's own; every row for a
 *     support.manage_requests holder.
 *   - Cycles: no result without recruitment capability; results for a
 *     recruitment.access holder.
 *   - A query under two characters always returns [].
 *   - Never surfaces a group outside People/Cycles/Requests (no incidents,
 *     applications, applicants).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { searchEntities } from "./entities";

// ---------------------------------------------------------------------------
// Helpers (copied from src/modules/support/services/attachments.test.ts)
// ---------------------------------------------------------------------------

async function createPerson(
  name: string,
  opts: { status?: "ACTIVE" | "OFFBOARDED" } = {}
) {
  return prisma.person.create({
    data: { name, status: opts.status ?? "ACTIVE" },
  });
}

async function grantPermission(personId: string, permission: string) {
  const role = await prisma.role.create({
    data: {
      name: `Role-${permission}-${Date.now()}-${Math.random()}`,
      isSystem: false,
      grants: { create: [{ permission }] },
    },
  });
  await prisma.roleAssignment.create({ data: { roleId: role.id, personId, termId: null } });
}

/** A minimal active Term, needed as a RecruitmentCycle FK. */
async function createTerm() {
  return prisma.term.create({
    data: {
      code: `T-${Date.now()}-${Math.random()}`,
      name: "Test Term",
      startDate: new Date("2026-01-01"),
      endDate: new Date("2026-06-01"),
      status: "ACTIVE",
    },
  });
}

beforeEach(resetDb);

describe("searchEntities permission scoping", () => {
  let plain: string;
  let admin: string;
  let complianceMgr: string;

  beforeEach(async () => {
    plain = (await createPerson("Plain Person")).id;
    admin = (await createPerson("Ada Admin")).id;
    complianceMgr = (await createPerson("Cora Compliance")).id;
    await grantPermission(admin, "admin.manage_people");
    await grantPermission(complianceMgr, "volunteers.manage_compliance");
  });

  it("returns no people to a viewer with neither people permission", async () => {
    const hits = await searchEntities(plain, "Ada");
    expect(hits.filter((h) => h.group === "People")).toEqual([]);
  });

  // Both module-gate tests below describe a role the Roles UI lets an admin
  // compose: the fine-grained permission on its own, with no access to the
  // module whose layout wraps the destination page. Every People row such a
  // viewer got would bounce at that layout, so there must be no row.
  it("returns no people to an admin.manage_people holder without admin module access", async () => {
    // admin/layout.tsx requires module access (admin.access), which
    // admin.manage_people does not imply.
    const hits = await searchEntities(admin, "Plain");
    expect(hits.filter((h) => h.group === "People")).toEqual([]);
  });

  it("returns no people to a volunteers.manage_compliance holder without volunteers module access", async () => {
    // volunteers/layout.tsx admits volunteers.view OR volunteers.verify_spanish
    // only; volunteers.manage_compliance is not in that set.
    const hits = await searchEntities(complianceMgr, "Plain");
    expect(hits.filter((h) => h.group === "People")).toEqual([]);
  });

  it("links people to the admin page for an admin.access + admin.manage_people holder", async () => {
    await grantPermission(admin, "admin.access");
    const hits = await searchEntities(admin, "Plain");
    const person = hits.find((h) => h.group === "People");
    expect(person?.href).toMatch(/^\/admin\/people\//);
  });

  it("links people to the compliance page for a volunteers.view + volunteers.manage_compliance holder", async () => {
    await grantPermission(complianceMgr, "volunteers.view");
    const hits = await searchEntities(complianceMgr, "Plain");
    const person = hits.find((h) => h.group === "People");
    expect(person?.href).toMatch(/^\/volunteers\/compliance\//);
  });

  it("links people to the compliance page when volunteers.verify_spanish carries module access", async () => {
    // The other half of the volunteers module gate: additionalAccessPermissions.
    await grantPermission(complianceMgr, "volunteers.verify_spanish");
    const hits = await searchEntities(complianceMgr, "Plain");
    expect(hits.find((h) => h.group === "People")?.href).toMatch(/^\/volunteers\/compliance\//);
  });

  it("prefers the admin link when the viewer qualifies for both tiers", async () => {
    await grantPermission(admin, "admin.access");
    await grantPermission(admin, "volunteers.view");
    await grantPermission(admin, "volunteers.manage_compliance");
    const hits = await searchEntities(admin, "Plain");
    expect(hits.find((h) => h.group === "People")?.href).toMatch(/^\/admin\/people\//);
  });

  it("returns only the viewer's own support requests when they are not a manager", async () => {
    const mine = await prisma.techRequest.create({
      data: { requesterId: plain, category: "OTHER", subject: "Broken laptop", description: "x" },
    });
    await prisma.techRequest.create({
      data: { requesterId: admin, category: "OTHER", subject: "Broken monitor", description: "x" },
    });
    const hits = await searchEntities(plain, "Broken");
    const reqs = hits.filter((h) => h.group === "Requests");
    expect(reqs).toHaveLength(1);
    expect(reqs[0].id).toBe(mine.id);
  });

  it("returns every support request to a support.manage_requests holder", async () => {
    await grantPermission(admin, "support.manage_requests");
    await prisma.techRequest.create({
      data: { requesterId: plain, category: "OTHER", subject: "Broken laptop", description: "x" },
    });
    const hits = await searchEntities(admin, "Broken laptop");
    expect(hits.filter((h) => h.group === "Requests").length).toBeGreaterThanOrEqual(1);
  });

  it("returns no cycles to someone with no recruitment capability", async () => {
    const term = await createTerm();
    await prisma.recruitmentCycle.create({
      data: {
        title: "Zebra Cycle",
        publicSlug: `zebra-${Date.now()}`,
        status: "OPEN",
        track: "VOLUNTEER",
        termId: term.id,
        createdById: admin,
        departments: [],
      },
    });
    const hits = await searchEntities(plain, "Zebra");
    expect(hits.filter((h) => h.group === "Cycles")).toEqual([]);
  });

  it("returns cycles to a recruitment.access holder", async () => {
    await grantPermission(admin, "recruitment.access");
    const term = await createTerm();
    await prisma.recruitmentCycle.create({
      data: {
        title: "Zebra Cycle",
        publicSlug: `zebra2-${Date.now()}`,
        status: "OPEN",
        track: "VOLUNTEER",
        termId: term.id,
        createdById: admin,
        departments: [],
      },
    });
    const hits = await searchEntities(admin, "Zebra");
    expect(hits.filter((h) => h.group === "Cycles").length).toBeGreaterThanOrEqual(1);
  });

  it("returns no cycles to a recruitment.score-only viewer (narrower than the subtree gate)", async () => {
    await grantPermission(admin, "recruitment.score");
    const term = await createTerm();
    await prisma.recruitmentCycle.create({
      data: {
        title: "Zebra Cycle",
        publicSlug: `zebra3-${Date.now()}`,
        status: "OPEN",
        track: "VOLUNTEER",
        termId: term.id,
        createdById: admin,
        departments: [],
      },
    });
    const hits = await searchEntities(admin, "Zebra");
    expect(hits.filter((h) => h.group === "Cycles")).toEqual([]);
  });

  it("never returns a group outside People, Cycles, or Requests", async () => {
    await grantPermission(admin, "*");
    const hits = await searchEntities(admin, "ab");
    const groups = new Set(hits.map((h) => h.group));
    for (const g of groups) expect(["People", "Cycles", "Requests"]).toContain(g);
  });

  it("returns nothing for a query under two characters", async () => {
    await grantPermission(admin, "*");
    expect(await searchEntities(admin, "a")).toEqual([]);
  });
});
