import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  netIdFromUpn,
  resolvePersonForLogin,
  getActivePerson,
  entraTenantAllowed,
  applicantEmailFromClaims,
  firstNameFromClaims,
  yaleEmailForNetId,
  accountEmailForPerson,
  mailingEmailForPerson,
} from "./match-person";

describe("netIdFromUpn", () => {
  it("extracts a NetID-shaped local part", () => {
    expect(netIdFromUpn("abc123@yale.edu")).toBe("abc123");
  });
  it("lowercases", () => {
    expect(netIdFromUpn("ABC123@yale.edu")).toBe("abc123");
  });
  it("rejects alias-style addresses (first.last)", () => {
    expect(netIdFromUpn("jack.carney@yale.edu")).toBeNull();
  });
  it("handles empty/garbage input", () => {
    expect(netIdFromUpn("")).toBeNull();
    expect(netIdFromUpn("@yale.edu")).toBeNull();
  });
  it("rejects a NetID-shaped local part from a non-Yale UPN", () => {
    expect(netIdFromUpn("bb123@evilcorp.com")).toBeNull();
  });
});

describe("resolvePersonForLogin", () => {
  beforeEach(resetDb);

  it("matches by already-linked entraObjectId first", async () => {
    const person = await prisma.person.create({
      data: { name: "A", entraObjectId: "oid-1", contactEmail: "a@yale.edu" },
    });
    const found = await resolvePersonForLogin({
      entraObjectId: "oid-1",
      upn: "zz999@yale.edu", // would not match anyone
      email: "other@yale.edu",
    });
    expect(found?.id).toBe(person.id);
  });

  it("matches by NetID from UPN and links the entraObjectId", async () => {
    const person = await prisma.person.create({
      data: { name: "B", netId: "bb123" },
    });
    const found = await resolvePersonForLogin({
      entraObjectId: "oid-2",
      upn: "BB123@yale.edu",
      email: null,
    });
    expect(found?.id).toBe(person.id);
    const reloaded = await prisma.person.findUniqueOrThrow({ where: { id: person.id } });
    expect(reloaded.entraObjectId).toBe("oid-2");
  });

  it("falls back to case-insensitive email match on contactEmail for a Yale-asserted claim", async () => {
    const person = await prisma.person.create({
      data: { name: "C", contactEmail: "c.person@yale.edu" },
    });
    const found = await resolvePersonForLogin({
      entraObjectId: "oid-3",
      upn: null,
      email: "C.Person@yale.edu",
    });
    expect(found?.id).toBe(person.id);
  });

  it("returns null when nothing matches", async () => {
    const found = await resolvePersonForLogin({
      entraObjectId: "oid-4",
      upn: "nobody1@yale.edu",
      email: "nobody@yale.edu",
    });
    expect(found).toBeNull();
  });

  it("does not re-link a Person already bound to a different oid", async () => {
    const p = await prisma.person.create({
      data: { name: "X", netId: "xy123", entraObjectId: "oid-existing" },
    });
    const found = await resolvePersonForLogin({
      entraObjectId: "oid-attacker",
      upn: "XY123@yale.edu",
      email: null,
    });
    expect(found?.id).toBe(p.id);
    const reloaded = await prisma.person.findUniqueOrThrow({ where: { id: p.id } });
    expect(reloaded.entraObjectId).toBe("oid-existing");
  });

  it("does not match a personal contactEmail from a non-Yale claim", async () => {
    await prisma.person.create({ data: { name: "V", contactEmail: "victim@gmail.com" } });
    const found = await resolvePersonForLogin({
      entraObjectId: "oid-guest",
      upn: null,
      email: "victim@gmail.com",
    });
    expect(found).toBeNull();
  });

  it("still matches contactEmail for Yale-asserted claims", async () => {
    const p = await prisma.person.create({
      data: { name: "W", contactEmail: "w.person@yale.edu" },
    });
    const found = await resolvePersonForLogin({
      entraObjectId: "oid-w",
      upn: null,
      email: "W.Person@yale.edu",
    });
    expect(found?.id).toBe(p.id);
  });

  it("prefers the linked oid over a conflicting netId match", async () => {
    const linked = await prisma.person.create({
      data: { name: "L", entraObjectId: "oid-l" },
    });
    await prisma.person.create({ data: { name: "M", netId: "mm123" } });
    const found = await resolvePersonForLogin({
      entraObjectId: "oid-l",
      upn: "mm123@yale.edu",
      email: null,
    });
    expect(found?.id).toBe(linked.id);
  });
});

describe("getActivePerson", () => {
  beforeEach(resetDb);

  it("returns an ACTIVE person", async () => {
    const p = await prisma.person.create({ data: { name: "P", contactEmail: "p@yale.edu" } });
    expect((await getActivePerson(p.id))?.id).toBe(p.id);
  });

  it("returns null for an OFFBOARDED person (immediate revocation)", async () => {
    const p = await prisma.person.create({
      data: { name: "Q", contactEmail: "q@yale.edu", status: "OFFBOARDED" },
    });
    expect(await getActivePerson(p.id)).toBeNull();
  });

  it("returns null for a deleted/unknown id", async () => {
    expect(await getActivePerson("nonexistent")).toBeNull();
  });
});

