/**
 * /admin/roles -- RBAC editor page.
 *
 * Two sections:
 *  1. Roles: one card per role with a grants checkbox editor, create-role form,
 *     and delete ConfirmButton for non-system roles.
 *  2. Assignments: table of all assignments with delete, plus create forms for
 *     person-assignment (GET search) and department-assignment.
 *
 * Gates on admin.manage_roles. Every action re-checks the same permission.
 */

import { requirePermission } from "@/platform/auth/session";
import { listRoles, listAssignments } from "@/modules/admin/services/rbac";
import { listTerms } from "@/modules/admin/services/terms";
import { prisma } from "@/platform/db";
import { PageHeader } from "@/platform/ui/page-header";
import { RolesPanel } from "@/modules/admin/components/roles-panel";
import { AssignmentForm } from "@/modules/admin/components/assignment-form";

const PAGE_HREF = "/admin/roles";

type PageProps = {
  searchParams: Promise<{
    rbacError?: string;
    saved?: string;
    assignq?: string;
  }>;
};

export default async function RolesPage({ searchParams }: PageProps) {
  await requirePermission("admin.manage_roles");

  const { rbacError, saved, assignq } = await searchParams;

  // Fetch all data in parallel.
  const [roles, assignments, terms, departments] = await Promise.all([
    listRoles(),
    listAssignments(),
    listTerms(),
    prisma.department.findMany({
      where: { isActive: true },
      orderBy: { code: "asc" },
    }),
  ]);

  return (
    <div className="space-y-10">
      <PageHeader title="Roles" description="Manage roles, permission grants, and assignments." />

      {/* Status messages */}
      {rbacError && (
        <p
          role="alert"
          className="rounded-md border border-critical/20 bg-red-50 px-3 py-2 text-sm text-critical"
        >
          {rbacError}
        </p>
      )}
      {saved === "1" && (
        <p className="text-sm text-success">Saved.</p>
      )}

      {/* Roles section */}
      <RolesPanel roles={roles} pageHref={PAGE_HREF} />

      {/* Assignments section */}
      <AssignmentForm
        assignments={assignments}
        roles={roles}
        departments={departments}
        terms={terms}
        assignq={assignq}
        pageHref={PAGE_HREF}
      />
    </div>
  );
}
