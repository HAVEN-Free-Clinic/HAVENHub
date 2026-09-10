import { describe, expect, it } from "vitest";
import { reconcilePersonNameWrite } from "./person-name-write";

describe("reconcilePersonNameWrite on create", () => {
  it("splits a bare name into parts and derives the display name back", () => {
    expect(reconcilePersonNameWrite("create", { name: "Jack Carney" })).toEqual({
      name: "Jack Carney",
      legalFirstName: "Jack",
      legalMiddleName: null,
      lastName: "Carney",
      preferredFirstName: null,
      nameNeedsReview: false,
    });
  });

  it("lifts a parenthetical out of the display name, flagging the guess", () => {
    expect(reconcilePersonNameWrite("create", { name: "Jonathan (Jack) Carney" })).toEqual({
      name: "Jack Carney",
      legalFirstName: "Jonathan",
      legalMiddleName: null,
      lastName: "Carney",
      preferredFirstName: "Jack",
      nameNeedsReview: true,
    });
  });

  it("flags a name it had to guess at", () => {
    expect(reconcilePersonNameWrite("create", { name: "Maria de la Cruz" })).toMatchObject({
      name: "Maria de la Cruz",
      lastName: "de la Cruz",
      nameNeedsReview: true,
    });
  });

  it("derives the display name when the caller supplies parts", () => {
    expect(
      reconcilePersonNameWrite("create", {
        legalFirstName: "Jonathan",
        lastName: "Carney",
        preferredFirstName: "Jack",
      }),
    ).toEqual({
      name: "Jack Carney",
      legalFirstName: "Jonathan",
      legalMiddleName: null,
      lastName: "Carney",
      preferredFirstName: "Jack",
      nameNeedsReview: false,
    });
  });

  it("lets explicit parts win over a stale name the caller also passed", () => {
    expect(
      reconcilePersonNameWrite("create", {
        name: "Jonathan (Jack) Carney",
        legalFirstName: "Jonathan",
        lastName: "Carney",
        preferredFirstName: "Jack",
      }),
    ).toMatchObject({ name: "Jack Carney", preferredFirstName: "Jack" });
  });

  it("preserves a caller's own review flag", () => {
    expect(
      reconcilePersonNameWrite("create", {
        legalFirstName: "Bo",
        lastName: "Peng",
        nameNeedsReview: true,
      }),
    ).toMatchObject({ name: "Bo Peng", nameNeedsReview: true });
  });

  it("keeps a mononym, which has a given name and no surname", () => {
    expect(
      reconcilePersonNameWrite("create", { legalFirstName: "Cher", lastName: "" }),
    ).toMatchObject({ name: "Cher", legalFirstName: "Cher", lastName: "" });
  });

  it("refuses a create that names nobody", () => {
    expect(() => reconcilePersonNameWrite("create", { contactEmail: "a@b.c" })).toThrow(
      /name/i,
    );
  });

  // The form posts "" for an empty box, so a submit with both name boxes blank
  // reaches here as parts rather than as a missing name.
  it("refuses parts that are blank, rather than seating a nameless person", () => {
    expect(() =>
      reconcilePersonNameWrite("create", { legalFirstName: "  ", lastName: "" }),
    ).toThrow(/legalFirstName/);
    expect(() =>
      reconcilePersonNameWrite("update", { legalFirstName: "", lastName: "Carney" }),
    ).toThrow(/legalFirstName/);
  });
});

describe("reconcilePersonNameWrite on update", () => {
  it("leaves a write that touches no name field completely alone", () => {
    const data = { phone: "203-555-0100" };
    expect(reconcilePersonNameWrite("update", data)).toBe(data);
  });

  it("re-splits when only the display name is written", () => {
    expect(reconcilePersonNameWrite("update", { name: "Jane Q Doe" })).toEqual({
      name: "Jane Doe",
      legalFirstName: "Jane",
      legalMiddleName: "Q",
      lastName: "Doe",
      preferredFirstName: null,
      nameNeedsReview: false,
    });
  });

  it("derives the display name from complete parts", () => {
    expect(
      reconcilePersonNameWrite("update", {
        legalFirstName: "Jonathan",
        legalMiddleName: null,
        lastName: "Carney",
        preferredFirstName: "Jack",
        nameNeedsReview: false,
      }),
    ).toMatchObject({ name: "Jack Carney" });
  });

  it("clears the preferred name back to the legal one", () => {
    expect(
      reconcilePersonNameWrite("update", {
        legalFirstName: "Jonathan",
        lastName: "Carney",
        preferredFirstName: null,
      }),
    ).toMatchObject({ name: "Jonathan Carney", preferredFirstName: null });
  });

  // Confirming a guessed split changes no name value, so it needs no parts.
  it("lets the review flag be cleared on its own", () => {
    const data = { nameNeedsReview: false };
    expect(reconcilePersonNameWrite("update", data)).toBe(data);
  });

  it("refuses a partial parts update, which cannot derive a display name", () => {
    expect(() =>
      reconcilePersonNameWrite("update", { preferredFirstName: "Jack" }),
    ).toThrow(/legalFirstName and lastName/);
    expect(() => reconcilePersonNameWrite("update", { lastName: "Carney" })).toThrow(
      /legalFirstName and lastName/,
    );
  });

  it("refuses a Prisma field-operation object it cannot read through", () => {
    expect(() =>
      reconcilePersonNameWrite("update", { name: { set: "Jack Carney" } }),
    ).toThrow(/plain string/);
  });
});
