import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";

vi.mock("@/platform/posthog/capture", () => ({ captureEvent: vi.fn() }));
vi.mock("@/platform/posthog/groups", () => ({
  activeTermGroup: vi.fn(async () => ({ term: "term-1" })),
}));

import { captureEvent } from "@/platform/posthog/capture";
import { verifyCertificate } from "./compliance";

async function grantPermission(personId: string, permission: string) {
  const role = await prisma.role.create({
    data: { name: `Role-${permission}-${Math.random()}`, isSystem: false, grants: { create: [{ permission }] } },
  });
  await prisma.roleAssignment.create({ data: { roleId: role.id, personId, termId: null } });
}

async function createCert(personId: string) {
  const id = `cert-${Math.random().toString(36).slice(2)}`;
  return prisma.hipaaCertificate.create({
    data: {
      personId,
      fileName: "test.pdf",
      storedName: `${id}.pdf`,
      size: 100,
      mimeType: "application/pdf",
      completionDate: new Date(Date.UTC(2025, 5, 1, 12)),
      uploadedAt: new Date(),
    },
  });
}

const calls = () =>
  vi.mocked(captureEvent).mock.calls.map(
    (c) => c[0] as { event: string; distinctId: string; properties?: Record<string, unknown> },
  );

beforeEach(async () => {
  vi.clearAllMocks();
  await resetDb();
});
afterEach(resetDb);

describe("verifyCertificate PostHog event", () => {
  it("fires hipaa_certificate_verified for the cert owner on first verify only", async () => {
    const actor = await prisma.person.create({ data: { name: "Mgr", status: "ACTIVE" } });
    await grantPermission(actor.id, "volunteers.manage_compliance");
    const owner = await prisma.person.create({ data: { name: "Vol", status: "ACTIVE" } });
    const cert = await createCert(owner.id);

    await verifyCertificate(actor.id, cert.id);
    expect(calls().map((c) => c.event)).toEqual(["hipaa_certificate_verified"]);
    expect(calls()[0].distinctId).toBe(owner.id);
    expect(calls()[0].properties).toMatchObject({ verified_by: actor.id, via: "verify" });

    vi.clearAllMocks();
    await verifyCertificate(actor.id, cert.id); // re-verify: already verified
    expect(calls()).toEqual([]);
  });
});
