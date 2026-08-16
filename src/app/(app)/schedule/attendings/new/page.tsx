import { redirect } from "next/navigation";
import { requireModuleAccess } from "@/platform/auth/session";
import {
  createAttending,
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
  searchParams: Promise<{ specialty?: string; error?: string }>;
};

export default async function NewAttendingPage({ searchParams }: PageProps) {
  const session = await requireModuleAccess("schedule");
  const sp = await searchParams;

  // Same gate as the nav tab and the roster page, so the URL is never a way
  // around the tab being absent.
  if (!(await canManageAttendings(session.personId))) redirect("/no-access");

  const specialties = await listSpecialties();
  // Which questions to ask depends on the specialty, which is not chosen until
  // the form is submitted. Render the questions for the pre-selected specialty
  // (from ?specialty=, else none) and let the service re-scope on save; posting
  // an answer the chosen specialty does not ask is simply dropped there.
  const selectedSpecialtyId = sp.specialty ?? null;
  const capabilities = await capabilitiesForSpecialty(selectedSpecialtyId);

  async function createAction(formData: FormData) {
    "use server";
    const actor = await requireModuleAccess("schedule");
    try {
      await createAttending(actor.personId, {
        scheduleName: (formData.get("scheduleName") as string) ?? "",
        fullName: (formData.get("fullName") as string) ?? "",
        credentials: (formData.get("credentials") as string) || null,
        specialtyId: (formData.get("specialtyId") as string) || null,
        email: (formData.get("email") as string) || null,
        phone: (formData.get("phone") as string) || null,
        notes: (formData.get("notes") as string) || null,
        capabilities: capabilitiesFromFormData(formData),
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
      <PageHeader
        title="Add attending"
        description="Faculty joining the clinic's attending roster."
      />
      {/* createAction redirects here with ?error= on a domain failure. Without
          this a duplicate schedule name bounced the user back to a blank form
          with no indication of what went wrong. */}
      {sp.error && <Alert tone="error">{sp.error}</Alert>}
      <AttendingForm
        action={createAction}
        specialties={specialties}
        selectedSpecialtyId={selectedSpecialtyId}
        capabilities={capabilities}
      />
    </div>
  );
}
