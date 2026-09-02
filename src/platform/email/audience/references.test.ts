import { describe, expect, it } from "vitest";
import { collectAudienceReferences } from "./references";
import type { AudienceNode } from "./types";
import { CYCLE_VALUED_FIELD_KEYS } from "./types";

describe("collectAudienceReferences", () => {
  it("collects department codes, cycle ids and term scopes", () => {
    const nodes: AudienceNode[] = [
      { field: "department", op: "in", value: ["CARDIO", "PEDS"] },
      { field: "appliedToCycle", op: "notIn", value: ["fall26"] },
      { field: "role", op: "eq", value: "VOLUNTEER", terms: ["sp26", "su26"] },
    ];
    const refs = collectAudienceReferences(nodes);
    expect([...refs.departmentCodes].sort()).toEqual(["CARDIO", "PEDS"]);
    expect([...refs.cycleIds]).toEqual(["fall26"]);
    expect([...refs.termIds].sort()).toEqual(["sp26", "su26"]);
  });

  // Driven off the shared registry rather than a hand-listed pair, because the
  // failure a hand-listed pair misses is exactly the #82 one: a cycle-valued
  // field added later and not collected here keeps a deleted cycle out of the
  // builder's picker, so the stored value filters forever with nothing on
  // screen to uncheck. Every member of the list has to be collected, including
  // ones that do not exist yet.
  it("collects the cycle ids named by EVERY cycle-valued field into one set", () => {
    // Guard the guard: an empty list would make the loop below vacuous.
    expect(CYCLE_VALUED_FIELD_KEYS.length).toBeGreaterThan(1);
    const refs = collectAudienceReferences(
      CYCLE_VALUED_FIELD_KEYS.map((field, i) => ({
        field,
        op: "in" as const,
        value: [`cycle-${i}`],
      })),
    );
    expect([...refs.cycleIds].sort()).toEqual(
      CYCLE_VALUED_FIELD_KEYS.map((_, i) => `cycle-${i}`).sort(),
    );
  });

  it("collects subcommittee ids named by a subcommittee condition", () => {
    const refs = collectAudienceReferences([
      { field: "subcommittee", op: "in", value: ["sub1", "sub2"] },
    ]);
    expect([...refs.subcommitteeIds].sort()).toEqual(["sub1", "sub2"]);
  });

  it("recurses into nested groups", () => {
    const nodes: AudienceNode[] = [
      {
        match: "ANY",
        children: [
          { field: "department", op: "in", value: ["DERM"] },
          {
            match: "NONE",
            children: [{ field: "onRoster", op: "isTrue", terms: ["fa25"] }],
          },
        ],
      },
    ];
    const refs = collectAudienceReferences(nodes);
    expect([...refs.departmentCodes]).toEqual(["DERM"]);
    expect([...refs.termIds]).toEqual(["fa25"]);
  });

  it("reads a term scope off any field, not just today's term-scoped ones", () => {
    // A stored audience written against an earlier registry must not lose its
    // scope just because the field is no longer marked term-scoped.
    const refs = collectAudienceReferences([
      { field: "licensedRN", op: "isTrue", terms: ["sp26"] },
    ]);
    expect([...refs.termIds]).toEqual(["sp26"]);
  });

  it("ignores blanks and non-string values", () => {
    const refs = collectAudienceReferences([
      { field: "department", op: "in", value: ["", "CARDIO"] },
      { field: "role", op: "eq", value: "VOLUNTEER", terms: [] },
    ]);
    expect([...refs.departmentCodes]).toEqual(["CARDIO"]);
    expect(refs.termIds.size).toBe(0);
  });

  it("is empty for an empty audience", () => {
    const refs = collectAudienceReferences([]);
    expect(refs.departmentCodes.size).toBe(0);
    expect(refs.cycleIds.size).toBe(0);
    expect(refs.termIds.size).toBe(0);
  });
});
