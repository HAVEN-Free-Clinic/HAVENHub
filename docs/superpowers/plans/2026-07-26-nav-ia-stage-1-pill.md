# Navigation IA Stage 1 (The Pill) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the top nav from hiding modules, give every module's sub-pages a one-hop path, and give `/training` and `/admin/contract` permanent homes.

**Architecture:** The module registry stays the single source of truth. `NavModule` grows a permission-filtered `nav` array so `GlobalNav` can render per-module dropdowns without a second permission fetch. A new `AccountMenu` absorbs My Info, Training, and the theme control, freeing two slots in the module row. Module titles shorten so the row fits without overflow.

**Tech Stack:** Next.js App Router (RSC + "use client"), TypeScript, Tailwind, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-07-26-nav-ia-user-friendliness-design.md`

## Global Constraints

- **No em-dashes anywhere.** CI-enforced by the `local/no-em-dash` ESLint rule; a violation fails `npm run lint`.
- **Run `npm run lint` (whole repo) before pushing.** Typecheck and tests do not catch ESLint boundary violations.
- **Nav items must mirror their page's own gate.** A nav item's `permission` must equal what the destination page passes to `requirePermission`, or the tab dead-ends at `/no-access`.
- **`src/platform/**` must not import from `src/modules/**`.** Enforced by an ESLint boundary rule. Dynamic nav items are resolved in `src/app/(app)/layout.tsx` and passed down as data.
- **Client components must not import the server registry.** `src/platform/modules/nav.ts` is the client-safe surface; it imports nothing from RBAC or Prisma so PrismaClient never reaches the client bundle.
- **Verification commands:** `npm test`, `npm run typecheck`, `npm run lint`.

---

### Task 1: Add `nav` to `NavModule` and populate it

Extends the client-safe `NavModule` type with the module's permission-filtered sub-items, and teaches `filterAccessibleModules` to fill it. Nothing renders it yet.

**Files:**
- Modify: `src/platform/modules/nav.ts:11-12`
- Modify: `src/platform/modules/access.ts:43-60`
- Test: `src/platform/modules/access.test.ts:42-59`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `NavModule` gains `nav: NavSubItem[]` where `type NavSubItem = { label: string; href: string }` (exported from `src/platform/modules/nav.ts`). `filterAccessibleModules(modules, perms, extraIds?, extraNavItems?)` gains a 4th optional parameter `extraNavItems?: Readonly<Record<string, NavSubItem[]>>`. `getAccessibleModules(personId, extraIds?, extraNavItems?)` gains the same 4th parameter.

- [ ] **Step 1: Write the failing tests**

Replace the existing `filterAccessibleModules` describe block at `src/platform/modules/access.test.ts:42-59` with:

```ts
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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/platform/modules/access.test.ts`
Expected: FAIL. The first test fails on the missing `nav: []` key; the later tests fail because `filterAccessibleModules` takes only 3 parameters.

- [ ] **Step 3: Extend the `NavModule` type**

In `src/platform/modules/nav.ts`, replace lines 11-12:

```ts
/** A module sub-page link, stripped of its permission (already applied server-side). */
export type NavSubItem = { label: string; href: string };

/** A module reduced to what the global nav needs (serializable, no icon). */
export type NavModule = {
  id: string;
  title: string;
  href: string;
  /**
   * The module's sub-pages the viewer may actually open, already
   * permission-filtered server-side. `permission` is deliberately stripped: the
   * global nav is a client component, and shipping permission strings to the
   * browser would leak the RBAC vocabulary for no benefit.
   */
  nav: NavSubItem[];
};
```

- [ ] **Step 4: Populate `nav` in `filterAccessibleModules`**

In `src/platform/modules/access.ts`, replace the import at line 6 and the two functions at lines 43-60:

```ts
import type { NavModule, NavSubItem } from "./nav";
export type { NavModule, NavSubItem };
```

```ts
/**
 * Active modules the user can access, as nav items with their permission-filtered
 * sub-pages.
 *
 * `extraIds` admits modules whose access can't be expressed as a permission the
 * engine holds -- notably recruitment, which a department director reaches by
 * *review scope* (a derived directorship, not a permission). `extraNavItems`
 * does the same at the sub-item level for tabs gated on dynamic conditions
 * rather than permissions (notably recruitment's "My interviews", gated on
 * interview-panel membership). Both are resolved by the caller (see the (app)
 * layout) so this platform helper stays free of any module-service import.
 */
