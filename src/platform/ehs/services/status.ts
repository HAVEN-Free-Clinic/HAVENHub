import { prisma } from "@/platform/db";
import { getActiveTerm } from "@/platform/terms/active-term";
import { missingTrainings, type EhsTrainingLite } from "@/platform/ehs/engine/applicability";

export type EhsCellState = "COMPLETE" | "MISSING";
export type EhsDashboardCell = {
  trainingId: string;
  state: EhsCellState;
  completedAt: Date | null;
};
export type EhsDashboardRow = {
  personId: string;
  name: string;
  departmentCodes: string[];
  addedToEhs: boolean;
  cells: EhsDashboardCell[];
};
export type EhsDashboard = {
  trainings: { id: string; name: string }[];
  rows: EhsDashboardRow[];
};

/** Master view of all active-term roster members. No department scoping. Admin only. */
export async function getEhsDashboard(): Promise<EhsDashboard> {
  const activeTerm = await getActiveTerm();
  if (!activeTerm) return { trainings: [], rows: [] };

  const activeTrainings = (await prisma.ehsTraining.findMany({
    where: { isActive: true },
    orderBy: { position: "asc" },
  })) as Array<{ id: string; name: string; isActive: boolean }>;

  const memberships = (await prisma.termMembership.findMany({
    where: { termId: activeTerm.id, status: "ACTIVE" },
    include: {
      person: {
        select: {
          name: true,
          addedToEhs: true,
          ehsCompletions: { select: { trainingId: true, completedAt: true } },
        },
      },
      department: { select: { code: true } },
    },
  })) as Array<{
    personId: string;
    departmentId: string;
    person: {
      name: string;
      addedToEhs: boolean;
      ehsCompletions: { trainingId: string; completedAt: Date | null }[];
    };
    department: { code: string };
  }>;

  // Collapse multi-department memberships to one row per person, unioning departments.
  const byPerson = new Map<
    string,
    {
      name: string;
      addedToEhs: boolean;
      departmentCodes: Set<string>;
      completions: Map<string, Date | null>;
    }
  >();

  for (const m of memberships) {
    let agg = byPerson.get(m.personId);
    if (!agg) {
      agg = {
        name: m.person.name,
        addedToEhs: m.person.addedToEhs,
        departmentCodes: new Set(),
        completions: new Map(
          m.person.ehsCompletions.map((c) => [c.trainingId, c.completedAt])
        ),
      };
      byPerson.set(m.personId, agg);
    }
    agg.departmentCodes.add(m.department.code);
  }

  const rows: EhsDashboardRow[] = [...byPerson.entries()]
    .map(([personId, agg]) => {
      const cells: EhsDashboardCell[] = activeTrainings.map((t) => {
        const done = agg.completions.has(t.id);
        return {
          trainingId: t.id,
          state: done ? "COMPLETE" : "MISSING",
          completedAt: done ? (agg.completions.get(t.id) ?? null) : null,
        };
      });
      return {
        personId,
        name: agg.name,
        departmentCodes: [...agg.departmentCodes].sort(),
        addedToEhs: agg.addedToEhs,
        cells,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    trainings: activeTrainings.map((t) => ({ id: t.id, name: t.name })),
    rows,
  };
}

export async function loadEhsMissingMap(
  activeTermId: string
): Promise<Map<string, string[]>> {
  const activeTrainings: EhsTrainingLite[] = (await prisma.ehsTraining.findMany({
    where: { isActive: true },
    select: { id: true, name: true, isActive: true },
  })) as Array<{ id: string; name: string; isActive: boolean }>;

  const memberships = (await prisma.termMembership.findMany({
    where: { termId: activeTermId, status: "ACTIVE" },
    select: {
      personId: true,
      person: { select: { ehsCompletions: { select: { trainingId: true } } } },
    },
  })) as Array<{
    personId: string;
    person: { ehsCompletions: { trainingId: string }[] };
  }>;

  const completedByPerson = new Map<string, Set<string>>();
  for (const m of memberships) {
    if (!completedByPerson.has(m.personId)) {
      completedByPerson.set(
        m.personId,
        new Set(m.person.ehsCompletions.map((c) => c.trainingId))
      );
    }
  }

  const out = new Map<string, string[]>();
  for (const [personId, completedIds] of completedByPerson) {
    const missing = missingTrainings({
      trainings: activeTrainings,
      completedTrainingIds: completedIds,
    });
    out.set(personId, missing.map((m) => m.name));
  }
  return out;
}
