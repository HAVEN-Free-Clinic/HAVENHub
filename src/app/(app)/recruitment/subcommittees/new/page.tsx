import { redirect } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { createSubcommittee, SubcommitteeValidationError } from "@/modules/admin/services/subcommittees";
import { PageHeader } from "@/platform/ui/page-header";
import { SubcommitteeForm } from "@/modules/admin/components/subcommittee-form";
import { optionalInt } from "@/modules/admin/form-coerce";

export default async function NewSubcommitteePage() {
  await requirePermission("recruitment.manage_cycles");

  async function createAction(formData: FormData) {
    "use server";
    const session = await requirePermission("recruitment.manage_cycles");
    try {
      const sc = await createSubcommittee(session.personId, {
        name: String(formData.get("name") ?? ""),
        isActive: formData.get("isActive") === "on",
        order: optionalInt(formData.get("order")) ?? 0,
      });
      redirect(`/recruitment/subcommittees/${sc.id}?saved=1`);
    } catch (err) {
      if (err instanceof SubcommitteeValidationError) {
        redirect(`/recruitment/subcommittees/new?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Create subcommittee" description="Applicants will be able to rank active subcommittees." />
      <SubcommitteeForm action={createAction} mode="create" />
    </div>
  );
}
