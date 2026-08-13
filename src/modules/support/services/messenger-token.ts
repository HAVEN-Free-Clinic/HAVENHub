/**
 * Mints the signed-in person's Intercom Messenger identity-verification JWT.
 *
 * Identity verification is the entire point. Without it the Messenger boots on
 * browser-supplied attributes, so anyone could open devtools and hold a support
 * conversation as another member. Every claim here comes from the server session
 * and the live Person row; nothing is taken from a request body or query.
 *
 * Shared by the token route (src/app/api/support/messenger-token) and the server
 * render of (app)/layout.tsx, so a first token and a refreshed token can never
 * drift apart in claims or TTL.
 *
 * WHY THIS LIVES IN src/modules/support RATHER THAN src/platform/intercom, where
 * the rest of the Intercom code sits: it calls getOnboardingStatus from
 * @/modules/onboarding, and eslint forbids src/platform from importing any
 * module (twice over -- no-restricted-imports on src/platform/**, plus an
 * import/no-restricted-paths zone catching relative-path evasion). It cannot
 * live under src/app either without filing support-domain logic by whichever
 * HTTP route happens to call it first.
 *
 * That location is legal only because neither "support" nor "onboarding" appears
 * in eslint.config.mjs's MODULE_IDS, which is an omission rather than a
 * decision: the generated rule forbids each LISTED module from importing every
 * other listed one, so adding EITHER name to that list breaks this file and
 * epic-rollup.ts alongside it. Whoever adds "onboarding" will be thinking about
 * onboarding, not about two files in support -- move the shared code first.
 */

import { auth } from "@/platform/auth/auth";
import { prisma, isDbUnreachableError } from "@/platform/db";
import { getActivePerson } from "@/platform/auth/match-person";
import { log, errorAttrs } from "@/platform/logging";
import { isIntercomConfigured } from "@/platform/intercom/config";
import { mintIntercomUserJwt, INTERCOM_TOKEN_TTL_SECONDS } from "@/platform/intercom/jwt";
import { buildAudienceAttributes } from "@/platform/intercom/audience";
import { buildProfileAttributes } from "@/platform/intercom/profile";
import { getEffectivePermissions } from "@/platform/rbac/engine";
import { getActiveTerm } from "@/platform/terms/active-term";
import { getOnboardingStatus } from "@/modules/onboarding/services/onboarding";

/**
 * Why a discriminated result rather than `string | null`: each refusal means
 * something specific, and both callers need to tell them apart.
 *
 *   not_configured       the integration is off, so the route 404s (looking
 *                        absent rather than half-configured) and the layout
 *                        mints nothing
 *   unauthorized         no session, OR a session resolving to no active
 *                        Person. That second case IS the offboarding
 *                        revocation check: an offboarded member must stop
 *                        getting tokens while their hub JWT is still valid
 *   membership_required  a Person, but requireActiveMembership was asked for
 *                        and they hold no ACTIVE TermMembership this term
 *   db_unreachable       we could not run the revocation check, so we refuse
 *                        rather than resolving as "still active"
 *
 * Collapsing these to null would force each caller to re-derive them, or to
 * skip them silently.
 */
export type MintResult =
  | { ok: true; token: string; expiresInSeconds: number }
  | { ok: false; reason: "not_configured" | "unauthorized" | "membership_required" | "db_unreachable" };

