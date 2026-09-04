import { notFound, redirect } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import {
  getAttendingSpecialty,
  referenceCounts,
  updateAttendingSpecialty,
  deleteAttendingSpecialty,
  AttendingSpecialtyConflictError,
  AttendingSpecialtyForbiddenError,
  AttendingSpecialtyInUseError,
  AttendingSpecialtyNotFoundError,
  AttendingSpecialtyValidationError,
} from "@/modules/admin/services/attending-specialties";
import { PageHeader } from "@/platform/ui/page-header";
import { SectionHeader } from "@/platform/ui/section-header";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { AttendingSpecialtyForm } from "@/modules/admin/components/attending-specialty-form";
import { optionalInt } from "@/modules/admin/form-coerce";

type PageProps = {
  params: Promise<{ id: string }>;
};

/** The errors the page turns into a toast rather than a 500. */
function isExpected(err: unknown): err is Error {
  return (
    err instanceof AttendingSpecialtyConflictError ||
    err instanceof AttendingSpecialtyValidationError ||
    err instanceof AttendingSpecialtyNotFoundError ||
    err instanceof AttendingSpecialtyForbiddenError ||
    err instanceof AttendingSpecialtyInUseError
  );
}

export default async function EditAttendingSpecialtyPage({ params }: PageProps) {
  await requirePermission("schedule.manage_attendings");
  const { id } = await params;

  const specialty = await getAttendingSpecialty(id);
  if (!specialty) notFound();

  // Shown next to the delete button so an admin sees WHY it will be refused
  // before clicking, not only after.
  const counts = await referenceCounts(id);
  const referenced = counts.attendings + counts.capabilities + counts.clinicDays;

  async function updateAction(formData: FormData) {
    "use server";
    const session = await requirePermission("schedule.manage_attendings");
    try {
      // `code` is deliberately absent: it is frozen after creation because the
      // roster importer's alias table is keyed on it. The form renders it
      // read-only, and not reading it here means a hand-crafted POST cannot
      // change it either.
      await updateAttendingSpecialty(session.personId, id, {
        name: String(formData.get("name") ?? ""),
        runsSpecialtyClinic: formData.get("runsSpecialtyClinic") === "on",
        order: optionalInt(formData.get("order")) ?? undefined,
      });
    } catch (err) {
      if (isExpected(err)) {
        redirect(`/schedule/specialties/${id}?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    redirect(`/schedule/specialties/${id}?saved=1`);
  }

  async function deleteAction() {
    "use server";
    const session = await requirePermission("schedule.manage_attendings");
    try {
      await deleteAttendingSpecialty(session.personId, id);
    } catch (err) {
      if (isExpected(err)) {
        redirect(`/schedule/specialties/${id}?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    // No flag on the way out: the row is gone from the list, which is the
    // feedback. A "saved" flag here would read as the wrong verb.
    redirect("/schedule/specialties");
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title={`Edit ${specialty.code}`}
        description="Code and name can both be changed; everything that points at this specialty follows the row, not the code."
      />
      <AttendingSpecialtyForm action={updateAction} mode="edit" specialty={specialty} />

      <section className="space-y-3">
        <SectionHeader level="title">Delete</SectionHeader>
        {referenced > 0 ? (
          <p className="text-sm text-muted-foreground">
            This specialty cannot be deleted while anything still references it: {counts.attendings}{" "}
            attending(s), {counts.capabilities} capability question(s), and {counts.clinicDays} clinic
            day(s) point at it. Move those onto another specialty first. Deleting anyway would
            silently blank each of those references rather than fail, which is why the button is not
            offered.
          </p>
        ) : (
          <form action={deleteAction} className="space-y-3">
            {/* eslint-disable-next-line local/no-adhoc-empty-state -- delete-confirmation prose, not an empty state: it explains why deletion is safe. */}
            <p className="text-sm text-muted-foreground">
              Nothing references this specialty, so it can be removed for good. This cannot be undone.
            </p>
            <ConfirmButton label="Delete specialty" confirmLabel="Delete permanently? Confirm?" />
          </form>
        )}
      </section>
    </div>
  );
}
