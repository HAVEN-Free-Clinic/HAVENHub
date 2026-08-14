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
 * Data-driven adaptive claims that are deliberately NOT registry permissions.
 * A few pages gate on a runtime capability rather than a permission string:
 * managing a schedule department (Builder) or a clinic service line
 * (Attendings) comes from an active directorship, which the
 * registry does not, and should not, model as a permission (see
 * src/app/(app)/schedule/layout.tsx). Their leaves still need to exist in the
 * published schema and the signed token so a GitBook condition can reference
 * them; unlike catalog leaves, their VALUE is computed by a service call in the
 * auth route (canManageAnyScheduleDept / canManageAnyAttendingRoster) and passed into
 * buildAdaptiveClaims, not derived from the permission set via hasPermission.
 * Regenerate the committed schema after editing this list, same as for a
 * registry permission change.
 */
export const ADAPTIVE_DERIVED_CLAIMS = [
  {
    module: "schedule",
    action: "manages_any_dept",
    description:
      "Whether the visitor manages at least one schedule department (via an active directorship, a delegation, or schedule.edit_all) and can therefore use the schedule Builder. Data-driven, not a registry permission.",
  },
  {
    module: "schedule",
    action: "manages_any_rhd_dept",
    description:
      "Whether the visitor manages at least one clinic service line and can therefore edit an Attendings roster. Data-driven, not a registry permission. The action name is historical: it is a published leaf a live GitBook page conditions on, so it outlived the RHD-only scope it was named for.",
  },
] as const;

/** Dotted `module.action` key for a derived claim, used to key its computed value. */
export function derivedClaimKey(claim: { module: string; action: string }): string {
  return `${claim.module}.${claim.action}`;
}

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
  // Merge in the data-driven claims (not permissions, so absent from the catalog).
  for (const { module, action, description } of ADAPTIVE_DERIVED_CLAIMS) {
    (canProperties[module] ??= {})[action] = { type: "boolean" as const, description };
  }
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
