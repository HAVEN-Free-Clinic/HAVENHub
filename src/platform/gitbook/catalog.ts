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
 * The GitBook adaptive-content visitor-claims JSON Schema, i.e. the bare schema
 * GitBook's adaptive-schema editor / `updateSiteAdaptiveSchema` API expects (the
 * `jsonSchema` value). It must satisfy GitBook's SiteAdaptiveJSONSchema contract:
 * every object node (top level, `can`, and each module) carries BOTH a `description`
 * and `additionalProperties: false`; every leaf is a typed primitive with a
 * `description`. Top-level `additionalProperties: false` is required by GitBook and
 * does not reject the standard visitor-auth claims (name/email/iat/exp) -- those are
 * reserved and validated by GitBook outside this adaptive schema.
 */
export function buildAdaptiveSchema() {
  const canProperties = buildNested((permission) => ({
    type: "boolean" as const,
    description: `Whether the visitor holds the ${permission} permission in HAVEN Hub.`,
  }));
  const moduleProperties: Record<string, unknown> = {};
  for (const [mod, actions] of Object.entries(canProperties)) {
    const title = MODULES.find((m) => m.id === mod)?.title ?? mod;
    moduleProperties[mod] = {
      type: "object",
      description: `Whether the visitor can access the ${title} area and its actions in HAVEN Hub.`,
      properties: actions,
      additionalProperties: false,
    };
  }
  return {
    type: "object" as const,
    properties: {
      can: {
        type: "object",
        description: "Which HAVEN Hub features the visitor can access, mirroring their in-app permissions.",
        properties: moduleProperties,
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  };
}
