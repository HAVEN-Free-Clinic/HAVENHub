/**
 * Route-level authorization for the HIPAA certificate download (audit 14, TSI-04).
 *
 * This route serves the most sensitive bytes in the app -- a signed federal
 * training certificate carrying a member's full name -- and had no test of any
 * kind. canViewCertificate has its own unit tests, but nothing proved the ROUTE
 * consults it, passes (viewer, owner) in that order, or refuses before touching
 * storage. A swapped argument pair or a dropped `!allowed` would have shipped
 * green.
 *
 * The session is the only mocked collaborator: auth() cannot run outside a
 * request. Everything downstream (getActivePerson, canViewCertificate, the RBAC
 * engine, Prisma) is real, so these cases exercise the actual access decision
 * rather than a stub of it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";

vi.mock("@/platform/auth/auth", () => ({ auth: vi.fn() }));
vi.mock("@/platform/storage", () => ({ getObject: vi.fn() }));

import { auth } from "@/platform/auth/auth";
import { getObject } from "@/platform/storage";
import { GET } from "./route";

const CERT_BYTES = Buffer.from("%PDF-1.4 fake certificate");

function signedInAs(personId: string | null): void {
  vi.mocked(auth).mockResolvedValue((personId ? { personId } : null) as never);
}

function call(id: string, query = ""): Promise<Response> {
  return GET(new Request(`https://hub.test/my-info/certificate/${id}${query}`), {
    params: Promise.resolve({ id }),
  });
}

async function person(name: string, status: "ACTIVE" | "OFFBOARDED" = "ACTIVE") {
  return prisma.person.create({ data: { name, status } });
}

async function certificateFor(personId: string) {
  return prisma.hipaaCertificate.create({
    data: {
      personId,
      fileName: "HIPAA Certificate.pdf",
      storedName: "cert-abc.pdf",
      size: CERT_BYTES.byteLength,
      mimeType: "application/pdf",
    },
  });
}

/** Grant a permission through a real role assignment, so `can()` is exercised. */
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

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
  vi.mocked(getObject).mockResolvedValue(CERT_BYTES);
});

describe("GET /my-info/certificate/[id]", () => {
  it("serves the owner their own certificate", async () => {
    const owner = await person("Owner");
    const cert = await certificateFor(owner.id);
    signedInAs(owner.id);

    const res = await call(cert.id);

    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(CERT_BYTES);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(vi.mocked(getObject)).toHaveBeenCalledWith("cert-abc.pdf");
  });

  it("refuses a signed-in stranger, and never reads the bytes", async () => {
    const owner = await person("Owner");
    const stranger = await person("Stranger");
    const cert = await certificateFor(owner.id);
    signedInAs(stranger.id);

    const res = await call(cert.id);

    // 404 rather than 403: an unauthorized viewer must not learn the cert exists.
    expect(res.status).toBe(404);
    expect(vi.mocked(getObject)).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated request", async () => {
    const owner = await person("Owner");
    const cert = await certificateFor(owner.id);
    signedInAs(null);

    const res = await call(cert.id);

    expect(res.status).toBe(401);
    expect(vi.mocked(getObject)).not.toHaveBeenCalled();
  });

  it("refuses a session whose person has been offboarded since sign-in", async () => {
    const owner = await person("Owner", "OFFBOARDED");
    const cert = await certificateFor(owner.id);
    signedInAs(owner.id);

    const res = await call(cert.id);

    expect(res.status).toBe(401);
    expect(vi.mocked(getObject)).not.toHaveBeenCalled();
  });

  it("lets a compliance manager download another member's certificate", async () => {
    const owner = await person("Owner");
    const manager = await person("Compliance Manager");
    await grant(manager.id, "volunteers.manage_compliance");
    const cert = await certificateFor(owner.id);
    signedInAs(manager.id);

    expect((await call(cert.id)).status).toBe(200);
  });

  it("does not let volunteers.view alone reach a certificate", async () => {
    const owner = await person("Owner");
    const nosy = await person("Roster Viewer");
    // volunteers.view opens the roster; a certificate additionally needs the
    // viewer to manage a department the owner is an active member of.
    await grant(nosy.id, "volunteers.view");
    const cert = await certificateFor(owner.id);
    signedInAs(nosy.id);

    expect((await call(cert.id)).status).toBe(404);
  });

  it("never renders a stored text/html certificate inline", async () => {
    const owner = await person("Owner");
    const cert = await prisma.hipaaCertificate.create({
      data: {
        personId: owner.id,
        fileName: "cert.html",
        storedName: "cert-evil.html",
        size: 10,
        // Imported rows carry whatever mimeType the source recorded, so an
        // inline text/html would execute script on our own origin.
        mimeType: "text/html",
      },
    });
    signedInAs(owner.id);

    const res = await call(cert.id, "?inline=1");

    expect(res.headers.get("Content-Disposition")).toContain("attachment");
  });
});
