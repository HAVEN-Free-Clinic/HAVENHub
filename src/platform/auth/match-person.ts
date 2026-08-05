import { cache } from "react";
import type { Person } from "@prisma/client";
import { prisma } from "@/platform/db";

/**
 * Login → Person resolution (spec §5). SECURITY LAYERING: the NextAuth signIn
 * callback is responsible for (a) verifying the token's tenant (tid) is Yale's
 * and (b) enforcing Person.status; this module only resolves identity. The
 * domain checks below are defense-in-depth, not the primary gate.
 */

export type LoginProfile = {
  entraObjectId?: string | null;
  upn?: string | null;
  email?: string | null;
};

/**
 * What a Yale NetID looks like: 2-8 letters then optional digits ("jc999",
 * "acn38", "mmm325"). The single definition, so the login path and anything
 * WRITING Person.netId agree on what belongs in that column -- an address or
 * other free text there can never match a sign-in, and it feeds the YNHH Epic
 * access PDF, which expects a real NetID.
 */
export function isNetIdShaped(value: string): boolean {
  return /^[a-z]{2,8}[0-9]*$/i.test(value);
}

/**
 * Yale UPNs look like "abc123@yale.edu" (NetID local part).
 * Alias addresses ("first.last@yale.edu") are not NetIDs, and
 * non-Yale domains never carry NetIDs.
 */
export function netIdFromUpn(upn: string): string | null {
  const [local, domain] = upn.split("@");
  if (domain?.toLowerCase() !== "yale.edu") return null;
  if (!local) return null;
  return isNetIdShaped(local) ? local.toLowerCase() : null;
}

/**
 * The identity half of login resolution (spec §5), with NO status gate and NO
 * write of any kind: given a claim, which Person does it name?
 *
 * This is the project's single definition of "this claim belongs to that
 * Person". It is shared by resolvePersonForLogin (which adds oid linking, and
 * whose callers add the Person.status gate) and findMemberRecordByClaim (which
 * only reads the record). Keeping one copy is the point: two hand-maintained
 * copies of a trust gate drift, and a drifted copy here is an account-takeover
 * bug. Change the matching rules ONLY here.
 */
async function matchPersonByClaim(profile: LoginProfile): Promise<Person | null> {
  // 1. Already linked
  if (profile.entraObjectId) {
    const linked = await prisma.person.findUnique({
      where: { entraObjectId: profile.entraObjectId },
    });
    if (linked) return linked;
  }

  // 2. NetID extracted from UPN
  const netId = profile.upn ? netIdFromUpn(profile.upn) : null;
  if (netId) {
    const byNetId = await prisma.person.findFirst({
      where: { netId: { equals: netId, mode: "insensitive" } },
    });
    if (byNetId) return byNetId;
  }

  // 3. Email against contactEmail, but ONLY when the claim is Yale-asserted
  //    (toLowerCase().endsWith("@yale.edu")). The trust gate lives entirely on the
  //    CLAIM side: contactEmail may be a personal address (e.g. gmail), and an Entra
  //    guest can carry an arbitrary external email claim. Matching only Yale-asserted
  //    claims means such a guest can never hijack a Person via their stored personal
  //    email. A person whose stored email is personal is reached instead via
  //    netId-from-UPN (step 2) or a linked oid (step 1). A genuine Yale claim
  //    (first.last@yale.edu) never equals a stored gmail address, so no cross-match
  //    is possible either direction.
  if (profile.email && profile.email.toLowerCase().endsWith("@yale.edu")) {
    const byEmail = await prisma.person.findFirst({
      where: { contactEmail: { equals: profile.email, mode: "insensitive" as const } },
    });
    if (byEmail) return byEmail;
  }

  // 4. No match
  return null;
}

/**
 * Resolution order per spec §5. Matches via steps 2/3 link entraObjectId,
 * except when a Person is already bound to a different oid; in that case
 * linking is skipped and the stored oid remains authoritative. A step-1 match
 * is already bound to this same oid, so link() is a no-op for it.
 */
export async function resolvePersonForLogin(
  profile: LoginProfile
): Promise<Person | null> {
  const match = await matchPersonByClaim(profile);
  return match ? link(match, profile.entraObjectId) : null;
}

