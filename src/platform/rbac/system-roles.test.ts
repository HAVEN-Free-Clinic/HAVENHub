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

  // Issue #82: edit_own_dept is now enforced as a member-department grant. It was
  // a no-op on the auto-attached Director role; leaving it would silently widen
  // directors' edit reach to their non-director memberships. Directors keep their
  // scope via director membership, so the grant is removed.
  it("does not grant the Director role schedule.edit_own_dept", () => {
    expect(grantsFor("Director")).not.toContain("schedule.edit_own_dept");
  });

  it("grants admin.manage_roster to Volunteer Operations Manager", () => {
    const volOps = SYSTEM_ROLES.find((r) => r.name === "Volunteer Operations Manager");
    expect(volOps).toBeDefined();
    expect(volOps!.grants).toContain("admin.manage_roster");
  });
});
