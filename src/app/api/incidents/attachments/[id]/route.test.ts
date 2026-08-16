/**
 * Route-level authorization for incident evidence downloads (audit 14, TSI-04).
 *
 * This route had no test at all. Its access rule is not expressed anywhere else
 * -- it is written inline in the handler -- so nothing but this file proves that
 * a manager who is a SUBJECT of the report cannot pull the evidence filed
 * against them. That rule protects the whole reporting channel: a director who
 * could read the photos naming them would make anonymous reporting worthless.
 *
 * Only auth() is mocked (it cannot run outside a request) plus storage. The RBAC
 * engine and Prisma are real, so the branches below are the real decision.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";

vi.mock("@/platform/auth/auth", () => ({ auth: vi.fn() }));
vi.mock("@/platform/storage", () => ({ getObject: vi.fn() }));

import { auth } from "@/platform/auth/auth";
import { getObject } from "@/platform/storage";
import { GET } from "./route";

const EVIDENCE = Buffer.from("photo-bytes");

function signedInAs(personId: string | null): void {
  vi.mocked(auth).mockResolvedValue((personId ? { personId } : null) as never);
}

function call(id: string, query = ""): Promise<Response> {
  return GET(new Request(`https://hub.test/api/incidents/attachments/${id}${query}`), {
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

async function reportWithEvidence(reporterId: string, subjectIds: string[] = []) {
  const report = await prisma.incidentReport.create({
    data: {
      reporterId,
      description: "Something happened.",
      subjects: { create: subjectIds.map((personId) => ({ personId })) },
    },
  });
  return prisma.incidentReportAttachment.create({
    data: {
      reportId: report.id,
      fileName: "evidence.png",
      storedName: "incidents/evidence-1.png",
      size: EVIDENCE.byteLength,
      mimeType: "image/png",
      uploadedById: reporterId,
    },
  });
}

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
  vi.mocked(getObject).mockResolvedValue(EVIDENCE);
});

describe("GET /api/incidents/attachments/[id]", () => {
  it("serves the reporter their own evidence", async () => {
    const reporter = await person("Reporter");
    const attachment = await reportWithEvidence(reporter.id);
    signedInAs(reporter.id);

    const res = await call(attachment.id);

    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(EVIDENCE);
    expect(vi.mocked(getObject)).toHaveBeenCalledWith("incidents/evidence-1.png");
  });

  it("refuses a signed-in stranger, and never reads the bytes", async () => {
    const reporter = await person("Reporter");
    const stranger = await person("Stranger");
    const attachment = await reportWithEvidence(reporter.id);
    signedInAs(stranger.id);

    const res = await call(attachment.id);

    // 404, not 403: a stranger must not learn the attachment exists.
    expect(res.status).toBe(404);
    expect(vi.mocked(getObject)).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated request", async () => {
    const reporter = await person("Reporter");
    const attachment = await reportWithEvidence(reporter.id);
    signedInAs(null);

    expect((await call(attachment.id)).status).toBe(401);
    expect(vi.mocked(getObject)).not.toHaveBeenCalled();
  });

  it("lets an incidents manager download evidence", async () => {
    const reporter = await person("Reporter");
    const manager = await person("Manager");
    await grant(manager.id, "incidents.manage");
    const attachment = await reportWithEvidence(reporter.id);
    signedInAs(manager.id);

    expect((await call(attachment.id)).status).toBe(200);
  });

  it("refuses a manager who is a subject of the report they are reading about", async () => {
    const reporter = await person("Reporter");
    const accusedManager = await person("Accused Manager");
    await grant(accusedManager.id, "incidents.manage");
    const attachment = await reportWithEvidence(reporter.id, [accusedManager.id]);
    signedInAs(accusedManager.id);

    const res = await call(attachment.id);

    expect(res.status).toBe(404);
    expect(vi.mocked(getObject)).not.toHaveBeenCalled();
  });

  it("never renders a stored text/html attachment inline", async () => {
    const reporter = await person("Reporter");
    const report = await prisma.incidentReport.create({
      data: { reporterId: reporter.id, description: "d" },
    });
    const attachment = await prisma.incidentReportAttachment.create({
      data: {
        reportId: report.id,
        fileName: "note.html",
        storedName: "incidents/note.html",
        size: 5,
        // The uploader's browser supplies mimeType, so inline text/html here
        // would be stored XSS on our own origin.
        mimeType: "text/html",
        uploadedById: reporter.id,
      },
    });
    signedInAs(reporter.id);

    const res = await call(attachment.id, "?inline=1");

    expect(res.headers.get("Content-Disposition")).toContain("attachment");
  });
});
