import { describe, expect, it } from "vitest";
import { SYSTEM_ROLES } from "./system-roles";
import { MODULES } from "@/platform/modules/registry";

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

  // #135: admin.manage_roster is only honored by routes under the admin.access
  // module gate, which the VOM role does not grant -- so the permission was
  // unreachable for its entire intended audience (the holder was bounced to
  // /no-access before any manage_roster-aware code ran). Roster editing was not a
  // designed capability for this role, so the grant is dropped rather than the
  // whole admin surface opened up. This asserts it stays dropped.
  it("does not grant the unreachable admin.manage_roster to Volunteer Operations Manager (#135)", () => {
    const volOps = SYSTEM_ROLES.find((r) => r.name === "Volunteer Operations Manager");
    expect(volOps).toBeDefined();
    expect(volOps!.grants).not.toContain("admin.manage_roster");
  });

  // #136: my-info.access was retired from the registry (my-info is open access,
  // permissions: []), but the Director/Volunteer grant lists still referenced it,
  // so the seed created RoleGrant rows for a permission no gate checks, that the
  // roles editor cannot represent, and that its replace-set silently deletes on the
  // next edit. This guard would have caught it at the moment the manifest changed:
  // every grant must be "*" or a permission some module manifest actually declares.
  it("only grants permissions a module manifest declares (or the wildcard)", () => {
    const declared = new Set(MODULES.flatMap((m) => m.permissions));
    const offenders = SYSTEM_ROLES.flatMap((role) =>
      role.grants
        .filter((grant) => grant !== "*" && !declared.has(grant))
        .map((grant) => `${role.name}: ${grant}`),
    );
    expect(offenders).toEqual([]);
  });

  it("does not grant the retired my-info.access permission (#136)", () => {
    for (const role of SYSTEM_ROLES) {
      expect(role.grants).not.toContain("my-info.access");
    }
  });
});
