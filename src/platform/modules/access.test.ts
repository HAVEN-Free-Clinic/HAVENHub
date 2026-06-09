import { describe, it, expect } from "vitest";
import {
  canAccessModule,
  filterAccessibleModules,
  isModuleActive,
  type NavModule,
} from "./access";
import type { ModuleManifest } from "./types";

function mod(overrides: Partial<ModuleManifest>): ModuleManifest {
  return {
    id: "x",
    title: "X",
    description: "",
    icon: () => null,
    permissions: [],
    status: "active",
    nav: [],
    ...overrides,
  };
}

describe("canAccessModule", () => {
  it("allows modules with no accessPermission", () => {
    expect(canAccessModule(mod({ accessPermission: undefined }), new Set())).toBe(true);
  });
  it("requires the permission when one is declared", () => {
    expect(canAccessModule(mod({ accessPermission: "admin.access" }), new Set())).toBe(false);
    expect(
      canAccessModule(mod({ accessPermission: "admin.access" }), new Set(["admin.access"])),
    ).toBe(true);
  });
});

describe("filterAccessibleModules", () => {
  it("maps active accessible modules to nav items and drops coming-soon", () => {
    const modules = [
      mod({ id: "schedule", title: "Clinic Schedule", accessPermission: "schedule.view" }),
      mod({ id: "my-info", title: "My Info", accessPermission: undefined }),
      mod({ id: "triage", title: "Triage", accessPermission: "triage.access", status: "coming-soon" }),
    ];
    const result = filterAccessibleModules(modules, new Set(["schedule.view"]));
    expect(result).toEqual<NavModule[]>([
      { id: "schedule", title: "Clinic Schedule", href: "/schedule" },
      { id: "my-info", title: "My Info", href: "/my-info" },
    ]);
  });
  it("drops active modules the user cannot access", () => {
    const modules = [mod({ id: "admin", title: "Admin", accessPermission: "admin.access" })];
    expect(filterAccessibleModules(modules, new Set())).toEqual([]);
  });
});

describe("isModuleActive", () => {
  it("matches exact and nested paths but not sibling prefixes", () => {
    expect(isModuleActive("/admin", "/admin")).toBe(true);
    expect(isModuleActive("/admin/people", "/admin")).toBe(true);
    expect(isModuleActive("/admin-tools", "/admin")).toBe(false);
    expect(isModuleActive("/schedule", "/admin")).toBe(false);
  });
});
