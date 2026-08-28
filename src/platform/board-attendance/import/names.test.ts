import { describe, expect, it } from "vitest";
import { buildPersonIndex, matchName, nameKeys, NAME_ALIASES } from "./names";

const people = [
  { id: "p-suh", name: "Samuel Suh" },
  { id: "p-pete", name: "Panagiotis (Pete) Hatzelamprou" },
  { id: "p-lupe", name: "Guadalupe (Lupe) Hernandez Zavala" },
  { id: "p-betty", name: "Beatriz (Betty) Duran-Becerra" },
  { id: "p-lucy", name: "Lucy Kim" },
  { id: "p-carney", name: "Jack Carney" },
  { id: "p-kevin", name: "Kevin Lai" },
  { id: "p-william", name: "William Zhu" },
  { id: "p-ma", name: "YuXuan (Christina) Ma" },
];
const index = buildPersonIndex(people);

describe("nameKeys", () => {
  it("yields both the formal and the preferred spelling", () => {
    expect(nameKeys("Panagiotis (Pete) Hatzelamprou")).toEqual(
      expect.arrayContaining(["panagiotis hatzelamprou", "pete hatzelamprou"]),
    );
  });

  it("flattens accents and hyphens", () => {
    expect(nameKeys("María Mendoza")).toContain("maria mendoza");
    expect(nameKeys("Betty Duran-Becerra")).toContain("betty duran becerra");
  });

  it("drops an interior initial but never a leading or trailing short name", () => {
    expect(nameKeys("Lucy W Kim")).toContain("lucy kim");
    // "Ma" is a whole surname, not an initial, and dropping it would collapse
    // every YuXuan in the directory onto one key.
    expect(nameKeys("YuXuan Ma")).toEqual(["yuxuan ma"]);
  });
});

describe("matchName", () => {
  it("matches an exact name", () => {
    expect(matchName("Jack Carney", index)).toMatchObject({ kind: "matched", personId: "p-carney" });
  });

  it("matches the sheet's everyday spelling to the roster's formal one", () => {
    expect(matchName("Pete Hatzelamprou", index)).toMatchObject({ kind: "matched", personId: "p-pete" });
    expect(matchName("Lupe Hernandez Zavala", index)).toMatchObject({ kind: "matched", personId: "p-lupe" });
    expect(matchName("Betty Duran-Becerra", index)).toMatchObject({ kind: "matched", personId: "p-betty" });
  });

  it("matches through a middle initial", () => {
    expect(matchName("Lucy W Kim", index)).toMatchObject({ kind: "matched", personId: "p-lucy" });
  });

  it("applies the alias table and says so", () => {
    expect(matchName("Sam Suh", index)).toMatchObject({
      kind: "matched",
      personId: "p-suh",
      viaAlias: true,
    });
    expect(matchName("Yuxan Ma", index)).toMatchObject({ kind: "matched", personId: "p-ma", viaAlias: true });
  });

  it("never resolves a name by surname similarity", () => {
    // Both of these were offered by a surname matcher on the real sheet. Either
    // would attach one director's absences, and so their strike count, to a
    // different person.
    expect(matchName("Nathan Lai", index).kind).toBe("unknown");
    expect(matchName("Justin Zhu", index).kind).toBe("unknown");
  });

  it("refuses a name two people answer to", () => {
    const shared = buildPersonIndex([
      { id: "a", name: "Chris Smith" },
      { id: "b", name: "Chris Smith" },
    ]);
    expect(matchName("Chris Smith", shared).kind).toBe("ambiguous");
  });

  it("strips a parenthetical annotation from the name it would create", () => {
    const match = matchName("Thomas Huang (tenure ended feb)", index);
    expect(match).toMatchObject({ kind: "unknown", canonicalName: "Thomas Huang" });
  });
});

describe("NAME_ALIASES", () => {
  it("has no key that a whitespace-collapsing parser could never produce", () => {
    // parse.ts collapses runs of whitespace, so an alias key holding a double
    // space is dead code that silently never fires.
    for (const key of Object.keys(NAME_ALIASES)) {
      expect(key).toBe(key.replace(/\s+/g, " ").trim());
    }
  });

  it("never maps two sheet spellings onto each other in a cycle", () => {
    for (const [from, to] of Object.entries(NAME_ALIASES)) {
      expect(NAME_ALIASES[to]).toBeUndefined();
      expect(to).not.toBe(from);
    }
  });
});
