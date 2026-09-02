/**
 * The node-path scheme is deliberately written twice: once in
 * audience/resolve.ts, which reaches into prisma and must stay out of the client
 * bundle, and once in node-paths.ts for the builder. Duplication is the right
 * call there, but only if a drift between the two is loud. This file is what
 * makes it loud -- it is the only place that imports both.
 */
import { describe, expect, it } from "vitest";
import type { Audience } from "@/platform/email/audience/types";
import {
  MAX_COUNTED_NODES as SERVER_MAX,
  ROOT_NODE_PATH as SERVER_ROOT,
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

  it("walks a nested tree in the server's order, keyed the server's way", () => {
    expect(nodePaths(NESTED)).toEqual(["root", "0", "1", "1.0", "1.1", "1.1.0"]);
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
