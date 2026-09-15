import { describe, it, expect } from "vitest";
import { splitPersonName } from "@/platform/person-name";
import { matchCandidates, exactNetIdMatch, MAX_RESULTS } from "./check-in-match";
import type { CheckInCandidate } from "@/modules/recruitment/services/attendance-events";

function candidate(over: Partial<CheckInCandidate> & { name: string }): CheckInCandidate {
  const parts = splitPersonName(over.name);
  return {
    kind: "person",
    id: over.name.toLowerCase().replace(/\W/g, ""),
    legalFirstName: parts.legalFirstName,
    lastName: parts.lastName,
    email: null,
    netId: null,
    departmentCodes: [],
    offRoster: false,
    accepted: false,
    expected: true,
    checkedIn: false,
    ...over,
  };
}

const jane = candidate({ name: "Jane Carney", netId: "jc2847", email: "jane.carney@yale.edu" });
const john = candidate({ name: "John Carnahan", netId: "jrc99", email: "j.carnahan@yale.edu" });
const applicant = candidate({
  name: "Sam Rivera",
  kind: "applicant",
  id: "acc_1",
  netId: "sr410",
  email: "sam@yale.edu",
  accepted: true,
  offRoster: true,
});
const all = [jane, john, applicant];

describe("matchCandidates", () => {
  it("returns nothing for an empty query, rather than the whole list", () => {
    // The door opens with an empty box. Showing every person in the hub under it
    // is both useless and the slowest thing the screen could render.
    expect(matchCandidates(all, "")).toEqual([]);
    expect(matchCandidates(all, "   ")).toEqual([]);
  });

  it("matches on name, email and netId", () => {
    expect(matchCandidates(all, "carn").map((c) => c.name)).toEqual(["Jane Carney", "John Carnahan"]);
    expect(matchCandidates(all, "sam@yale").map((c) => c.name)).toEqual(["Sam Rivera"]);
    expect(matchCandidates(all, "jc28").map((c) => c.name)).toEqual(["Jane Carney"]);
  });

  it("ignores case and surrounding whitespace", () => {
    expect(matchCandidates(all, "  JC2847 ").map((c) => c.name)).toEqual(["Jane Carney"]);
  });

  it("caps the list so a one-letter query cannot render a thousand rows", () => {
    const many = Array.from({ length: MAX_RESULTS + 10 }, (_, i) =>
      candidate({ name: `Person ${i}`, id: `p${i}` }),
    );
    expect(matchCandidates(many, "person")).toHaveLength(MAX_RESULTS);
  });
});

describe("exactNetIdMatch", () => {
  it("resolves a full netId", () => {
    expect(exactNetIdMatch(all, "jc2847")?.name).toBe("Jane Carney");
    expect(exactNetIdMatch(all, " SR410 ")?.name).toBe("Sam Rivera");
  });

  it("refuses a partial netId", () => {
    // The whole safety of Enter-to-commit is that a netId is unique and complete.
    // A prefix is not: "jc28" could grow into somebody else.
    expect(exactNetIdMatch(all, "jc28")).toBeNull();
  });

  it("refuses a name, however unambiguous", () => {
    expect(exactNetIdMatch(all, "Jane Carney")).toBeNull();
  });

  it("refuses when nothing matches", () => {
    expect(exactNetIdMatch(all, "zz999")).toBeNull();
  });

  it("ignores candidates with no netId", () => {
    const nameless = candidate({ name: "No NetId" });
    expect(exactNetIdMatch([nameless], "")).toBeNull();
  });

  it("prefers the person row when a person and an applicant share a netId", () => {
    // Applicant.netId carries no unique constraint, and someone who applied with
    // one address while their Person carries another survives the email dedupe.
    // A linked check-in is strictly better than an unlinked one, so it wins.
    const twin = candidate({
      name: "Jane Carney",
      kind: "applicant",
      id: "acc_jane",
      netId: "jc2847",
      email: "jcarney@gmail.com",
      accepted: true,
    });
    expect(exactNetIdMatch([twin, jane], "jc2847")).toBe(jane);
  });

  it("refuses when two people share a netId", () => {
    // Person.netId is unique, so this should be impossible -- and if the database
    // ever says otherwise, the door must not pick one at a keystroke.
    const clash = candidate({ name: "Someone Else", id: "other", netId: "jc2847" });
    expect(exactNetIdMatch([jane, clash], "jc2847")).toBeNull();
  });
});
