import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { loadComplianceStatusMap } from "./status";

beforeEach(resetDb);

const NOW = new Date("2026-06-01T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

async function person(name: string) {
  return prisma.person.create({ data: { name } });
}

async function cert(
  personId: string,
  completionDate: Date | null,
  uploadedAt: Date,
  // Dated certs default to verified so they resolve to their date-based status;
  // pass null to exercise the awaiting-verification gate.
  verifiedAt: Date | null = completionDate ? uploadedAt : null,
) {
  return prisma.hipaaCertificate.create({
    data: {
      personId,
      fileName: "c.pdf",
      storedName: "c.pdf",
      size: 1,
      mimeType: "application/pdf",
      completionDate,
      uploadedAt,
      verifiedAt,
    },
  });
}

describe("loadComplianceStatusMap", () => {
  it("derives status live from the newest cert + term end, covering every person", async () => {
    const termEnd = new Date(NOW.getTime() + 10 * DAY);

    const compliant = await person("Compliant"); // expires NOW+165d -> COMPLIANT
    await cert(compliant.id, new Date(NOW.getTime() - 200 * DAY), NOW);

    const expired = await person("Expired"); // expires NOW-35d -> EXPIRED
    await cert(expired.id, new Date(NOW.getTime() - 400 * DAY), NOW);

    const noCert = await person("No Cert"); // no row -> NO_CERTIFICATE

    const map = await loadComplianceStatusMap(termEnd, NOW);

    expect(map.get(compliant.id)).toBe("COMPLIANT");
    expect(map.get(expired.id)).toBe("EXPIRED");
    expect(map.get(noCert.id)).toBe("NO_CERTIFICATE");
    // Every person is covered, including those with no certificate.
    expect(map.size).toBe(3);
  });

  it("uses the newest certificate by uploadedAt", async () => {
    const termEnd = new Date(NOW.getTime() + 10 * DAY);
    const p = await person("Two Certs");
    // Older cert is compliant; the newer (by uploadedAt) cert is expired, so the
    // newest wins and the person resolves to EXPIRED.
    await cert(p.id, new Date(NOW.getTime() - 200 * DAY), new Date(NOW.getTime() - 50 * DAY));
    await cert(p.id, new Date(NOW.getTime() - 400 * DAY), new Date(NOW.getTime() - 1 * DAY));

    const map = await loadComplianceStatusMap(termEnd, NOW);
    expect(map.get(p.id)).toBe("EXPIRED");
  });

  it("classifies a dated but unverified cert as PENDING_VERIFICATION", async () => {
    const termEnd = new Date(NOW.getTime() + 10 * DAY);
    const p = await person("Unverified");
    // Date would otherwise read COMPLIANT, but no human has verified it.
    await cert(p.id, new Date(NOW.getTime() - 200 * DAY), NOW, null);

    const map = await loadComplianceStatusMap(termEnd, NOW);
    expect(map.get(p.id)).toBe("PENDING_VERIFICATION");
  });
});