describe("entraTenantAllowed", () => {
  it("allows when no tenant is configured", () => {
    expect(entraTenantAllowed({ tid: "whatever" }, undefined)).toBe(true);
  });
  it("allows when the token carries no tid", () => {
    expect(entraTenantAllowed({}, "yale-tenant")).toBe(true);
  });
  it("allows a matching tid", () => {
    expect(entraTenantAllowed({ tid: "yale-tenant" }, "yale-tenant")).toBe(true);
  });
  it("rejects a mismatched tid", () => {
    expect(entraTenantAllowed({ tid: "other-tenant" }, "yale-tenant")).toBe(false);
  });
});

describe("applicantEmailFromClaims", () => {
  it("prefers the email claim, lowercased", () => {
    expect(
      applicantEmailFromClaims({ email: "New.Grad@Yale.edu", preferred_username: "ng99@yale.edu" }),
    ).toBe("new.grad@yale.edu");
  });
  it("falls back to the UPN when the email claim is absent", () => {
    expect(applicantEmailFromClaims({ preferred_username: "NG99@yale.edu" })).toBe("ng99@yale.edu");
  });
  it("falls back to the provided user email when claims are empty", () => {
    expect(applicantEmailFromClaims({}, "Someone@yale.edu")).toBe("someone@yale.edu");
  });
  it("returns null when nothing is usable", () => {
    expect(applicantEmailFromClaims({}, null)).toBeNull();
    expect(applicantEmailFromClaims({})).toBeNull();
  });
});

describe("firstNameFromClaims", () => {
  it("prefers the given_name claim", () => {
    expect(firstNameFromClaims({ given_name: "Jack", name: "Carney, Jack" })).toBe("Jack");
  });
  it("trims the given_name claim", () => {
    expect(firstNameFromClaims({ given_name: "  Jack  " })).toBe("Jack");
  });
  it("derives the first token from a 'First Last' display name", () => {
    expect(firstNameFromClaims({ name: "Jack Carney" })).toBe("Jack");
  });
  it("derives the first name from a 'Last, First' display name", () => {
    expect(firstNameFromClaims({ name: "Carney, Jack" })).toBe("Jack");
  });
  it("handles a 'Last, First Middle' display name", () => {
    expect(firstNameFromClaims({ name: "Carney, Jack Ryan" })).toBe("Jack");
  });
  it("takes the name before the comma for a 'First Last, <credential>' display name", () => {
    expect(firstNameFromClaims({ name: "Jane Doe, RN" })).toBe("Jane");
    expect(firstNameFromClaims({ name: "John Smith, MD" })).toBe("John");
    expect(firstNameFromClaims({ name: "Jane Doe, Ph.D." })).toBe("Jane");
    expect(firstNameFromClaims({ name: "John Smith, Jr" })).toBe("John");
  });
  it("ignores a blank given_name and falls back to the display name", () => {
    expect(firstNameFromClaims({ given_name: "   ", name: "Jack Carney" })).toBe("Jack");
  });
  it("returns null when no name claim is usable", () => {
    expect(firstNameFromClaims({})).toBeNull();
    expect(firstNameFromClaims({ given_name: null, name: null })).toBeNull();
    expect(firstNameFromClaims({ name: "   " })).toBeNull();
    expect(firstNameFromClaims({ name: "Carney," })).toBeNull();
  });
});

describe("yaleEmailForNetId", () => {
  it("builds the Yale address from a NetID", () => {
    expect(yaleEmailForNetId("abc123")).toBe("abc123@yale.edu");
  });

  it("lowercases and trims so it round-trips against a stored emailLower", () => {
    expect(yaleEmailForNetId("  ABC123 ")).toBe("abc123@yale.edu");
  });
});

/**
 * Two resolvers, opposite orders, on purpose. The pair is easy to "tidy" into
 * one, and doing so silently changes either who the app thinks you are or where
 * a director's copied list sends mail -- so the difference is asserted head to
 * head rather than one function at a time.
 */
describe("accountEmailForPerson vs mailingEmailForPerson", () => {
  const both = { netId: "abc123", contactEmail: "preferred@example.com" };

  it("disagree for a person holding both, and that is the point", () => {
    // Which account is this? The Yale one.
    expect(accountEmailForPerson(both)).toBe("abc123@yale.edu");
    // Where do we mail them? Where they asked to be mailed, and where every
    // message this app already sends goes.
    expect(mailingEmailForPerson(both)).toBe("preferred@example.com");
  });

  it("both fall back to whichever identifier the person does have", () => {
    const netIdOnly = { netId: "abc123", contactEmail: null };
    const contactOnly = { netId: null, contactEmail: "only@example.com" };

    expect(accountEmailForPerson(netIdOnly)).toBe("abc123@yale.edu");
    expect(mailingEmailForPerson(netIdOnly)).toBe("abc123@yale.edu");
    expect(accountEmailForPerson(contactOnly)).toBe("only@example.com");
    expect(mailingEmailForPerson(contactOnly)).toBe("only@example.com");
  });

  it("return the empty string, not null, when we hold neither", () => {
    // A CSV row keeps the person with a blank cell; a mailing list must filter
    // these out, because a blank entry breaks the paste.
    expect(accountEmailForPerson({ netId: null, contactEmail: null })).toBe("");
    expect(mailingEmailForPerson({ netId: null, contactEmail: null })).toBe("");
  });

  it("treats a whitespace-only contact address as absent for mailing", () => {
    // /my-info takes this field from the member, so it can hold a stray space.
    expect(mailingEmailForPerson({ netId: "abc123", contactEmail: "   " })).toBe(
      "abc123@yale.edu",
    );
  });
});
