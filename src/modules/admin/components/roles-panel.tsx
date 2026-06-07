/**
 * RolesPanel: server component for the RBAC roles section on /admin/roles.
 *
 * Renders one card per role with:
 *  - Name, description, system badge, assignment count
 *  - Grants editor: checkbox grid grouped by module, plus a "Platform" group
 *    with the "*" (wildcard) checkbox
 *  - Create-role inline form at the top
 *  - Delete (non-system roles only) via ConfirmButton
 *
 * NOTE: Module enablement toggles (status stays code-driven in the registry)
 * are deferred; this editor only manages role/grant records.
 */

import type { ReactNode } from "react";
import type { Role, RoleGrant } from "@prisma/client";
import { redirect } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { MODULES } from "@/platform/modules/registry";
import {
  createRole,
  setRoleGrants,
  deleteRole,
  RoleConflictError,
  RoleNotFoundError,
  UnknownPermissionError,
  SystemRoleError,
  LastAdminError,
} from "@/modules/admin/services/rbac";
import { Badge } from "@/platform/ui/badge";
import { Button } from "@/platform/ui/button";
import { Input } from "@/platform/ui/input";
import { ConfirmButton } from "@/platform/ui/confirm-button";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RoleWithGrants = Role & {
  grants: RoleGrant[];
  _count: { assignments: number };
};

type RolesPanelProps = {
  roles: RoleWithGrants[];
  /** Base href for this page (e.g. /admin/roles). Used for redirects. */
  pageHref: string;
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h2 className="mb-4 text-base font-semibold tracking-tight text-slate-800">
      {children}
    </h2>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export async function RolesPanel({ roles, pageHref }: RolesPanelProps): Promise<ReactNode> {
  // ---------------------------------------------------------------------------
  // Server actions
  // ---------------------------------------------------------------------------

  async function createRoleAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("admin.manage_roles");
    const name = (formData.get("roleName") as string | null)?.trim() ?? "";
    const description = (formData.get("roleDescription") as string | null)?.trim() || null;

    if (!name) {
      redirect(`${pageHref}?rbacError=${encodeURIComponent("Role name is required.")}`);
    }

    try {
      await createRole(actor.personId, name, description);
    } catch (err) {
      if (err instanceof RoleConflictError) {
        redirect(
          `${pageHref}?rbacError=${encodeURIComponent(err.message)}`
        );
      }
      throw err;
    }
    redirect(`${pageHref}?saved=1`);
  }

  async function saveGrantsAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("admin.manage_roles");
    const roleId = formData.get("roleId") as string | null;
    if (!roleId) {
      redirect(`${pageHref}?rbacError=${encodeURIComponent("Missing role ID.")}`);
    }
    const permissions = formData.getAll("permissions") as string[];

    try {
      await setRoleGrants(actor.personId, roleId, permissions);
    } catch (err) {
      if (err instanceof UnknownPermissionError || err instanceof LastAdminError) {
        redirect(
          `${pageHref}?rbacError=${encodeURIComponent(err.message)}`
        );
      }
      throw err;
    }
    redirect(`${pageHref}?saved=1`);
  }

  async function deleteRoleAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("admin.manage_roles");
    const roleId = formData.get("roleId") as string | null;
    if (!roleId) {
      redirect(`${pageHref}?rbacError=${encodeURIComponent("Missing role ID.")}`);
    }

    try {
      await deleteRole(actor.personId, roleId);
    } catch (err) {
      if (err instanceof RoleNotFoundError) {
        redirect(
          `${pageHref}?rbacError=${encodeURIComponent("Role no longer exists; the page may be stale.")}`
        );
      }
      if (err instanceof SystemRoleError) {
        redirect(
          `${pageHref}?rbacError=${encodeURIComponent(err.message)}`
        );
      }
      throw err;
    }
    redirect(`${pageHref}?saved=1`);
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <section className="space-y-6">
      <SectionHeading>Roles</SectionHeading>

      {/* Create-role inline form */}
      <div className="rounded-lg border border-slate-200 bg-white p-5">
        <h3 className="mb-4 text-sm font-semibold text-slate-700">Create new role</h3>
        <form action={createRoleAction} className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-slate-500">Name</label>
            <Input
              type="text"
              name="roleName"
              required
              placeholder="e.g. Schedule Editor"
              className="w-56"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-slate-500">
              Description{" "}
              <span className="font-normal text-slate-400">(optional)</span>
            </label>
            <Input
              type="text"
              name="roleDescription"
              placeholder="Short description..."
              className="w-72"
            />
          </div>
          <Button type="submit" variant="primary" size="sm">
            Create role
          </Button>
        </form>
      </div>

      {/* One card per role */}
      {roles.length === 0 && (
        <p className="text-sm text-slate-400">No roles yet. Create one above.</p>
      )}
      {roles.map((role) => {
        const grantedSet = new Set(role.grants.map((g) => g.permission));

        return (
          <div
            key={role.id}
            className="rounded-lg border border-slate-200 bg-white p-5 space-y-5"
          >
            {/* Card header */}
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-slate-800">{role.name}</h3>
                  {role.isSystem && (
                    <Badge tone="brand">System</Badge>
                  )}
                </div>
                {role.description && (
                  <p className="text-xs text-slate-500">{role.description}</p>
                )}
                <p className="text-xs text-slate-400">
                  {role._count.assignments} assignment(s)
                </p>
              </div>

              {/* Delete button for non-system roles only */}
              {!role.isSystem && (
                <form action={deleteRoleAction}>
                  <input type="hidden" name="roleId" value={role.id} />
                  <ConfirmButton label="Delete role" confirmLabel="Delete this role? Confirm?" />
                </form>
              )}
            </div>

            {/* Grants editor: one form per role */}
            <form action={saveGrantsAction} className="space-y-4">
              <input type="hidden" name="roleId" value={role.id} />

              {/* Module permission groups */}
              {MODULES.filter((m) => m.permissions.length > 0).map((mod) => (
                <div key={mod.id} className="space-y-2">
                  <p className="text-xs font-medium uppercase tracking-wider text-slate-400">
                    {mod.title}
                  </p>
                  <div className="flex flex-wrap gap-x-6 gap-y-1.5">
                    {mod.permissions.map((perm) => (
                      <label
                        key={perm}
                        className="flex items-center gap-2 text-sm text-slate-700"
                      >
                        <input
                          type="checkbox"
                          name="permissions"
                          value={perm}
                          defaultChecked={grantedSet.has(perm)}
                          className="rounded border-slate-300"
                        />
                        <span className="font-mono text-xs">{perm}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}

              {/* Platform group: wildcard */}
              <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-wider text-slate-400">
                  Platform
                </p>
                <div className="flex flex-wrap gap-x-6 gap-y-1.5">
                  <label className="flex items-center gap-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      name="permissions"
                      value="*"
                      defaultChecked={grantedSet.has("*")}
                      className="rounded border-slate-300"
                    />
                    <span className="font-mono text-xs">*</span>
                    <span className="text-xs text-slate-400">(superadmin: all permissions)</span>
                  </label>
                </div>
              </div>

              <div className="pt-1">
                <Button type="submit" variant="outline" size="sm">
                  Save grants
                </Button>
              </div>
            </form>
          </div>
        );
      })}
    </section>
  );
}
