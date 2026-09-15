/**
 * Unit tests for compareBuilderMembers, the ordering used by the schedule
 * builder's member lists (Day view "Available to assign" pool and the grid).
 *
 * Pure function, no database: directors come first, then volunteers, with each
 * group ordered by SURNAME (comparePersonName), like every other list of people.
 */

import { describe, expect, it } from "vitest";
import { compareBuilderMembers } from "./builder";

// The comparator keys on the name PARTS now, so the fixture supplies them.
// `name` here is written "Given Surname" and split on the space.
type Member = {
  kind: "DIRECTOR" | "VOLUNTEER";
  person: { name: string; legalFirstName: string; lastName: string };
};

const member = (kind: Member["kind"], name: string): Member => {
  const parts = name.split(" ");
  return {
    kind,
    person: { name, legalFirstName: parts[0], lastName: parts.slice(1).join(" ") },
  };
};

const order = (members: Member[]) =>
  [...members].sort(compareBuilderMembers).map((m) => m.person.name);

describe("compareBuilderMembers", () => {
  it("puts directors ahead of volunteers regardless of name", () => {
    expect(
      order([member("VOLUNTEER", "Aaron"), member("DIRECTOR", "Zoe")]),
    ).toEqual(["Zoe", "Aaron"]);
  });

  it("sorts alphabetically within the director group", () => {
    expect(
      order([member("DIRECTOR", "Carol"), member("DIRECTOR", "Alice")]),
    ).toEqual(["Alice", "Carol"]);
  });

  it("sorts alphabetically within the volunteer group", () => {
    expect(
      order([member("VOLUNTEER", "Ben"), member("VOLUNTEER", "Ana")]),
    ).toEqual(["Ana", "Ben"]);
  });

  it("groups all directors before all volunteers in a mixed list", () => {
    expect(
      order([
        member("VOLUNTEER", "Tara"),
        member("DIRECTOR", "Nina"),
        member("VOLUNTEER", "Bob"),
        member("DIRECTOR", "Drew"),
      ]),
    ).toEqual(["Drew", "Nina", "Bob", "Tara"]);
  });
});
