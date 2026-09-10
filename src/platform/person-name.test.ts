import { describe, expect, it } from "vitest";
import {
  displayNameOf,
  firstNameOf,
  legalNameOf,
  splitPersonName,
  sortKeyOf,
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

  // Nothing distinguishes "(Jack)" from "(inactive)" lexically, and reading the
  // second one as a name puts "inactive Carney" on a roster and a wallet pass.
  // A lifted nickname is therefore always a guess, however plausible.
  it("lifts a parenthetical into preferredFirstName, and flags it", () => {
    expect(splitPersonName("Jonathan (Jack) Carney")).toEqual({
      legalFirstName: "Jonathan",
      legalMiddleName: null,
      lastName: "Carney",
      preferredFirstName: "Jack",
      needsReview: true,
    });
    expect(splitPersonName("Jane Doe (inactive)")).toMatchObject({
      preferredFirstName: "inactive",
      needsReview: true,
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
