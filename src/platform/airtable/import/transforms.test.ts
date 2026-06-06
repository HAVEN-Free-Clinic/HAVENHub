import { describe, expect, it } from "vitest";
import { ALL_PEOPLE_FIELDS, SU26_ROSTER_FIELDS } from "../fields";
import { transformPeople, transformRoster } from "./transforms";

const F = ALL_PEOPLE_FIELDS;
const R = SU26_ROSTER_FIELDS;

describe("transformPeople", () => {
  it("maps fields, trims, lowercases netId, and derives yaleEmail from @yale.edu contact emails", () => {
    const [person] = transformPeople([
      {
        id: "recA",
        fields: {
          [F.name]: "  Jane Doe ",
          [F.netId]: " JD123 ",
          [F.contactEmail]: "Jane.Doe@yale.edu",
          [F.phone]: "203-555-0101",
          [F.epicId]: "E123",
          [F.yaleAffiliation]: "Yale College",
          [F.gradYear]: "2027",
        },
      },
    ]);
    expect(person).toEqual({
      airtableRecordId: "recA",
      name: "Jane Doe",
      netId: "jd123",
      contactEmail: "jane.doe@yale.edu",
      yaleEmail: "jane.doe@yale.edu",
      phone: "203-555-0101",
      epicId: "E123",
      yaleAffiliation: "Yale College",
      gradYear: "2027",
    });
  });

  it("leaves yaleEmail null for personal emails and tolerates missing fields", () => {
    const [person] = transformPeople([
      { id: "recB", fields: { [F.name]: "Sam", [F.contactEmail]: "sam@gmail.com" } },
    ]);
    expect(person.yaleEmail).toBeNull();
    expect(person.netId).toBeNull();
    expect(person.contactEmail).toBe("sam@gmail.com");
  });

  it("skips records with no name and reports them", () => {
    const result = transformPeople([{ id: "recC", fields: {} }]);
    expect(result).toHaveLength(0);
  });
});

describe("transformRoster", () => {
  it("builds departments and memberships keyed by airtable record ids", () => {
    const roster = transformRoster([
      {
        id: "recDept1",
        fields: {
          [R.departmentName]: "ITCM",
          [R.directors]: ["recA"],
          [R.volunteers]: ["recB", "recC"],
        },
      },
    ]);
    expect(roster.departments).toEqual([{ code: "ITCM", name: "ITCM" }]);
    expect(roster.memberships).toEqual([
      { departmentCode: "ITCM", personRecordId: "recA", kind: "DIRECTOR" },
      { departmentCode: "ITCM", personRecordId: "recB", kind: "VOLUNTEER" },
      { departmentCode: "ITCM", personRecordId: "recC", kind: "VOLUNTEER" },
    ]);
  });

  it("skips roster rows without a department name", () => {
    const roster = transformRoster([{ id: "recX", fields: {} }]);
    expect(roster.departments).toHaveLength(0);
    expect(roster.memberships).toHaveLength(0);
  });
});
