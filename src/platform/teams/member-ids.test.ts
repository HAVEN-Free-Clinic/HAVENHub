import { describe, expect, it, vi } from "vitest";
import { resolveMemberIds, type ChatMemberCandidate } from "./member-ids";

function member(over: Partial<ChatMemberCandidate> = {}): ChatMemberCandidate {
  return {
    personId: "p-1",
    name: "Goeun Lee",
    netId: "gl123",
    contactEmail: "goeun@example.com",
    entraObjectId: null,
    departmentName: "Behavioral Health",
    ...over,
  };
}

describe("resolveMemberIds", () => {
  it("uses a stored entraObjectId without calling the directory", async () => {
    const lookup = vi.fn();
    const [resolved] = await resolveMemberIds([member({ entraObjectId: "oid-1" })], { lookup });
    expect(resolved).toMatchObject({ userId: "oid-1", source: "stored" });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("looks the person up by netId@yale.edu when no id is stored", async () => {
    const lookup = vi.fn(async (bind: string) => (bind === "gl123@yale.edu" ? "oid-2" : null));
    const [resolved] = await resolveMemberIds([member()], { lookup });
    expect(resolved).toMatchObject({ userId: "oid-2", source: "directory" });
    expect(lookup).toHaveBeenCalledWith("gl123@yale.edu");
  });

  it("falls through to the contact email when the netId misses", async () => {
    const lookup = vi.fn(async (bind: string) => (bind === "goeun@example.com" ? "oid-3" : null));
    const [resolved] = await resolveMemberIds([member()], { lookup });
    expect(resolved).toMatchObject({ userId: "oid-3", source: "directory" });
    expect(lookup).toHaveBeenNthCalledWith(1, "gl123@yale.edu");
    expect(lookup).toHaveBeenNthCalledWith(2, "goeun@example.com");
  });

  it("reports a person the directory does not know", async () => {
    const lookup = vi.fn(async () => null);
    const [resolved] = await resolveMemberIds([member()], { lookup });
    expect(resolved.userId).toBeNull();
    expect(resolved.source).toBe("unresolved");
    expect(resolved.reason).toMatch(/directory/i);
  });

  it("reports a person with nothing to look up", async () => {
    const lookup = vi.fn();
    const [resolved] = await resolveMemberIds(
      [member({ netId: null, contactEmail: null })],
      { lookup },
    );
    expect(resolved.source).toBe("unresolved");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("treats a lookup failure as unresolved rather than failing the batch", async () => {
    const lookup = vi.fn(async () => {
      throw new Error("Graph user lookup failed: 429");
    });
    const resolved = await resolveMemberIds([member(), member({ personId: "p-2" })], { lookup });
    expect(resolved).toHaveLength(2);
    expect(resolved.every((r) => r.source === "unresolved")).toBe(true);
    expect(resolved[0].reason).toContain("429");
  });

  it("keeps input order", async () => {
    const lookup = vi.fn(async () => "oid-x");
    const resolved = await resolveMemberIds(
      [member({ personId: "p-1", name: "A" }), member({ personId: "p-2", name: "B" })],
      { lookup },
    );
    expect(resolved.map((r) => r.member.name)).toEqual(["A", "B"]);
  });
});
