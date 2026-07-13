import { MODULES } from "@/platform/modules/registry";

/**
 * Single source of truth for the permission strings exposed to GitBook adaptive
 * content: the sorted, de-duped union of every module's declared permissions.
 * Derived from MODULES so it can never drift from the RBAC editor.
 */
export const ADAPTIVE_PERMISSION_CATALOG: string[] = [
  ...new Set(MODULES.flatMap((m) => m.permissions)),
].sort();

/**
 * Split "learning.manage_courses" into ["learning", "manage_courses"] on the first dot.
 * The module segment becomes a GitBook dot-access key (visitor.claims.can.<module>.<action>),
 * so if a permission-bearing module id ever contains a hyphen (e.g. "my-info"), the generated
 * condition would be an invalid JS expression and the id would need normalizing first. No
 * permission-bearing module has a hyphenated id today, so this is a caveat, not a live bug.
 */
function splitPermission(permission: string): [string, string] {
  const dot = permission.indexOf(".");
  return [permission.slice(0, dot), permission.slice(dot + 1)];
}

/**
 * Build the nested module -> action shape used by both the visitor-claims schema
 * and the signed `can` claim, mapping each catalog permission to a leaf value.
 */
export function buildNested<T>(leaf: (permission: string) => T): Record<string, Record<string, T>> {
  const out: Record<string, Record<string, T>> = {};
  for (const permission of ADAPTIVE_PERMISSION_CATALOG) {
    const [mod, action] = splitPermission(permission);
    (out[mod] ??= {})[action] = leaf(permission);
  }
  return out;
}

/**
 * The GitBook adaptive-content visitor-claims JSON Schema. Describes only our
 * custom `can` object; the top level stays permissive (additionalProperties not
 * set to false) so GitBook does not reject the standard name/email/iat/exp claims.
 */
export function buildAdaptiveSchema() {
  const canProperties = buildNested((permission) => ({
    type: "boolean" as const,
    description: `Whether the visitor holds the ${permission} permission in HAVEN Hub.`,
  }));
  const properties: Record<string, unknown> = {};
  for (const [mod, actions] of Object.entries(canProperties)) {
    properties[mod] = { type: "object", properties: actions, additionalProperties: false };
  }
  return {
    type: "object" as const,
    properties: {
      can: { type: "object", properties, additionalProperties: false },
    },
  };
}
