import { describe, expect, it } from "vitest";
import { resolveTriageRoster, type TriageRosterAssignment } from "./triage-chats";

const BVHD = { id: "d-bvhd", code: "BVHD", name: "Behavioral Health" };
const LABR = { id: "d-labr", code: "LABR", name: "Laboratory" };
const EXEC = { id: "d-exec", code: "EXEC", name: "Executive Directors" };
const PCAR = { id: "d-pcar", code: "PCAR", name: "Primary Care Clinical Advisors" };

function assignment(
  over: Partial<TriageRosterAssignment> & { name: string; department: typeof BVHD },
): TriageRosterAssignment {
  const personId = over.personId ?? `p-${over.name.toLowerCase().replace(/\W+/g, "-")}`;
  return {
    personId,
    role: over.role ?? "DIRECTOR",
    triage: over.triage ?? true,
    department: over.department,
    person: {
      id: personId,
      name: over.name,
      netId: over.person?.netId ?? "nid",
      contactEmail: over.person?.contactEmail ?? null,
      entraObjectId: over.person?.entraObjectId ?? "oid",
    },
  };
}

describe("resolveTriageRoster", () => {
  it("takes only triage-tagged directors from the selected departments", () => {
    const roster = resolveTriageRoster({
      assignments: [
        assignment({ name: "Goeun Lee", department: BVHD }),
        assignment({ name: "Not On Triage", department: BVHD, triage: false }),
        assignment({ name: "A Volunteer", department: BVHD, role: "VOLUNTEER" }),
      ],
      selectedDepartments: [BVHD],
      alwaysIncludeDepartments: [],
    });
    expect(roster.members.map((m) => m.name)).toEqual(["Goeun Lee"]);
  });

  it("takes every director from the always-include departments regardless of the triage flag", () => {
    const roster = resolveTriageRoster({
      assignments: [
        assignment({ name: "Phil Xu", department: EXEC, triage: false }),
        assignment({ name: "Andy Gu", department: EXEC, triage: false }),
        assignment({ name: "Matt Anderson", department: PCAR, triage: false }),
        assignment({ name: "An Exec Volunteer", department: EXEC, role: "VOLUNTEER" }),
      ],
      selectedDepartments: [],
      alwaysIncludeDepartments: [EXEC, PCAR],
    });
    expect(roster.members.map((m) => m.name).sort()).toEqual(["Andy Gu", "Matt Anderson", "Phil Xu"]);
    expect(roster.sessionCoordinators).toEqual(["Andy Gu", "Phil Xu"]);
    expect(roster.clinicalAdvisors).toEqual(["Matt Anderson"]);
  });

  it("lists a person once even when they hold triage shifts in two selected departments", () => {
    const shared = { personId: "p-shared", name: "Ju Hyun Lee" };
    const roster = resolveTriageRoster({
      assignments: [
        assignment({ ...shared, department: BVHD }),
        assignment({ ...shared, department: LABR }),
      ],
      selectedDepartments: [BVHD, LABR],
      alwaysIncludeDepartments: [],
    });
    expect(roster.members).toHaveLength(1);
  });

  it("builds a roster block that names exactly the members", () => {
    const roster = resolveTriageRoster({
      assignments: [
        assignment({ name: "Jovan Stanisavic", department: LABR }),
        assignment({ name: "Goeun Lee", department: BVHD }),
      ],
      selectedDepartments: [BVHD, LABR],
      alwaysIncludeDepartments: [],
    });
    expect(roster.rosterBlock).toBe(
      "- Behavioral Health: Goeun Lee\n- Laboratory: Jovan Stanisavic",
    );
    for (const member of roster.members) {
      expect(roster.rosterBlock).toContain(member.name);
    }
  });

  it("names a selected department that has no triage director on shift", () => {
    const roster = resolveTriageRoster({
      assignments: [assignment({ name: "Goeun Lee", department: BVHD })],
      selectedDepartments: [BVHD, LABR],
      alwaysIncludeDepartments: [],
    });
    expect(roster.emptyDepartments).toEqual(["Laboratory"]);
  });

  it("carries the lookup candidates for each member", () => {
    const roster = resolveTriageRoster({
      assignments: [
        {
          ...assignment({ name: "Goeun Lee", department: BVHD }),
          person: { id: "p-1", name: "Goeun Lee", netId: "gl123", contactEmail: "gl@example.com", entraObjectId: null },
          personId: "p-1",
        },
      ],
      selectedDepartments: [BVHD],
      alwaysIncludeDepartments: [],
    });
    expect(roster.members[0]).toMatchObject({
      netId: "gl123",
      contactEmail: "gl@example.com",
      entraObjectId: null,
    });
  });

  it("keeps two same-named people in the same department as two roster entries", () => {
    const roster = resolveTriageRoster({
      assignments: [
        assignment({ personId: "p-1", name: "Goeun Lee", department: BVHD }),
        assignment({ personId: "p-2", name: "Goeun Lee", department: BVHD }),
      ],
      selectedDepartments: [BVHD],
      alwaysIncludeDepartments: [],
    });
    // Both are really in the chat, so both must appear in the printed roster.
    // Deduping the bullet by display name would silently drop one of them.
    expect(roster.members).toHaveLength(2);
    expect(roster.rosterBlock).toBe("- Behavioral Health: Goeun Lee, Goeun Lee");
  });
});
