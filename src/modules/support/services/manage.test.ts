/**
 * TDD tests for the support module manager-action service.
 *
 * assignRequest, setStatus, setPriority, resolveRequest, cancelRequest all
 * require support.manage_requests. cancelOwnRequest does not (self-service,
 * gated instead on requesterId === actor).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { createTechRequest, SupportNotFoundError, SupportStateError } from "./tech-request";
import {
  assignRequest,
  setStatus,
  setPriority,
  resolveRequest,
  cancelRequest,
  cancelOwnRequest,
} from "./manage";

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

describe("assignRequest", () => {
  it("requires the manage permission", async () => {
    const p = await createPerson("Alice");
    const req = await createTechRequest(p.id, { category: "OTHER", subject: "S", description: "d" });
    await expect(assignRequest(p.id, req.id, p.id)).rejects.toThrow(/permission/i);
  });

  it("sets assignedToId and notifies the new assignee", async () => {
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Marla Manager", { contactEmail: "mgr@example.com" });
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });

    const updated = await assignRequest(mgr.id, req.id, mgr.id);
    expect(updated.assignedToId).toBe(mgr.id);

    const logs = await prisma.emailLog.findMany({ where: { template: "support.request_assigned" } });
    expect(logs.map((l) => l.toEmail)).toContain("mgr@example.com");
  });

  it("unassigns when given null and sends no notification", async () => {
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Marla Manager", { contactEmail: "mgr@example.com" });
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    await assignRequest(mgr.id, req.id, mgr.id);

    const updated = await assignRequest(mgr.id, req.id, null);
    expect(updated.assignedToId).toBeNull();

    const logs = await prisma.emailLog.findMany({ where: { template: "support.request_assigned" } });
    expect(logs).toHaveLength(1); // only the earlier assignment, not the unassign
  });

  it("refuses to reassign a resolved (terminal) ticket", async () => {
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    await resolveRequest(mgr.id, req.id, "Reset the account.");

    await expect(assignRequest(mgr.id, req.id, mgr.id)).rejects.toThrow(SupportStateError);
  });
});

describe("setStatus", () => {
  it("requires the manage permission", async () => {
    const p = await createPerson("Alice");
    const req = await createTechRequest(p.id, { category: "OTHER", subject: "S", description: "d" });
    await expect(setStatus(p.id, req.id, "IN_PROGRESS")).rejects.toThrow(/permission/i);
  });

  it("updates status and notifies the requester on AWAITING_REQUESTER", async () => {
    const owner = await createPerson("Owner", { contactEmail: "owner@example.com" });
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });

    const updated = await setStatus(mgr.id, req.id, "AWAITING_REQUESTER");
    expect(updated.status).toBe("AWAITING_REQUESTER");

    const logs = await prisma.emailLog.findMany({ where: { template: "support.status_changed" } });
    expect(logs.map((l) => l.toEmail)).toContain("owner@example.com");
  });

  it("notifies the requester on any status transition (e.g. IN_PROGRESS)", async () => {
    const owner = await createPerson("Owner", { contactEmail: "owner@example.com" });
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });

    await setStatus(mgr.id, req.id, "IN_PROGRESS");

    const logs = await prisma.emailLog.findMany({ where: { template: "support.status_changed" } });
    expect(logs.map((l) => l.toEmail)).toContain("owner@example.com");
  });

  it("notifies on AWAITING_YNHH and CLOSED transitions too", async () => {
    const owner = await createPerson("Owner", { contactEmail: "owner@example.com" });
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });

    await setStatus(mgr.id, req.id, "AWAITING_YNHH");
    await setStatus(mgr.id, req.id, "CLOSED");

    const logs = await prisma.emailLog.findMany({ where: { template: "support.status_changed" } });
    expect(logs).toHaveLength(2);
  });

  it("does not notify on a no-op (same-status) call", async () => {
    const owner = await createPerson("Owner", { contactEmail: "owner@example.com" });
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    // Fresh tickets start SUBMITTED; re-setting SUBMITTED is not a transition.
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });

    await setStatus(mgr.id, req.id, "SUBMITTED");

    const logs = await prisma.emailLog.findMany({ where: { template: "support.status_changed" } });
    expect(logs).toHaveLength(0);
  });

  it("blocks transitions out of a terminal state", async () => {
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    await cancelRequest(mgr.id, req.id, "No longer needed.");

    await expect(setStatus(mgr.id, req.id, "IN_PROGRESS")).rejects.toThrow();
  });

  it("rejects RESOLVED as a target status -- must go through resolveRequest", async () => {
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });

    await expect(setStatus(mgr.id, req.id, "RESOLVED")).rejects.toThrow(SupportStateError);

    const after = await prisma.techRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(after.status).not.toBe("RESOLVED");
    expect(after.resolvedAt).toBeNull();
    expect(after.resolution).toBeNull();
  });

  it("rejects CANCELLED as a target status -- must go through cancelRequest", async () => {
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });

    await expect(setStatus(mgr.id, req.id, "CANCELLED")).rejects.toThrow(SupportStateError);

    const after = await prisma.techRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(after.status).not.toBe("CANCELLED");
  });

  it("still allows CLOSED as a direct transition", async () => {
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });

    const updated = await setStatus(mgr.id, req.id, "CLOSED");
    expect(updated.status).toBe("CLOSED");
  });
});

describe("setPriority", () => {
  it("requires the manage permission", async () => {
    const p = await createPerson("Alice");
    const req = await createTechRequest(p.id, { category: "OTHER", subject: "S", description: "d" });
    await expect(setPriority(p.id, req.id, "HIGH")).rejects.toThrow(/permission/i);
  });

  it("updates priority", async () => {
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });

    const updated = await setPriority(mgr.id, req.id, "CRITICAL");
    expect(updated.priority).toBe("CRITICAL");
  });

  it("refuses to change priority on a resolved (terminal) ticket", async () => {
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    await resolveRequest(mgr.id, req.id, "Reset the account.");

    await expect(setPriority(mgr.id, req.id, "CRITICAL")).rejects.toThrow(SupportStateError);
  });
});

describe("resolveRequest", () => {
  it("sets RESOLVED with resolvedAt and a resolution", async () => {
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    await resolveRequest(mgr.id, req.id, "Reset the account.");
    const after = await prisma.techRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(after.status).toBe("RESOLVED");
    expect(after.resolvedAt).not.toBeNull();
    expect(after.resolution).toBe("Reset the account.");
  });

  it("notifies the requester", async () => {
    const owner = await createPerson("Owner", { contactEmail: "owner@example.com" });
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });

    await resolveRequest(mgr.id, req.id, "Reset the account.");

    const logs = await prisma.emailLog.findMany({ where: { template: "support.request_resolved" } });
    expect(logs.map((l) => l.toEmail)).toContain("owner@example.com");
  });

  it("rejects a blank resolution", async () => {
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });

    await expect(resolveRequest(mgr.id, req.id, "   ")).rejects.toThrow(/resolution/i);
  });
});

describe("cancelRequest", () => {
  it("requires the manage permission", async () => {
    const p = await createPerson("Alice");
    const req = await createTechRequest(p.id, { category: "OTHER", subject: "S", description: "d" });
    await expect(cancelRequest(p.id, req.id, "no longer needed")).rejects.toThrow(/permission/i);
  });

  it("cancels a non-terminal ticket", async () => {
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });

    const updated = await cancelRequest(mgr.id, req.id, "Duplicate ticket.");
    expect(updated.status).toBe("CANCELLED");
  });

  it("rejects cancelling an already-terminal ticket", async () => {
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    await cancelRequest(mgr.id, req.id, "Duplicate ticket.");

    await expect(cancelRequest(mgr.id, req.id, "Again.")).rejects.toThrow();
  });
});

describe("cancelOwnRequest", () => {
  it("lets the owner cancel their own open ticket", async () => {
    const owner = await createPerson("Owner");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    await cancelOwnRequest(owner.id, req.id);
    const after = await prisma.techRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(after.status).toBe("CANCELLED");
  });

  it("does not require the manage permission", async () => {
    const owner = await createPerson("Owner");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    // No grantPermission call at all -- should still succeed.
    await expect(cancelOwnRequest(owner.id, req.id)).resolves.toBeDefined();
  });

  it("refuses to cancel someone else's ticket", async () => {
    const owner = await createPerson("Owner");
    const stranger = await createPerson("Stranger");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    await expect(cancelOwnRequest(stranger.id, req.id)).rejects.toThrow(SupportNotFoundError);
  });

  it("rejects cancelling an already-terminal ticket", async () => {
    const owner = await createPerson("Owner");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    await cancelOwnRequest(owner.id, req.id);
    await expect(cancelOwnRequest(owner.id, req.id)).rejects.toThrow();
  });
});
