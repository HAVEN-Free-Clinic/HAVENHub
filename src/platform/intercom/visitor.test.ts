/**
 * buildVisitorIdentityAttributes is a pure formatter, so these are about the
 * two rules that are easy to regress and that the /apply layout depends on:
 * absent values are OMITTED (never sent empty), and the keys stay exactly what
 * the Intercom workspace is configured for.
 */
import { describe, expect, it } from "vitest";
import {
  buildVisitorIdentityAttributes,
  VISITOR_EMAIL_ATTRIBUTE,
  VISITOR_NAME_ATTRIBUTE,
} from "./visitor";

describe("buildVisitorIdentityAttributes", () => {
  it("sends both attributes when the portal knows a name and an email", () => {
    expect(
      buildVisitorIdentityAttributes({ name: "Jane Doe", email: "jane.doe@yale.edu" })
    ).toEqual({
      [VISITOR_NAME_ATTRIBUTE]: "Jane Doe",
      [VISITOR_EMAIL_ATTRIBUTE]: "jane.doe@yale.edu",
    });
  });

  it("omits the name rather than sending it empty -- the magic-link path carries an email and no name", () => {
    const attrs = buildVisitorIdentityAttributes({ name: null, email: "someone@example.org" });
    expect(attrs).toEqual({ [VISITOR_EMAIL_ATTRIBUTE]: "someone@example.org" });
    expect(attrs).not.toHaveProperty(VISITOR_NAME_ATTRIBUTE);
  });

  it("treats a whitespace-only name as absent, so the sidebar shows no blank field", () => {
    expect(buildVisitorIdentityAttributes({ name: "   ", email: "a@b.edu" })).toEqual({
      [VISITOR_EMAIL_ATTRIBUTE]: "a@b.edu",
    });
  });

  it("trims, so a stray space in a stored name does not reach the workspace", () => {
    expect(buildVisitorIdentityAttributes({ name: " Jane Doe ", email: " a@b.edu " })).toEqual({
      [VISITOR_NAME_ATTRIBUTE]: "Jane Doe",
      [VISITOR_EMAIL_ATTRIBUTE]: "a@b.edu",
    });
  });

  it("returns undefined when there is nothing to say, so a signed-out boot is unchanged", () => {
    expect(buildVisitorIdentityAttributes({ name: null, email: null })).toBeUndefined();
    expect(buildVisitorIdentityAttributes({ name: "", email: "" })).toBeUndefined();
  });

  it("keys contain a space, which is what keeps a spread into the boot args from colliding with app_id/user_id/email/name", () => {
    for (const key of [VISITOR_NAME_ATTRIBUTE, VISITOR_EMAIL_ATTRIBUTE]) {
      expect(key).toContain(" ");
      expect(["app_id", "user_id", "email", "name"]).not.toContain(key);
    }
  });
});
