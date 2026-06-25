import { redirect } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { createSubcommittee, SubcommitteeValidationError } from "@/modules/admin/services/subcommittees";
import { PageHeader } from "@/platform/ui/page-header";
import { SubcommitteeForm } from "@/modules/admin/components/subcommittee-form";
import { optionalInt } from "@/modules/admin/form-coerce";

type PageProps = { searchParams: Promise<{ error?: string }> };

export default async function NewSubcommitteePage({ searchParams }: PageProps) {
  await requirePermission("admin.manage_subcommittees");
  const { error } = await searchParams;

  async function createAction(formData: FormData) {
    "use server";
    const session = await requirePermission("admin.manage_subcommittees");
    try {
      const sc = await createSubcommittee(session.personId, {
        name: String(formData.get("name") ?? ""),
        isActive: formData.get("isActive") === "on",
        order: optionalInt(formData.get("order")) ?? 0,
      });
      redirect(`/admin/subcommittees/${sc.id}?saved=1`);
    } catch (err) {
      if (err instanceof SubcommitteeValidationError) {
        redirect(`/admin/subcommittees/new?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Create subcommittee" description="Applicants will be able to rank active subcommittees." />
      <SubcommitteeForm action={createAction} mode="create" error={error} />
    </div>
  );
}
