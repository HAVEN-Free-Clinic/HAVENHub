import { prisma } from "@/platform/db";
import { getActiveTerm } from "@/platform/terms/active-term";
import { manageableDepartmentIds } from "@/platform/departments";
import {
  missingTrainings,
  requiredTrainingsForMember,
  type RequirableTraining,
} from "@/modules/ehs/engine/applicability";

export type EhsCellState = "COMPLETE" | "MISSING" | "NA";
export type EhsDashboardCell = {
  trainingId: string;
  state: EhsCellState;
  completedAt: Date | null;
};
export type EhsDashboardRow = {
  personId: string;
  name: string;
  departmentCodes: string[];
  cells: EhsDashboardCell[];
};
export type EhsDashboard = {
  trainings: { id: string; name: string }[];
  rows: EhsDashboardRow[];
};

/** Load the active EHS catalog as RequirableTraining[] (name + department scoping). */
async function loadCatalog(): Promise<RequirableTraining[]> {
  const rows = (await prisma.ehsTraining.findMany({
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
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    isActive: r.isActive,
    requiredForAll: r.requiredForAll,
    departmentIds: r.departments.map((d) => d.departmentId),
  }));
}

export async function getEhsDashboard(
  viewerPersonId: string
): Promise<EhsDashboard> {
  const activeTerm = await getActiveTerm();
  if (!activeTerm) return { trainings: [], rows: [] };

  const deptIds = await manageableDepartmentIds(viewerPersonId);
  if (deptIds.length === 0) return { trainings: [], rows: [] };

  const catalog = await loadCatalog();

  const memberships = (await prisma.termMembership.findMany({
    where: { termId: activeTerm.id, departmentId: { in: deptIds }, status: "ACTIVE" },
    include: {
      person: {
        include: {
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
      ehsCompletions: { trainingId: string; completedAt: Date | null }[];
    };
    department: { code: string };
  }>;

  // Collapse multi-department memberships to one row per person, unioning departments.
  const byPerson = new Map<
    string,
    { name: string; departmentIds: Set<string>; departmentCodes: Set<string> }
  >();
  const completionByPerson = new Map<string, Map<string, Date | null>>();

  for (const m of memberships) {
    let agg = byPerson.get(m.personId);
    if (!agg) {
      agg = {
        name: m.person.name,
        departmentIds: new Set(),
        departmentCodes: new Set(),
      };
      byPerson.set(m.personId, agg);
    }
    agg.departmentIds.add(m.departmentId);
    agg.departmentCodes.add(m.department.code);
    if (!completionByPerson.has(m.personId)) {
      completionByPerson.set(
        m.personId,
        new Map(m.person.ehsCompletions.map((c) => [c.trainingId, c.completedAt]))
      );
    }
  }

  const rows: EhsDashboardRow[] = [...byPerson.entries()]
    .map(([personId, agg]) => {
      const memberDepartmentIds = [...agg.departmentIds];
      const required = new Set(
        requiredTrainingsForMember({ trainings: catalog, memberDepartmentIds }).map(
          (t) => t.id
        )
      );
      const completions = completionByPerson.get(personId) ?? new Map<string, Date | null>();
      const cells: EhsDashboardCell[] = catalog.map((t) => {
        if (!required.has(t.id))
          return { trainingId: t.id, state: "NA", completedAt: null };
        const done = completions.has(t.id);
        return {
          trainingId: t.id,
          state: done ? "COMPLETE" : "MISSING",
          completedAt: done ? (completions.get(t.id) ?? null) : null,
        };
      });
      return {
        personId,
        name: agg.name,
        departmentCodes: [...agg.departmentCodes].sort(),
        cells,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return { trainings: catalog.map((t) => ({ id: t.id, name: t.name })), rows };
}

export async function loadEhsMissingMap(
  activeTermId: string
): Promise<Map<string, string[]>> {
  const catalog = await loadCatalog();
  const memberships = (await prisma.termMembership.findMany({
    where: { termId: activeTermId, status: "ACTIVE" },
    select: {
      personId: true,
      departmentId: true,
      person: { select: { ehsCompletions: { select: { trainingId: true } } } },
    },
  })) as Array<{
    personId: string;
    departmentId: string;
    person: { ehsCompletions: { trainingId: string }[] };
  }>;

  const deptsByPerson = new Map<string, Set<string>>();
  const completedByPerson = new Map<string, Set<string>>();
  for (const m of memberships) {
    if (!deptsByPerson.has(m.personId)) deptsByPerson.set(m.personId, new Set());
    deptsByPerson.get(m.personId)!.add(m.departmentId);
    if (!completedByPerson.has(m.personId)) {
      completedByPerson.set(
        m.personId,
        new Set(m.person.ehsCompletions.map((c) => c.trainingId))
      );
    }
  }

  const out = new Map<string, string[]>();
  for (const [personId, deptSet] of deptsByPerson) {
    const missing = missingTrainings({
      trainings: catalog,
      memberDepartmentIds: [...deptSet],
      completedTrainingIds: completedByPerson.get(personId) ?? new Set(),
    });
    out.set(personId, missing.map((m) => m.name));
  }
  return out;
}
