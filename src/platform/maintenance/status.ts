import { getSetting, getSettingUncached } from "@/platform/settings/service";
import { getEffectivePermissions, hasPermission } from "@/platform/rbac/engine";

/**
 * Runtime state of maintenance mode: the switch, the copy shown on the
 * maintenance page, and who is allowed past it.
 *
 * Every read goes through getSetting, which falls back to the registered env
 * default when the database is unreachable. maintenance.enabled defaults to
 * false, so a Neon blip can never strand the hub in maintenance mode -- the
 * failure direction is "the site comes back", not "the site stays dark".
 */

/**
 * The permission that lets someone keep using the hub while maintenance mode is
 * on -- and, not by coincidence, the permission /admin/settings gates on, which
 * is to say the permission that lets someone turn maintenance mode ON.
 *
 * The two MUST be the same string. They were not: the switch was writable by any
 * holder of admin.manage_settings while the bypass asked for the bare "*"
 * (Platform Admin) grant, so a settings admin who was not also a Platform Admin
 * could take the hub down with one click and then be bounced to /maintenance
 * along with everybody else, with no way back to the switch that undid it. The
 * only documented escape was an UPDATE against the production database. Anyone
 * who can turn it on can turn it off anyway, so refusing them the hub in between
 * bought no safety and cost the hub an outage (audit 14, maintenance self-lockout).
 *
 * Still narrow: hasPermission() treats "*" as satisfying any check, so a Platform
 * Admin passes here exactly as before without the grant being named twice.
 */
export const MAINTENANCE_BYPASS_PERMISSION = "admin.manage_settings";

export type MaintenanceNotice = {
  /** Admin-authored copy, or "" to use the maintenance page's default wording. */
  message: string;
  /** Free-text return estimate, or "" to promise nothing. */
  until: string;
};

/**
 * Is the hub currently in maintenance mode, right now, straight from the row?
 *
 * Uncached on purpose. Two independent 30s getSetting caches decide this: the
 * proxy bundle's copy blocks the request, and the render bundle's copy makes the
 * /maintenance page redirect back to "/" once the window is over. Nothing keeps
 * the two in step (setSetting only clears the writing instance's cache, and a
 * serverless fleet has one cache per instance), so for up to 30s after the
 * switch moved, one of them said "on" while the other said "off" and the visitor
 * ping-ponged /maintenance -> / -> /maintenance until the browser gave up with
 * ERR_TOO_MANY_REDIRECTS (audit 14, AUTH-MAINT-03).
 *
 * Every caller that can send a visitor somewhere else reads THIS, so both ends
 * of that bounce agree within a request or two and the loop cannot form. The
 * proxy keeps a cached pre-check in front of it (see isMaintenanceEnabledCached)
 * so the uncached read only happens for requests that are about to be blocked.
 */
export async function isMaintenanceEnabled(): Promise<boolean> {
  return getSettingUncached<boolean>("maintenance.enabled");
}

/**
 * The 30s-cached read, for the one caller that runs on EVERY request and must
 * not pay a database round trip to learn what is almost always "off".
 *
 * Only safe as a negative: a cached "off" serves the site (worst case the hub
 * stays up a few seconds into a window), while a cached "on" must be confirmed
 * against isMaintenanceEnabled before anyone is redirected.
 */
export async function isMaintenanceEnabledCached(): Promise<boolean> {
  return getSetting<boolean>("maintenance.enabled");
}

/** The admin-authored copy for the maintenance page. */
export async function getMaintenanceNotice(): Promise<MaintenanceNotice> {
  const [message, until] = await Promise.all([
    getSetting<string>("maintenance.message"),
    getSetting<string>("maintenance.until"),
  ]);
  return { message: message.trim(), until: until.trim() };
}

/** True when this person keeps full access to the hub during a maintenance window. */
export async function holdsMaintenanceBypass(personId: string): Promise<boolean> {
  return hasPermission(await getEffectivePermissions(personId), MAINTENANCE_BYPASS_PERMISSION);
}
