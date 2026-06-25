import { notFound, redirect } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import {
  getSubcommittee, updateSubcommittee,
  SubcommitteeValidationError, SubcommitteeNotFoundError,
} from "@/modules/admin/services/subcommittees";
import { PageHeader } from "@/platform/ui/page-header";
import { SubcommitteeForm } from "@/modules/admin/components/subcommittee-form";
import { optionalInt } from "@/modules/admin/form-coerce";

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string }>;
};

export default async function EditSubcommitteePage({ params, searchParams }: PageProps) {
  await requirePermission("admin.manage_subcommittees");
  const { id } = await params;
  const { error, saved } = await searchParams;

  const subcommittee = await getSubcommittee(id);
  if (!subcommittee) notFound();

  async function updateAction(formData: FormData) {
    "use server";
    const session = await requirePermission("admin.manage_subcommittees");
    try {
      await updateSubcommittee(session.personId, id, {
        name: String(formData.get("name") ?? ""),
        isActive: formData.get("isActive") === "on",
        order: optionalInt(formData.get("order")) ?? 0,
      });
    } catch (err) {
      if (err instanceof SubcommitteeValidationError || err instanceof SubcommitteeNotFoundError) {
        redirect(`/admin/subcommittees/${id}?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    redirect(`/admin/subcommittees/${id}?saved=1`);
  }

  return (
    <div className="space-y-8">
      <PageHeader title={`Edit ${subcommittee.name}`} description="Toggle Active to deactivate (soft remove)." />
      <SubcommitteeForm action={updateAction} mode="edit" subcommittee={subcommittee} error={error} saved={saved} />
    </div>
  );
}
