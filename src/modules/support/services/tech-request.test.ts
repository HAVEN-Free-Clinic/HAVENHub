/**
 * TDD tests for the support module TechRequest service core.
 *
 * createTechRequest(actorPersonId, input):
 *   - Creates a SUBMITTED ticket owned by the requester, default priority MEDIUM.
 *   - Rejects a blank subject.
 *
 * Read access:
 *   - listMyRequests returns only the caller's tickets.
 *   - getTechRequest hides another person's ticket from a non-manager (SupportNotFoundError).
 *   - getTechRequest lets a manager read any ticket.
 *   - listAllRequests requires the manage permission.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  createTechRequest,
  listMyRequests,
  getTechRequest,
  listAllRequests,
  SupportNotFoundError,
} from "./tech-request";

// ---------------------------------------------------------------------------
// Helpers (copied from src/modules/volunteers/services/epic.test.ts)
// ---------------------------------------------------------------------------

async function createPerson(
  name: string,
  opts: { netId?: string; contactEmail?: string; epicId?: string; status?: "ACTIVE" | "OFFBOARDED" } = {}
) {
  return prisma.person.create({
    data: {
      name,
      netId: opts.netId ?? null,
      contactEmail: opts.contactEmail ?? null,
      epicId: opts.epicId ?? null,
      status: opts.status ?? "ACTIVE",
    },
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

beforeEach(resetDb);

describe("createTechRequest", () => {
  it("creates a SUBMITTED ticket owned by the requester", async () => {
    const p = await createPerson("Alice");
    const req = await createTechRequest(p.id, {
      category: "GENERAL_IT",
      subject: "Laptop won't connect",
      description: "Wifi drops on the clinic floor.",
    });
    expect(req.status).toBe("SUBMITTED");
    expect(req.requesterId).toBe(p.id);
    expect(req.priority).toBe("MEDIUM");
    expect(req.number).toBeGreaterThan(0);
  });

  it("rejects a blank subject", async () => {
    const p = await createPerson("Alice");
    await expect(
      createTechRequest(p.id, { category: "OTHER", subject: "  ", description: "x" })
    ).rejects.toThrow(/subject/i);
  });
});

describe("read access", () => {
  it("listMyRequests returns only the caller's tickets", async () => {
    const a = await createPerson("Alice");
    const b = await createPerson("Bob");
    await createTechRequest(a.id, { category: "TEAMS", subject: "A", description: "x" });
    await createTechRequest(b.id, { category: "TEAMS", subject: "B", description: "y" });
    const rows = await listMyRequests(a.id);
    expect(rows.map((r) => r.subject)).toEqual(["A"]);
  });

  it("getTechRequest hides another person's ticket from a non-manager", async () => {
    const owner = await createPerson("Owner");
    const stranger = await createPerson("Stranger");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    await expect(getTechRequest(stranger.id, req.id)).rejects.toThrow(SupportNotFoundError);
  });

  it("getTechRequest lets a manager read any ticket", async () => {
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    const detail = await getTechRequest(mgr.id, req.id);
    expect(detail.id).toBe(req.id);
  });

  it("listAllRequests requires the manage permission", async () => {
    const p = await createPerson("Alice");
    await expect(listAllRequests(p.id, {})).rejects.toThrow(/permission/i);
  });
});
