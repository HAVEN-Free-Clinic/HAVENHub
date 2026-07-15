import { hasPermission } from "@/platform/rbac/engine";
import { ADAPTIVE_DERIVED_CLAIMS, buildNested, derivedClaimKey } from "./catalog";

/**
 * Turn an effective-permission set into the nested `can` claim GitBook adaptive
 * content reads (e.g. visitor.claims.can.learning.manage_courses). Permission
 * leaves route through hasPermission, so a person holding "*" gets every one
 * true.
 *
 * Data-driven leaves (ADAPTIVE_DERIVED_CLAIMS, e.g. schedule.manages_any_dept)
 * are not permissions, so their value cannot come from the permission set. The
 * caller computes them (a service call in the auth route) and passes them in via
 * `derived`, keyed by dotted `module.action`; any omitted derived claim defaults
 * to false.
 */
export function buildAdaptiveClaims(
  perms: Set<string>,
  derived: Partial<Record<string, boolean>> = {}
): { can: Record<string, Record<string, boolean>> } {
  const can = buildNested((permission) => hasPermission(perms, permission));
  for (const claim of ADAPTIVE_DERIVED_CLAIMS) {
    (can[claim.module] ??= {})[claim.action] = derived[derivedClaimKey(claim)] ?? false;
  }
  return { can };
}
