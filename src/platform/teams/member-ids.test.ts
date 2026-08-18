import { describe, expect, it } from "vitest";
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
  it("uses a stored entraObjectId", () => {
    const [resolved] = resolveMemberIds([member({ entraObjectId: "oid-1" })]);
    expect(resolved).toMatchObject({ userId: "oid-1", source: "stored" });
  });

  it("reports a person who has never signed in, even with a netId and an email on file", () => {
    // The regression this guards: a netId and a contact email used to be enough
    // to seat someone via a directory lookup. Dropping User.ReadBasic.All means
    // they no longer are, and such a person must surface for a manual add rather
    // than silently vanishing from the chat.
    const [resolved] = resolveMemberIds([member()]);
    expect(resolved.userId).toBeNull();
    expect(resolved.source).toBe("unresolved");
    expect(resolved.reason).toMatch(/signed in/i);
  });

  it("reports a person with no identifiers at all", () => {
    const [resolved] = resolveMemberIds([member({ netId: null, contactEmail: null })]);
    expect(resolved.source).toBe("unresolved");
    expect(resolved.userId).toBeNull();
  });

  it("keeps input order and resolves each member independently", () => {
    const resolved = resolveMemberIds([
      member({ personId: "p-1", name: "A", entraObjectId: "oid-a" }),
      member({ personId: "p-2", name: "B" }),
      member({ personId: "p-3", name: "C", entraObjectId: "oid-c" }),
    ]);
    expect(resolved.map((r) => r.member.name)).toEqual(["A", "B", "C"]);
    expect(resolved.map((r) => r.source)).toEqual(["stored", "unresolved", "stored"]);
  });
});
