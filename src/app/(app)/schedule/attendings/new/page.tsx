import { redirect } from "next/navigation";
import { requireModuleAccess } from "@/platform/auth/session";
import { createAttending, canManageAnyRhdDept, CAPABILITY_KEYS, AttendingValidationError, AttendingForbiddenError, type CapabilityValue } from "@/modules/schedule/services/attendings";
import { AttendingForm } from "@/modules/schedule/components/attending-form";
import { PageHeader } from "@/platform/ui/page-header";

type PageProps = { searchParams: Promise<{ error?: string }> };

export default async function NewAttendingPage({ searchParams }: PageProps) {
  const session = await requireModuleAccess("schedule");
  if (!(await canManageAnyRhdDept(session.personId))) redirect("/no-access");
  const { error } = await searchParams;

  async function createAction(formData: FormData) {
    "use server";
    const session = await requireModuleAccess("schedule");
    const capabilities: Record<string, CapabilityValue> = Object.fromEntries(
      CAPABILITY_KEYS.map((k) => [k, (formData.get(k) as string) as CapabilityValue]),
    );
    try {
      await createAttending(session.personId, {
        scheduleName: (formData.get("scheduleName") as string) ?? "",
        fullName: (formData.get("fullName") as string) ?? "",
        capabilities,
        notes: (formData.get("notes") as string) || null,
      });
    } catch (err) {
      if (err instanceof AttendingValidationError || err instanceof AttendingForbiddenError) {
        redirect(`/schedule/attendings/new?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    redirect("/schedule/attendings");
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Add attending" />
      <AttendingForm action={createAction} error={error} />
    </div>
  );
}
