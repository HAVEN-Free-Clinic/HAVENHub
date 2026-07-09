/**
 * TDD tests for the support module attachments service.
 *
 * validateSupportUpload(file, maxMb?):
 *   - rejects a disallowed mime type (returns a message mentioning "type").
 *   - rejects an oversize file (returns a message mentioning "large").
 *   - accepts an allowed, in-budget file (returns null).
 *
 * persistAttachment(actorPersonId, target, file):
 *   - throws SupportForbiddenError on a disallowed/oversize file.
 *   - stores a ticket-level attachment (requestId set).
 *   - stores a comment-level attachment (commentId set).
 *
 * getAttachmentForDownload(actorPersonId, attachmentId):
 *   - denies a stranger (SupportNotFoundError; non-leaky).
 *   - allows the requester to download their own ticket attachment.
 *   - allows a manager to download any attachment.
 *   - denies a non-manager requester an attachment on an INTERNAL comment.
 *   - allows a manager an attachment on an INTERNAL comment.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { createTechRequest, SupportForbiddenError, SupportNotFoundError } from "./tech-request";
import { addComment } from "./comments";
import { validateSupportUpload, persistAttachment, getAttachmentForDownload } from "./attachments";

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

describe("validateSupportUpload", () => {
  it("rejects an executable and oversize file, accepts a png", () => {
    expect(
      validateSupportUpload({ fileName: "x.exe", mimeType: "application/x-msdownload", size: 10 })
    ).toMatch(/type/i);
    expect(
      validateSupportUpload({ fileName: "big.png", mimeType: "image/png", size: 999 * 1024 * 1024 })
    ).toMatch(/large/i);
    expect(
      validateSupportUpload({ fileName: "shot.png", mimeType: "image/png", size: 1024 })
    ).toBeNull();
  });
});

describe("persistAttachment", () => {
  it("throws SupportForbiddenError on a disallowed file", async () => {
    const owner = await createPerson("Owner");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    await expect(
      persistAttachment(owner.id, { requestId: req.id }, {
        fileName: "x.exe",
        mimeType: "application/x-msdownload",
        bytes: Buffer.from("x"),
      })
    ).rejects.toThrow(SupportForbiddenError);
  });

  it("stores a ticket-level attachment with requestId set", async () => {
    const owner = await createPerson("Owner");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    const att = await persistAttachment(owner.id, { requestId: req.id }, {
      fileName: "shot.png",
      mimeType: "image/png",
      bytes: Buffer.from("hello"),
    });
    expect(att.requestId).toBe(req.id);
    expect(att.commentId).toBeNull();
    expect(att.filename).toBe("shot.png");
    expect(att.uploadedById).toBe(owner.id);
  });

  it("stores a comment-level attachment with commentId set", async () => {
    const owner = await createPerson("Owner");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    const comment = await addComment(owner.id, req.id, { body: "an update", visibility: "PUBLIC" });
    const att = await persistAttachment(owner.id, { commentId: comment.id }, {
      fileName: "notes.txt",
      mimeType: "text/plain",
      bytes: Buffer.from("hello"),
    });
    expect(att.commentId).toBe(comment.id);
    expect(att.requestId).toBeNull();
  });
});

describe("getAttachmentForDownload", () => {
  it("denies a stranger", async () => {
    const owner = await createPerson("Owner");
    const stranger = await createPerson("Stranger");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    const att = await persistAttachment(owner.id, { requestId: req.id }, {
      fileName: "a.png",
      mimeType: "image/png",
      bytes: Buffer.from("x"),
    });
    await expect(getAttachmentForDownload(stranger.id, att.id)).rejects.toThrow(SupportNotFoundError);
  });

  it("allows the requester to download their own ticket attachment", async () => {
    const owner = await createPerson("Owner");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    const att = await persistAttachment(owner.id, { requestId: req.id }, {
      fileName: "a.png",
      mimeType: "image/png",
      bytes: Buffer.from("hello world"),
    });
    const result = await getAttachmentForDownload(owner.id, att.id);
    expect(result.filename).toBe("a.png");
    expect(result.mimeType).toBe("image/png");
    expect(result.bytes.toString()).toBe("hello world");
  });

  it("allows a manager to download any attachment", async () => {
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    const att = await persistAttachment(owner.id, { requestId: req.id }, {
      fileName: "a.png",
      mimeType: "image/png",
      bytes: Buffer.from("hello"),
    });
    const result = await getAttachmentForDownload(mgr.id, att.id);
    expect(result.filename).toBe("a.png");
  });

  it("denies the requester an attachment on an INTERNAL comment", async () => {
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    const comment = await addComment(mgr.id, req.id, { body: "internal triage", visibility: "INTERNAL" });
    const att = await persistAttachment(mgr.id, { commentId: comment.id }, {
      fileName: "notes.txt",
      mimeType: "text/plain",
      bytes: Buffer.from("secret"),
    });
    await expect(getAttachmentForDownload(owner.id, att.id)).rejects.toThrow(SupportNotFoundError);
  });

  it("allows a manager an attachment on an INTERNAL comment", async () => {
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    const comment = await addComment(mgr.id, req.id, { body: "internal triage", visibility: "INTERNAL" });
    const att = await persistAttachment(mgr.id, { commentId: comment.id }, {
      fileName: "notes.txt",
      mimeType: "text/plain",
      bytes: Buffer.from("secret"),
    });
    const result = await getAttachmentForDownload(mgr.id, att.id);
    expect(result.bytes.toString()).toBe("secret");
  });
});