/**
 * The Person a verified claim names, WHATEVER their status, without linking or
 * otherwise writing. This is deliberately not an authentication path and grants
 * nothing: it exists so the apply portal can recognize a returning alum whose
 * Person.status is OFFBOARDED, which auth.ts refuses to sign in as a member
 * (resolveEntraLogin returns null for OFFBOARDED, so they arrive as a
 * prospective applicant).
 *
 * Callers MUST NOT use this to grant access. Hub access resolves through
 * resolvePersonForLogin + getActivePerson, both of which enforce
 * Person.status === "ACTIVE".
 *
 * It runs the same trust gate as sign-in, so it can only ever surface a record
 * the caller has already proven they own: a linked oid, a NetID from a Yale
 * UPN, or a Yale-asserted email. A non-Yale claim reaches nothing by email.
 */
export async function findMemberRecordByClaim(
  profile: LoginProfile
): Promise<Person | null> {
  return matchPersonByClaim(profile);
}

/**
 * Per-request person lookup for session validation: a person who has been
 * OFFBOARDED (or deleted) after sign-in must lose access immediately, not
 * when their JWT expires (spec §5 "revocations take effect immediately").
 * Memoized per request via React cache() so the multiple guards a single render
 * runs (shared layout + module layout + page) hit the DB once; the cache is
 * per-request, so a status change still takes effect on the next navigation.
 */
export const getActivePerson = cache(
  async (personId: string): Promise<Person | null> => {
    const person = await prisma.person.findUnique({ where: { id: personId } });
    if (!person || person.status !== "ACTIVE") return null;
    return person;
  }
);

/**
 * True unless the Entra token asserts a tenant (tid) different from the one we are
 * configured for. The pinned issuer already restricts sign-in to Yale's tenant, so
 * this is defense in depth. A missing tid or missing config is allowed.
 */
export function entraTenantAllowed(
  claims: { tid?: string | null },
  configuredTenantId: string | null | undefined,
): boolean {
  if (configuredTenantId && claims.tid && claims.tid !== configuredTenantId) return false;
  return true;
}

/**
 * The verified address used to key a prospective applicant. Entra always carries a
 * UPN (preferred_username); the email claim can be absent, so fall back to it, then
 * to the NextAuth-provided user email. Lowercased; null when nothing is usable.
 */
export function applicantEmailFromClaims(
  claims: { email?: string | null; preferred_username?: string | null },
  fallbackEmail?: string | null,
): string | null {
  const raw = claims.email ?? claims.preferred_username ?? fallbackEmail ?? null;
  return raw ? raw.toLowerCase() : null;
}

/**
 * Name suffixes and post-nominal credentials that can trail a display name after a
 * comma ("Jane Doe, RN"), so we don't mistake them for a "Last, First" first name.
 * Lowercased, periods stripped.
 */
const NAME_SUFFIXES = new Set([
  "jr", "sr", "ii", "iii", "iv", "v",
  "md", "do", "rn", "np", "pa", "phd", "mph", "msn", "dnp", "dds", "dmd",
  "psyd", "edd", "lcsw", "esq", "mba", "ms", "ma", "bs", "ba",
]);

/**
 * The applicant's first name for a friendly greeting, taken from the Entra sign-in.
 * Prefers the explicit `given_name` claim (present when the tenant surfaces it);
 * otherwise derives it from the display `name` claim, handling "First Last",
 * "Last, First" (common in Active Directory), and "First Last, <suffix>" (e.g.
 * "Jane Doe, RN"). Returns null when no usable name is present, so the caller can
 * greet without one rather than fall back to an email local part.
 */
export function firstNameFromClaims(claims: {
  given_name?: string | null;
  name?: string | null;
}): string | null {
  const given = claims.given_name?.trim();
  if (given) return given;
  const display = claims.name?.trim();
  if (!display) return null;
  // A comma is ambiguous: "Last, First" (the name follows the comma) vs
  // "First Last, <suffix/credential>" (the name precedes it). Take the segment
  // after the comma as the name, unless its first token is a known suffix -- then
  // the name is the segment before the comma.
  let segment = display;
  if (display.includes(",")) {
    const [before, after] = display.split(",", 2).map((s) => s.trim());
    const afterHead = after?.split(/\s+/)[0]?.toLowerCase().replace(/\./g, "");
    segment = afterHead && NAME_SUFFIXES.has(afterHead) ? before : after;
  }
  const first = segment?.split(/\s+/)[0]?.trim();
  return first || null;
}

async function link(person: Person, entraObjectId?: string | null): Promise<Person> {
  if (!entraObjectId || person.entraObjectId === entraObjectId) return person;
  // A Person already bound to a DIFFERENT oid is never re-linked here, because that would
  // let a colliding UPN/email claim hijack the record (and P2002 on the unique index).
  // The login still resolves to the person; the stored oid remains authoritative.
  if (person.entraObjectId) return person;
  return prisma.person.update({
    where: { id: person.id },
    data: { entraObjectId },
  });
}
