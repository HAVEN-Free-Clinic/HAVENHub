/**
 * Route-level authorization for support attachment downloads (audit 14, TSI-04).
 *
 * getAttachmentForDownload is well covered as a service, but the route that
 * exposes it to the internet had no test: nothing proved it passes the SESSION's
 * person id (rather than, say, the uploader's) as the actor, that it maps
 * SupportNotFoundError to a 404 instead of a 500, or that it refuses before the
 * service ever loads bytes. Support tickets routinely carry screenshots of
 * rosters and patient-adjacent systems.
 *
 * Only auth() and storage are mocked; the service, the RBAC engine, and Prisma
 * are real, so the "stranger" case below is the real access decision.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";

vi.mock("@/platform/auth/auth", () => ({ auth: vi.fn() }));
vi.mock("@/platform/storage", () => ({ getObject: vi.fn(), putObject: vi.fn() }));

import { auth } from "@/platform/auth/auth";
import { getObject } from "@/platform/storage";
import { GET } from "./route";

const FILE = Buffer.from("screenshot-bytes");

function signedInAs(personId: string | null): void {
  vi.mocked(auth).mockResolvedValue((personId ? { personId } : null) as never);
}

function call(id: string): Promise<Response> {
  return GET(new Request(`https://hub.test/support/attachment/${id}`), {
    params: Promise.resolve({ id }),
  });
}

async function person(name: string) {
  return prisma.person.create({ data: { name } });
}

let roleSeq = 0;
async function grant(personId: string, permission: string) {
  const role = await prisma.role.create({
    data: {
      name: `Role-${permission}-${++roleSeq}`,
      isSystem: false,
      grants: { create: [{ permission }] },
    },
  });
  await prisma.roleAssignment.create({ data: { roleId: role.id, personId, termId: null } });
}

async function ticketWithAttachment(
  requesterId: string,
  file: { filename?: string; mimeType?: string } = {},
) {
  const request = await prisma.techRequest.create({
    data: {
      requesterId,
      category: "OTHER",
      subject: "Printer is down",
      description: "It makes a noise.",
    },
  });
  return prisma.techRequestAttachment.create({
    data: {
      requestId: request.id,
      storageKey: "support/ticket-1/file.png",
      filename: file.filename ?? "screenshot.png",
      mimeType: file.mimeType ?? "image/png",
      size: FILE.byteLength,
      uploadedById: requesterId,
    },
  });
}

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
  vi.mocked(getObject).mockResolvedValue(FILE);
});

describe("GET /support/attachment/[id]", () => {
  it("serves the requester their own ticket attachment", async () => {
    const requester = await person("Requester");
    const attachment = await ticketWithAttachment(requester.id);
    signedInAs(requester.id);

    const res = await call(attachment.id);

    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(FILE);
    expect(vi.mocked(getObject)).toHaveBeenCalledWith("support/ticket-1/file.png");
  });

  it("refuses a signed-in stranger, and never reads the bytes", async () => {
    const requester = await person("Requester");
    const stranger = await person("Stranger");
    const attachment = await ticketWithAttachment(requester.id);
    signedInAs(stranger.id);

    const res = await call(attachment.id);

    // 404, not 403: a stranger must not learn the attachment exists.
    expect(res.status).toBe(404);
    expect(vi.mocked(getObject)).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated request", async () => {
    const requester = await person("Requester");
    const attachment = await ticketWithAttachment(requester.id);
    signedInAs(null);

    expect((await call(attachment.id)).status).toBe(401);
    expect(vi.mocked(getObject)).not.toHaveBeenCalled();
  });

  it("lets a support manager download another member's attachment", async () => {
    const requester = await person("Requester");
    const manager = await person("Support Manager");
    await grant(manager.id, "support.manage_requests");
    const attachment = await ticketWithAttachment(requester.id);
    signedInAs(manager.id);

    expect((await call(attachment.id)).status).toBe(200);
  });

  it("404s an attachment id that does not exist, rather than throwing", async () => {
    const requester = await person("Requester");
    signedInAs(requester.id);

    expect((await call("no-such-attachment")).status).toBe(404);
  });

  it("forces a download even for an image, and never renders inline", async () => {
    const requester = await person("Requester");
    // mimeType is whatever the uploader's browser claimed, so this route never
    // sends inline -- an inline text/html would be stored XSS on our origin.
    const attachment = await ticketWithAttachment(requester.id, {
      filename: "note.html",
      mimeType: "text/html",
    });
    signedInAs(requester.id);

    const res = await call(attachment.id);

    expect(res.headers.get("Content-Disposition")).toContain("attachment");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});
