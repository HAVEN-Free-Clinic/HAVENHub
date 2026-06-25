import { notFound } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { cycleTrail } from "@/modules/recruitment/breadcrumbs";
import { PageHeader } from "@/platform/ui/page-header";
import { QuizBuilder, type QuizSection } from "./quiz-builder";

export default async function QuizBuilderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requirePermission("recruitment.manage_cycles");
  const cycle = await getCycle(id);
  if (!cycle) notFound();

  const sections: QuizSection[] = cycle.sections
    .filter((s) => s.purpose === "QUIZ")
    .map((s) => ({
      id: s.id,
      title: s.title,
      questions: s.fields.map((f) => ({
        id: f.id, label: f.label,
        options: (f.options as { value: string; label: string }[] | null) ?? [],
        correctValue: f.correctValue,
      })),
    }));

  return (
    <div className="max-w-3xl space-y-6">
      <SetBreadcrumb trail={cycleTrail({ cycleId: id, cycleTitle: cycle.title, section: { label: "Form builder", slug: "builder" }, leaf: "Training quiz" })} />
      <PageHeader title="Training quiz" description={cycle.title} />
      <QuizBuilder cycleId={id} cycleTitle={cycle.title} editable={cycle.status === "DRAFT"} sections={sections} />
    </div>
  );
}