export function filterAccessibleModules(
  modules: ModuleManifest[],
  perms: Set<string>,
  extraIds: ReadonlySet<string> = new Set(),
  extraNavItems: Readonly<Record<string, NavSubItem[]>> = {},
): NavModule[] {
  return modules
    .filter((m) => m.status === "active" && (canAccessModule(m, perms) || extraIds.has(m.id)))
    .map((m) => ({
      id: m.id,
      title: m.title,
      href: `/${m.id}`,
      nav: [
        // Strip `permission`: it has already been applied, and the consumer is a
        // client component.
        ...filterNavItems(m.nav, perms).map(({ label, href }) => ({ label, href })),
        ...(extraNavItems[m.id] ?? []),
      ],
    }));
}

/** Server entry point: resolve the signed-in user's accessible modules. */
export async function getAccessibleModules(
  personId: string,
  extraIds: ReadonlySet<string> = new Set(),
  extraNavItems: Readonly<Record<string, NavSubItem[]>> = {},
): Promise<NavModule[]> {
  const perms = await getEffectivePermissions(personId);
  return filterAccessibleModules(MODULES, perms, extraIds, extraNavItems);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/platform/modules/access.test.ts`
Expected: PASS, all cases.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS. `AppShell` passes only 2 arguments to `getAccessibleModules`, which is still valid because the new parameters are optional.

- [ ] **Step 7: Commit**

```bash
git add src/platform/modules/nav.ts src/platform/modules/access.ts src/platform/modules/access.test.ts
git commit -m "feat(nav): carry permission-filtered sub-items on NavModule"
```

---

### Task 2: Shorten module titles and give `/admin/contract` a nav entry

Cuts the module row from 104 to 78 characters (My Info still present until Task 4) and retires the Admin overview quick-link row that was `/admin/contract`'s only entry point.

**Files:**
- Modify: `src/platform/modules/registry.ts:18,52,79,95,180`
- Modify: `src/platform/modules/registry.ts:126-140` (Admin nav)
- Modify: `src/app/(app)/admin/page.tsx:60-67,84-97`
- Modify: `e2e/login.spec.ts:10-13`
- Test: `src/platform/modules/registry.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: module `title` values `"Schedule"`, `"Volunteers"`, `"Incidents"`, `"Clinic"`, `"Support"`. Admin nav gains `{ label: "Onboarding contract", href: "/admin/contract", permission: "admin.manage_settings" }`.

- [ ] **Step 1: Write the failing test**

Append to `src/platform/modules/registry.test.ts`, inside the existing `describe("module registry", ...)` block:

```ts
  it("keeps module titles short enough that the nav row fits without overflow", () => {
    // GlobalNav collapses overflow into a "More" dropdown, which hides modules
    // from exactly the users who can access the most. The pill has roughly 820px
    // after the logo and right-hand controls; at text-sm plus px-2.5 padding a
    // title costs roughly 7px per character plus 20px. Budget the row at 90
    // characters total so a full admin never overflows on a laptop.
    // my-info moves to the account menu in Task 4, which replaces this id check
    // with the `!m.personal` predicate. Excluded here so the budget is measured
    // against the same set both before and after that change.
    const rowTitles = MODULES.filter((m) => m.status === "active" && m.id !== "my-info").map((m) => m.title);
    const chars = rowTitles.reduce((sum, t) => sum + t.length, 0);
    expect(chars, `nav row titles total ${chars} chars: ${rowTitles.join(", ")}`).toBeLessThanOrEqual(90);
  });

  it("gives the onboarding contract editor a nav entry so it is not orphaned", () => {
    const admin = MODULES.find((m) => m.id === "admin")!;
    expect(admin.nav.map((n) => n.href)).toContain("/admin/contract");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/platform/modules/registry.test.ts`
Expected: FAIL on both new cases. The title-length test reports 97 chars against a 90 budget (104 total minus "My Info"), and the contract test finds no `/admin/contract` nav entry.

- [ ] **Step 3: Shorten the titles**

In `src/platform/modules/registry.ts`, change these five `title` values only. Leave `id`, `description`, and every `href` untouched.

```ts
// line 18
    title: "Schedule",
// line 52
    title: "Volunteers",
// line 79
    title: "Incidents",
// line 95
    title: "Clinic",
// line 180
    title: "Support",
```

- [ ] **Step 4: Add the Admin nav entry**

In `src/platform/modules/registry.ts`, insert after the Subcommittees entry (line 135), before Audit:

```ts
      { label: "Onboarding contract", href: "/admin/contract", permission: "admin.manage_settings" },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/platform/modules/registry.test.ts src/platform/modules/access.test.ts`
Expected: PASS. The measured set (8 modules, excluding My Info) drops from 97 to 64 characters. The row as actually rendered still carries My Info until Task 4, so it is 71 on screen at this point. `access.test.ts`'s "registry nav permissions" case confirms `admin.manage_settings` is declared in the admin module's `permissions` array (it is, at line 120).

- [ ] **Step 6: Remove the redundant Admin quick-link row**

In `src/app/(app)/admin/page.tsx`, delete the `quickLinks` array (lines 60-67) and replace the `PageHeader` (lines 80-98) with:

```tsx
      <PageHeader
        title="Admin"
        description={`${appName} operations: people, terms, roles, and audit.`}
      />
```

Then delete the now-unused imports of `Link` (line 1) and `buttonClasses` (line 8). Leave `hasPermission` imported: `statCards` still uses it at line 76.

- [ ] **Step 7: Update the e2e tile assertions**

In `e2e/login.spec.ts`, replace lines 10-13:

```ts
  // Use the module tile link's unique aria-label to avoid a strict-mode violation
  // (plain text matches the nav link, the hidden measurement span, and the tile).
  await expect(page.getByRole("link", { name: "Open Schedule" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Volunteers" })).toBeVisible();
```

- [ ] **Step 8: Verify the full suite and lint**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS. Watch for other `admin/page.tsx` references to the deleted imports.

- [ ] **Step 9: Commit**

```bash
git add src/platform/modules/registry.ts src/platform/modules/registry.test.ts src/app/\(app\)/admin/page.tsx e2e/login.spec.ts
git commit -m "feat(nav): shorten module titles and give /admin/contract a nav entry"
```

---

### Task 3: Render per-module dropdowns in `GlobalNav`

The label keeps navigating to the module root; a separate chevron button discloses the module's sub-pages.

**Files:**
- Modify: `src/platform/ui/global-nav.tsx`
- Test: `src/platform/ui/global-nav.test.tsx` (create)

**Interfaces:**
- Consumes: `NavModule` with `nav: NavSubItem[]` from Task 1.
- Produces: no new exports. `GlobalNav({ items }: { items: NavModule[] })` is unchanged in signature.

- [ ] **Step 1: Write the failing test**

This repo has **no jsdom and no `@testing-library/react`**; `vitest.config.ts` sets
`environment: "node"`, and the one existing component test
(`src/platform/ui/env-banner.test.tsx`) asserts against `renderToStaticMarkup`
output. Follow that pattern rather than adding a test stack: assert here on what
server rendering can express (which disclosures exist, where the label links),
and cover the click/Escape interaction in Playwright in Task 6, where a real
browser actually runs it.

Create `src/platform/ui/global-nav.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { GlobalNav } from "./global-nav";
import type { NavModule } from "@/platform/modules/nav";

// GlobalNav is a client component; usePathname needs a stub under SSR.
vi.mock("next/navigation", () => ({ usePathname: () => "/schedule" }));

const ITEMS: NavModule[] = [
  {
    id: "schedule",
    title: "Schedule",
    href: "/schedule",
    nav: [
      { label: "My schedule", href: "/schedule" },
      { label: "Builder", href: "/schedule/builder" },
    ],
  },
  { id: "recruitment", title: "Recruitment", href: "/recruitment", nav: [{ label: "Cycles", href: "/recruitment" }] },
  { id: "clinic", title: "Clinic", href: "/clinic", nav: [] },
];

describe("GlobalNav module dropdowns", () => {
  it("renders a disclosure only for modules with two or more sub-items", () => {
    const out = renderToStaticMarkup(<GlobalNav items={ITEMS} />);
    expect(out).toContain('aria-label="Schedule sub-pages"');
    expect(out).not.toContain('aria-label="Recruitment sub-pages"');
    expect(out).not.toContain('aria-label="Clinic sub-pages"');
  });

  it("keeps the module label a link to the module root", () => {
    const out = renderToStaticMarkup(<GlobalNav items={ITEMS} />);
    expect(out).toContain('href="/schedule"');
    expect(out).toContain("Schedule");
  });

  it("keeps sub-page links closed until the disclosure is activated", () => {
    // Panels are state-driven, so nothing sub-page-specific is in the initial markup.
    const out = renderToStaticMarkup(<GlobalNav items={ITEMS} />);
    expect(out).not.toContain('href="/schedule/builder"');
  });

  it("renders every module in the measurement layer so sizing accounts for all of them", () => {
    const out = renderToStaticMarkup(<GlobalNav items={ITEMS} />);
    expect(out).toContain("data-measure-item");
    expect(out).toContain("data-measure-more");
  });

  it("renders nothing when the viewer can access no modules", () => {
    expect(renderToStaticMarkup(<GlobalNav items={[]} />)).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/platform/ui/global-nav.test.tsx`
Expected: FAIL on the first case: the markup contains no `aria-label="Schedule sub-pages"` because no disclosure is rendered yet. The last two cases pass already, which is fine; they are regression guards.

- [ ] **Step 3: Add dropdown state and the module disclosure**

In `src/platform/ui/global-nav.tsx`, replace the single `moreOpen` state at line 31 with a unified "which panel is open" state, so only one panel is ever open:

```tsx
  // Which panel is open: a module id, "more", or null. A single value guarantees
  // opening one panel closes any other.
  const [openPanel, setOpenPanel] = useState<string | null>(null);
  const moreOpen = openPanel === "more";
```

Delete the old `const [moreOpen, setMoreOpen] = useState(false);` line and replace every `setMoreOpen(true)` with `setOpenPanel("more")`, every `setMoreOpen(false)` with `setOpenPanel(null)`, and the toggle `onClick={() => setMoreOpen((v) => !v)}` at line 190 with:

```tsx
              onClick={() => setOpenPanel((v) => (v === "more" ? null : "more"))}
```

- [ ] **Step 4: Render the per-module disclosure**

In `src/platform/ui/global-nav.tsx`, replace the `visible.map(...)` block at lines 169-181 with:

```tsx
        {visible.map((m) => {
          const active = isModuleActive(pathname, m.href);
          // One sub-page is not worth a dropdown: the module link already goes
          // there or somewhere adjacent. Two or more earns the disclosure.
          const hasMenu = m.nav.length >= 2;
          const menuOpen = openPanel === m.id;
          return (
            <div key={m.id} className="relative flex items-center">
              <Link
                href={m.href}
                aria-current={active ? "page" : undefined}
                className={linkClasses(active)}
              >
                {m.title}
              </Link>
              {hasMenu && (
                <button
                  type="button"
                  aria-haspopup="true"
                  aria-expanded={menuOpen}
                  aria-label={`${m.title} sub-pages`}
                  onClick={() => setOpenPanel((v) => (v === m.id ? null : m.id))}
                  className="ml-0.5 inline-flex h-6 w-5 items-center justify-center rounded text-foreground-soft transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                >
                  <ChevronDown
                    aria-hidden
                    className={`h-3.5 w-3.5 transition-transform ${menuOpen ? "rotate-180" : ""}`}
                  />
                </button>
              )}
              {menuOpen && (
                // A labelled container of navigation links, not an APG menu widget
                // (we implement only Tab + Escape, not arrow-key roving focus).
                <nav
                  aria-label={`${m.title} sub-pages`}
                  className="absolute left-0 top-full z-20 mt-1 flex min-w-44 flex-col gap-1 rounded-xl border border-border bg-surface p-1.5 shadow-lg"
                >
                  {m.nav.map((item) => (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={() => setOpenPanel(null)}
                      className={`block ${linkClasses(pathname === item.href)}`}
                    >
                      {item.label}
                    </Link>
                  ))}
                </nav>
              )}
            </div>
          );
        })}
```

- [ ] **Step 5: Make Escape and outside-click close any panel**

In `src/platform/ui/global-nav.tsx`, replace the Escape effect at lines 126-141:

```tsx
  // Escape closes whichever panel is open and restores focus to its trigger.
  useEffect(() => {
    if (!open && openPanel === null) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      // buttonRef is the mobile hamburger (sm:hidden on desktop, so focusing it
      // there is a no-op), so the desktop "More" menu restores focus itself.
      if (openPanel === "more") moreButtonRef.current?.focus();
      else if (openPanel === null) buttonRef.current?.focus();
      setOpen(false);
      setOpenPanel(null);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, openPanel]);
```

Then replace the outside-click effect at lines 144-153 so it closes module panels too:

```tsx
  // A pointer press anywhere outside the desktop nav closes any open panel.
  useEffect(() => {
    if (openPanel === null) return;
    function handlePointerDown(e: MouseEvent) {
      const target = e.target as Node;
      if (moreRef.current?.contains(target)) return;
      if (navRef.current?.contains(target)) return;
      setOpenPanel(null);
    }
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [openPanel]);
```

- [ ] **Step 6: Reserve chevron width in the measurement layer**

The hidden measurement layer sizes the row. If it omits the chevron, `recompute` under-reserves and items clip. In `src/platform/ui/global-nav.tsx`, replace the `items.map(...)` inside the measurement div at lines 230-234:

```tsx
        {items.map((m) => (
          <span key={m.id} data-measure-item className="inline-flex items-center">
            <span className={linkClasses(false)}>{m.title}</span>
            {m.nav.length >= 2 && (
              <span className="ml-0.5 inline-flex h-6 w-5 items-center justify-center">
                <ChevronDown aria-hidden className="h-3.5 w-3.5" />
              </span>
            )}
          </span>
        ))}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run src/platform/ui/global-nav.test.tsx`
Expected: PASS, all five cases. Interaction (open, Escape, outside-click) is not
covered here by design; Task 6 covers it in Playwright.

- [ ] **Step 8: Verify the whole suite**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/platform/ui/global-nav.tsx src/platform/ui/global-nav.test.tsx
git commit -m "feat(nav): disclose module sub-pages from the global nav"
```

---

### Task 4: Account menu, and move My Info out of the module row

Adds the `personal` flag, builds `AccountMenu`, and folds My Info, Training, and the theme control into it.

**Files:**
- Modify: `src/platform/modules/types.ts:18-36`
- Modify: `src/platform/modules/registry.ts` (my-info entry, line 37-47)
- Modify: `src/platform/modules/access.ts` (`filterAccessibleModules` filter)
- Create: `src/platform/ui/account-menu.tsx`
- Modify: `src/platform/ui/app-shell.tsx:99-132`
- Modify: `src/platform/modules/registry.test.ts` (switch to `!m.personal`)
- Test: `src/platform/modules/access.test.ts`

**Interfaces:**
- Consumes: `NavModule`/`NavSubItem` from Task 1; short titles from Task 2.
- Produces: `ModuleManifest` gains `personal?: boolean`. New client component exported as a named export from `src/platform/ui/account-menu.tsx`:

```ts
export function AccountMenu(props: {
  userName: string | null;
  termLabel: string | null;
  themeInitial: ThemePreference;
  /** Passed in, not imported, so this client component never pulls the auth
   *  module into the browser bundle. */
  signOutAction: () => Promise<void>;
}): JSX.Element;
```

- [ ] **Step 1: Write the failing test**

Append to the `filterAccessibleModules` describe block in `src/platform/modules/access.test.ts`:

```ts
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
```

Also update the existing regression case at `src/platform/modules/access.test.ts:111`, which asserts `ids` contains `my-info`. It must now assert the opposite:

```ts
    expect(ids).not.toContain("my-info"); // personal: lives in the account menu
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/platform/modules/access.test.ts`
Expected: FAIL. TypeScript rejects `personal` on the `mod()` fixture, and the `MODULES` assertion returns `undefined`.

- [ ] **Step 3: Add the `personal` flag to the manifest type**

In `src/platform/modules/types.ts`, add to `ModuleManifest` after `status` (line 34):

```ts
  /**
   * Personal, single-user surfaces (My Info) render in the account menu instead
   * of the module row: they are not team modules, and the row is width-limited.
   * They remain full modules everywhere else, including the hub tile grid.
   */
  personal?: boolean;
```

- [ ] **Step 4: Flag my-info and exclude personal modules from the row**

In `src/platform/modules/registry.ts`, add to the my-info entry after `status: "active",` (line 45):

```ts
    personal: true,
```

In `src/platform/modules/access.ts`, change the `filterAccessibleModules` filter:

```ts
    .filter((m) => m.status === "active" && !m.personal && (canAccessModule(m, perms) || extraIds.has(m.id)))
```

- [ ] **Step 5: Switch the title-budget test to the real predicate**

In `src/platform/modules/registry.test.ts`, replace the placeholder from Task 2:

```ts
    const rowTitles = MODULES.filter((m) => m.status === "active" && !m.personal).map((m) => m.title);
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/platform/modules/`
Expected: PASS. The rendered row is now 64 characters across 8 modules, down from 104.

- [ ] **Step 7: Create the account menu**

Create `src/platform/ui/account-menu.tsx`:

```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { UserRoundPen, GraduationCap, LogOut, Sun, Moon, Monitor } from "lucide-react";
import { THEME_ATTR, THEME_COOKIE, effectiveClass, type ThemePreference } from "./theme";
import { setThemePreference } from "./theme-actions";

const THEMES: { value: ThemePreference; label: string; Icon: typeof Sun }[] = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: Monitor },
];

