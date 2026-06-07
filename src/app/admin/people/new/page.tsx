import { redirect } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { createPerson, PersonConflictError } from "@/modules/admin/services/people";
import { PersonForm } from "@/modules/admin/components/person-form";
import { PageHeader } from "@/platform/ui/page-header";

type PageProps = {
  searchParams: Promise<{ error?: string }>;
};

export default async function NewPersonPage({ searchParams }: PageProps) {
  await requirePermission("admin.manage_people");
  const { error } = await searchParams;

  async function createAction(formData: FormData) {
    "use server";
    const actorSession = await requirePermission("admin.manage_people");
    let person;
    try {
      person = await createPerson(actorSession.personId, {
        name: (formData.get("name") as string) ?? "",
        netId: (formData.get("netId") as string) || null,
        contactEmail: (formData.get("contactEmail") as string) || null,
        phone: (formData.get("phone") as string) || null,
        epicId: (formData.get("epicId") as string) || null,
        yaleAffiliation: (formData.get("yaleAffiliation") as string) || null,
        gradYear: (formData.get("gradYear") as string) || null,
      });
    } catch (err) {
      if (err instanceof PersonConflictError) {
        redirect(
          `/admin/people/new?error=${encodeURIComponent(`${err.field} already belongs to another person`)}`
        );
      }
      throw err;
    }
    redirect(`/admin/people/${person.id}?saved=1`);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Add person"
        description="Create a new person in HAVEN Hub. They will not be linked to Airtable until a sync is run."
      />
      <PersonForm action={createAction} error={error} />
    </div>
  );
}
