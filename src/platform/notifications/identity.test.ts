import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { resolveTeamsUser } from "./identity";

describe("resolveTeamsUser", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("returns the stored entraObjectId without calling Graph", async () => {
    const fetchImpl = vi.fn();
    const id = await resolveTeamsUser(
      { id: "p1", entraObjectId: "entra-123", contactEmail: "x@y.com" },
      { fetchImpl: fetchImpl as unknown as typeof fetch, getToken: async () => "tok" }
    );
    expect(id).toBe("entra-123");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns null when there is no entra id and no contactEmail", async () => {
    const id = await resolveTeamsUser(
      { id: "p1", entraObjectId: null, contactEmail: null },
      { getToken: async () => "tok" }
    );
    expect(id).toBeNull();
  });

  it("looks up by email via Graph and caches the id back onto the person", async () => {
    const person = await prisma.person.create({
      data: { name: "Sam", contactEmail: "sam@example.com" },
    });
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "entra-looked-up" }),
    });
    const id = await resolveTeamsUser(
      { id: person.id, entraObjectId: null, contactEmail: "sam@example.com" },
      { fetchImpl: fetchImpl as unknown as typeof fetch, getToken: async () => "tok" }
    );
    expect(id).toBe("entra-looked-up");
    const url = fetchImpl.mock.calls[0][0] as string;
    expect(url).toContain("/users/sam%40example.com");
    const reloaded = await prisma.person.findUnique({ where: { id: person.id } });
    expect(reloaded?.entraObjectId).toBe("entra-looked-up");
  });

  it("returns null when the Graph lookup fails", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => "not found" });
    const id = await resolveTeamsUser(
      { id: "p1", entraObjectId: null, contactEmail: "missing@example.com" },
      { fetchImpl: fetchImpl as unknown as typeof fetch, getToken: async () => "tok" }
    );
    expect(id).toBeNull();
  });
});
