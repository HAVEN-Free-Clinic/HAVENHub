import { prisma } from "@/platform/db";
import { certExpiresAt, effectiveCompliance, effectiveComplianceStatus, type ComplianceStatus } from "./rules";

type CertRow = { completionDate: Date | null; verifiedAt: Date | null };

/**
 * Every person's full certificate history, newest-first (personId asc,
 * uploadedAt desc), so {@link effectiveCompliance} (and the
 * `effectiveComplianceStatus` wrapper around it) can apply its
 * verified-fallback. Shared by {@link loadComplianceStatusMap} and
 * {@link loadHipaaExpiryMap} so both select their effective certificate from
 * the exact same rows -- two separate queries computing "the effective cert"
 * from data that could theoretically be fetched differently is exactly the
 * kind of drift that made campaign audiences disagree with the compliance page
 * once already (#125/#129, see effectiveCompliance's doc comment).
 */
async function loadCertHistoryByPerson(): Promise<Map<string, CertRow[]>> {
  const certs = await prisma.hipaaCertificate.findMany({
    orderBy: [{ personId: "asc" }, { uploadedAt: "desc" }],
    select: { personId: true, completionDate: true, verifiedAt: true },
  });
  const certsByPerson = new Map<string, CertRow[]>();
  for (const c of certs) {
    const list = certsByPerson.get(c.personId);
    if (list) list.push({ completionDate: c.completionDate, verifiedAt: c.verifiedAt });
    else certsByPerson.set(c.personId, [{ completionDate: c.completionDate, verifiedAt: c.verifiedAt }]);
  }
  return certsByPerson;
}

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
  const certsByPerson = await loadCertHistoryByPerson();

  const statusByPerson = new Map<string, ComplianceStatus>();
  for (const p of persons) {
    statusByPerson.set(p.id, effectiveComplianceStatus(certsByPerson.get(p.id) ?? [], termEnd, now));
  }
  return statusByPerson;
}

/**
 * Compute the live HIPAA certificate expiry date for every Person, keyed by
 * person id. `null` means no computable expiry: no certificate at all, or the
 * certificate {@link effectiveCompliance} selects has no parsed completionDate
 * (UNKNOWN_DATE, with no verified fallback available either).
 *
 * Expiry is DERIVED (completionDate + {@link CERT_VALIDITY_DAYS} days, via
 * {@link certExpiresAt}), never stored, so it cannot be a plain relation date
 * the way `hipaaCompletedAt`/`hipaaVerifiedAt` are. It is precomputed here, on
 * the same seam `complianceStatusByPerson` already uses (see AudienceCtx in
 * person-fields.ts), rather than expressed as a shifted boundary over
 * `completionDate` in the operator layer -- see the two reasons below, both of
 * which the alternative cannot satisfy:
 *
 * 1. SELECTING the right certificate. `effectiveComplianceStatus` does not
 *    simply read the newest cert: when the newest is an unverified early
 *    renewal (PENDING_VERIFICATION) or dateless (UNKNOWN_DATE), it falls back
 *    to the older still-valid VERIFIED cert, so clearance is not revoked while
 *    a fresh upload awaits a coordinator. A relation-date field over
 *    `completionDate` has no way to express that selection -- Prisma's `some`
 *    only tests "does ANY related row satisfy this date predicate", it cannot
 *    pick the SAME row `effectiveCompliance` would pick. Reusing
 *    `effectiveCompliance` directly (as this function does) is the only way to
 *    keep `hipaaExpiresAt` from silently disagreeing with `complianceStatus`
 *    for the same person -- exactly the class of bug the doc comment on
 *    `effectiveCompliance` describes already happening once (audit 14, L3).
 * 2. CENTRALIZING the derivation. Precomputing the date here means
 *    `CERT_VALIDITY_DAYS` is read from `rules.ts` in exactly one place; a
 *    relation-date-plus-shifted-boundary approach would need every consumer
 *    (or the operator layer itself) to re-derive the offset, and would drift
 *    the moment that lifetime becomes configurable per person or per program.
 *
 * `termEnd` does not change WHICH certificate gets selected -- `complianceStatus`
 * only uses it to choose between the COMPLIANT and EXPIRING_SOON labels, and
 * `effectiveCompliance`'s fallback loop treats both labels as "found a usable
 * cert" -- but it is threaded through anyway so this calls `effectiveCompliance`
 * exactly the way `loadComplianceStatusMap` does, rather than asking every
 * caller to re-prove that non-dependence for itself.
 *
 * @param termEnd  End date of the active term, or null when none is active.
 * @param now      Reference timestamp (defaults to the current wall clock).
 */
export async function loadHipaaExpiryMap(
  termEnd: Date | null,
  now: Date = new Date(),
): Promise<Map<string, Date | null>> {
  const persons = await prisma.person.findMany({ select: { id: true } });
  const certsByPerson = await loadCertHistoryByPerson();

  const expiryByPerson = new Map<string, Date | null>();
  for (const p of persons) {
    const { cert } = effectiveCompliance(certsByPerson.get(p.id) ?? [], termEnd, now);
    expiryByPerson.set(p.id, cert?.completionDate ? certExpiresAt(cert.completionDate) : null);
  }
  return expiryByPerson;
}
