import { describe, expect, it } from "vitest";
import {
  displayNameOf,
  firstNameOf,
  legalNameOf,
  splitPersonName,
  sortKeyOf,
  personNameSearchClauses,
  comparePersonName,
} from "./person-name";

describe("firstNameOf", () => {
  it("takes the leading token when there is no parenthetical", () => {
    expect(firstNameOf("Jonathan Carney")).toBe("Jonathan");
    expect(firstNameOf("Jane Q Doe")).toBe("Jane");
    expect(firstNameOf("Cher")).toBe("Cher");
  });

  it("prefers a parenthetical preferred name wherever it sits", () => {
    expect(firstNameOf("Jonathan (Jack) Carney")).toBe("Jack");
    expect(firstNameOf("(Jack) Jonathan Carney")).toBe("Jack");
    expect(firstNameOf("Jonathan Carney (Jack)")).toBe("Jack");
    expect(firstNameOf("Carney, Jonathan (Jack)")).toBe("Jack");
  });

  // From the production roster: "Antonio Bolea (Tony Vega)". Only "Tony" is
  // lifted, so "Vega" is discarded, and we cannot know whether that was a second
  // given name or the surname he actually goes by. Dropping part of a name is a
  // guess like any other.
  it("flags a parenthetical carrying more than one token", () => {
    expect(splitPersonName("Antonio Bolea (Tony Vega)")).toMatchObject({
      preferredFirstName: "Tony",
      needsReview: true,
    });
  });

  it("takes only the first token inside the parenthetical", () => {
    expect(firstNameOf("Jonathan (Jack Ryan) Carney")).toBe("Jack");
  });

  it("keeps the punctuation real given names carry", () => {
    expect(firstNameOf("Siobhan (Bláthnaid) Murphy")).toBe("Bláthnaid");
    expect(firstNameOf("Mary (Mary-Kate) Olsen")).toBe("Mary-Kate");
    expect(firstNameOf("Sean (O'Neill) Murphy")).toBe("O'Neill");
  });

  it("ignores pronouns in parentheses", () => {
    expect(firstNameOf("Peggy (she/her) Bia")).toBe("Peggy");
    expect(firstNameOf("Peggy (she) Bia")).toBe("Peggy");
    expect(firstNameOf("Alex (they/them) Chen")).toBe("Alex");
    expect(firstNameOf("Alex (They/Them) Chen")).toBe("Alex");
  });

  it("ignores credentials in parentheses", () => {
    expect(firstNameOf("Jane Doe (RN)")).toBe("Jane");
    expect(firstNameOf("Jane Doe (M.D.)")).toBe("Jane");
    expect(firstNameOf("John Smith (Jr)")).toBe("John");
  });

  it("skips an unusable group and keeps scanning", () => {
    expect(firstNameOf("Bo (he/him) (Jack) Peng")).toBe("Jack");
    expect(firstNameOf("Bo (Jack) Peng (he/him)")).toBe("Jack");
  });

  it("ignores a parenthetical that is not shaped like a name", () => {
    expect(firstNameOf("Jonathan () Carney")).toBe("Jonathan");
    expect(firstNameOf("Jonathan (   ) Carney")).toBe("Jonathan");
    expect(firstNameOf("Jonathan (#2) Carney")).toBe("Jonathan");
    expect(firstNameOf("Jonathan (2nd) Carney")).toBe("Jonathan");
  });

  it("collapses surrounding whitespace", () => {
    expect(firstNameOf("   Jonathan   Carney  ")).toBe("Jonathan");
    expect(firstNameOf("  (Jack)  Jonathan  ")).toBe("Jack");
  });

  it("returns an empty string when there is no usable name", () => {
    expect(firstNameOf("")).toBe("");
    expect(firstNameOf("   ")).toBe("");
    expect(firstNameOf(null)).toBe("");
    expect(firstNameOf(undefined)).toBe("");
  });

  it("reads the stored parts when handed a person rather than a string", () => {
    expect(
      firstNameOf({
        legalFirstName: "Jonathan",
        lastName: "Carney",
        preferredFirstName: "Jack",
      }),
    ).toBe("Jack");
    expect(
      firstNameOf({
        legalFirstName: "Jonathan",
        lastName: "Carney",
        preferredFirstName: null,
      }),
    ).toBe("Jonathan");
  });
});

