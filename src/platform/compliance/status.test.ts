import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { loadComplianceStatusMap, loadHipaaExpiryMap } from "./status";
import { certExpiresAt } from "./rules";

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

  // #125/#129: campaign audiences used newest-cert-only, so a person mid-renewal
  // was classified differently here than everywhere else. Use the full-history
  // verified-fallback, matching clearance/dashboard/reminders.
  it("applies the verified-fallback: an unverified renewal over a still-valid verified cert reads COMPLIANT", async () => {
    const termEnd = new Date(NOW.getTime() + 10 * DAY);
    const p = await person("Renewing");
    // Older verified cert is still valid (COMPLIANT).
    await cert(p.id, new Date(NOW.getTime() - 200 * DAY), new Date(NOW.getTime() - 50 * DAY));
    // Newest cert is an unverified early renewal (would be PENDING_VERIFICATION alone).
    await cert(p.id, new Date(NOW.getTime() - 5 * DAY), new Date(NOW.getTime() - 1 * DAY), null);

    const map = await loadComplianceStatusMap(termEnd, NOW);
    expect(map.get(p.id)).toBe("COMPLIANT");
  });
});

describe("loadHipaaExpiryMap", () => {
  it("computes completion date + CERT_VALIDITY_DAYS, covering every person", async () => {
    const termEnd = new Date(NOW.getTime() + 10 * DAY);
    const completionDate = new Date(NOW.getTime() - 200 * DAY);

    const withCert = await person("Has Cert");
    await cert(withCert.id, completionDate, NOW);

    const noCert = await person("No Cert");

    const map = await loadHipaaExpiryMap(termEnd, NOW);

    expect(map.get(withCert.id)).toEqual(certExpiresAt(completionDate));
    // No certificate at all -> no computable expiry.
    expect(map.get(noCert.id)).toBeNull();
    expect(map.size).toBe(2);
  });

  it("resolves an unverified cert's completion date too -- expiry is about the DATE, not verification", async () => {
    const termEnd = new Date(NOW.getTime() + 10 * DAY);
    const completionDate = new Date(NOW.getTime() - 200 * DAY);
    const p = await person("Unverified");
    await cert(p.id, completionDate, NOW, null);

    const map = await loadHipaaExpiryMap(termEnd, NOW);
    expect(map.get(p.id)).toEqual(certExpiresAt(completionDate));
  });

  it("a cert with no parsed completion date has no computable expiry", async () => {
    const termEnd = new Date(NOW.getTime() + 10 * DAY);
    const p = await person("Undated");
    await cert(p.id, null, NOW, null);

    const map = await loadHipaaExpiryMap(termEnd, NOW);
    expect(map.get(p.id)).toBeNull();
  });

  // The trap this whole field exists to avoid: mid-renewal, the newest upload
  // is an unverified early renewal, so effectiveComplianceStatus falls back to
  // the older still-valid VERIFIED cert. The expiry map must select the SAME
  // certificate, or a "certificates expiring soon" campaign would target a
  // different person than the compliance page shows as expiring soon for the
  // exact same underlying data.
  it("applies the same verified-fallback effectiveComplianceStatus does: expiry comes from the older still-valid VERIFIED cert, not the newest unverified upload", async () => {
    const termEnd = new Date(NOW.getTime() + 10 * DAY);
    const p = await person("Renewing");
    const olderCompletionDate = new Date(NOW.getTime() - 200 * DAY); // still valid (COMPLIANT)
    await cert(p.id, olderCompletionDate, new Date(NOW.getTime() - 50 * DAY));
    // Newest cert (by uploadedAt) is an unverified early renewal.
    const newerCompletionDate = new Date(NOW.getTime() - 5 * DAY);
    await cert(p.id, newerCompletionDate, new Date(NOW.getTime() - 1 * DAY), null);

    const statusMap = await loadComplianceStatusMap(termEnd, NOW);
    expect(statusMap.get(p.id)).toBe("COMPLIANT"); // sanity: confirms the fallback fired

    const expiryMap = await loadHipaaExpiryMap(termEnd, NOW);
    // Must match the OLDER verified cert's expiry, not the newer unverified one.
    expect(expiryMap.get(p.id)).toEqual(certExpiresAt(olderCompletionDate));
    expect(expiryMap.get(p.id)).not.toEqual(certExpiresAt(newerCompletionDate));
  });
});
