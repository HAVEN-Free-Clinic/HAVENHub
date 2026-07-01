import { prisma } from "@/platform/db";

export type MyEhsItem = {
  id: string;
  name: string;
  complete: boolean;
  completedAt: Date | null;
};

export async function getMyEhsStatus(personId: string): Promise<MyEhsItem[]> {
  const activeTrainings = (await prisma.ehsTraining.findMany({
    where: { isActive: true },
    orderBy: { position: "asc" },
    select: { id: true, name: true },
  })) as Array<{ id: string; name: string }>;

  if (activeTrainings.length === 0) return [];

  const completionRows = (await prisma.ehsCompletion.findMany({
    where: { personId, trainingId: { in: activeTrainings.map((t) => t.id) } },
    select: { trainingId: true, completedAt: true },
  })) as Array<{ trainingId: string; completedAt: Date | null }>;

  const completions = new Map(completionRows.map((c) => [c.trainingId, c.completedAt]));

  return activeTrainings.map((t) => ({
    id: t.id,
    name: t.name,
    complete: completions.has(t.id),
    completedAt: completions.get(t.id) ?? null,
  }));
}
