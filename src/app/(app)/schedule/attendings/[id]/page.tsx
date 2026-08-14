import { notFound, redirect } from "next/navigation";
import { requireModuleAccess } from "@/platform/auth/session";
import {
  getAttending,
  updateAttending,
  canManageAttendings,
  listSpecialties,
  capabilitiesForSpecialty,
  capabilitiesFromFormData,
  AttendingValidationError,
  AttendingForbiddenError,
} from "@/modules/schedule/services/attendings";
import { AttendingForm } from "@/modules/schedule/components/attending-form";
import { Alert } from "@/platform/ui/alert";
import { PageHeader } from "@/platform/ui/page-header";

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
};

export default async function EditAttendingPage({ params, searchParams }: PageProps) {
  const session = await requireModuleAccess("schedule");
  const { id } = await params;
  const { error } = await searchParams;

  if (!(await canManageAttendings(session.personId))) redirect("/no-access");

  const attending = await getAttending(id);
  if (!attending) notFound();

  const [specialties, capabilities] = await Promise.all([
    listSpecialties(),
    capabilitiesForSpecialty(attending.specialtyId),
  ]);

  async function updateAction(formData: FormData) {
    "use server";
    const actor = await requireModuleAccess("schedule");
    try {
      await updateAttending(actor.personId, id, {
        scheduleName: (formData.get("scheduleName") as string) ?? "",
        fullName: (formData.get("fullName") as string) ?? "",
        credentials: (formData.get("credentials") as string) || null,
        specialtyId: (formData.get("specialtyId") as string) || null,
        email: (formData.get("email") as string) || null,
        phone: (formData.get("phone") as string) || null,
        notes: (formData.get("notes") as string) || null,
        capabilities: capabilitiesFromFormData(formData),
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
      <PageHeader title={`Edit ${attending.scheduleName}`} description={attending.fullName} />
      {/* updateAction redirects here with ?error= on a domain failure. */}
      {error && <Alert tone="error">{error}</Alert>}
      <AttendingForm
        action={updateAction}
        attending={attending}
        specialties={specialties}
        selectedSpecialtyId={attending.specialtyId}
        capabilities={capabilities}
        values={attending.capabilityValues}
      />
    </div>
  );
}
