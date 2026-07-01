import { prisma } from "@/platform/db";
import { complianceStatus, type ComplianceStatus } from "./rules";

/**
 * Compute the live compliance status for every Person, keyed by person id.
 *
 * Mirrors the reminder engine's rule (reminders.ts): take the newest
 * certificate by uploadedAt and apply {@link complianceStatus} against the
 * active term's end date. Persons with no certificate resolve to
 * NO_CERTIFICATE, so the returned map covers the entire Person table, never
 * the stale, engine-derived subset that ComplianceReminder rows represent.
 *
 * @param termEnd  End date of the active term, or null when none is active.
 * @param now      Reference timestamp (defaults to the current wall clock).
 */
export async function loadComplianceStatusMap(
  termEnd: Date | null,
  now: Date = new Date(),
): Promise<Map<string, ComplianceStatus>> {
  const persons = await prisma.person.findMany({ select: { id: true } });

  // Newest cert per person: order by (personId asc, uploadedAt desc) and keep
  // the first row seen for each personId.
  const certs = await prisma.hipaaCertificate.findMany({
    orderBy: [{ personId: "asc" }, { uploadedAt: "desc" }],
    select: { personId: true, completionDate: true, verifiedAt: true },
  });
  const newestCert = new Map<string, { completionDate: Date | null; verifiedAt: Date | null }>();
  for (const c of certs) {
    if (!newestCert.has(c.personId)) {
      newestCert.set(c.personId, { completionDate: c.completionDate, verifiedAt: c.verifiedAt });
    }
  }

  const statusByPerson = new Map<string, ComplianceStatus>();
  for (const p of persons) {
    statusByPerson.set(p.id, complianceStatus(newestCert.get(p.id) ?? null, termEnd, now));
  }
  return statusByPerson;
}
