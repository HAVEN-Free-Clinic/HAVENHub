import type { Prisma } from "@prisma/client";
import type { TemplateSection } from "./types";

export async function materializeTemplate(tx: Prisma.TransactionClient, cycleId: string, sections: TemplateSection[]): Promise<void> {
  for (const s of sections) {
    const section = await tx.formSection.create({
      data: { cycleId, title: s.title, description: s.description ?? null, order: s.order, appliesTo: s.appliesTo, departmentCode: s.departmentCode, purpose: s.purpose },
    });
    if (s.fields.length === 0) continue;
    await tx.formField.createMany({
      data: s.fields.map((f) => ({
        sectionId: section.id, cycleId, key: f.key, label: f.label, type: f.type,
        required: f.required, helpText: f.helpText ?? null, order: f.order,
        options: (f.options ?? undefined) as Prisma.InputJsonValue | undefined,
        validation: (f.validation ?? undefined) as Prisma.InputJsonValue | undefined,
        correctValue: f.correctValue ?? null,
        visibleWhen: (f.visibleWhen ?? undefined) as Prisma.InputJsonValue | undefined,
      })),
    });
  }
}
