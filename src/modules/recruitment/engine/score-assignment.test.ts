import { describe, it, expect } from "vitest";
import { allocateAssignments, type AssignmentPair } from "./score-assignment";

const app = (id: string, applicantPersonId: string | null = null) => ({ id, applicantPersonId });
const pair = (applicationId: string, scorerId: string): AssignmentPair => ({ applicationId, scorerId });
/** Sorted "app:scorer" strings, so assertions don't depend on emission order. */
const keys = (pairs: AssignmentPair[]) => pairs.map((p) => `${p.applicationId}:${p.scorerId}`).sort();
/** How many adds each scorer picked up, for the balance assertions. */
const loads = (pairs: AssignmentPair[]) => {
  const out: Record<string, number> = {};
  for (const p of pairs) out[p.scorerId] = (out[p.scorerId] ?? 0) + 1;
  return out;
};

const base = { applications: [], scorerIds: [], target: 2, existing: [], scored: [] };

describe("allocateAssignments", () => {
  it("gives every application `target` scorers when the pool is fresh", () => {
    const { add, remove } = allocateAssignments({
      ...base,
      applications: [app("a1"), app("a2")],
      scorerIds: ["s1", "s2"],
      target: 2,
    });
    expect(keys(add)).toEqual(["a1:s1", "a1:s2", "a2:s1", "a2:s2"]);
    expect(remove).toEqual([]);
  });

  it("never assigns a scorer their own application", () => {
    const { add } = allocateAssignments({
      ...base,
      applications: [app("a1", "s1")],
      scorerIds: ["s1", "s2"],
      target: 2,
    });
    // s1 is the applicant, so the only eligible scorer is s2 and the target
    // clamps to one rather than forcing a self-score.
    expect(keys(add)).toEqual(["a1:s2"]);
  });

  it("clamps the target to the number of eligible scorers", () => {
    const { add } = allocateAssignments({
      ...base,
      applications: [app("a1")],
      scorerIds: ["s1", "s2"],
      target: 5,
    });
    expect(keys(add)).toEqual(["a1:s1", "a1:s2"]);
  });

  it("spreads the work evenly across the pool", () => {
    const { add } = allocateAssignments({
      ...base,
      applications: [app("a1"), app("a2"), app("a3"), app("a4"), app("a5"), app("a6")],
      scorerIds: ["s1", "s2", "s3"],
      target: 1,
    });
    expect(add).toHaveLength(6);
    expect(loads(add)).toEqual({ s1: 2, s2: 2, s3: 2 });
  });

  it("counts an existing assignment toward the target and leaves it in place", () => {
    const { add, remove } = allocateAssignments({
      ...base,
      applications: [app("a1")],
      scorerIds: ["s1", "s2", "s3"],
      target: 2,
      existing: [pair("a1", "s1")],
    });
    expect(add).toHaveLength(1);
    expect(add[0].scorerId).not.toBe("s1");
    expect(remove).toEqual([]);
  });

  it("counts a score from outside the pool toward the target", () => {
    // A lead who is not in the pool scored a1 from the detail page. That is a
    // real review, so a1 needs one fewer assignment, not two.
    const { add } = allocateAssignments({
      ...base,
      applications: [app("a1")],
      scorerIds: ["s1", "s2"],
      target: 2,
      scored: [pair("a1", "outsider")],
    });
    expect(keys(add)).toEqual(["a1:s1"]);
  });

  it("does not assign a scorer who already scored the application", () => {
    const { add } = allocateAssignments({
      ...base,
      applications: [app("a1")],
      scorerIds: ["s1", "s2"],
      target: 1,
      scored: [pair("a1", "s1")],
    });
    expect(add).toEqual([]);
  });

  it("drops a departed scorer's unscored work and refills it from the pool", () => {
    const { add, remove } = allocateAssignments({
      ...base,
      applications: [app("a1")],
      scorerIds: ["s2"], // s1 has been unchecked
      target: 1,
      existing: [pair("a1", "s1")],
    });
    expect(keys(remove)).toEqual(["a1:s1"]);
    expect(keys(add)).toEqual(["a1:s2"]);
  });

  it("keeps a departed scorer's assignment when they already scored it", () => {
    const { add, remove } = allocateAssignments({
      ...base,
      applications: [app("a1")],
      scorerIds: ["s2"],
      target: 1,
      existing: [pair("a1", "s1")],
      scored: [pair("a1", "s1")],
    });
    // The score stands, so a1 is covered and nothing moves.
    expect(remove).toEqual([]);
    expect(add).toEqual([]);
  });

  it("clears unscored assignments when the pool is emptied", () => {
    const { add, remove } = allocateAssignments({
      ...base,
      applications: [app("a1"), app("a2")],
      scorerIds: [],
      target: 2,
      existing: [pair("a1", "s1"), pair("a2", "s1")],
    });
    expect(add).toEqual([]);
    expect(keys(remove)).toEqual(["a1:s1", "a2:s1"]);
  });

  it("only touches the applications it was given", () => {
    const { add, remove } = allocateAssignments({
      ...base,
      applications: [app("a1")],
      scorerIds: ["s2"],
      target: 1,
      // a9 is decided or routed, so it is not in the eligible list at all.
      existing: [pair("a9", "s1")],
    });
    expect(keys(add)).toEqual(["a1:s2"]);
    expect(remove).toEqual([]);
  });

  it("is deterministic across runs", () => {
    const input = {
      ...base,
      applications: [app("a1"), app("a2"), app("a3")],
      scorerIds: ["s1", "s2", "s3", "s4"],
      target: 2,
    };
    expect(keys(allocateAssignments(input).add)).toEqual(keys(allocateAssignments(input).add));
  });

  it("varies which scorers pair up on an application", () => {
    // Load balancing alone is not enough. Breaking ties alphabetically pairs
    // s1 with s2 and s3 with s4 on every single application, so each applicant
    // is read by one of two fixed duos instead of a mixed panel.
    const { add } = allocateAssignments({
      ...base,
      applications: ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"].map((id) => app(id)),
      scorerIds: ["s1", "s2", "s3", "s4"],
      target: 2,
    });
    const pairsPerApp = new Map<string, string[]>();
    for (const p of add) pairsPerApp.set(p.applicationId, [...(pairsPerApp.get(p.applicationId) ?? []), p.scorerId]);
    const distinctPairs = new Set([...pairsPerApp.values()].map((s) => s.slice().sort().join("+")));
    expect(distinctPairs.size).toBeGreaterThan(2);
  });

  it("adds nothing when the target is zero", () => {
    const { add, remove } = allocateAssignments({
      ...base,
      applications: [app("a1")],
      scorerIds: ["s1"],
      target: 0,
    });
    expect(add).toEqual([]);
    expect(remove).toEqual([]);
  });

  it("returns nothing for an empty roster", () => {
    expect(allocateAssignments({ ...base, scorerIds: ["s1"] })).toEqual({ add: [], remove: [] });
  });
});