/** First letters of the first and last name parts, e.g. "Maya Chen" -> "MC". */
function toInitials(name: string | null): string {
  if (!name) return "·";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "·";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] ?? "" : "";
  return (first + last).toUpperCase();
}

function applyToDocument(pref: ThemePreference) {
  const root = document.documentElement;
  root.setAttribute(THEME_ATTR, pref);
  // Live OS-scheme changes while in "system" mode are handled by ThemeListener.
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  root.classList.toggle("dark", effectiveClass(pref, prefersDark) === "dark");
  document.cookie = `${THEME_COOKIE}=${pref};path=/;max-age=${60 * 60 * 24 * 365};samesite=lax`;
}

/**
 * The account disclosure in the toolbar: personal pages (My Info, Training),
 * the theme control, and sign-out.
 *
 * Deliberately shows no clearance status. getOnboardingStatus costs roughly 9 DB
 * queries, which is why onboarding-gate-cache.ts caches cleared gate decisions;
 * rendering clearance here would run it on every page for every user and defeat
 * that cache. `termLabel` is already resolved by the shell, so it is free.
 *
 * `signOutAction` is passed in rather than imported so this client component
 * never pulls the auth module into the browser bundle.
 */
export function AccountMenu({
  userName,
  termLabel,
  themeInitial,
  signOutAction,
}: {
  userName: string | null;
  termLabel: string | null;
  themeInitial: ThemePreference;
  signOutAction: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [pref, setPref] = useState<ThemePreference>(themeInitial);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function pickTheme(next: ThemePreference) {
    setPref(next);
    applyToDocument(next); // optimistic, instant
    void setThemePreference(next);
  }

  const itemClasses =
    "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium text-foreground-soft transition-colors hover:bg-muted hover:text-foreground";

  return (
    <div ref={ref} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="Account menu"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2.5 rounded-full p-0.5 transition-opacity hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
      >
        <span
          aria-hidden
          className="grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br from-brand to-brand-deep text-xs font-semibold tracking-wide text-white"
        >
          {toInitials(userName)}
        </span>
      </button>

      {open && (
        <div className="glass-panel absolute right-0 top-11 z-40 w-60 overflow-hidden rounded-xl p-1.5">
          <div className="border-b border-border-subtle px-2.5 pb-2.5 pt-1.5">
            <p className="truncate text-sm font-semibold text-foreground">{userName ?? "Signed in"}</p>
            {termLabel && <p className="mt-0.5 text-xs text-muted-foreground">{termLabel}</p>}
          </div>

          <div className="flex flex-col gap-0.5 py-1.5">
            <Link href="/my-info" onClick={() => setOpen(false)} className={itemClasses}>
              <UserRoundPen aria-hidden className="h-4 w-4" />
              My Info
            </Link>
            <Link href="/training" onClick={() => setOpen(false)} className={itemClasses}>
              <GraduationCap aria-hidden className="h-4 w-4" />
              Training
            </Link>
          </div>

          <div className="border-t border-border-subtle px-2.5 py-2">
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-subtle-foreground">
              Theme
            </p>
            <div role="radiogroup" aria-label="Theme" className="flex gap-1">
              {THEMES.map(({ value, label, Icon }) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={pref === value}
                  onClick={() => pickTheme(value)}
                  className={`flex flex-1 flex-col items-center gap-1 rounded-lg border px-2 py-1.5 text-[11px] font-medium transition-colors ${
                    pref === value
                      ? "border-brand bg-brand-faint text-brand-fg"
                      : "border-border text-muted-foreground hover:bg-muted hover:text-foreground"
                  }`}
                >
                  <Icon aria-hidden className="h-3.5 w-3.5" />
                  {label}
                </button>
              ))}
            </div>
          </div>

          <form action={signOutAction} className="border-t border-border-subtle pt-1.5">
            <button type="submit" className={`w-full ${itemClasses}`}>
              <LogOut aria-hidden className="h-4 w-4" />
              Sign out
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 8: Mount it in the shell**

In `src/platform/ui/app-shell.tsx`, replace the right-hand controls block (lines 99-132) with:

```tsx
          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
            <NotificationBell />
            <AccountMenu
              userName={userName}
              termLabel={termLabel ?? null}
              themeInitial={resolvedTheme}
              signOutAction={async () => {
                "use server";
                await signOut({ redirectTo: "/login" });
              }}
            />
          </div>
```

Update the imports at the top of the file: replace `import { ThemeToggle } from "./theme-toggle";` with `import { AccountMenu } from "./account-menu";`, and delete the now-unused `Button` (line 12) and `LogOut` (line 4) imports. Keep `resolvePreference` (line 19): it still computes `resolvedTheme`.

Delete the now-unused `toInitials` helper at lines 23-31 and the `initials` const at line 68; `AccountMenu` owns that logic.

- [ ] **Step 9: Verify the whole suite**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS. `app-shell.importer.test.ts` guards that `AppShell` has a single importer; it is unaffected.

- [ ] **Step 10: Commit**

```bash
git add src/platform/modules/types.ts src/platform/modules/registry.ts src/platform/modules/registry.test.ts src/platform/modules/access.ts src/platform/modules/access.test.ts src/platform/ui/account-menu.tsx src/platform/ui/app-shell.tsx
git commit -m "feat(nav): account menu owns My Info, Training, and theme"
```

---

### Task 5: Thread the panelist "My interviews" tab into the global nav

The only dynamic (non-permission) nav item. Resolved in the app layout and passed down as data so the platform layer stays free of module imports.

**Files:**
- Modify: `src/modules/recruitment/services/interviews.ts:235-238`
- Modify: `src/app/(app)/layout.tsx:15-46`
- Modify: `src/platform/ui/app-shell.tsx` (props)
- Test: `src/modules/recruitment/nav.test.ts`

**Interfaces:**
- Consumes: `filterAccessibleModules(..., extraNavItems)` from Task 1; `AccountMenu` from Task 4.
- Produces: `AppShell` gains prop `extraNavItems?: Record<string, { label: string; href: string }[]>`. `isInterviewPanelist` becomes `cache()`-wrapped, same signature `(personId: string) => Promise<boolean>`.

- [ ] **Step 1: Write the failing test**

Append to `src/modules/recruitment/nav.test.ts`:

```ts
import { globalNavExtras } from "./nav";

describe("globalNavExtras", () => {
  it("offers the My interviews tab to a panelist", () => {
    expect(globalNavExtras({ isPanelist: true })).toEqual({
      recruitment: [{ label: "My interviews", href: "/recruitment/interviews" }],
    });
  });

  it("offers nothing to a non-panelist", () => {
    expect(globalNavExtras({ isPanelist: false })).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/recruitment/nav.test.ts`
Expected: FAIL with "globalNavExtras is not exported".

- [ ] **Step 3: Add the helper**

Append to `src/modules/recruitment/nav.ts`:

```ts
/**
 * The dynamic nav items the *global* nav needs for recruitment, shaped as the
 * `extraNavItems` map filterAccessibleModules takes. "My interviews" is gated on
 * interview-panel membership, not a permission, so it cannot flow through the
 * registry's permission-based filterNavItems.
 */
export function globalNavExtras(opts: { isPanelist: boolean }): Record<string, ModuleNavItem[]> {
  return opts.isPanelist ? { recruitment: [MY_INTERVIEWS_NAV_ITEM] } : {};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/recruitment/nav.test.ts`
Expected: PASS.

- [ ] **Step 5: Dedupe the panelist query**

In `src/modules/recruitment/services/interviews.ts`, wrap the function in React `cache()` so the shell, the dashboard, and the recruitment layout share one query per request. Add `import { cache } from "react";` at the top if absent, then replace lines 235-238:

```ts
export const isInterviewPanelist = cache(async function isInterviewPanelist(
  personId: string,
): Promise<boolean> {
  const count = await prisma.interviewPanelist.count({ where: { personId } });
  return count > 0;
});
```

- [ ] **Step 6: Accept and forward the prop in `AppShell`**

In `src/platform/ui/app-shell.tsx`, add to the props type after `extraModuleIds`:

```tsx
  /** Nav sub-items gated on dynamic conditions rather than permissions, keyed by
   *  module id (e.g. recruitment's panelist-only "My interviews"). */
  extraNavItems?: Record<string, { label: string; href: string }[]>;
```

Destructure `extraNavItems` alongside `extraModuleIds`, then pass it through:

```tsx
    getAccessibleModules(personId, new Set(extraModuleIds ?? []), extraNavItems ?? {}),
```

- [ ] **Step 7: Resolve it in the app layout**

In `src/app/(app)/layout.tsx`, add the imports:

```tsx
import { isInterviewPanelist } from "@/modules/recruitment/services/interviews";
import { globalNavExtras } from "@/modules/recruitment/nav";
```

Replace the parallel fetch (lines 17-20) and the `AppShell` call:

```tsx
  const [activeTerm, scope, isPanelist] = await Promise.all([
    getActiveTerm(),
    reviewScope(person.personId),
    isInterviewPanelist(person.personId),
  ]);
```

```tsx
      <AppShell
        userName={person.name}
        termLabel={activeTerm?.name ?? null}
        personId={person.personId}
        personThemePreference={person.themePreference}
        extraModuleIds={extraModuleIds}
        extraNavItems={globalNavExtras({ isPanelist })}
      >
```

- [ ] **Step 8: Verify the whole suite**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS. The ESLint boundary rule is satisfied: the module import lives in `src/app/`, not `src/platform/`.

- [ ] **Step 9: Commit**

```bash
git add src/modules/recruitment/nav.ts src/modules/recruitment/nav.test.ts src/modules/recruitment/services/interviews.ts src/platform/ui/app-shell.tsx src/app/\(app\)/layout.tsx
git commit -m "feat(nav): surface the panelist My interviews tab in the global nav"
```

---

### Task 6: End-to-end coverage for the new paths

Proves the two headline claims: a sub-page is reachable in one hop from anywhere, and `/training` is no longer orphaned.

**Files:**
- Create: `e2e/global-nav.spec.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-5.
- Produces: nothing.

- [ ] **Step 1: Write the test**

Create `e2e/global-nav.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

async function devSignIn(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', "j.carney@yale.edu");
  await page.click('button:has-text("Dev sign in")');
  await page.waitForURL((url) => url.pathname === "/");
}

test("module dropdown reaches a sub-page in one hop from another module", async ({ page }) => {
  await devSignIn(page);
  // Start somewhere that is NOT admin, to prove the hop is global.
  await page.goto("/schedule");
  await page.getByRole("button", { name: "Admin sub-pages" }).click();
  await page.getByRole("link", { name: "Onboarding contract" }).click();
  await page.waitForURL((url) => url.pathname === "/admin/contract");
  await expect(page).toHaveURL(/\/admin\/contract$/);
});

test("account menu reaches Training, which has no other nav entry", async ({ page }) => {
  await devSignIn(page);
  await page.goto("/schedule");
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("link", { name: "Training" }).click();
  await page.waitForURL((url) => url.pathname === "/training");
  await expect(page).toHaveURL(/\/training$/);
});

test("a full admin sees every module inline, with nothing pushed behind More", async ({ page }) => {
  await devSignIn(page);
  // The whole point of shortening titles: overflow must not fire at desktop width.
  await page.setViewportSize({ width: 1280, height: 800 });
  const nav = page.getByRole("navigation", { name: "Modules" });
  await expect(nav.getByRole("button", { name: "More" })).toHaveCount(0);
});

test("Escape closes an open dropdown and returns focus to its chevron", async ({ page }) => {
  // Not unit-testable: vitest runs in node with no jsdom, so GlobalNav's
  // interaction lives here. See src/platform/ui/global-nav.test.tsx.
  await devSignIn(page);
  await page.goto("/schedule");
  const chevron = page.getByRole("button", { name: "Admin sub-pages" });
  await chevron.click();
  await expect(page.getByRole("link", { name: "Onboarding contract" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("link", { name: "Onboarding contract" })).toHaveCount(0);
  await expect(chevron).toBeFocused();
});

test("opening one dropdown closes any other", async ({ page }) => {
  await devSignIn(page);
  await page.goto("/schedule");
  await page.getByRole("button", { name: "Admin sub-pages" }).click();
  await expect(page.getByRole("link", { name: "Onboarding contract" })).toBeVisible();
  await page.getByRole("button", { name: "Schedule sub-pages" }).click();
  await expect(page.getByRole("link", { name: "Onboarding contract" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Attendings" })).toBeVisible();
});

test("sign out still works from the account menu", async ({ page }) => {
  await devSignIn(page);
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL((url) => url.pathname === "/login");
  await expect(page).toHaveURL(/\/login$/);
});
```

- [ ] **Step 2: Verify locally as far as possible**

Run: `npm run lint && npm run typecheck`
Expected: PASS.

The Playwright suite cannot be run locally (it needs the CI Postgres and seeded fixtures). Do not attempt to run it here and do not claim it passes. It runs in CI on push.

- [ ] **Step 3: Commit**

```bash
git add e2e/global-nav.spec.ts
git commit -m "test(e2e): cover module dropdowns, account menu, and no nav overflow"
```

- [ ] **Step 4: Push and watch CI**

```bash
git push -u origin design/nav-ia-user-friendliness
```

CI runs lint, typecheck, vitest, and the full Playwright suite. The known-fragile selectors updated in this plan are `e2e/login.spec.ts:12-13` (Task 2). If any other spec fails on a module title, fix the selector rather than reverting the rename.

---

## Verification checklist

Before opening the PR, confirm each of these with actual command output, not assumption:

- [ ] `npm test` passes.
- [ ] `npm run typecheck` passes.
- [ ] `npm run lint` passes across the whole repo.
- [ ] CI Playwright run is green.
- [ ] Manual: at 1280px width, an admin sees all 8 modules inline with no "More".
- [ ] Manual: the Admin chevron lists all 11 sub-pages including Onboarding contract.
- [ ] Manual: Escape closes an open dropdown and focus returns to its chevron.
- [ ] Manual: the account menu reaches My Info and Training, theme switching still persists across a reload, and sign out works.
- [ ] Manual: My Info still has a tile on the hub and no longer appears in the module row.

## Not in this plan

Stages 2 through 4 of the spec get their own plans once Stage 1 lands:

- Stage 2: command palette (`Cmd+K`, nav-target index).
- Stage 3: cycle workspace nav (`cycles/[id]/layout.tsx`, `cycle-nav.ts`).
- Stage 4: shared `TabRow` primitive, `/support/epic` restyle.
