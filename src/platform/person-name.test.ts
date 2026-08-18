import { describe, expect, it } from "vitest";
import { firstNameOf } from "./person-name";

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
});