describe("splitPersonName", () => {
  it("splits a plain two-token name with confidence", () => {
    expect(splitPersonName("Jonathan Carney")).toEqual({
      legalFirstName: "Jonathan",
      legalMiddleName: null,
      lastName: "Carney",
      preferredFirstName: null,
      needsReview: false,
    });
  });

  // A nickname on this roster is written like a name: "(Jack)", "(Betty)",
  // "(Christina)". An annotation is not: "(inactive)", "(LOA)", "(do not
  // schedule)". Capitalisation is the only signal separating them, so it is what
  // decides whether the lift is trusted or queued for a human.
  it("trusts a capitalised parenthetical as the name it looks like", () => {
    expect(splitPersonName("Jonathan (Jack) Carney")).toEqual({
      legalFirstName: "Jonathan",
      legalMiddleName: null,
      lastName: "Carney",
      preferredFirstName: "Jack",
      needsReview: false,
    });
    expect(splitPersonName("YuXuan (Christina) Ma")).toMatchObject({
      preferredFirstName: "Christina",
      needsReview: false,
    });
  });

  it("flags a lifted parenthetical that does not read as a given name", () => {
    // Lowercase: an annotation, not a nickname.
    expect(splitPersonName("Jane Doe (inactive)")).toMatchObject({
      preferredFirstName: "inactive",
      needsReview: true,
    });
    // ALL-CAPS that is not a known credential. "RN" is in NAME_SUFFIXES and is
    // discarded outright; "LOA" is not, so it lifts and gets queued.
    expect(splitPersonName("Jane Doe (LOA)")).toMatchObject({
      preferredFirstName: "LOA",
      needsReview: true,
    });
  });

  // The documented hole in the rule, pinned so it is a known limit rather than a
  // surprise: a capitalised annotation is indistinguishable from a nickname.
  it("cannot tell a capitalised annotation from a nickname", () => {
    expect(splitPersonName("Jane Doe (Inactive)")).toMatchObject({
      preferredFirstName: "Inactive",
      needsReview: false,
    });
  });

  // A parenthetical we RECOGNIZE and discard is not a guess: the pronoun and
  // credential lists are closed, so nothing was interpreted.
  it("stays confident when the parenthetical was a pronoun or a credential", () => {
    expect(splitPersonName("Peggy (she/her) Bia")).toMatchObject({ needsReview: false });
    expect(splitPersonName("Jane Doe (RN)")).toMatchObject({ needsReview: false });
  });

  // "Jane Q Doe" displays as "Jane Doe" and nobody minds. "J. R. Carney"
  // displays as "J. Carney", which is not what J. R. is called.
  it("flags a name whose given name is itself an initial", () => {
    expect(splitPersonName("J. R. Carney")).toMatchObject({
      legalFirstName: "J.",
      legalMiddleName: "R.",
      lastName: "Carney",
      needsReview: true,
    });
    expect(splitPersonName("J. Carney")).toMatchObject({
      legalFirstName: "J.",
      lastName: "Carney",
      needsReview: true,
    });
  });

  it("drops a pronoun parenthetical without reading it as a preferred name", () => {
    expect(splitPersonName("Peggy (she/her) Bia")).toEqual({
      legalFirstName: "Peggy",
      legalMiddleName: null,
      lastName: "Bia",
      preferredFirstName: null,
      needsReview: false,
    });
  });

  it("drops a credential parenthetical without reading it as a preferred name", () => {
    expect(splitPersonName("Jane Doe (RN)")).toEqual({
      legalFirstName: "Jane",
      legalMiddleName: null,
      lastName: "Doe",
      preferredFirstName: null,
      needsReview: false,
    });
  });

  it("keeps a plain middle initial confident, since dropping it from display is right", () => {
    expect(splitPersonName("Jane Q Doe")).toMatchObject({ needsReview: false });
  });

  it("treats a bare middle initial as confident", () => {
    expect(splitPersonName("Jane Q Doe")).toMatchObject({
      legalFirstName: "Jane",
      legalMiddleName: "Q",
      lastName: "Doe",
      needsReview: false,
    });
    expect(splitPersonName("Jane Q. Doe")).toMatchObject({
      legalMiddleName: "Q.",
      needsReview: false,
    });
  });

  it("keeps a particle with the surname, and flags it", () => {
    expect(splitPersonName("Maria de la Cruz")).toEqual({
      legalFirstName: "Maria",
      legalMiddleName: null,
      lastName: "de la Cruz",
      preferredFirstName: null,
      needsReview: true,
    });
    expect(splitPersonName("Piet van der Berg")).toMatchObject({
      lastName: "van der Berg",
      needsReview: true,
    });
  });

  // From the production roster: "Yasmine Ben Naceur". "ben" sits with bin/ibn,
  // which were already here; it was simply missed.
  it("treats ben as a surname particle", () => {
    expect(splitPersonName("Yasmine Ben Naceur")).toMatchObject({
      legalFirstName: "Yasmine",
      lastName: "Ben Naceur",
      needsReview: true,
    });
  });

  it("flags a three-token name whose middle is not an initial", () => {
    expect(splitPersonName("Guadalupe Hernandez Zavala")).toEqual({
      legalFirstName: "Guadalupe",
      legalMiddleName: "Hernandez",
      lastName: "Zavala",
      preferredFirstName: null,
      needsReview: true,
    });
  });

  it("reads the comma form as Last, First and flags it", () => {
    expect(splitPersonName("Carney, Jonathan")).toEqual({
      legalFirstName: "Jonathan",
      legalMiddleName: null,
      lastName: "Carney",
      preferredFirstName: null,
      needsReview: true,
    });
    expect(splitPersonName("Peng, Bo (Jack)")).toMatchObject({
      legalFirstName: "Bo",
      lastName: "Peng",
      preferredFirstName: "Jack",
      needsReview: true,
    });
  });

  // From the attendings contact sheet: "Ponce Terashima, Javier". Everything
  // before the comma IS the surname; re-tokenising it threw "Ponce" away and
  // filed him under Terashima.
  it("keeps a compound surname whole in the Last, First form", () => {
    expect(splitPersonName("Ponce Terashima, Javier")).toMatchObject({
      legalFirstName: "Javier",
      legalMiddleName: null,
      lastName: "Ponce Terashima",
      needsReview: true,
    });
    expect(splitPersonName("Hernandez Castillo, Carlos")).toMatchObject({
      legalFirstName: "Carlos",
      lastName: "Hernandez Castillo",
    });
  });

  it("still reads a middle name after the comma", () => {
    expect(splitPersonName("Doe, Jane Q")).toMatchObject({
      legalFirstName: "Jane",
      legalMiddleName: "Q",
      lastName: "Doe",
    });
  });

  it("strips a trailing credential rather than reading it as a surname, and flags it", () => {
    expect(splitPersonName("Jane Doe, RN")).toEqual({
      legalFirstName: "Jane",
      legalMiddleName: null,
      lastName: "Doe",
      preferredFirstName: null,
      needsReview: true,
    });
    expect(splitPersonName("Jane Doe, M.D.")).toMatchObject({
      lastName: "Doe",
      needsReview: true,
    });
  });

  it("strips a trailing suffix carried without a comma, and flags it", () => {
    expect(splitPersonName("John Smith Jr")).toMatchObject({
      legalFirstName: "John",
      legalMiddleName: null,
      lastName: "Smith",
      needsReview: true,
    });
  });

  it("flags a mononym, leaving the surname empty rather than guessing", () => {
    expect(splitPersonName("Cher")).toEqual({
      legalFirstName: "Cher",
      legalMiddleName: null,
      lastName: "",
      preferredFirstName: null,
      needsReview: true,
    });
  });

  it("flags an empty name instead of throwing", () => {
    for (const empty of ["", "   ", null, undefined]) {
      expect(splitPersonName(empty)).toEqual({
        legalFirstName: "",
        legalMiddleName: null,
        lastName: "",
        preferredFirstName: null,
        needsReview: true,
      });
    }
  });

  it("agrees with firstNameOf on which name to greet by", () => {
    for (const name of [
      "Jonathan (Jack) Carney",
      "Peggy (she/her) Bia",
      "Jane Doe (RN)",
      "Bo (he/him) (Jack) Peng",
      "Jonathan Carney",
    ]) {
      const parts = splitPersonName(name);
      expect(parts.preferredFirstName ?? parts.legalFirstName).toBe(firstNameOf(name));
    }
  });
});

