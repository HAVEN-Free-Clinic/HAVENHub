// src/app/(app)/recruitment/cycles/[id]/builder/page.tsx
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { cycleTrail } from "@/modules/recruitment/breadcrumbs";
import { PageHeader } from "@/platform/ui/page-header";
import { FormBuilder } from "./form-builder";
import type { BuilderSection } from "./section-card";

export default async function BuilderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cycle = await getCycle(id);
  if (!cycle) notFound();

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
      <PageHeader
        title="Form builder"
        description={cycle.title}
        action={
          <Link
            href={`/recruitment/cycles/${id}/builder/quiz`}
            className="inline-flex items-center gap-1 text-sm font-medium text-brand-fg hover:text-brand-hover"
          >
            Training quiz <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        }
      />
      <FormBuilder
        cycleId={id}
        cycleTitle={cycle.title}
        editable={cycle.status === "DRAFT"}
        status={cycle.status}
        departments={cycle.departments}
        sections={sections}
      />
    </div>
  );
}
