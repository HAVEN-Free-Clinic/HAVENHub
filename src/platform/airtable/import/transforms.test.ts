import { describe, expect, it } from "vitest";
import { ALL_PEOPLE_FIELDS, SU26_ROSTER_FIELDS } from "../fields";
import { transformPeople, transformRoster } from "./transforms";

const F = ALL_PEOPLE_FIELDS;
const R = SU26_ROSTER_FIELDS;

describe("transformPeople", () => {
  it("maps fields, trims, and lowercases netId and contactEmail", () => {
    const { people: [person] } = transformPeople([
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
      phone: "203-555-0101",
      epicId: "E123",
      yaleAffiliation: "Yale College",
      gradYear: "2027",
    });
  });

  it("tolerates missing fields and lowercases a personal contactEmail", () => {
    const { people: [person] } = transformPeople([
      { id: "recB", fields: { [F.name]: "Sam", [F.contactEmail]: "Sam@Gmail.com" } },
    ]);
    expect(person.netId).toBeNull();
    expect(person.contactEmail).toBe("sam@gmail.com");
  });

  it("skips records with no name", () => {
    const { people } = transformPeople([{ id: "recC", fields: {} }]);
    expect(people).toHaveLength(0);
  });

  // Members with no Yale NetID (YNHH staff, community volunteers) have had their
  // work address typed into the NetID cell. It can never match a Yale sign-in and
  // it feeds the NetID column of the YNHH Epic access PDF, so it must not be written.
  it("drops a non-NetID-shaped value and reports it, still importing the person", () => {
    const { people, rejectedNetIds } = transformPeople([
      {
        id: "recD",
        fields: {
          [F.name]: "Naomi Chinama",
          [F.netId]: "NAOMI.CHINAMA@YNHH.ORG",
          [F.contactEmail]: "naomi.chinama@gmail.com",
        },
      },
    ]);
    expect(people).toHaveLength(1);
    expect(people[0].netId).toBeNull();
    // contactEmail is untouched: it is how these members sign in.
    expect(people[0].contactEmail).toBe("naomi.chinama@gmail.com");
    expect(rejectedNetIds).toEqual([
      { recordId: "recD", name: "Naomi Chinama", value: "NAOMI.CHINAMA@YNHH.ORG" },
    ]);
  });

  it("accepts the real NetID shapes and reports nothing", () => {
    const { people, rejectedNetIds } = transformPeople(
      ["jc999", "acn38", "mmm325", "ad2975", "ab"].map((netId, i) => ({
        id: `rec${i}`,
        fields: { [F.name]: `P${i}`, [F.netId]: netId },
      })),
    );
    expect(people.map((p) => p.netId)).toEqual(["jc999", "acn38", "mmm325", "ad2975", "ab"]);
    expect(rejectedNetIds).toEqual([]);
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
