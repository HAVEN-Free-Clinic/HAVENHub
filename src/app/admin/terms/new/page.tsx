import { redirect } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { createTerm, TermConflictError, TermDateError } from "@/modules/admin/services/terms";
import { PageHeader } from "@/platform/ui/page-header";
import { TermForm } from "@/modules/admin/components/term-form";

type PageProps = {
  searchParams: Promise<{ error?: string }>;
};

export default async function NewTermPage({ searchParams }: PageProps) {
  await requirePermission("admin.manage_terms");
  const { error } = await searchParams;

  async function createAction(formData: FormData) {
    "use server";
    const actorSession = await requirePermission("admin.manage_terms");

    const code = (formData.get("code") as string) ?? "";
    const name = (formData.get("name") as string) ?? "";
    const startDate = (formData.get("startDate") as string) ?? "";
    const endDate = (formData.get("endDate") as string) ?? "";

    // Validate end >= start before calling the service (M2 carry-forward).
    if (startDate && endDate && endDate < startDate) {
      redirect(
        `/admin/terms/new?error=${encodeURIComponent("End date must be after the start date")}`
      );
    }

    let term;
    try {
      term = await createTerm(actorSession.personId, { code, name, startDate, endDate });
    } catch (err) {
      if (err instanceof TermConflictError) {
        redirect(
          `/admin/terms/new?error=${encodeURIComponent(`A term with code "${err.code}" already exists.`)}`
        );
      }
      if (err instanceof TermDateError) {
        redirect(
          `/admin/terms/new?error=${encodeURIComponent(`Invalid date: ${err.input}`)}`
        );
      }
      throw err;
    }

    redirect(`/admin/terms/${term.id}?saved=1`);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Create term"
        description="A new term starts in PLANNING status. Clinic dates are auto-populated from Saturdays between the start and end dates."
      />
      <TermForm action={createAction} error={error} />
    </div>
  );
}
