import { prisma } from "@/platform/db";
import { ApplyForm } from "./apply-form";

export default async function ApplyPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const cycle = await prisma.recruitmentCycle.findUnique({
    where: { publicSlug: slug },
    include: { sections: { where: { purpose: "APPLICATION" }, include: { fields: { orderBy: { order: "asc" } } }, orderBy: { order: "asc" } } },
  });

  const now = new Date();
  const open = cycle && cycle.status === "OPEN" && (!cycle.opensAt || cycle.opensAt <= now) && (!cycle.closesAt || cycle.closesAt >= now);

  if (!cycle || !open) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16 text-center">
        <h1 className="text-xl font-semibold">Applications are closed</h1>
        <p className="mt-2 text-slate-500">This recruitment form is not currently accepting submissions.</p>
      </main>
    );
  }

  const def = {
    slug: cycle.publicSlug,
    title: cycle.title,
    acceptsRenewals: cycle.acceptsRenewals,
    departments: cycle.departments,
    sections: cycle.sections.map((s) => ({
      id: s.id, title: s.title, description: s.description, appliesTo: s.appliesTo, departmentCode: s.departmentCode,
      fields: s.fields.map((f) => ({ key: f.key, label: f.label, helpText: f.helpText, type: f.type, required: f.required, options: (f.options as { value: string; label: string }[] | null) ?? null, validation: (f.validation as Record<string, unknown> | null) ?? null })),
    })),
  };

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">{def.title}</h1>
      <ApplyForm def={def} />
    </main>
  );
}