describe("displayNameOf", () => {
  it("pairs the preferred name with the surname", () => {
    expect(
      displayNameOf({
        legalFirstName: "Jonathan",
        legalMiddleName: null,
        lastName: "Carney",
        preferredFirstName: "Jack",
      }),
    ).toBe("Jack Carney");
  });

  it("falls back to the legal first name, and never shows the middle name", () => {
    expect(
      displayNameOf({
        legalFirstName: "Jane",
        legalMiddleName: "Quinn",
        lastName: "Doe",
        preferredFirstName: null,
      }),
    ).toBe("Jane Doe");
  });

  it("does not leave a dangling space for a mononym", () => {
    expect(
      displayNameOf({
        legalFirstName: "Cher",
        legalMiddleName: null,
        lastName: "",
        preferredFirstName: null,
      }),
    ).toBe("Cher");
  });
});

describe("legalNameOf", () => {
  it("ignores the preferred name and includes the middle name", () => {
    expect(
      legalNameOf({
        legalFirstName: "Jonathan",
        legalMiddleName: "Peter",
        lastName: "Carney",
        preferredFirstName: "Jack",
      }),
    ).toBe("Jonathan Peter Carney");
  });

  it("collapses a missing middle name", () => {
    expect(
      legalNameOf({
        legalFirstName: "Jonathan",
        legalMiddleName: null,
        lastName: "Carney",
        preferredFirstName: "Jack",
      }),
    ).toBe("Jonathan Carney");
  });
});

