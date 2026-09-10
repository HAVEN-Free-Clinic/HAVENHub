/**
 * Unit tests for the shared list-sort param helpers.
 *
 * Honest framing: these are green against the code they were lifted from --
 * parseSort and nextDirection are applicant-sort.ts's parseApplicantSort and
 * nextSortDirection with the key set passed in rather than closed over, and the
 * recruitment suite already covered that behaviour. They are here so the
 * behaviour stays pinned now that it has more than one consumer, not as proof
 * the extraction was needed. The test that actually fails against the old code
 * is the masterCompliance paging one in the volunteers compliance suite.
 */

import { describe, expect, it } from "vitest";
import { nextDirection, parseSort, type SortDirection } from "./sort";

const KEYS = ["name", "departments"] as const;
type Key = (typeof KEYS)[number];

const DEFAULTS: Record<Key, SortDirection> = { name: "asc", departments: "desc" };

describe("parseSort", () => {
  it("returns the key/direction pair for a known key", () => {
    expect(parseSort("name", "desc", KEYS)).toEqual({ key: "name", dir: "desc" });
  });

  it("returns null for a key the list does not offer", () => {
    expect(parseSort("salary", "asc", KEYS)).toBeNull();
  });

  it("returns null when the direction is missing or garbage", () => {
    expect(parseSort("name", undefined, KEYS)).toBeNull();
    expect(parseSort("name", "sideways", KEYS)).toBeNull();
    expect(parseSort("name", "", KEYS)).toBeNull();
  });

  it("returns null for an absent or empty sort param", () => {
    expect(parseSort(undefined, "asc", KEYS)).toBeNull();
    expect(parseSort("", "asc", KEYS)).toBeNull();
  });
});

describe("nextDirection", () => {
  it("flips the direction of the column that is already active", () => {
    expect(nextDirection({ key: "name", dir: "asc" }, "name", DEFAULTS)).toBe("desc");
    expect(nextDirection({ key: "name", dir: "desc" }, "name", DEFAULTS)).toBe("asc");
  });

  it("opens a different column in that column's own default direction", () => {
    expect(nextDirection({ key: "name", dir: "desc" }, "departments", DEFAULTS)).toBe("desc");
    expect(nextDirection(null, "name", DEFAULTS)).toBe("asc");
    expect(nextDirection(null, "departments", DEFAULTS)).toBe("desc");
  });
});
