/**
 * TDD tests for Epic promotion: linking an Epic-category TechRequest into
 * the existing Epic pipeline via promoteToEpic.
 *
 * promoteToEpic(actorPersonId, techRequestId, kind):
 *   - Requires support.manage_requests (SupportForbiddenError otherwise).
 *   - kind must be one of NEW/MODIFY/RENEW (SupportStateError otherwise).
 *   - Ticket must exist (SupportNotFoundError), be category EPIC
 *     (SupportStateError otherwise), and not already be linked
 *     (SupportStateError otherwise).
 *   - Creates an EpicRequest with the manager-chosen kind via
 *     createEpicRequest, links it back onto the ticket (epicRequestId),
 *     records the kind on the ticket (epicSubtype), and sets the ticket
 *     status to IN_PROGRESS.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  createTechRequest,
  SupportForbiddenError,
  SupportNotFoundError,
  SupportStateError,
} from "./tech-request";
import { cancelOwnRequest } from "./manage";
import { promoteToEpic } from "./epic-link";

// ---------------------------------------------------------------------------
// Helpers (copied from src/modules/support/services/manage.test.ts)
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

describe("promoteToEpic", () => {
  it("links a new EpicRequest using the manager-chosen kind", async () => {
    const owner = await createPerson("Owner", { status: "ACTIVE" });
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, {
      category: "EPIC",
      subject: "Need Epic",
      description: "New volunteer",
    });

    const epic = await promoteToEpic(mgr.id, req.id, "NEW");

    expect(epic.kind).toBe("NEW");
    expect(epic.personId).toBe(owner.id);

    const linked = await prisma.techRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(linked.epicRequestId).toBe(epic.id);
    expect(linked.epicSubtype).toBe("NEW");
    expect(linked.status).toBe("IN_PROGRESS");
  });

  it("carries the ticket number and subject into the EpicRequest notes", async () => {
    const owner = await createPerson("Owner", { status: "ACTIVE" });
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, {
      category: "EPIC",
      subject: "Need Epic",
      description: "New volunteer",
    });

    const epic = await promoteToEpic(mgr.id, req.id, "NEW");

    expect(epic.notes).toContain(`#${req.number}`);
    expect(epic.notes).toContain("Need Epic");
  });

  it("refuses to promote a non-Epic ticket", async () => {
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "GENERAL_IT", subject: "S", description: "d" });

    await expect(promoteToEpic(mgr.id, req.id, "NEW")).rejects.toThrow(SupportStateError);
  });

  it("refuses to promote a ticket that is already linked", async () => {
    const owner = await createPerson("Owner", { status: "ACTIVE" });
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, {
      category: "EPIC",
      subject: "Need Epic",
      description: "New volunteer",
    });
    await promoteToEpic(mgr.id, req.id, "NEW");

    await expect(promoteToEpic(mgr.id, req.id, "NEW")).rejects.toThrow(SupportStateError);
  });

  it("rejects a non-manager", async () => {
    const owner = await createPerson("Owner", { status: "ACTIVE" });
    const req = await createTechRequest(owner.id, {
      category: "EPIC",
      subject: "Need Epic",
      description: "New volunteer",
    });

    await expect(promoteToEpic(owner.id, req.id, "NEW")).rejects.toThrow(SupportForbiddenError);
  });

  it("raises a not-found error for a missing ticket", async () => {
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");

    await expect(promoteToEpic(mgr.id, "does-not-exist", "NEW")).rejects.toThrow(SupportNotFoundError);
  });

  it("refuses to promote a terminal (cancelled) ticket", async () => {
    const owner = await createPerson("Owner", { status: "ACTIVE" });
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, {
      category: "EPIC",
      subject: "Need Epic",
      description: "New volunteer",
    });
    await cancelOwnRequest(owner.id, req.id);

    await expect(promoteToEpic(mgr.id, req.id, "NEW")).rejects.toThrow(SupportStateError);

    const epicRequestCount = await prisma.epicRequest.count();
    expect(epicRequestCount).toBe(0);
    const unchanged = await prisma.techRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(unchanged.epicRequestId).toBeNull();
    expect(unchanged.status).toBe("CANCELLED");
  });

  it("propagates createEpicRequest's typed errors, e.g. a non-ACTIVE requester", async () => {
    const owner = await createPerson("Owner", { status: "OFFBOARDED" });
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, {
      category: "EPIC",
      subject: "Need Epic",
      description: "New volunteer",
    });

    await expect(promoteToEpic(mgr.id, req.id, "NEW")).rejects.toThrow(/ACTIVE/);
  });

  it("rejects an invalid kind", async () => {
    const owner = await createPerson("Owner", { status: "ACTIVE" });
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, {
      category: "EPIC",
      subject: "Need Epic",
      description: "New volunteer",
    });

    await expect(
      promoteToEpic(mgr.id, req.id, "DEACTIVATE")
    ).rejects.toThrow(SupportStateError);

    const unchanged = await prisma.techRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(unchanged.epicRequestId).toBeNull();
    expect(unchanged.status).toBe("SUBMITTED");
  });
});
