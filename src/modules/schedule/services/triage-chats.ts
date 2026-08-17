import type { ShiftRole } from "@prisma/client";

/** A department as the resolver needs it: identity plus the label it prints. */
export type TriageDepartment = { id: string; code: string; name: string };

/** One ShiftAssignment row, narrowed to what the roster rules read. */
export type TriageRosterAssignment = {
  personId: string;
  role: ShiftRole;
  triage: boolean;
  department: TriageDepartment;
  person: {
    id: string;
    name: string;
    netId: string | null;
    contactEmail: string | null;
    entraObjectId: string | null;
  };
};

/**
 * A person going into the chat. Carries every candidate the Graph layer can use
 * to resolve them to an Entra object id. The resolver itself never touches the
 * network, so reachability is decided later, by the layer that can ask.
 */
export type TriageRosterMember = {
  personId: string;
  name: string;
  netId: string | null;
  contactEmail: string | null;
  entraObjectId: string | null;
  departmentName: string;
};

export type TriageRoster = {
  members: TriageRosterMember[];
  /** Plain-text bulleted list, one line per contributing department. */
  rosterBlock: string;
  sessionCoordinators: string[];
  clinicalAdvisors: string[];
  /** Selected departments that contributed nobody, for a review-screen warning. */
  emptyDepartments: string[];
  /**
   * Always-include departments that contributed nobody, for their own
   * review-screen warning.
   *
   * Kept apart from `emptyDepartments` because the two mean different things to
   * an ED: a selected department with no triage director on shift is a hole in
   * the schedule, while an always-include department with nobody on shift also
   * blanks that department's template variable ({{sessionCoordinators}},
   * {{clinicalAdvisors}}) into whatever sentence the preset wraps it in.
   */
  emptyAlwaysIncludeDepartments: string[];
};

/** Department codes whose members also get their own template variable. */
const SESSION_COORDINATOR_CODE = "EXEC";
const CLINICAL_ADVISOR_CODE = "PCAR";

/**
 * Turn one clinic date's assignments into the chat's membership and the roster
 * block printed in the opening message. One pass produces both, which is the
 * point: a bulleted list that can name somebody who is not in the chat is the
 * bug this feature exists to remove.
 *
 * Selected departments contribute only their triage-tagged directors, because
 * "who is fielding triage calls for this department" is exactly the question the
 * chat asks. The always-include departments (EXEC, PCAR, PATS by default)
 * contribute every director on shift instead: they are small leadership and
 * coordination groups where the triage tag is not the relevant distinction.
 *
 * Callers must pass assignments ALREADY filtered to one clinic date and to
 * people holding an ACTIVE TermMembership in the department they are assigned
 * to. That filter is not optional and is not done here only because it needs the
 * database: offboarding removes the membership but leaves future assignments in
 * place until a director clears them, so without it an offboarded volunteer is
 * added to a twenty-person chat.
 */
export function resolveTriageRoster(input: {
  assignments: TriageRosterAssignment[];
  selectedDepartments: TriageDepartment[];
  alwaysIncludeDepartments: TriageDepartment[];
}): TriageRoster {
  const { assignments, selectedDepartments, alwaysIncludeDepartments } = input;

  const selectedIds = new Set(selectedDepartments.map((d) => d.id));
  const alwaysIds = new Set(alwaysIncludeDepartments.map((d) => d.id));

  const qualifies = (a: TriageRosterAssignment): boolean => {
    if (a.role !== "DIRECTOR") return false;
    if (alwaysIds.has(a.department.id)) return true;
    return selectedIds.has(a.department.id) && a.triage;
  };

  // Dedupe by person, keeping the FIRST department that qualified them once the
  // list is in a deterministic order. Sorting before the walk (rather than
  // relying on query order) is what makes the chosen department stable.
  const ordered = [...assignments].filter(qualifies).sort((a, b) => {
    const byDept = a.department.name.localeCompare(b.department.name);
    return byDept !== 0 ? byDept : a.person.name.localeCompare(b.person.name);
  });

  const byDepartment = new Map<string, { personId: string; name: string }[]>();
  const seen = new Set<string>();
  const members: TriageRosterMember[] = [];

  for (const a of ordered) {
    // Keyed on personId, NOT on the display name. Two different people can share
    // a name, and dropping one of them from the printed roster while they sit in
    // the chat is exactly the disagreement this function exists to prevent. A
    // name printed twice is odd but honest; a member missing from the roster is
    // not. Deduping here also covers one person holding two qualifying rows in
    // the same department, which is what this guard was originally for.
    const people = byDepartment.get(a.department.name) ?? [];
    if (!people.some((p) => p.personId === a.personId)) {
      people.push({ personId: a.personId, name: a.person.name });
    }
    byDepartment.set(a.department.name, people);

    if (seen.has(a.personId)) continue;
    seen.add(a.personId);
    members.push({
      personId: a.personId,
      name: a.person.name,
      netId: a.person.netId,
      contactEmail: a.person.contactEmail,
      entraObjectId: a.person.entraObjectId,
      departmentName: a.department.name,
    });
  }

  const namesForCode = (code: string): string[] => {
    const seenIds = new Set<string>();
    const names: string[] = [];
    for (const a of ordered) {
      if (a.department.code !== code) continue;
      if (seenIds.has(a.personId)) continue;
      seenIds.add(a.personId);
      names.push(a.person.name);
    }
    return names;
  };

  const rosterBlock = [...byDepartment.entries()]
    .map(([department, people]) => `- ${department}: ${people.map((p) => p.name).join(", ")}`)
    .join("\n");

  // One contributing set for both answers. Built from `ordered` (every
  // qualifying assignment) and NOT from `members` (deduped to one department per
  // person): a director who also holds a triage shift in a selected department
  // appears under only one of them in `members`, which would report the other as
  // empty when it is not.
  const contributing = new Set(ordered.map((a) => a.department.id));
  const emptyNames = (departments: TriageDepartment[]): string[] =>
    departments
      .filter((d) => !contributing.has(d.id))
      .map((d) => d.name)
      .sort();

  return {
    members,
    rosterBlock,
    sessionCoordinators: namesForCode(SESSION_COORDINATOR_CODE),
    clinicalAdvisors: namesForCode(CLINICAL_ADVISOR_CODE),
    emptyDepartments: emptyNames(selectedDepartments),
    // A department can be both selected and always-include. It is reported once,
    // as a selected department, rather than warned about twice.
    emptyAlwaysIncludeDepartments: emptyNames(
      alwaysIncludeDepartments.filter((d) => !selectedIds.has(d.id)),
    ),
  };
}