describe("sortKeyOf", () => {
  it("sorts on the surname, then the legal first name", () => {
    expect(
      sortKeyOf({
        legalFirstName: "Jonathan",
        legalMiddleName: null,
        lastName: "Carney",
        preferredFirstName: "Jack",
      }),
    ).toEqual(["carney", "jonathan"]);
  });

  it("folds accents so surnames collate next to their unaccented spelling", () => {
    expect(
      sortKeyOf({
        legalFirstName: "José",
        legalMiddleName: null,
        lastName: "Peña",
        preferredFirstName: null,
      }),
    ).toEqual(["pena", "jose"]);
  });
});

describe("personNameSearchClauses", () => {
  /**
   * legalMiddleName is NULLABLE, and that makes it dangerous in a clause that
   * might be negated. `"middle" LIKE '%x%'` is NULL for a row with no middle
   * name, NULL survives an OR, and NOT(NULL) is NULL, so every person without a
   * middle name silently disappears from a "does not contain" filter or a NONE
   * group. Same shape as #224.
   *
   * The explicit IS NOT NULL guard turns that NULL into a false, which negates
   * correctly.
   */
  it("guards the nullable middle name so a negated search cannot drop null rows", () => {
    const clauses = personNameSearchClauses("Rivera");
    expect(clauses).toContainEqual({
      AND: [
        { legalMiddleName: { not: null } },
        { legalMiddleName: { contains: "Rivera", mode: "insensitive" } },
      ],
    });
    // The NOT NULL columns need no guard.
    expect(clauses).toContainEqual({ name: { contains: "Rivera", mode: "insensitive" } });
  });

  it("prefixes every clause, guard included, when searching across a relation", () => {
    const clauses = personNameSearchClauses("Rivera", "person");
    expect(clauses).toContainEqual({
      person: {
        AND: [
          { legalMiddleName: { not: null } },
          { legalMiddleName: { contains: "Rivera", mode: "insensitive" } },
        ],
      },
    });
  });
});

describe("comparePersonName", () => {
  const p = (legalFirstName: string, lastName: string, preferredFirstName: string | null = null) => ({
    legalFirstName,
    lastName,
    preferredFirstName,
  });

  it("orders by surname, then by the legal given name", () => {
    const rows = [p("Zoe", "Adams"), p("Al", "Baker"), p("Bea", "Adams")];
    expect([...rows].sort(comparePersonName).map((r) => `${r.legalFirstName} ${r.lastName}`)).toEqual([
      "Bea Adams",
      "Zoe Adams",
      "Al Baker",
    ]);
  });

  // The same reason PERSON_NAME_ORDER keys on the legal name: a list that
  // reorders itself because somebody set a nickname is a list that moved under
  // a reader who did nothing.
  it("ignores the preferred name, so setting one does not reshuffle a list", () => {
    const before = [p("Al", "Baker"), p("Zoe", "Adams")];
    const after = [p("Al", "Baker", "Zzz"), p("Zoe", "Adams")];
    const key = (r: { legalFirstName: string; lastName: string }) => `${r.legalFirstName} ${r.lastName}`;
    expect([...after].sort(comparePersonName).map(key)).toEqual([...before].sort(comparePersonName).map(key));
  });

  it("folds accents, so Peña sorts beside Pena", () => {
    const rows = [p("Ana", "Perez"), p("Ana", "Peña"), p("Ana", "Perry")];
    expect([...rows].sort(comparePersonName).map((r) => r.lastName)).toEqual(["Peña", "Perez", "Perry"]);
  });

  it("puts a mononym first, which is the documented wart", () => {
    const rows = [p("Ada", "Lovelace"), p("Cher", "")];
    expect([...rows].sort(comparePersonName).map((r) => r.legalFirstName)).toEqual(["Cher", "Ada"]);
  });
});
