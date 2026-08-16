import { hasPermission } from "@/platform/rbac/engine";

/**
 * The Intercom contact attributes that help-center article audiences filter on,
 * and the Hub permissions behind each.
 *
 * These exist because Intercom gates article visibility on STORED contact
 * attributes, not on signed per-request claims the way GitBook adaptive content
 * did. There is no way to hand Intercom a permission set at read time, so the
 * flags have to live on the contact.
 *
 * Seven coarse flags rather than the full 32-permission catalog: the help
 * centre only draws twelve collection-level boundaries, so per-permission
 * granularity would be attributes nobody ever filters on, each needing its own
 * segment to be useful.
 *
 * Keys are verbatim what Intercom generated from the attribute display names,
 * spaces and capital H included. They are the contract with the workspace, so
 * renaming one here silently detaches every segment built on it.
 */
export const HUB_AUDIENCE_ATTRIBUTES: ReadonlyArray<{
  key: string;
  permissions: readonly string[];
}> = [
  { key: "Hub admin access", permissions: ["admin.access"] },
  { key: "Hub recruitment access", permissions: ["recruitment.access"] },
  { key: "Hub incidents access", permissions: ["incidents.manage", "incidents.view_strikes"] },
  { key: "Hub volunteers access", permissions: ["volunteers.view"] },
  { key: "Hub schedule manage", permissions: ["schedule.edit_all", "schedule.edit_own_dept"] },
  { key: "Hub learning manage", permissions: ["learning.manage_courses"] },
  { key: "Hub support manage", permissions: ["support.manage_requests"] },
];

/**
 * Every flag the Messenger JWT should carry, derived from an effective
 * permission set.
 *
 * ALWAYS returns all seven keys, including the false ones, and that is
 * load-bearing rather than tidy. Intercom MERGES custom attributes onto the
 * contact instead of replacing them, so an omitted attribute keeps whatever
 * value it had before. A demoted director whose flag simply stopped being sent
 * would keep `true` forever and keep seeing admin articles. Sending `false`
 * explicitly is the only thing that revokes access.
 *
 * Permissions route through hasPermission, so a person holding "*" lights every
 * flag, matching how the GitBook claims already behave.
 */
export function buildAudienceAttributes(perms: Set<string>): Record<string, boolean> {
  const attributes: Record<string, boolean> = {};
  for (const { key, permissions } of HUB_AUDIENCE_ATTRIBUTES) {
    attributes[key] = permissions.some((permission) => hasPermission(perms, permission));
  }
  return attributes;
}
