import { describe, it, expect } from "vitest";
import { resolveIdentities } from "./identity";

const row = (key: string, email: string | null, netId: string | null, first = "Ada", last = "Lovelace") =>
  ({ key, firstName: first, lastName: last, email, netId });

describe("resolveIdentities", () => {
  it("merges rows sharing an email", () => {
    const out = resolveIdentities([row("a", "x@yale.edu", null), row("b", "X@Yale.edu", null)]);
    expect(out).toHaveLength(1);
    expect(out[0].memberKeys.sort()).toEqual(["a", "b"]);
  });

  it("merges rows sharing a netId even with different emails", () => {
    const out = resolveIdentities([row("a", "old@yale.edu", "abc12"), row("b", "new@gmail.com", "abc12")]);
    expect(out).toHaveLength(1);
    expect(out[0].emails.sort()).toEqual(["new@gmail.com", "old@yale.edu"]);
  });

  it("transitively merges two clusters joined by a later row", () => {
    // The case that defeats incremental resolution: a and b look unrelated
    // until c arrives carrying both edges.
    const out = resolveIdentities([
      row("a", "x@yale.edu", null),
      row("b", "y@yale.edu", "abc12"),
      row("c", "x@yale.edu", "abc12"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].memberKeys.sort()).toEqual(["a", "b", "c"]);
  });

  it("keeps genuinely distinct people apart", () => {
    const out = resolveIdentities([row("a", "x@yale.edu", "abc12"), row("b", "y@yale.edu", "def34")]);
    expect(out).toHaveLength(2);
  });

  it("never merges on a null netId", () => {
    const out = resolveIdentities([row("a", "x@yale.edu", null), row("b", "y@yale.edu", null)]);
    expect(out).toHaveLength(2);
  });

  it("emits exactly one primaryEmail that is present in emails", () => {
    const out = resolveIdentities([row("a", "x@yale.edu", "abc12"), row("b", "y@yale.edu", "abc12")]);
    expect(out[0].emails).toContain(out[0].primaryEmail);
  });

  it("drops rows with neither an email nor a netId", () => {
    expect(resolveIdentities([row("a", null, null)])).toHaveLength(0);
  });
});
