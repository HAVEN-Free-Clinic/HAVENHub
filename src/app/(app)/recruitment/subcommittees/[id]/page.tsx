import { notFound, redirect } from "next/navigation";
import { ActiveBadge } from "@/platform/ui/active-badge";
import { requirePermission } from "@/platform/auth/session";
import {
  getSubcommittee, updateSubcommittee,
  SubcommitteeValidationError, SubcommitteeNotFoundError,
} from "@/modules/admin/services/subcommittees";
import { PageHeader } from "@/platform/ui/page-header";
import { SubcommitteeForm } from "@/modules/admin/components/subcommittee-form";
import { optionalInt } from "@/modules/admin/form-coerce";
import { SetBreadcrumbLeaf } from "@/platform/ui/breadcrumb-context";

type PageProps = {
  params: Promise<{ id: string }>;
};

export default async function EditSubcommitteePage({ params }: PageProps) {
  await requirePermission("recruitment.manage_cycles");
  const { id } = await params;

  const subcommittee = await getSubcommittee(id);
  if (!subcommittee) notFound();

  async function updateAction(formData: FormData) {
    "use server";
    const session = await requirePermission("recruitment.manage_cycles");
    try {
      await updateSubcommittee(session.personId, id, {
        name: String(formData.get("name") ?? ""),
        isActive: formData.get("isActive") === "on",
        order: optionalInt(formData.get("order")) ?? 0,
      });
    } catch (err) {
      if (err instanceof SubcommitteeValidationError || err instanceof SubcommitteeNotFoundError) {
        redirect(`/recruitment/subcommittees/${id}?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    redirect(`/recruitment/subcommittees/${id}?saved=1`);
  }

  return (
    <div className="space-y-8">
      <SetBreadcrumbLeaf label={subcommittee.name} />
      {/* The soft-remove note moved onto the Active checkbox itself, where the
          control it describes is. */}
      <PageHeader
        title={subcommittee.name}
        status={<ActiveBadge active={subcommittee.isActive} />}
      />
      <SubcommitteeForm action={updateAction} mode="edit" subcommittee={subcommittee} />
    </div>
  );
}
