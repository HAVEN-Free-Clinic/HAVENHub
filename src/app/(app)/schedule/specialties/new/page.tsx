import { redirect } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import {
  createAttendingSpecialty,
  AttendingSpecialtyConflictError,
  AttendingSpecialtyForbiddenError,
  AttendingSpecialtyValidationError,
} from "@/modules/admin/services/attending-specialties";
import { PageHeader } from "@/platform/ui/page-header";
import { AttendingSpecialtyForm } from "@/modules/admin/components/attending-specialty-form";
import { optionalInt } from "@/modules/admin/form-coerce";

export default async function NewAttendingSpecialtyPage() {
  await requirePermission("schedule.manage_attendings");

  async function createAction(formData: FormData) {
    "use server";
    const session = await requirePermission("schedule.manage_attendings");
    try {
      const specialty = await createAttendingSpecialty(session.personId, {
        code: String(formData.get("code") ?? ""),
        name: String(formData.get("name") ?? ""),
        runsSpecialtyClinic: formData.get("runsSpecialtyClinic") === "on",
        // Blank means "no preference": let the service apply its own default
        // rather than coercing an empty box to 0 here.
        order: optionalInt(formData.get("order")) ?? undefined,
      });
      redirect(`/schedule/specialties/${specialty.id}?saved=1`);
    } catch (err) {
      if (
        err instanceof AttendingSpecialtyConflictError ||
        err instanceof AttendingSpecialtyValidationError ||
        err instanceof AttendingSpecialtyForbiddenError
      ) {
        redirect(`/schedule/specialties/new?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Create attending specialty"
        description="Code and name must each be unique. Tick the Specialty Clinic box only if this specialty takes over a whole clinic date."
      />
      <AttendingSpecialtyForm action={createAction} mode="create" />
    </div>
  );
}
