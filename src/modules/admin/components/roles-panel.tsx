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
import { Card } from "@/platform/ui/card";
import { Input, Field } from "@/platform/ui/input";
import { Checkbox } from "@/platform/ui/checkbox";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { FormActions } from "@/platform/ui/form";
import { SectionHeader } from "@/platform/ui/section-header";

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
      <SectionHeader level="title" className="mb-4">Roles</SectionHeader>

      {/* Create-role inline form */}
      <Card>
        <h3 className="mb-4 text-sm font-semibold text-foreground-soft">Create new role</h3>
        <form action={createRoleAction} className="flex flex-wrap items-end gap-3">
          <Field label="Name">
            <Input
              type="text"
              name="roleName"
              required
              placeholder="e.g. Schedule Editor"
              className="w-56"
            />
          </Field>
          <Field label="Description" hint="Optional.">
            <Input
              type="text"
              name="roleDescription"
              placeholder="Short description..."
              className="w-72"
            />
          </Field>
          <Button type="submit" variant="primary" size="sm">
            Create role
          </Button>
        </form>
      </Card>

      {/* One card per role */}
      {roles.length === 0 && (
        <p className="text-sm text-muted-foreground">No roles yet. Create one above.</p>
      )}
      {roles.map((role) => {
        const grantedSet = new Set(role.grants.map((g) => g.permission));

        return (
          <Card key={role.id} className="space-y-5">
            {/* Card header */}
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-foreground">{role.name}</h3>
                  {role.isSystem && (
                    <Badge tone="brand">System</Badge>
                  )}
                </div>
                {role.description && (
                  <p className="text-xs text-muted-foreground">{role.description}</p>
                )}
                <p className="text-xs text-subtle-foreground">
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
                  <SectionHeader>{mod.title}</SectionHeader>
                  <div className="flex flex-wrap gap-x-6 gap-y-1.5">
                    {mod.permissions.map((perm) => (
                      <label
                        key={perm}
                        className="flex items-center gap-2 text-sm text-foreground-soft"
                      >
                        <Checkbox
                          name="permissions"
                          value={perm}
                          defaultChecked={grantedSet.has(perm)}
                        />
                        <span className="font-mono text-xs">{perm}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}

              {/* Platform group: wildcard */}
              <div className="space-y-2">
                <SectionHeader>Platform</SectionHeader>
                <div className="flex flex-wrap gap-x-6 gap-y-1.5">
                  <label className="flex items-center gap-2 text-sm text-foreground-soft">
                    <Checkbox
                      name="permissions"
                      value="*"
                      defaultChecked={grantedSet.has("*")}
                    />
                    <span className="font-mono text-xs">*</span>
                    <span className="text-xs text-subtle-foreground">(superadmin: all permissions)</span>
                  </label>
                </div>
              </div>

              <FormActions>
                <Button type="submit" variant="outline" size="sm">
                  Save grants
                </Button>
              </FormActions>
            </form>
          </Card>
        );
      })}
    </section>
  );
}
