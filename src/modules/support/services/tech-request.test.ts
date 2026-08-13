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
  createTechRequestFromConversation,
  listMyRequests,
  getTechRequest,
  listAllRequests,
  isManager,
  SupportNotFoundError,
  SupportStateError,
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

describe("createTechRequestFromConversation", () => {
  it("creates a SUBMITTED ticket owned by the requester and stamps the conversation id", async () => {
    const p = await createPerson("Alice");
    const { ticket, created } = await createTechRequestFromConversation(p.id, {
      intercomConversationId: "conv_1",
      category: "GENERAL_IT",
      subject: "Laptop won't connect",
      description: "Wifi drops on the clinic floor.",
    });
    expect(created).toBe(true);
    expect(ticket.status).toBe("SUBMITTED");
    expect(ticket.requesterId).toBe(p.id);
    expect(ticket.intercomConversationId).toBe("conv_1");
  });

  it("is idempotent: a second call for the same conversation id returns the same ticket unchanged", async () => {
    const p = await createPerson("Alice");
    const first = await createTechRequestFromConversation(p.id, {
      intercomConversationId: "conv_1",
      category: "GENERAL_IT",
      subject: "Laptop won't connect",
      description: "Wifi drops on the clinic floor.",
    });
    // A retry can arrive with a different body (Fin re-composing its call) --
    // the existing ticket must come back unchanged regardless.
    const second = await createTechRequestFromConversation(p.id, {
      intercomConversationId: "conv_1",
      category: "OTHER",
      subject: "Different subject",
      description: "Different description",
    });

    expect(second.created).toBe(false);
    expect(second.ticket.id).toBe(first.ticket.id);
    expect(second.ticket.number).toBe(first.ticket.number);
    expect(second.ticket.category).toBe("GENERAL_IT");
    expect(await prisma.techRequest.count()).toBe(1);
  });

  it("survives two genuinely concurrent calls for the same conversation id without a raw constraint error", async () => {
    const p = await createPerson("Alice");
    const input = {
      intercomConversationId: "conv_race",
      category: "GENERAL_IT" as const,
      subject: "Laptop won't connect",
      description: "Wifi drops on the clinic floor.",
    };
    const [a, b] = await Promise.all([
      createTechRequestFromConversation(p.id, input),
      createTechRequestFromConversation(p.id, input),
    ]);

    expect(a.ticket.number).toBe(b.ticket.number);
    // Exactly one of the two calls did the actual insert.
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
    expect(await prisma.techRequest.count()).toBe(1);
  });

  it("rejects a blank subject", async () => {
    const p = await createPerson("Alice");
    await expect(
      createTechRequestFromConversation(p.id, {
        intercomConversationId: "conv_1",
        category: "OTHER",
        subject: "  ",
        description: "x",
      })
    ).rejects.toThrow(SupportStateError);
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

  it("listAllRequests admits a view-only holder", async () => {
    const owner = await createPerson("Owner");
    const auditor = await createPerson("Auditor");
    await grantPermission(auditor.id, "support.view_all_requests");
    await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    const { rows } = await listAllRequests(auditor.id, {});
    expect(rows.map((r) => r.subject)).toEqual(["S"]);
  });

  it("getTechRequest lets a view-only holder read any ticket", async () => {
    const owner = await createPerson("Owner");
    const auditor = await createPerson("Auditor");
    await grantPermission(auditor.id, "support.view_all_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    const detail = await getTechRequest(auditor.id, req.id);
    expect(detail.id).toBe(req.id);
  });

  it("view-only alone does not make someone a manager", async () => {
    // The distinction the whole permission rests on: read paths widen, every
    // write path (assignment, status, comments, Epic tools) keeps gating on
    // isManager, so granting view-only must never satisfy it.
    const auditor = await createPerson("Auditor");
    await grantPermission(auditor.id, "support.view_all_requests");
    expect(await isManager(auditor.id)).toBe(false);
  });
});
