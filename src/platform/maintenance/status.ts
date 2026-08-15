import { getSetting } from "@/platform/settings/service";
import { getEffectivePermissions } from "@/platform/rbac/engine";

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
 * The grant that lets someone keep using the hub while maintenance mode is on.
 *
 * Deliberately the bare "*" (Platform Admin) rather than admin.access: the
 * bypass is for the handful of people who run the deploy, not for every holder
 * of an admin permission. hasPermission() treats "*" as satisfying any
 * permission check, so this asks getEffectivePermissions for the raw grant
 * instead of going through can().
 */
export const MAINTENANCE_BYPASS_GRANT = "*";

export type MaintenanceNotice = {
  /** Admin-authored copy, or "" to use the maintenance page's default wording. */
  message: string;
  /** Free-text return estimate, or "" to promise nothing. */
  until: string;
};

/** Is the hub currently in maintenance mode? */
export async function isMaintenanceEnabled(): Promise<boolean> {
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
  return (await getEffectivePermissions(personId)).has(MAINTENANCE_BYPASS_GRANT);
}
