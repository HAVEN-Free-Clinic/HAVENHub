/**
 * TDD tests for the support module comment service.
 *
 * addComment(actorPersonId, requestId, { body, visibility }):
 *   - A non-manager may post PUBLIC on their own ticket.
 *   - A non-manager cannot post INTERNAL (SupportForbiddenError).
 *   - A non-manager cannot comment on someone else's ticket (SupportNotFoundError).
 *   - A manager may post PUBLIC or INTERNAL on any ticket.
 *
 * listComments(actorPersonId, requestId):
 *   - INTERNAL rows are filtered out for the requester; a manager sees all.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { createTechRequest, SupportForbiddenError, SupportNotFoundError } from "./tech-request";
import { addComment, listComments, notifyCommentAdded } from "./comments";

// ---------------------------------------------------------------------------
// Helpers (copied from tech-request.test.ts / epic.test.ts)
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

describe("comments visibility", () => {
  it("hides INTERNAL comments from the requester", async () => {
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });

    await addComment(mgr.id, req.id, { body: "internal triage", visibility: "INTERNAL" });
    await addComment(mgr.id, req.id, { body: "hello requester", visibility: "PUBLIC" });

    const ownerView = await listComments(owner.id, req.id);
    expect(ownerView.map((c) => c.body)).toEqual(["hello requester"]);

    const mgrView = await listComments(mgr.id, req.id);
    expect(mgrView).toHaveLength(2);
  });

  it("forbids a non-manager from posting INTERNAL", async () => {
    const owner = await createPerson("Owner");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    await expect(
      addComment(owner.id, req.id, { body: "x", visibility: "INTERNAL" })
    ).rejects.toThrow(SupportForbiddenError);
  });

  it("forbids commenting on someone else's ticket as a non-manager", async () => {
    const owner = await createPerson("Owner");
    const stranger = await createPerson("Stranger");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    await expect(
      addComment(stranger.id, req.id, { body: "x", visibility: "PUBLIC" })
    ).rejects.toThrow(SupportNotFoundError);
  });

  it("a non-manager may post PUBLIC on their own ticket", async () => {
    const owner = await createPerson("Owner");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    const comment = await addComment(owner.id, req.id, { body: "an update from me", visibility: "PUBLIC" });
    expect(comment.body).toBe("an update from me");
    expect(comment.visibility).toBe("PUBLIC");
    expect(comment.authorId).toBe(owner.id);
  });

  it("a manager may post INTERNAL on any ticket", async () => {
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    const comment = await addComment(mgr.id, req.id, { body: "internal note", visibility: "INTERNAL" });
    expect(comment.visibility).toBe("INTERNAL");
  });

  it("rejects a blank body", async () => {
    const owner = await createPerson("Owner");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    await expect(
      addComment(owner.id, req.id, { body: "   ", visibility: "PUBLIC" })
    ).rejects.toThrow(/body/i);
  });

  it("updates the ticket's updatedAt on a new comment", async () => {
    const owner = await createPerson("Owner");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    const before = req.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    await addComment(owner.id, req.id, { body: "bump", visibility: "PUBLIC" });
    const after = await prisma.techRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.getTime());
  });

  it("a stranger listing comments on someone else's ticket gets SupportNotFoundError", async () => {
    const owner = await createPerson("Owner");
    const stranger = await createPerson("Stranger");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    await expect(listComments(stranger.id, req.id)).rejects.toThrow(SupportNotFoundError);
  });
});

describe("notifyCommentAdded", () => {
  it("notifies no one for an INTERNAL comment", async () => {
    const owner = await createPerson("Owner", { contactEmail: "owner@example.com" });
    const mgr = await createPerson("Manager", { contactEmail: "mgr@example.com" });
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    const comment = await addComment(mgr.id, req.id, { body: "internal", visibility: "INTERNAL" });

    await notifyCommentAdded(prisma, req, comment, mgr);

    const logs = await prisma.emailLog.findMany({ where: { template: "support.comment_added" } });
    expect(logs).toHaveLength(0);
  });

  it("notifies the requester when a manager posts a PUBLIC reply", async () => {
    const owner = await createPerson("Owner", { contactEmail: "owner@example.com" });
    const mgr = await createPerson("Manager", { contactEmail: "mgr@example.com" });
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    const comment = await addComment(mgr.id, req.id, { body: "reply", visibility: "PUBLIC" });

    await notifyCommentAdded(prisma, req, comment, mgr);

    const logs = await prisma.emailLog.findMany({ where: { template: "support.comment_added" } });
    expect(logs.map((l) => l.toEmail)).toEqual(["owner@example.com"]);
  });

  it("notifies the assignee (not all managers) when the requester replies on an assigned ticket", async () => {
    const owner = await createPerson("Owner", { contactEmail: "owner@example.com" });
    const assignee = await createPerson("Assignee", { contactEmail: "assignee@example.com" });
    const otherMgr = await createPerson("Other Manager", { contactEmail: "other@example.com" });
    await grantPermission(assignee.id, "support.manage_requests");
    await grantPermission(otherMgr.id, "support.manage_requests");
    let req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    req = await prisma.techRequest.update({ where: { id: req.id }, data: { assignedToId: assignee.id } });
    const comment = await addComment(owner.id, req.id, { body: "an update", visibility: "PUBLIC" });

    await notifyCommentAdded(prisma, req, comment, owner);

    const logs = await prisma.emailLog.findMany({ where: { template: "support.comment_added" } });
    expect(logs.map((l) => l.toEmail)).toEqual(["assignee@example.com"]);
  });

  it("falls back to current managers when the requester replies but the assignee is no longer active (audit #9)", async () => {
    const owner = await createPerson("Owner", { contactEmail: "owner@example.com" });
    // The assignee was a manager but has since been offboarded, yet still lingers
    // on the ticket (the detail UI keeps a former assignee in the select).
    const staleAssignee = await createPerson("Stale", { contactEmail: "stale@example.com", status: "OFFBOARDED" });
    await grantPermission(staleAssignee.id, "support.manage_requests");
    const currentMgr = await createPerson("Current Manager", { contactEmail: "current@example.com" });
    await grantPermission(currentMgr.id, "support.manage_requests");
    let req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    req = await prisma.techRequest.update({ where: { id: req.id }, data: { assignedToId: staleAssignee.id } });
    const comment = await addComment(owner.id, req.id, { body: "an update", visibility: "PUBLIC" });

    await notifyCommentAdded(prisma, req, comment, owner);

    const logs = await prisma.emailLog.findMany({ where: { template: "support.comment_added" } });
    // A current manager is reached rather than the reply dead-ending at the stale
    // assignee (which was previously the sole recipient).
    expect(logs.map((l) => l.toEmail)).toContain("current@example.com");
  });

  it("notifies every manager when the requester replies on an unassigned ticket", async () => {
    const owner = await createPerson("Owner", { contactEmail: "owner@example.com" });
    const mgr1 = await createPerson("Manager One", { contactEmail: "mgr1@example.com" });
    const mgr2 = await createPerson("Manager Two", { contactEmail: "mgr2@example.com" });
    await grantPermission(mgr1.id, "support.manage_requests");
    await grantPermission(mgr2.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    const comment = await addComment(owner.id, req.id, { body: "an update", visibility: "PUBLIC" });

    await notifyCommentAdded(prisma, req, comment, owner);

    const logs = await prisma.emailLog.findMany({ where: { template: "support.comment_added" } });
    expect(logs.map((l) => l.toEmail).sort()).toEqual(["mgr1@example.com", "mgr2@example.com"]);
  });

  it("never notifies the author, even if the author is also in the recipient set", async () => {
    const owner = await createPerson("Owner", { contactEmail: "owner@example.com" });
    await grantPermission(owner.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    const comment = await addComment(owner.id, req.id, { body: "self note", visibility: "PUBLIC" });

    await notifyCommentAdded(prisma, req, comment, owner);

    const logs = await prisma.emailLog.findMany({ where: { template: "support.comment_added" } });
    expect(logs).toHaveLength(0);
  });
});

describe("addComment reopen on requester reply", () => {
  async function resolvedTicket() {
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    await prisma.techRequest.update({ where: { id: req.id }, data: { status: "RESOLVED", resolvedAt: new Date() } });
    return { owner, mgr, req };
  }

  // The resolution email tells the requester "reply on the ticket and we'll
  // follow up", but there was no reopen path; a reply used to succeed into a void.
  it("reopens a RESOLVED ticket to IN_PROGRESS when the requester replies", async () => {
    const { owner, req } = await resolvedTicket();
    await addComment(owner.id, req.id, { body: "still broken", visibility: "PUBLIC" });
    const after = await prisma.techRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(after.status).toBe("IN_PROGRESS");
    expect(after.resolvedAt).toBeNull();
  });

  it("does NOT reopen when a manager comments on a resolved ticket", async () => {
    const { mgr, req } = await resolvedTicket();
    await addComment(mgr.id, req.id, { body: "closing note", visibility: "PUBLIC" });
    expect((await prisma.techRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe("RESOLVED");
  });

  it("does NOT reopen a CANCELLED ticket on a requester reply", async () => {
    const owner = await createPerson("Owner");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    await prisma.techRequest.update({ where: { id: req.id }, data: { status: "CANCELLED" } });
    await addComment(owner.id, req.id, { body: "hello?", visibility: "PUBLIC" });
    expect((await prisma.techRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe("CANCELLED");
  });
});
