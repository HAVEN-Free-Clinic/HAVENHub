import { prisma } from "@/platform/db";
import { getActiveTerm } from "@/platform/terms/active-term";
import {
  requiredTrainingsForMember,
  type RequirableTraining,
} from "@/modules/ehs/engine/applicability";

export type MyEhsItem = {
  id: string;
  name: string;
  complete: boolean;
  completedAt: Date | null;
};

export async function getMyEhsStatus(personId: string): Promise<MyEhsItem[]> {
  const activeTerm = await getActiveTerm();
  if (!activeTerm) return [];

  const memberships = await prisma.termMembership.findMany({
    where: { personId, termId: activeTerm.id, status: "ACTIVE" },
    select: { departmentId: true },
  });
  const memberDepartmentIds = memberships.map((m) => m.departmentId);
  if (memberDepartmentIds.length === 0) return [];

  const catalogRows = (await prisma.ehsTraining.findMany({
    where: { isActive: true },
    orderBy: { position: "asc" },
    include: { departments: { select: { departmentId: true } } },
  })) as Array<{
    id: string;
    name: string;
    isActive: boolean;
    requiredForAll: boolean;
    departments: { departmentId: string }[];
  }>;

  const catalog: RequirableTraining[] = catalogRows.map((r) => ({
    id: r.id,
    name: r.name,
    isActive: r.isActive,
    requiredForAll: r.requiredForAll,
    departmentIds: r.departments.map((d) => d.departmentId),
  }));

  const required = requiredTrainingsForMember({ trainings: catalog, memberDepartmentIds });

  const completionRows = (await prisma.ehsCompletion.findMany({
    where: { personId, trainingId: { in: required.map((t) => t.id) } },
    select: { trainingId: true, completedAt: true },
  })) as Array<{ trainingId: string; completedAt: Date | null }>;

  const completions = new Map(completionRows.map((c) => [c.trainingId, c.completedAt]));

  return required.map((t) => ({
    id: t.id,
    name: t.name,
    complete: completions.has(t.id),
    completedAt: completions.get(t.id) ?? null,
  }));
}
