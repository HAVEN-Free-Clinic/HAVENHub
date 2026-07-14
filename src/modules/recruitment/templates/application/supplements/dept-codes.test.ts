import { describe, it, expect } from "vitest";
import { normalizeDeptCode, SUPPLEMENT_DEPARTMENTS } from "./dept-codes";
// Side-effect-free catalog (NOT prisma/seed.ts, which self-executes the seed
// on import and would try to touch the database).
import { DEPARTMENTS } from "../../../../../../prisma/department-catalog";

// Repo Department seed codes (source of truth), derived from the real catalog
// so this invariant can't silently drift from prisma/seed.ts.
const SEED_CODES = new Set(DEPARTMENTS.map((d) => d.code));

describe("dept-codes", () => {
  it("normalizes Airtable aliases to seed codes", () => {
    expect(normalizeDeptCode("FCLR")).toBe("FCRL");
    expect(normalizeDeptCode("SR&R")).toBe("SRR");
    expect(normalizeDeptCode(" mdic ")).toBe("MDIC");
  });
  it("every supplement department resolves to a seeded Department code", () => {
    for (const track of ["VOLUNTEER", "DIRECTOR"] as const) {
      for (const code of SUPPLEMENT_DEPARTMENTS[track]) expect(SEED_CODES.has(code)).toBe(true);
    }
  });
});
