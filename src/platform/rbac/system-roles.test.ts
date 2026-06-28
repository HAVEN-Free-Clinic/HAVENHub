import { describe, expect, it } from "vitest";
import { SYSTEM_ROLES } from "./system-roles";

function grantsFor(name: string): string[] {
  const role = SYSTEM_ROLES.find((r) => r.name === name);
  if (!role) throw new Error(`No system role named ${name}`);
  return role.grants;
}

describe("system roles", () => {
  // Issue #65: a director-only member is assigned learning courses (any active
  // membership in an assigned department), but opening one requires
  // learning.access. Without this grant the onboarding gate locks the director
  // out of the whole app with no way to satisfy the requirement.
  it("grants the Director role learning.access so assigned courses are openable", () => {
    expect(grantsFor("Director")).toContain("learning.access");
  });

  it("keeps learning.access on the Volunteer role", () => {
    expect(grantsFor("Volunteer")).toContain("learning.access");
  });
});
