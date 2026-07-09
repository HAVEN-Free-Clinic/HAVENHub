/**
 * TDD tests for Epic promotion: linking an Epic-category TechRequest into
 * the existing Epic pipeline via promoteToEpic.
 *
 * promoteToEpic(actorPersonId, techRequestId):
 *   - Requires support.manage_requests (SupportForbiddenError otherwise).
 *   - Ticket must exist (SupportNotFoundError), be category EPIC with a
 *     subtype (SupportStateError otherwise), and not already be linked
 *     (SupportStateError otherwise).
 *   - Creates an EpicRequest from the ticket's intake fields via
 *     createEpicRequest, links it back onto the ticket (epicRequestId), and
 *     sets the ticket status to IN_PROGRESS.
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
  it("links a new EpicRequest carrying the intake fields", async () => {
    const owner = await createPerson("Owner", { status: "ACTIVE" });
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, {
      category: "EPIC",
      epicSubtype: "NEW",
      subject: "Need Epic",
      description: "New volunteer",
      epicJobTitle: "Scribe",
      epicMirrorId: "EPIC123",
    });

    const epic = await promoteToEpic(mgr.id, req.id);

    expect(epic.kind).toBe("NEW");
    expect(epic.jobTitle).toBe("Scribe");
    expect(epic.mirrorEpicId).toBe("EPIC123");
    expect(epic.personId).toBe(owner.id);

    const linked = await prisma.techRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(linked.epicRequestId).toBe(epic.id);
    expect(linked.status).toBe("IN_PROGRESS");
  });

  it("carries the ticket number and subject into the EpicRequest notes", async () => {
    const owner = await createPerson("Owner", { status: "ACTIVE" });
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, {
      category: "EPIC",
      epicSubtype: "NEW",
      subject: "Need Epic",
      description: "New volunteer",
    });

    const epic = await promoteToEpic(mgr.id, req.id);

    expect(epic.notes).toContain(`#${req.number}`);
    expect(epic.notes).toContain("Need Epic");
  });

  it("refuses to promote a non-Epic ticket", async () => {
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "GENERAL_IT", subject: "S", description: "d" });

    await expect(promoteToEpic(mgr.id, req.id)).rejects.toThrow(SupportStateError);
  });

  it("refuses to promote a ticket that is already linked", async () => {
    const owner = await createPerson("Owner", { status: "ACTIVE" });
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, {
      category: "EPIC",
      epicSubtype: "NEW",
      subject: "Need Epic",
      description: "New volunteer",
    });
    await promoteToEpic(mgr.id, req.id);

    await expect(promoteToEpic(mgr.id, req.id)).rejects.toThrow(SupportStateError);
  });

  it("rejects a non-manager", async () => {
    const owner = await createPerson("Owner", { status: "ACTIVE" });
    const req = await createTechRequest(owner.id, {
      category: "EPIC",
      epicSubtype: "NEW",
      subject: "Need Epic",
      description: "New volunteer",
    });

    await expect(promoteToEpic(owner.id, req.id)).rejects.toThrow(SupportForbiddenError);
  });

  it("raises a not-found error for a missing ticket", async () => {
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");

    await expect(promoteToEpic(mgr.id, "does-not-exist")).rejects.toThrow(SupportNotFoundError);
  });

  it("propagates createEpicRequest's typed errors, e.g. a non-ACTIVE requester", async () => {
    const owner = await createPerson("Owner", { status: "OFFBOARDED" });
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, {
      category: "EPIC",
      epicSubtype: "NEW",
      subject: "Need Epic",
      description: "New volunteer",
    });

    await expect(promoteToEpic(mgr.id, req.id)).rejects.toThrow(/ACTIVE/);
  });
});
