import { notFound, redirect } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { prisma } from "@/platform/db";
import {
  updateDepartment,
  setDelegations,
  DepartmentNotFoundError,
  DepartmentValidationError,
} from "@/modules/admin/services/departments";
import { PageHeader } from "@/platform/ui/page-header";
import { SectionHeader } from "@/platform/ui/section-header";
import { DepartmentForm } from "@/modules/admin/components/department-form";
import { DelegationEditor } from "@/modules/admin/components/delegation-editor";
import { optionalInt, epicRequirement } from "@/modules/admin/form-coerce";

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string }>;
};

export default async function EditDepartmentPage({ params, searchParams }: PageProps) {
  await requirePermission("admin.manage_departments");
  const { id } = await params;
  const { error, saved } = await searchParams;

  const department = await prisma.department.findUnique({
    where: { id },
    include: { managesDelegations: { select: { managedDepartmentId: true } } },
  });
  if (!department) notFound();

  const selectedIds = department.managesDelegations.map((m) => m.managedDepartmentId);
  // Include already-managed departments even if they are now inactive, otherwise a
  // deactivated-but-managed department would be absent from the checkbox list and
  // silently dropped from the delegation set on the next save.
  const candidates = await prisma.department.findMany({
    where: { id: { not: id }, OR: [{ isActive: true }, { id: { in: selectedIds } }] },
    select: { id: true, code: true, name: true },
    orderBy: { code: "asc" },
  });

  async function updateAction(formData: FormData) {
    "use server";
    const session = await requirePermission("admin.manage_departments");
    try {
      await updateDepartment(session.personId, id, {
        name: String(formData.get("name") ?? ""),
        isActive: formData.get("isActive") === "on",
        idealHeadcount: optionalInt(formData.get("idealHeadcount")),
        patientCapacityPerProvider: optionalInt(formData.get("patientCapacityPerProvider")),
        requiresEpicDirector: epicRequirement(formData.get("requiresEpicDirector")),
        requiresEpicVolunteer: epicRequirement(formData.get("requiresEpicVolunteer")),
      });
    } catch (err) {
      if (err instanceof DepartmentValidationError || err instanceof DepartmentNotFoundError) {
        redirect(`/admin/departments/${id}?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    redirect(`/admin/departments/${id}?saved=1`);
  }

  async function setDelegationsAction(formData: FormData) {
    "use server";
    const session = await requirePermission("admin.manage_departments");
    const managed = formData.getAll("managed").map(String);
    try {
      await setDelegations(session.personId, id, managed);
    } catch (err) {
      if (err instanceof DepartmentValidationError || err instanceof DepartmentNotFoundError) {
        redirect(`/admin/departments/${id}?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    redirect(`/admin/departments/${id}?saved=1`);
  }

  return (
    <div className="space-y-8">
      <PageHeader title={`Edit ${department.code}`} description="Code is permanent. Toggle Active to deactivate (soft remove)." />
      <DepartmentForm action={updateAction} mode="edit" department={department} error={error} saved={saved} />

      <section className="space-y-3">
        <SectionHeader level="title">Delegations</SectionHeader>
        <DelegationEditor action={setDelegationsAction} candidates={candidates} selectedIds={selectedIds} />
      </section>
    </div>
  );
}
