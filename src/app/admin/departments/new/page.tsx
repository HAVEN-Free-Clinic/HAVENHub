import { redirect } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import {
  createDepartment,
  DepartmentConflictError,
  DepartmentValidationError,
} from "@/modules/admin/services/departments";
import { PageHeader } from "@/platform/ui/page-header";
import { DepartmentForm } from "@/modules/admin/components/department-form";

function optionalInt(raw: FormDataEntryValue | null): number | null {
  if (raw === null || String(raw).trim() === "") return null;
  return Number(raw);
}

type PageProps = { searchParams: Promise<{ error?: string }> };

export default async function NewDepartmentPage({ searchParams }: PageProps) {
  await requirePermission("admin.manage_departments");
  const { error } = await searchParams;

  async function createAction(formData: FormData) {
    "use server";
    const session = await requirePermission("admin.manage_departments");
    try {
      const dept = await createDepartment(session.personId, {
        code: String(formData.get("code") ?? ""),
        name: String(formData.get("name") ?? ""),
        isActive: formData.get("isActive") === "on",
        idealHeadcount: optionalInt(formData.get("idealHeadcount")),
        patientCapacityPerProvider: optionalInt(formData.get("patientCapacityPerProvider")),
      });
      redirect(`/admin/departments/${dept.id}?saved=1`);
    } catch (err) {
      if (err instanceof DepartmentConflictError || err instanceof DepartmentValidationError) {
        redirect(`/admin/departments/new?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Create department" description="Code is permanent once set; the name can change later." />
      <DepartmentForm action={createAction} mode="create" error={error} />
    </div>
  );
}
