import { prisma } from "@/platform/db";
import { getActiveTerm } from "@/platform/terms/active-term";
import {
  isStudentAffiliation,
  requiredTrainingsForMember,
  type RequirableTraining,
} from "@/platform/ehs/engine/applicability";
import { ehsCompletionUrl } from "@/platform/ehs/completion-link";

export type MyEhsItem = {
  id: string;
  name: string;
  /** Catalog description, shown so a member can tell what the item actually is. */
  description: string | null;
  complete: boolean;
  completedAt: Date | null;
  /** Where to go and do it, or null when a coordinator records it for you. */
  completionUrl: string | null;
};

export async function getMyEhsStatus(personId: string, termIdOverride?: string): Promise<MyEhsItem[]> {
  // Defaults to the active term; pass a termId to compute EHS for a next term so
  // the member's own checklist matches the schedule builder's cleared banner.
  const termId = termIdOverride ?? (await getActiveTerm())?.id;
  if (!termId) return [];

  const memberships = await prisma.termMembership.findMany({
    where: { personId, termId, status: "ACTIVE" },
    select: { departmentId: true },
  });
  const memberDepartmentIds = memberships.map((m) => m.departmentId);
  if (memberDepartmentIds.length === 0) return [];

  const person = (await prisma.person.findUnique({
    where: { id: personId },
    select: { yaleAffiliation: true },
  })) as { yaleAffiliation: string | null } | null;
  const isStudent = isStudentAffiliation(person?.yaleAffiliation);

  const catalogRows = (await prisma.ehsTraining.findMany({
    where: { isActive: true },
    orderBy: { position: "asc" },
    include: { departments: { select: { departmentId: true } } },
  })) as Array<{
    id: string;
    name: string;
    description: string | null;
    isActive: boolean;
    requiredForAll: boolean;
    completionUrl: string | null;
    departments: { departmentId: string }[];
  }>;

  // The applicability engine only needs the scoping fields, so the presentation
  // ones (description, link) ride alongside in a lookup rather than widening it.
  const detailsById = new Map(
    catalogRows.map((r) => [
      r.id,
      { description: r.description, completionUrl: ehsCompletionUrl(r.completionUrl) },
    ])
  );

  const catalog: RequirableTraining[] = catalogRows.map((r) => ({
    id: r.id,
    name: r.name,
    isActive: r.isActive,
    requiredForAll: r.requiredForAll,
    departmentIds: r.departments.map((d) => d.departmentId),
  }));

  const required = requiredTrainingsForMember({ trainings: catalog, memberDepartmentIds, isStudent });

  const completionRows = (await prisma.ehsCompletion.findMany({
    where: { personId, trainingId: { in: required.map((t) => t.id) } },
    select: { trainingId: true, completedAt: true },
  })) as Array<{ trainingId: string; completedAt: Date | null }>;

  const completions = new Map(completionRows.map((c) => [c.trainingId, c.completedAt]));

  return required.map((t) => ({
    id: t.id,
    name: t.name,
    description: detailsById.get(t.id)?.description ?? null,
    complete: completions.has(t.id),
    completedAt: completions.get(t.id) ?? null,
    completionUrl: detailsById.get(t.id)?.completionUrl ?? null,
  }));
}
