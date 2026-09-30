import { describe, expect, it } from "vitest";
import type { ClearanceSummary } from "@/platform/clearance";
import { buildShiftClearanceDigests, type DigestAssignment, type DigestDirector } from "./shift-clearance-digest";

const SCTP = { id: "d-sctp", code: "SCTP", name: "Senior Primary Care" };
const JCTP = { id: "d-jctp", code: "JCTP", name: "Junior Primary Care" };

function person(id: string, first: string, last: string) {
  return { id, name: `${first} ${last}`, legalFirstName: first, lastName: last };
}
function director(id: string, name: string, dept: DigestDirector["department"]): DigestDirector {
  return { department: dept, person: { id, name, contactEmail: `${id}@x.org`, entraObjectId: null } };
}
function summary(cleared: boolean, missing: ClearanceSummary["missing"] = []): ClearanceSummary {
  return { onboarded: true, cleared, tasks: [], missing };
}

describe("buildShiftClearanceDigests", () => {
  it("lists only uncleared scheduled people, with short labels, to their department's director", () => {
    const zed = person("p-zed", "Zed", "Zulu");
    const amy = person("p-amy", "Amy", "Alpha");
    const ok = person("p-ok", "Olly", "Okay");
    const assignments: DigestAssignment[] = [
      { role: "VOLUNTEER", department: SCTP, person: zed },
      { role: "SHADOW", department: SCTP, person: amy },
      { role: "VOLUNTEER", department: SCTP, person: ok },
    ];
    const clearance = new Map([
      [zed.id, summary(false, ["hipaa", "ehs"])],
      [amy.id, summary(false, ["training"])],
      [ok.id, summary(true)],
    ]);

    const out = buildShiftClearanceDigests({ assignments, directors: [director("dir", "Dana Dir", SCTP)], clearance });

    expect(out).toHaveLength(1);
    expect(out[0].departmentNames).toBe("Senior Primary Care");
    // Sorted by last name; the cleared person is absent.
    expect(out[0].members).toEqual([
      { name: "Amy Alpha", roleLabel: "Shadow", departmentName: "Senior Primary Care", missing: ["Volunteer training"] },
      { name: "Zed Zulu", roleLabel: "Volunteer", departmentName: "Senior Primary Care", missing: ["HIPAA certificate", "EHS training"] },
    ]);
  });

  it("sends nothing to a director whose departments are all cleared", () => {
    const ok = person("p-ok", "Olly", "Okay");
    const out = buildShiftClearanceDigests({
      assignments: [{ role: "VOLUNTEER", department: SCTP, person: ok }],
      directors: [director("dir", "Dana Dir", SCTP)],
      clearance: new Map([[ok.id, summary(true)]]),
    });
    expect(out).toEqual([]);
  });

  it("gives a two-department director one email, and keeps other departments out", () => {
    const a = person("p-a", "Ann", "Able");
    const b = person("p-b", "Ben", "Baker");
    const assignments: DigestAssignment[] = [
      { role: "VOLUNTEER", department: SCTP, person: a },
      { role: "VOLUNTEER", department: JCTP, person: b },
    ];
    const clearance = new Map([
      [a.id, summary(false, ["hipaa"])],
      [b.id, summary(false, ["hipaa"])],
    ]);
    const out = buildShiftClearanceDigests({
      assignments,
      directors: [director("both", "Bo Both", SCTP), director("both", "Bo Both", JCTP), director("sc", "Sam Sc", SCTP)],
      clearance,
    });

    const both = out.find((d) => d.director.id === "both")!;
    expect(both.departmentNames).toBe("Junior Primary Care, Senior Primary Care");
    expect(both.members.map((m) => m.name)).toEqual(["Ben Baker", "Ann Able"]);
    const sc = out.find((d) => d.director.id === "sc")!;
    expect(sc.members.map((m) => m.name)).toEqual(["Ann Able"]);
  });

  it("keeps an uncleared director on their own list", () => {
    const dir = person("dir", "Dana", "Dir");
    const out = buildShiftClearanceDigests({
      assignments: [{ role: "DIRECTOR", department: SCTP, person: dir }],
      directors: [director("dir", "Dana Dir", SCTP)],
      clearance: new Map([[dir.id, summary(false, ["directorTraining"])]]),
    });
    expect(out[0].members).toEqual([
      { name: "Dana Dir", roleLabel: "Director", departmentName: "Senior Primary Care", missing: ["Director training"] },
    ]);
  });

  it("does not flag someone the clearance load never returned", () => {
    const ghost = person("p-ghost", "Gus", "Ghost");
    const out = buildShiftClearanceDigests({
      assignments: [{ role: "VOLUNTEER", department: SCTP, person: ghost }],
      directors: [director("dir", "Dana Dir", SCTP)],
      clearance: new Map(),
    });
    expect(out).toEqual([]);
  });
});
