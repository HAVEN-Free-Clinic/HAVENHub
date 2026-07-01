import { notFound, redirect } from "next/navigation";
import { requireModuleAccess } from "@/platform/auth/session";
import { getAttending, updateAttending, canManageAnyRhdDept, CAPABILITY_KEYS, AttendingValidationError, AttendingForbiddenError, type CapabilityValue } from "@/modules/schedule/services/attendings";
import { AttendingForm } from "@/modules/schedule/components/attending-form";
import { PageHeader } from "@/platform/ui/page-header";

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
};

export default async function EditAttendingPage({ params, searchParams }: PageProps) {
  const session = await requireModuleAccess("schedule");
  if (!(await canManageAnyRhdDept(session.personId))) redirect("/no-access");
  const { id } = await params;
  const { error } = await searchParams;
  const attending = await getAttending(id);
  if (!attending) notFound();

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
      <PageHeader title={`Edit ${attending.scheduleName}`} />
      <AttendingForm action={updateAction} attending={attending} error={error} />
    </div>
  );
}
