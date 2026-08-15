import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";
import { config } from "@/platform/config";
import { log, errorAttrs } from "@/platform/logging";
import { isMaintenanceExempt } from "./gate";
import { isMaintenanceEnabled, holdsMaintenanceBypass } from "./status";

/**
 * The maintenance decision for one request, made in the proxy so it covers
 * signed-out visitors, the applicant-portal host, and server-action POSTs
 * (Next posts an action to the current page's URL) with one rule.
 *
 * Cost on a healthy site is one settings read, cached 30s in process. Nothing
 * here touches the session or RBAC unless maintenance mode is actually on.
 */

/**
 * The signed-in person's id, read from the session JWT alone (no database).
 *
 * getToken derives its decryption salt from the cookie name, which differs
 * between an https deploy (__Secure-authjs.session-token) and plain http in
 * local dev (authjs.session-token). Inferring the scheme behind Vercel's proxy
 * and getting it wrong would lock every admin out of the site they just took
 * down, so try the secure name first and fall back to the plain one. Only one
 * of the two cookies is ever present, so the losing call returns null before
 * it decrypts anything.
 */
async function personIdFromRequest(request: NextRequest): Promise<string | null> {
  for (const secureCookie of [true, false]) {
    const token = await getToken({ req: request, secret: config.AUTH_SECRET, secureCookie });
    if (token?.personId) return token.personId;
  }
  return null;
}

/** True when this request must be sent to the maintenance page instead of served. */
export async function isBlockedByMaintenance(request: NextRequest): Promise<boolean> {
  if (isMaintenanceExempt(request.nextUrl.pathname)) return false;

  let enabled: boolean;
  try {
    enabled = await isMaintenanceEnabled();
  } catch (err) {
    // Fail open, on purpose. getSetting already degrades to the registered
    // default (false) when the database is unreachable, so reaching this catch
    // means something unexpected broke in the settings layer. A bug there must
    // not be able to take down a hub nobody asked to take down.
    log.error("[maintenance] could not resolve the switch; serving the site", errorAttrs(err));
    return false;
  }
  if (!enabled) return false;

  try {
    const personId = await personIdFromRequest(request);
    if (!personId) return true;
    return !(await holdsMaintenanceBypass(personId));
  } catch (err) {
    // Fail closed, also on purpose, and note that this is the opposite call to
    // the one above: past this point an admin has deliberately taken the hub
    // down, so an error deciding WHO may pass resolves to "nobody". An admin
    // locked out this way still has the no-deploy escape hatch documented on
    // the maintenance.enabled setting (clear the row in the database).
    log.error("[maintenance] could not resolve the visitor; holding the gate", errorAttrs(err));
    return true;
  }
}
