import { describe, it, expect } from "vitest";
import {
  canAccessModule,
  filterAccessibleModules,
  filterNavItems,
  isModuleActive,
  type NavModule,
} from "./access";
import { MODULES } from "./registry";
import type { ModuleManifest, ModuleNavItem } from "./types";

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

describe("filterNavItems", () => {
  const nav: ModuleNavItem[] = [
    { label: "Overview", href: "/admin" }, // no permission: always shown
    { label: "People", href: "/admin/people", permission: "admin.manage_people" },
    { label: "Terms", href: "/admin/terms", permission: "admin.manage_terms" },
  ];

  it("keeps items with no permission and drops items the viewer lacks", () => {
    const result = filterNavItems(nav, new Set(["admin.manage_people"]));
    expect(result).toEqual<ModuleNavItem[]>([
      { label: "Overview", href: "/admin" },
      { label: "People", href: "/admin/people", permission: "admin.manage_people" },
    ]);
  });

  it("keeps only permission-free items when the viewer holds none of the sub-permissions", () => {
    expect(filterNavItems(nav, new Set())).toEqual<ModuleNavItem[]>([
      { label: "Overview", href: "/admin" },
    ]);
  });

  it("honors the wildcard grant", () => {
    expect(filterNavItems(nav, new Set(["*"]))).toEqual(nav);
  });
});

describe("registry nav permissions", () => {
  it("only references permissions its own module declares", () => {
    for (const mod of MODULES) {
      const declared = new Set(mod.permissions);
      for (const item of mod.nav) {
        if (item.permission) {
          expect(
            declared.has(item.permission),
            `${mod.id} nav "${item.label}" requires undeclared permission "${item.permission}"`,
          ).toBe(true);
        }
      }
    }
  });
});

describe("top-nav module filtering (regression for limited roles)", () => {
  it("hides modules a limited role cannot access", () => {
    // A schedule-only volunteer (e.g. seed "Volunteer" role) must NOT see
    // admin/recruitment/volunteers/learning in the global nav.
    const result = filterAccessibleModules(MODULES, new Set(["schedule.view", "learning.access"]));
    const ids = result.map((m) => m.id);
    expect(ids).toContain("schedule");
    expect(ids).toContain("learning");
    expect(ids).toContain("my-info"); // open module, no accessPermission
    expect(ids).toContain("clinic"); // open module, no accessPermission
    expect(ids).not.toContain("admin");
    expect(ids).not.toContain("recruitment");
    expect(ids).not.toContain("volunteers");
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
