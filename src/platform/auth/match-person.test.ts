import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { netIdFromUpn, resolvePersonForLogin } from "./match-person";

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

  it("falls back to case-insensitive email match on contactEmail or yaleEmail", async () => {
    const person = await prisma.person.create({
      data: { name: "C", yaleEmail: "c.person@yale.edu" },
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
