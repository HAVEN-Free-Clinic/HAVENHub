import { redirect } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import {
  createDepartment,
  DepartmentConflictError,
  DepartmentValidationError,
} from "@/modules/admin/services/departments";
import { PageHeader } from "@/platform/ui/page-header";
import { DepartmentForm } from "@/modules/admin/components/department-form";
import { optionalInt, epicRequirement } from "@/modules/admin/form-coerce";

export default async function NewDepartmentPage() {
  await requirePermission("admin.manage_departments");

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
        requiresEpicDirector: epicRequirement(formData.get("requiresEpicDirector")),
        requiresEpicVolunteer: epicRequirement(formData.get("requiresEpicVolunteer")),
        autoRouteApplicants: formData.get("autoRouteApplicants") === "on",
        allowShiftDrop: formData.get("allowShiftDrop") === "on",
        hoursPerShift: optionalInt(formData.get("hoursPerShift")),
        minInterpreterScore: optionalInt(formData.get("minInterpreterScore")),
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
      <DepartmentForm action={createAction} mode="create" />
    </div>
  );
}
