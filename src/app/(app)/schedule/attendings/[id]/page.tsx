import { notFound, redirect } from "next/navigation";
import { requireModuleAccess } from "@/platform/auth/session";
import { getAttending, updateAttending, manageableServiceLines, CAPABILITY_KEYS, AttendingValidationError, AttendingForbiddenError, type CapabilityValue } from "@/modules/schedule/services/attendings";

/** Reproductive health keeps the procedure matrix; no other line has one. */
const PROCEDURE_LINE_CODE = "SRHD";
import { AttendingForm } from "@/modules/schedule/components/attending-form";
import { PageHeader } from "@/platform/ui/page-header";

type PageProps = {
  params: Promise<{ id: string }>;
};

export default async function EditAttendingPage({ params }: PageProps) {
  const session = await requireModuleAccess("schedule");
  const { id } = await params;
  const attending = await getAttending(id);
  if (!attending) notFound();

  // Scoped to THIS attending's service line, not "manages any": a primary care
  // director must not reach the edit form for a reproductive health attending.
  // updateAttending re-checks the same thing, so this only decides whether the
  // form renders rather than being the security boundary.
  const manageable = await manageableServiceLines(session.personId);
  const line = manageable.find((l) => l.id === attending.departmentId);
  if (!line) redirect("/no-access");

  async function updateAction(formData: FormData) {
    "use server";
    const session = await requireModuleAccess("schedule");
    const capabilities: Record<string, CapabilityValue> = Object.fromEntries(
      CAPABILITY_KEYS.map((k) => [k, (formData.get(k) as string) as CapabilityValue]),
    );
    try {
      await updateAttending(session.personId, id, {
        scheduleName: (formData.get("scheduleName") as string) ?? "",
        fullName: (formData.get("fullName") as string) ?? "",
        capabilities,
        notes: (formData.get("notes") as string) || null,
        isActive: formData.get("isActive") === "on",
      });
    } catch (err) {
      if (err instanceof AttendingValidationError || err instanceof AttendingForbiddenError) {
        redirect(`/schedule/attendings/${id}?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    redirect("/schedule/attendings");
  }

  return (
    <div className="space-y-6">
      <PageHeader title={`Edit ${attending.scheduleName}`} description={line!.name} />
      <AttendingForm
        action={updateAction}
        attending={attending}
        showCapabilities={line!.code === PROCEDURE_LINE_CODE}
      />
    </div>
  );
}
