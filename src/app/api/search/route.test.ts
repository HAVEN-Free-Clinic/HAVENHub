import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock every collaborator so this exercises the route's auth + serving logic
// alone, with no database.
vi.mock("@/platform/auth/auth", () => ({ auth: vi.fn() }));
vi.mock("@/platform/auth/match-person", () => ({ getActivePerson: vi.fn() }));
vi.mock("@/platform/db", () => ({ isDbUnreachableError: vi.fn() }));
vi.mock("@/modules/search/entities", () => ({ searchEntities: vi.fn() }));

import { GET } from "./route";
import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";
import { isDbUnreachableError } from "@/platform/db";
import { searchEntities } from "@/modules/search/entities";

const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

function call(query: string): Promise<Response> {
  return GET(new Request(`https://hub.test/api/search${query}`));
}

describe("GET /api/search", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mock(auth).mockResolvedValue({ personId: "p1" });
    mock(getActivePerson).mockResolvedValue({ id: "p1" });
    mock(isDbUnreachableError).mockReturnValue(false);
    mock(searchEntities).mockResolvedValue([]);
  });

  it("401s when there is no session", async () => {
    mock(auth).mockResolvedValue(null);
    const res = await call("?q=ada");
    expect(res.status).toBe(401);
    expect(searchEntities).not.toHaveBeenCalled();
  });

  it("401s when the session has a personId but getActivePerson returns null (revoked)", async () => {
    mock(getActivePerson).mockResolvedValue(null);
    const res = await call("?q=ada");
    expect(res.status).toBe(401);
    expect(searchEntities).not.toHaveBeenCalled();
  });

  it("returns [] for a missing q param", async () => {
    mock(searchEntities).mockResolvedValue([]);
    const res = await call("");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: [] });
  });

  it("returns [] for a q under 2 characters", async () => {
    mock(searchEntities).mockResolvedValue([]);
    const res = await call("?q=a");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: [] });
    // Length gating lives in searchEntities itself; the route just passes the
    // query through rather than duplicating the check.
    expect(searchEntities).toHaveBeenCalledWith("p1", "a");
  });

  it("delegates to searchEntities with the SESSION personId, never a client-supplied id", async () => {
    const hit = { id: "e1", label: "Ada Lovelace", sub: null, href: "/people/e1", group: "People" as const };
    mock(searchEntities).mockResolvedValue([hit]);

    // A crafted personId in the query string must be ignored -- scoping is
    // always the authenticated session's identity, never anything a client
    // can supply. This is the boundary the whole route exists to enforce.
    const res = await call("?q=ada&personId=attacker-id");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: [hit] });
    expect(searchEntities).toHaveBeenCalledWith("p1", "ada");
    expect(searchEntities).not.toHaveBeenCalledWith("attacker-id", expect.anything());
  });

  it("returns 503, not 500, when the DB is unreachable", async () => {
    mock(searchEntities).mockRejectedValue(new Error("connect ECONNREFUSED"));
    mock(isDbUnreachableError).mockReturnValue(true);
    const res = await call("?q=ada");
    expect(res.status).toBe(503);
  });
});
