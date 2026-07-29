import { notFound } from "next/navigation";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { requirePermission } from "@/platform/auth/session";
import { prisma } from "@/platform/db";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { cycleTrail } from "@/modules/recruitment/breadcrumbs";
import { PageHeader } from "@/platform/ui/page-header";
import type { DepartmentNameRow } from "@/modules/recruitment/templates/department-options";
import { FormBuilder } from "./form-builder";
import type { BuilderSection } from "./section-card";

export default async function BuilderPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission("recruitment.access");
  await requirePermission("recruitment.manage_cycles");
  const { id } = await params;
  const cycle = await getCycle(id);
  if (!cycle) notFound();

  const subcommittees = await prisma.subcommittee.findMany({
    where: { isActive: true },
    select: { id: true, name: true },
    orderBy: [{ order: "asc" }, { name: "asc" }],
  });

  // Department code -> name rows, mirroring apply/[slug]/page.tsx exactly, so the
  // "Preview form" modal (ApplyPreview) can resolve department names and generated
  // supplement-section titles the same way the live apply wizard does. Passed
  // alongside the raw `sections`/`departments` (still codes) rather than baked into
  // them: SectionCard's own title editor must keep showing the stored title as-is,
  // not the resolved display name, or saving would freeze a name-based title into
  // the row (see resolveSectionTitle's own doc comment on why that matters).
  const departmentRows: DepartmentNameRow[] = cycle.departments.length
    ? await prisma.department.findMany({ where: { code: { in: cycle.departments } }, select: { code: true, name: true } })
    : [];

  const sections: BuilderSection[] = cycle.sections
    .filter((s) => s.purpose === "APPLICATION")
    .map((s) => ({
      id: s.id,
      title: s.title,
      description: s.description,
      appliesTo: s.appliesTo,
      departmentCode: s.departmentCode,
      fields: s.fields.map((f) => ({
        id: f.id,
        key: f.key,
        label: f.label,
        helpText: f.helpText,
        type: f.type,
        required: f.required,
        options: (f.options as { value: string; label: string }[] | null) ?? null,
        validation: (f.validation as Record<string, unknown> | null) ?? null,
        correctValue: f.correctValue,
        visibleWhen: f.visibleWhen ?? null,
      })),
    }));

  return (
    <div className="max-w-3xl space-y-6">
      <SetBreadcrumb
        trail={cycleTrail({
          cycleId: id,
          cycleTitle: cycle.title,
          section: { label: "Form builder", slug: "builder" },
        })}
      />
      {/* The training quiz is reached from the cycle overview page ("Edit quiz"),
          so no duplicate link here -- this keeps the form builder about the
          application form only. */}
      <PageHeader title="Form builder" description={cycle.title} />
      <FormBuilder
        cycleId={id}
        cycleTitle={cycle.title}
        editable={cycle.status !== "ARCHIVED"}
        status={cycle.status}
        departments={cycle.departments}
        departmentNames={departmentRows}
        subcommittees={subcommittees}
        sections={sections}
        acceptsRenewals={cycle.acceptsRenewals}
      />
    </div>
  );
}
