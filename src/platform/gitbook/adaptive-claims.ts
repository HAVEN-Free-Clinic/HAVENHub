import { hasPermission } from "@/platform/rbac/engine";
import { buildNested } from "./catalog";

/**
 * Turn an effective-permission set into the nested `can` claim GitBook adaptive
 * content reads (e.g. visitor.claims.can.learning.manage_courses). Routes every
 * check through hasPermission, so a person holding "*" gets every leaf true.
 */
export function buildAdaptiveClaims(perms: Set<string>): {
  can: Record<string, Record<string, boolean>>;
} {
  return { can: buildNested((permission) => hasPermission(perms, permission)) };
}