export async function mintMessengerTokenForSession(opts?: {
  /**
   * The /apply portal's identity rule: also require a current ACTIVE
   * TermMembership before minting.
   *
   * This can only ADD a restriction on top of the checks below, never remove
   * one, so a caller cannot use it to obtain an identified boot it would not
   * already be eligible for. The hub deliberately does not pass it -- a member
   * between terms has no row in the query below but still signs into the hub
   * and must still be identified (see cross-term-overlap-model, and the (app)
   * layout's own comment on this split) -- so the flag's ABSENCE is what keeps
   * that case working, not a gap in enforcement.
   *
   * SECURITY, and the reason this is a mint-time check rather than only a
   * client-side one: IntercomMessenger's 401/403-to-visitor fallback is guarded
   * on `!booted`, and a server-minted `initialToken` sets `booted` at mount. Any
   * surface that passes BOTH initialToken and this flag therefore has no working
   * client-side gate -- it is unreachable by construction. If /apply ever gets a
   * server-minted token, this check is the only thing standing between a
   * stranger and an identified boot, and its absence produces no error anywhere.
   */
  requireActiveMembership?: boolean;
}): Promise<MintResult> {
  // Feature off (either env var unset) looks like the route does not exist,
  // rather than advertising a half-configured integration.
  if (!isIntercomConfigured()) return { ok: false, reason: "not_configured" };

  const session = await auth();
  if (!session?.personId) return { ok: false, reason: "unauthorized" };

  try {
    // The person lookup is the revocation check -- an offboarded member must
    // stop getting tokens even while their hub JWT is still valid -- so a DB
    // blip refuses rather than resolving as "still active".
    const person = await getActivePerson(session.personId);
    if (!person) return { ok: false, reason: "unauthorized" };

    // Audience flags ride on the token rather than being pushed to Intercom by a
    // separate sync job, so they are recomputed from live permissions on every
    // Messenger boot and cannot drift into a stale copy.
    const [perms, onboarding, activeTerm] = await Promise.all([
      getEffectivePermissions(person.id),
      getOnboardingStatus(person.id),
      getActiveTerm(),
    ]);

    // Active department memberships THIS TERM, same query shape as epic.ts's
    // sendEpicEmail. Only meaningful alongside an active term, so it is left
    // empty (and buildProfileAttributes omits "Departments") without one. Serves
    // the membership gate below as well, rather than issuing a second query.
    let departmentNames: string[] = [];
    let hasActiveMembership = false;
    if (activeTerm) {
      const memberships = await prisma.termMembership.findMany({
        where: { personId: person.id, termId: activeTerm.id, status: "ACTIVE" },
        include: { department: { select: { name: true } } },
      });
      departmentNames = memberships.map((m) => m.department.name).sort();
      hasActiveMembership = memberships.length > 0;
    }

    if (opts?.requireActiveMembership && !hasActiveMembership) {
      return { ok: false, reason: "membership_required" };
    }

    const profile = buildProfileAttributes({
      epicId: person.epicId,
      netId: person.netId,
      departmentNames,
      memberStatus: person.status,
      // getOnboardingStatus returns cleared: true when there is no active term
      // (a dormant, never-blocking status -- see its own doc comment), which
      // would read as a misleadingly reassuring "Cleared" with no term to be
      // cleared FOR. Gating on activeTerm here means Active term and Clearance
      // at last sign-in are omitted together rather than sending that term-less
      // "Cleared".
      activeTerm: activeTerm ? { name: activeTerm.name, cleared: onboarding.cleared } : null,
    });

    const token = await mintIntercomUserJwt({
      personId: person.id,
      name: person.name,
      email: person.contactEmail ?? null,
      audience: buildAudienceAttributes(perms),
      profile,
    });

    return { ok: true, token, expiresInSeconds: INTERCOM_TOKEN_TTL_SECONDS };
  } catch (err) {
    if (isDbUnreachableError(err)) {
      log.warn("[intercom] database unreachable minting messenger token", errorAttrs(err));
      return { ok: false, reason: "db_unreachable" };
    }
    // Everything else -- an unrecognized DB error shape, a jose failure, a bug
    // in getEffectivePermissions -- rethrows rather than collapsing into a
    // refusal. A programmer error quietly becoming a 401 is an afternoon spent
    // debugging Intercom's identity verification for no reason. Callers that
    // cannot afford a rejection contain it themselves: see (app)/layout.tsx.
    throw err;
  }
}
