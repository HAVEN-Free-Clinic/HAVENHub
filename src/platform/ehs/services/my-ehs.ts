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
  /** When complete only by a live provisional grant, the date it lapses; null otherwise. */
  provisionalUntil: Date | null;
  /** Where to go and do it, or null when a coordinator records it for you. */
  completionUrl: string | null;
  /** Whether a Platform Admin may clear this item provisionally (TB blood test, mask fit). */
  allowsProvisional?: boolean;
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
    allowsProvisional: boolean;
    departments: { departmentId: string }[];
  }>;

  // The applicability engine only needs the scoping fields, so the presentation
  // ones (description, link, provisional) ride alongside in a lookup rather than
  // widening it.
  const detailsById = new Map(
    catalogRows.map((r) => [
      r.id,
      {
        description: r.description,
        completionUrl: ehsCompletionUrl(r.completionUrl),
        allowsProvisional: r.allowsProvisional,
      },
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

  // A live provisional grant stands in for a completion until it lapses, so a
  // member's own gate agrees with the clearance and blocker reads in status.ts.
  const provisionalRows = await prisma.ehsProvisionalClearance.findMany({
    where: {
      personId,
      trainingId: { in: required.map((t) => t.id) },
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    select: { trainingId: true, expiresAt: true },
  });
  const provisionalUntil = new Map(provisionalRows.map((p) => [p.trainingId, p.expiresAt]));

  return required.map((t) => {
    const done = completions.has(t.id);
    return {
      id: t.id,
      name: t.name,
      description: detailsById.get(t.id)?.description ?? null,
      complete: done || provisionalUntil.has(t.id),
      completedAt: completions.get(t.id) ?? null,
      // A real completion wins: once EHS confirms it, the item stops reading provisional.
      provisionalUntil: done ? null : (provisionalUntil.get(t.id) ?? null),
      completionUrl: detailsById.get(t.id)?.completionUrl ?? null,
      allowsProvisional: detailsById.get(t.id)?.allowsProvisional ?? false,
    };
  });
}