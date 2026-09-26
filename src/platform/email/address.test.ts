import { describe, expect, it } from "vitest";
import { isDeliverableAddress } from "./address";

describe("isDeliverableAddress", () => {
  it.each(["a@b.org", "first.last@yale.edu", "a+tag@mail.example.com", "  x@y.io  "])(
    "accepts %s",
    (addr) => {
      expect(isDeliverableAddress(addr)).toBe(true);
    },
  );

  it.each([
    "first..last@yale.edu",
    ".first@yale.edu",
    "first.@yale.edu",
    "a@yale..edu",
    "a@.yale.edu",
    "a@yale.edu.",
    "no-at-sign.org",
    "a@nodot",
    "a b@c.org",
    "",
    null,
    undefined,
  ])("rejects %s", (addr) => {
    expect(isDeliverableAddress(addr)).toBe(false);
  });
});
