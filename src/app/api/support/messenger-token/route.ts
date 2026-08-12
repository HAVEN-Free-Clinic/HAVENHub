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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Mints the signed-in person's Intercom Messenger identity-verification JWT.
 *
 * Identity verification is the entire point of this route. Without it the
 * Messenger boots on browser-supplied attributes, so anyone could open devtools
 * and open a support conversation as another member. Every claim here is taken
 * from the server session and the live Person row; nothing comes from the
 * request body or query.
 *
 * Minting lives in a route handler rather than the (app) layout for two
 * reasons. Stamping `exp` needs the wall clock, which the lint purity rule
 * keeps out of render. And a long-lived tab needs somewhere to go for a fresh
 * token, instead of booting once with one that silently dies mid-session.
 *
 * The person lookup is the revocation check -- an offboarded member must stop
 * getting tokens even while their hub JWT is still valid -- so a DB blip
 * degrades to 503 rather than resolving as "still active". Same contract as
 * /api/notifications.
 *
 * Also assembles the `profile` claims (Epic ID, Yale NetID, Departments,
 * Member status, Active term, Clearance at last sign-in) that give a human
 * Intercom agent -- who has no MCP access, unlike Fin -- member context
 * beyond a bare name. jwt.ts's buildProfileAttributes-consuming type lives in
 * src/platform and must not import src/modules, so this route does the
 * module-sourced lookups (getOnboardingStatus, the department query) itself
 * and passes plain values in. Clearance specifically reuses getOnboardingStatus
 * -- the same function the my_clearance_status MCP tool calls (see
 * src/app/api/mcp/tools/compliance.ts) -- rather than re-deriving it, so a
 * member is never told one thing by Fin/the dashboard and another by an
 * Intercom agent reading this profile.
 */
export async function GET(): Promise<Response> {
  // Feature off (either env var unset) looks like the route does not exist,
  // rather than advertising a half-configured integration.
  if (!isIntercomConfigured()) {
    return Response.json({ error: "Not Found" }, { status: 404 });
  }

  const session = await auth();
  if (!session?.personId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const person = await getActivePerson(session.personId);
    if (!person) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

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
    // empty (and buildProfileAttributes omits "Departments") without one.
    let departmentNames: string[] = [];
    if (activeTerm) {
      const memberships = await prisma.termMembership.findMany({
        where: { personId: person.id, termId: activeTerm.id, status: "ACTIVE" },
        include: { department: { select: { name: true } } },
      });
      departmentNames = memberships.map((m) => m.department.name).sort();
    }

    const profile = buildProfileAttributes({
      epicId: person.epicId,
      netId: person.netId,
      departmentNames,
      memberStatus: person.status,
      // getOnboardingStatus returns cleared: true when there is no active
      // term (a dormant, never-blocking status -- see its own doc comment),
      // which would read as a misleadingly reassuring "Cleared" with no term
      // to be cleared FOR. Gating on activeTerm here means Active term and
      // Clearance at last sign-in are omitted together rather than sending
      // that term-less "Cleared".
      activeTerm: activeTerm ? { name: activeTerm.name, cleared: onboarding.cleared } : null,
    });

    const token = await mintIntercomUserJwt({
      personId: person.id,
      name: person.name,
      email: person.contactEmail ?? null,
      audience: buildAudienceAttributes(perms),
      profile,
    });

    return Response.json(
      { token, expiresInSeconds: INTERCOM_TOKEN_TTL_SECONDS },
      // A bearer token must never sit in a shared or browser cache.
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    if (isDbUnreachableError(err)) {
      log.warn("[intercom] database unreachable minting messenger token", errorAttrs(err));
      return Response.json({ error: "Service Unavailable" }, { status: 503 });
    }
    throw err;
  }
}
