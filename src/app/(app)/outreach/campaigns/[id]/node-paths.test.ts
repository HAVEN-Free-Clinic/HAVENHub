/**
 * The node-path scheme is deliberately written twice: once in
 * audience/resolve.ts, which reaches into prisma and must stay out of the client
 * bundle, and once in node-paths.ts for the builder. Duplication is the right
 * call there, but only if a drift between the two is loud. This file is what
 * makes it loud: it is the only place that imports both, and it compares them
 * to EACH OTHER rather than each to its own copy of the expected answer. An
 * earlier version only compared the two constants and checked the client walk
 * against a hardcoded literal, so changing the server's child-path scheme left
 * this file green while seven tests elsewhere failed -- a guard describing
 * itself as something it was not.
 */
import { describe, expect, it } from "vitest";
import type { Audience } from "@/platform/email/audience/types";
import {
  MAX_COUNTED_NODES as SERVER_MAX,
  ROOT_NODE_PATH as SERVER_ROOT,
  enumerateNodes,
} from "@/platform/email/audience/resolve";
import {
  MAX_COUNTED_NODES,
  ROOT_NODE_PATH,
  audienceStructureKey,
  childNodePath,
  nodePaths,
} from "./node-paths";

const NESTED: Audience = {
  recordType: "PERSON",
  match: "ALL",
  conditions: [
    { field: "name", op: "contains", value: "a" },
    {
      match: "ANY",
      children: [
        { field: "name", op: "contains", value: "b" },
        { match: "NONE", children: [{ field: "name", op: "contains", value: "c" }] },
      ],
    },
  ],
};

describe("node paths", () => {
  it("agrees with the server on the constants it duplicates", () => {
    expect(ROOT_NODE_PATH).toBe(SERVER_ROOT);
    // Drift here is silent and nasty: the builder would promise counts the
    // server refuses to compute, or explain a budget the server has not hit.
    expect(MAX_COUNTED_NODES).toBe(SERVER_MAX);
  });

  // Compared against the server's OWN walk, not against a literal each side
  // repeats: two hardcoded lists agree right up until someone changes one of
  // them, which is the drift this file exists to catch.
  it("walks a nested tree in the server's order, keyed the server's way", () => {
    expect(nodePaths(NESTED)).toEqual(enumerateNodes(NESTED).map((n) => n.path));
    // Pinned literally as well, so a change that broke BOTH halves in the same
    // way still fails here.
    expect(nodePaths(NESTED)).toEqual(["root", "0", "1", "1.0", "1.1", "1.1.0"]);
  });

  it("agrees with the server's walk on a flat tree and on an empty one", () => {
    const flat: Audience = {
      recordType: "PERSON",
      match: "ANY",
      conditions: [
        { field: "name", op: "isNotEmpty" },
        { field: "name", op: "isEmpty" },
      ],
    };
    const empty: Audience = { recordType: "PERSON", match: "ALL", conditions: [] };
    for (const a of [flat, empty]) {
      expect(nodePaths(a)).toEqual(enumerateNodes(a).map((n) => n.path));
    }
    expect(nodePaths(empty)).toEqual(["root"]);
  });

  it("keeps root-level children unprefixed and nests everything below", () => {
    expect(childNodePath(ROOT_NODE_PATH, 0)).toBe("0");
    expect(childNodePath("1", 2)).toBe("1.2");
    expect(childNodePath("1.2", 0)).toBe("1.2.0");
  });
});

describe("audienceStructureKey", () => {
  it("ignores a value edit, which is what lets counts survive typing", () => {
    const edited: Audience = {
      ...NESTED,
      conditions: [{ field: "name", op: "contains", value: "azzz" }, NESTED.conditions[1]],
    };
    expect(audienceStructureKey(edited)).toBe(audienceStructureKey(NESTED));
  });

  it("changes when a clause is removed, because every later path shifts", () => {
    const removed: Audience = { ...NESTED, conditions: [NESTED.conditions[1]] };
    expect(audienceStructureKey(removed)).not.toBe(audienceStructureKey(NESTED));
  });

  // Same paths, same counts, different LABEL. This is the case a path-set
  // comparison alone would miss.
  it("changes when a group's connective flips, even though no path moves", () => {
    const flipped: Audience = {
      ...NESTED,
      conditions: [
        NESTED.conditions[0],
        { match: "NONE", children: [{ field: "name", op: "contains", value: "b" }] },
      ],
    };
    const same: Audience = {
      ...NESTED,
      conditions: [
        NESTED.conditions[0],
        { match: "ANY", children: [{ field: "name", op: "contains", value: "b" }] },
      ],
    };
    expect(nodePaths(flipped)).toEqual(nodePaths(same));
    expect(audienceStructureKey(flipped)).not.toBe(audienceStructureKey(same));
  });

  it("changes when the root connective flips", () => {
    expect(audienceStructureKey({ ...NESTED, match: "ANY" })).not.toBe(
      audienceStructureKey(NESTED),
    );
  });
});
