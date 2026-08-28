import type { Track } from "@prisma/client";
import { prisma } from "@/platform/db";
import { findMemberRecordByClaim } from "@/platform/auth/match-person";

/** The Entra claims behind a Yale SSO sign-in. Null for every other portal path
 *  (the applicant magic-link cookie, which proves only mailbox control). */
export type SsoClaim = { upn: string | null; email: string | null };

/**
 * The Person whose membership history decides the returning branch, for a visitor
 * who has already proven their identity to the portal.
 *
 * Normally that is the session's Person, and this returns it unchanged. It is not,
 * for exactly one group: a member offboarded at a term flip. resolveEntraLogin
 * (auth.ts) returns null for Person.status "OFFBOARDED", so they sign in
 * successfully and arrive with personId null, indistinguishable from a stranger to
 * everything downstream. Offboarding does not touch their TermMembership rows, so
 * the eligibility question still has a real answer; nothing was asking it.
 *
 * That is not a rare corner. The clinic's rule is continuity with summer excepted,
 * so a spring volunteer applying in the fall IS returning, and the spring-to-summer
 * offboarding sweep hits precisely that cohort: 253 of the 277 people whose last
 * active volunteer term was Spring 2026 were locked out of the Fall 2026 form's
 * returning branch, 230 of them from a renewal they qualified for. Having picked
 * "Renewing", they were then shown a Yale sign-in button they had just used.
 *
 * GRANTS NOTHING. findMemberRecordByClaim runs the same trust gate as sign-in (a
 * linked oid, a NetID from a Yale UPN, or a Yale-asserted email), so it can only
 * ever surface a record the caller has already proven they own, and the id returned
 * here is used only to read membership history, prefill the applicant's own stored
 * details, and stamp Application.applicantPersonId. Hub access still resolves
 * through resolvePersonForLogin + getActivePerson, both of which require
 * Person.status ACTIVE.
 *
 * SSO ONLY, deliberately. The claim must come from Entra, never from the applicant
 * magic-link cookie: that cookie proves control of a mailbox, and any @yale.edu
 * address can request one (portal-actions.ts does not reserve the domain). Treating
 * it as a Yale assertion would let mailbox possession stand in for SSO on the one
 * path that reads someone's membership record. Passing `sso: null` therefore falls
 * back to the session Person alone, which is what the pre-existing "sign in with
 * Yale to apply as a returning member" gate already told those visitors.
 */
export async function resolveReturningPersonId(
  sessionPersonId: string | null | undefined,
  sso: SsoClaim | null,
): Promise<string | null> {
  if (sessionPersonId) return sessionPersonId;
  // Both claims are offered because they reach a Person through different branches
  // of matchPersonByClaim and Yale sends them in different forms: the UPN is the
  // NetID-shaped one ("jc999@yale.edu"), the email claim is usually the alias
  // ("jack.carney@yale.edu"). 252 of the 253 people above are stored with an
  // alias-style contactEmail, so dropping either claim loses most of them.
  const upn = sso?.upn ?? sso?.email ?? null;
  const email = sso?.email ?? null;
  if (!upn && !email) return null;
  const person = await findMemberRecordByClaim({ upn, email });
  return person?.id ?? null;
}

export type RenewalContext = {
  personId: string;
  name: string | null;
  email: string | null;
  netId: string | null;
  phone: string | null;
  currentDepartments: string[];
  eligible: boolean;
};

/**
 * Eligibility + identity for a returning applicant. `kind` is the cycle's track
 * (VOLUNTEER or DIRECTOR): a returning director renews against their director
 * membership, a returning volunteer against their volunteer membership. `email`
 * is the verified session (Entra) address, returned verbatim, never read from
 * Person.contactEmail. Departments are the codes from the person's active
 * memberships of that kind in their most-recent term (by term.startDate).
 */
export async function getRenewalContext(personId: string, sessionEmail: string | null, kind: Track): Promise<RenewalContext> {
  const person = await prisma.person.findUnique({
    where: { id: personId },
    include: {
      memberships: {
        where: { kind, status: "ACTIVE" },
        include: { term: { select: { startDate: true } }, department: { select: { code: true } } },
      },
    },
  });
  if (!person) {
    return { personId, name: null, email: sessionEmail, netId: null, phone: null, currentDepartments: [], eligible: false };
  }
  let latest = 0;
  for (const m of person.memberships) latest = Math.max(latest, m.term.startDate.getTime());
  const currentDepartments = latest
    ? Array.from(new Set(person.memberships.filter((m) => m.term.startDate.getTime() === latest).map((m) => m.department.code)))
    : [];
  return {
    personId,
    name: person.name,
    email: sessionEmail,
    netId: person.netId,
    phone: person.phone,
    currentDepartments,
    eligible: currentDepartments.length > 0,
  };
}

/**
 * Maps a renewal context onto a cycle's field keys. Uses the guaranteed identity
 * keys plus field semantics (the same conventions submissions.ts relies on).
 * Fields that match nothing are left unset (off-convention forms simply do not
 * prefill). Department is handled by the form's renewal-department control.
 */
export function resolveRenewalPrefill(
  fields: { key: string; type: string }[],
  ctx: RenewalContext,
): { values: Record<string, string>; lockedKeys: string[] } {
  const values: Record<string, string> = {};
  const lockedKeys: string[] = [];

  const name = (ctx.name ?? "").trim();
  if (name) {
    const sp = name.indexOf(" ");
    values.first_name = sp === -1 ? name : name.slice(0, sp);
    values.last_name = sp === -1 ? "" : name.slice(sp + 1).trim();
  }

  for (const f of fields) {
    if ((f.type === "EMAIL" || f.key === "email") && ctx.email) {
      values[f.key] = ctx.email;
      lockedKeys.push(f.key);
    } else if ((f.type === "PHONE" || f.key === "phone") && ctx.phone) {
      values[f.key] = ctx.phone;
    } else if (f.key === "net_id" && ctx.netId) {
      // A person with an existing record cannot edit their NetID: lock it like the
      // verified email. Only locked when the record actually has one -- a record
      // without a NetID leaves the field editable so it can still be supplied.
      values[f.key] = ctx.netId;
      lockedKeys.push(f.key);
    }
  }
  return { values, lockedKeys };
}
