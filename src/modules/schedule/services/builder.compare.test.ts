/**
 * Unit tests for compareBuilderMembers — the ordering used by the schedule
 * builder's member lists (Day view "Available to assign" pool and the grid).
 *
 * Pure function, no database: directors come first, then volunteers, with each
 * group sorted alphabetically by name.
 */

import { describe, expect, it } from "vitest";
import { compareBuilderMembers } from "./builder";

type Member = { kind: "DIRECTOR" | "VOLUNTEER"; person: { name: string } };

const member = (kind: Member["kind"], name: string): Member => ({
  kind,
  person: { name },
});

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
