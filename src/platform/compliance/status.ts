import { prisma } from "@/platform/db";
import { effectiveComplianceStatus, type ComplianceStatus } from "./rules";

/**
 * Compute the live compliance status for every Person, keyed by person id.
 *
 * Uses {@link effectiveComplianceStatus} over each person's FULL certificate
 * history, exactly like clearance, the dashboard, and the reminder engine: an
 * unverified early renewal falls back to an older still-valid VERIFIED cert
 * rather than un-clearing the person. Previously this took only the newest cert
 * and applied complianceStatus(), so a person mid-renewal was classified
 * differently in campaign audiences than everywhere else. Persons with no
 * certificate resolve to NO_CERTIFICATE, so the returned map covers the entire
 * Person table, never the stale, engine-derived subset that ComplianceReminder
 * rows represent.
 *
 * @param termEnd  End date of the active term, or null when none is active.
 * @param now      Reference timestamp (defaults to the current wall clock).
 */
export async function loadComplianceStatusMap(
  termEnd: Date | null,
  now: Date = new Date(),
): Promise<Map<string, ComplianceStatus>> {
  const persons = await prisma.person.findMany({ select: { id: true } });

  // Full cert history per person, newest-first (personId asc, uploadedAt desc),
  // so effectiveComplianceStatus can apply its verified-fallback.
  const certs = await prisma.hipaaCertificate.findMany({
    orderBy: [{ personId: "asc" }, { uploadedAt: "desc" }],
    select: { personId: true, completionDate: true, verifiedAt: true },
  });
  const certsByPerson = new Map<string, Array<{ completionDate: Date | null; verifiedAt: Date | null }>>();
  for (const c of certs) {
    const list = certsByPerson.get(c.personId);
    if (list) list.push({ completionDate: c.completionDate, verifiedAt: c.verifiedAt });
    else certsByPerson.set(c.personId, [{ completionDate: c.completionDate, verifiedAt: c.verifiedAt }]);
  }

  const statusByPerson = new Map<string, ComplianceStatus>();
  for (const p of persons) {
    statusByPerson.set(p.id, effectiveComplianceStatus(certsByPerson.get(p.id) ?? [], termEnd, now));
  }
  return statusByPerson;
}
