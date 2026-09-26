import { getActivePerson } from "@/platform/auth/match-person";
import { isDbUnreachableError } from "@/platform/db";
import { log, errorAttrs } from "@/platform/logging";
import { getModule } from "@/platform/modules/registry";
import { canAccessModule } from "@/platform/modules/access";
import { MOBILE_RESOURCE, protectedResourceMetadataUrl, resourceUrl } from "@/platform/oauth/config";
import { publicOrigin } from "@/platform/oauth/origin";
import { verifyAccessToken } from "@/platform/oauth/tokens";
import { getEffectivePermissions } from "@/platform/rbac/engine";

/**
 * Shared plumbing for the mobile app's JSON API (src/app/api/mobile/v1).
 *
 * Every request carries a bearer token from the Hub's own OAuth server, bound
 * to MOBILE_RESOURCE. The token only says who is calling; each endpoint still
 * runs the same module and permission checks the matching Hub page does, so
 * the app can never see more than the website would show the same person.
 */

export type MobileContext = { personId: string; origin: string };

function bearer(request: Request): string {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "");
  return match?.[1] ?? "";
}

function unauthorized(origin: string, description: string): Response {
  const metadata = protectedResourceMetadataUrl(origin, MOBILE_RESOURCE);
  return Response.json(
    { error: "invalid_token", error_description: description },
    {
      status: 401,
      headers: {
        // The app treats any 401 as "refresh, then sign in again"; the header
        // is here so a standards-following client can discover the server.
        "WWW-Authenticate": `Bearer error="invalid_token", resource_metadata="${metadata}", scope="${MOBILE_RESOURCE.scope}"`,
      },
    },
  );
}

export function forbidden(description: string): Response {
  return Response.json({ error: "forbidden", error_description: description }, { status: 403 });
}

/**
 * Wrap a mobile endpoint: authenticate the bearer token, confirm the person is
 * still active, then run the handler as them. A database outage becomes a 503
 * (the app keeps showing what it last loaded) rather than a 500.
 *
 * The person lookup stays inside the outage guard on purpose: it is the
 * revocation check, and a DB blip must never resolve it as "still active".
 */
export function mobileHandler(
  handler: (request: Request, ctx: MobileContext) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const origin = publicOrigin(request.headers, request.url);
    try {
      const access = await verifyAccessToken(bearer(request), resourceUrl(origin, MOBILE_RESOURCE));
      if (!access) return unauthorized(origin, "Sign in to the HAVEN Hub again");
      const person = await getActivePerson(access.personId);
      if (!person) return unauthorized(origin, "This Hub account is no longer active");
      const response = await handler(request, { personId: access.personId, origin });
      response.headers.set("Cache-Control", "no-store");
      return response;
    } catch (err) {
      if (isDbUnreachableError(err)) {
        log.warn("[mobile-api] database unreachable", errorAttrs(err));
        return Response.json({ error: "unavailable" }, { status: 503 });
      }
      throw err;
    }
  };
}

/** The same gate requireModuleAccess applies to a Hub page, as a boolean. */
export async function mayUseModule(personId: string, moduleId: string): Promise<boolean> {
  const mod = getModule(moduleId);
  if (!mod) throw new Error(`Unknown module id: ${moduleId}`);
  return canAccessModule(mod, await getEffectivePermissions(personId));
}
