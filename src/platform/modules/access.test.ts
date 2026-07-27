import { describe, it, expect } from "vitest";
import {
  canAccessModule,
  filterAccessibleModules,
  filterNavItems,
  type NavModule,
} from "./access";
import { isModuleActive } from "./nav";
import { MODULES } from "./registry";
import type { ModuleManifest, ModuleNavItem } from "./types";

/**
 * The panelist-only "My interviews" item, inlined rather than imported from
 * @/modules/recruitment/nav: src/platform must never import from src/modules.
 */
const MY_INTERVIEWS = { label: "My interviews", href: "/recruitment/interviews" };

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
  it("also admits a viewer who holds an additionalAccessPermissions entry instead of accessPermission", () => {
    const m = mod({ accessPermission: "recruitment.access", additionalAccessPermissions: ["recruitment.score"] });
    expect(canAccessModule(m, new Set())).toBe(false);
    expect(canAccessModule(m, new Set(["recruitment.score"]))).toBe(true);
  });
});

describe("filterAccessibleModules", () => {
  it("maps active accessible modules to nav items and drops coming-soon", () => {
    const modules = [
      mod({ id: "schedule", title: "Schedule", accessPermission: "schedule.view" }),
      mod({ id: "my-info", title: "My Info", accessPermission: undefined }),
      mod({ id: "triage", title: "Triage", accessPermission: "triage.access", status: "coming-soon" }),
    ];
    const result = filterAccessibleModules(modules, new Set(["schedule.view"]));
    expect(result).toEqual<NavModule[]>([
      { id: "schedule", title: "Schedule", href: "/schedule", nav: [] },
      { id: "my-info", title: "My Info", href: "/my-info", nav: [] },
    ]);
  });

  it("drops active modules the user cannot access", () => {
    const modules = [mod({ id: "admin", title: "Admin", accessPermission: "admin.access" })];
    expect(filterAccessibleModules(modules, new Set())).toEqual([]);
  });

  it("populates nav with only the sub-items the viewer may open", () => {
    const modules = [
      mod({
        id: "admin",
        title: "Admin",
        accessPermission: "admin.access",
        permissions: ["admin.access", "admin.manage_people", "admin.manage_terms"],
        nav: [
          { label: "Overview", href: "/admin" },
          { label: "People", href: "/admin/people", permission: "admin.manage_people" },
          { label: "Terms", href: "/admin/terms", permission: "admin.manage_terms" },
        ],
      }),
    ];
    const result = filterAccessibleModules(modules, new Set(["admin.access", "admin.manage_people"]));
    expect(result[0].nav).toEqual([
      { label: "Overview", href: "/admin" },
      { label: "People", href: "/admin/people" },
    ]);
  });

  it("strips the permission field from nav items so the client bundle carries no permission strings", () => {
    const modules = [
      mod({
        id: "admin",
        title: "Admin",
        accessPermission: "admin.access",
        permissions: ["admin.access", "admin.manage_people"],
        nav: [{ label: "People", href: "/admin/people", permission: "admin.manage_people" }],
      }),
    ];
    const result = filterAccessibleModules(modules, new Set(["*"]));
    expect(result[0].nav[0]).not.toHaveProperty("permission");
  });

  it("appends extraNavItems after the permission-filtered items, preserving staff order", () => {
    const modules = [
      mod({
        id: "recruitment",
        title: "Recruitment",
        accessPermission: "recruitment.access",
        permissions: ["recruitment.access"],
        nav: [{ label: "Cycles", href: "/recruitment" }],
      }),
    ];
    const result = filterAccessibleModules(modules, new Set(["recruitment.access"]), new Set(), {
      recruitment: [{ label: "My interviews", href: "/recruitment/interviews" }],
    });
    expect(result[0].nav).toEqual([
      { label: "Cycles", href: "/recruitment" },
      { label: "My interviews", href: "/recruitment/interviews" },
    ]);
  });

  it("admits a module reached only via extraNavItems when the viewer also has module access", () => {
    const modules = [
      mod({ id: "recruitment", title: "Recruitment", accessPermission: "recruitment.access", permissions: ["recruitment.access"] }),
    ];
    const result = filterAccessibleModules(modules, new Set(), new Set(["recruitment"]), {
      recruitment: [{ label: "My interviews", href: "/recruitment/interviews" }],
    });
    expect(result[0].nav).toEqual([{ label: "My interviews", href: "/recruitment/interviews" }]);
  });

  it("wires a bare panelist through end-to-end: zero permissions, extraModuleIds and extraNavItems shaped exactly as recruitmentGlobalNav({ isReviewer: false, isPanelist: true }) would produce, still surfaces recruitment with My interviews", () => {
    // Regression: task 5 fix round 1. A bare panelist (on an interview panel
    // but holding neither recruitment.access nor a review scope, e.g. added
    // via listPanelistCandidates) has an EMPTY permission set here -- proving
    // filterAccessibleModules's own extraIds/extraNavItems contract is not the
    // gap. The gap was upstream: a caller that forgets to fold isPanelist into
    // extraModuleIds never gets this far, because the recruitment module row
    // is decided by extraIds *before* extraNavItems is even consulted.
    const modules = [
      mod({
        id: "recruitment",
        title: "Recruitment",
        accessPermission: "recruitment.access",
        permissions: ["recruitment.access"],
        nav: [{ label: "Cycles", href: "/recruitment" }],
      }),
    ];
    const result = filterAccessibleModules(modules, new Set(), new Set(["recruitment"]), {
      recruitment: [{ label: "My interviews", href: "/recruitment/interviews" }],
    });
    const recruitment = result.find((m) => m.id === "recruitment");
    expect(recruitment).toBeDefined();
    expect(recruitment?.nav).toContainEqual({ label: "My interviews", href: "/recruitment/interviews" });
  });

  it("omits dynamicGate items from the module nav the global dropdown renders", () => {
    // The global nav cannot evaluate a data-driven gate (e.g. "manages at least
    // one schedule department"), so offering the link would risk a bounce to
    // /no-access. Under-inclusive on purpose: the tab is still one hop away on
    // the module's own page, where the layout CAN resolve the gate.
    const modules = [
      mod({
        id: "schedule",
        title: "Schedule",
        accessPermission: "schedule.view",
        permissions: ["schedule.view", "schedule.manage_requests"],
        nav: [
          { label: "My schedule", href: "/schedule" },
          { label: "Builder", href: "/schedule/builder", dynamicGate: true },
          {
            label: "Approvals",
            href: "/schedule/requests",
            permission: "schedule.manage_requests",
            dynamicGate: true,
          },
        ],
      }),
    ];
    // Even a viewer holding every permission does not get the dynamicGate items.
    const result = filterAccessibleModules(modules, new Set(["*"]));
    expect(result[0].nav).toEqual([{ label: "My schedule", href: "/schedule" }]);
  });

  it("lands a module admitted only via extraIds on its first available nav item, not its root", () => {
    // A bare panelist (interview-panel membership only: no recruitment.access,
    // no recruitment.score, no review scope) is bounced from /recruitment, so
    // pointing the module link at the root would dead-end them. The caller
    // resolved "My interviews" from the very capability that admitted the
    // module, so that is where the module link goes.
    const result = filterAccessibleModules(MODULES, new Set(), new Set(["recruitment"]), {
      recruitment: [MY_INTERVIEWS],
    });
    expect(result.find((m) => m.id === "recruitment")?.href).toBe("/recruitment/interviews");
  });

  it("leaves a scope reviewer's module href at the module root", () => {
    // The other existing extraIds case: a department director reaches
    // recruitment by review scope, CAN open /recruitment, and gets no extra nav
    // items. Their first available item is "Cycles" (href /recruitment), so the
    // rule above is a no-op for them.
    const result = filterAccessibleModules(MODULES, new Set(), new Set(["recruitment"]));
    expect(result.find((m) => m.id === "recruitment")?.href).toBe("/recruitment");
  });

  it("leaves a normally-accessible module's href at the module root even when it has nav items", () => {
    const result = filterAccessibleModules(MODULES, new Set(["admin.access", "admin.manage_people"]));
    const admin = result.find((m) => m.id === "admin");
    expect(admin?.href).toBe("/admin");
    expect(admin?.nav.length).toBeGreaterThan(0);
  });

  it("keeps personal modules out of the nav row", () => {
    const modules = [
      mod({ id: "schedule", title: "Schedule", accessPermission: "schedule.view" }),
      mod({ id: "my-info", title: "My Info", accessPermission: undefined, personal: true }),
    ];
    const result = filterAccessibleModules(modules, new Set(["schedule.view"]));
    expect(result.map((m) => m.id)).toEqual(["schedule"]);
  });

  it("still reports my-info as a real module so the hub tile survives", () => {
    // e2e/my-info.spec.ts asserts the hub tile exists. The dashboard reads
    // MODULES directly, so `personal` must hide it from the nav row only.
    expect(MODULES.find((m) => m.id === "my-info")?.personal).toBe(true);
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

  it("still returns dynamicGate items, so the module tab row is unaffected", () => {
    // Only the global-nav path (filterAccessibleModules) skips them. The module
    // layout filters this output further using the real capability check, so
    // dropping them here would delete the tab from the module's own page too.
    const builder: ModuleNavItem = { label: "Builder", href: "/schedule/builder", dynamicGate: true };
    expect(filterNavItems([builder], new Set())).toEqual([builder]);
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
    expect(ids).not.toContain("my-info"); // personal: lives in the account menu
    expect(ids).not.toContain("clinic"); // gated on clinic.access, which this limited role lacks
    expect(ids).not.toContain("admin");
    expect(ids).not.toContain("recruitment");
    expect(ids).not.toContain("volunteers");
  });

  it("shows recruitment to a committee scorer (recruitment.score only, no recruitment.access)", () => {
    const result = filterAccessibleModules(MODULES, new Set(["recruitment.score"]));
    expect(result.map((m) => m.id)).toContain("recruitment");
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
