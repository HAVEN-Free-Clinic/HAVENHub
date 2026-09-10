import { expect, test } from "@playwright/test";
import { devLogin } from "./auth";

async function devSignIn(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', "j.carney@yale.edu");
  await page.click('button:has-text("Dev sign in")');
  await page.waitForURL((url) => url.pathname === "/");
}

// A module's dropdown panel. Scoping every panel-item lookup to its own panel is
// mandatory, not tidiness: a module's sub-pages are ALSO rendered in that
// module's ModuleNav tab row whenever you are inside it, so an unscoped
// getByRole("link", ...) matches twice and Playwright's strict mode throws.
function panel(page: import("@playwright/test").Page, moduleTitle: string) {
  return page.getByRole("navigation", { name: `${moduleTitle} sub-page links` });
}

function chevron(page: import("@playwright/test").Page, moduleTitle: string) {
  return page.getByRole("button", { name: `${moduleTitle} sub-pages` });
}

test("module dropdown reaches a sub-page in one hop from another module", async ({ page }) => {
  await devSignIn(page);
  // Start somewhere that is NOT admin, to prove the hop is global.
  await page.goto("/schedule");
  await chevron(page, "Admin").click();
  await panel(page, "Admin").getByRole("link", { name: "Onboarding contract" }).click();
  await page.waitForURL((url) => url.pathname === "/admin/contract");
  await expect(page).toHaveURL(/\/admin\/contract$/);
});

test("schedule dropdown reaches the Builder, whose gate the global nav cannot run", async ({ page }) => {
  // The Builder gates on "manages at least one schedule department", which no
  // permission string expresses, so the registry marks it dynamicGate and the
  // global nav used to drop it. A department director whose whole job is the
  // Builder had to land on /schedule first and find the tab. The app layout now
  // resolves that gate and hands the result to the nav, so the link is one hop
  // away from anywhere. (j.carney manages schedule departments in the seed --
  // schedule.spec.ts drives the Builder as this same user.)
  await devSignIn(page);
  await page.goto("/admin");
  await chevron(page, "Schedule").click();
  await panel(page, "Schedule").getByRole("link", { name: "Builder", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/schedule/builder");
});

test("recruitment dropdown reaches Events, whose gate the global nav cannot run", async ({ page }) => {
  // Same shape as the Builder above, for the tab the schedule work left behind.
  // Events gates on canRecordAttendance, which is recruitment.record_attendance
  // OR manage_cycles OR review_all OR a department director's review scope --
  // the last of which is data, not a permission, so the registry marks it
  // dynamicGate and the global nav dropped it. A recruitment director running
  // info sessions could reach the sign-in sheet only by landing on /recruitment
  // and spotting the tab; Cmd+K, which matches nav labels, had nothing to
  // offer. (j.carney can open the page -- event-attendance.spec.ts drives it as
  // this same user.)
  await devSignIn(page);
  await page.goto("/admin");
  await chevron(page, "Recruitment").click();
  await panel(page, "Recruitment").getByRole("link", { name: "Events", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/recruitment/events");
});

test("account menu reaches Training, which has no other nav entry", async ({ page }) => {
  await devSignIn(page);
  await page.goto("/schedule");
  await page.getByRole("button", { name: "Account menu" }).click();
  // exact: accessible-name matching is substring by default, so an unanchored
  // "Training" would also match any "... training ..." link a page adds later.
  await page.getByRole("link", { name: "Training", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/training");
  await expect(page).toHaveURL(/\/training$/);
});

test("a full admin can reach every module at desktop width, inline or via More", async ({ page }) => {
  // This used to assert that NOTHING was ever behind More. That held while the
  // row carried eight modules, and stopped holding when a ninth (Outreach)
  // arrived. The numbers, measured rather than estimated: nine chips are 780px,
  // the eight 4px gaps add 32px, and the nav has 792px, so the row is 20px
  // short. Chip padding is already down to pl-2 pr-0.5, so there is no slack
  // left to reclaim without renaming a module.
  //
  // Letting the overflow menu do its job is the right outcome here. Only
  // somebody holding every module sees all nine, and a 1440px laptop still
  // shows them inline; the cost of the old assertion was renaming a
  // user-facing module to buy 20px.
  //
  // What must stay true is that no module becomes UNREACHABLE, and that the row
  // never spills sideways. Assert those instead, so this still fails loudly if
  // a module silently disappears from the row rather than moving into More.
  await devSignIn(page);
  await page.setViewportSize({ width: 1280, height: 800 });

  // `exact` is load-bearing, not decoration: accessible-name matching is
  // substring by default, so once the overflow panel opens its own
  // "More modules" nav ALSO matches "Modules" and every locator call below
  // dies on a strict-mode violation.
  const nav = page.getByRole("navigation", { name: "Modules", exact: true });
  // Assert the nav itself first: without this, renaming the "Modules"
  // aria-label would make everything below pass vacuously.
  await expect(nav).toBeVisible();

  const expected = [
    "Admin",
    "Clinic",
    "Incidents",
    "Learning",
    "Outreach",
    "Recruitment",
    "Schedule",
    "Support",
    "Volunteers",
  ];

  const reachable = new Set(
    (await nav.getByRole("link").allInnerTexts()).map((t) => t.trim()).filter(Boolean),
  );

  // Anything that did not fit must be in the overflow menu, not gone.
  const more = nav.getByRole("button", { name: "More" });
  if ((await more.count()) > 0) {
    await more.click();
    const overflowPanel = page.getByRole("navigation", { name: "More modules" });
    await expect(overflowPanel).toBeVisible();
    for (const label of await overflowPanel.getByRole("link").allInnerTexts()) {
      reachable.add(label.trim());
    }
  }

  for (const title of expected) {
    expect(
      [...reachable],
      `"${title}" is reachable from neither the inline row nor the More menu`,
    ).toContain(title);
  }

  // Independent of overflow: the row must never spill sideways.
  const spill = await nav.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(spill, "the module row overflows its own width at 1280px").toBeLessThanOrEqual(0);
});

test("the toolbar does not overflow its own width on a phone", async ({ page }) => {
  // The desktop assertion above only ever guarded 1280px. Narrow widths were
  // reasoned about but never measured, and they are the riskier case: the
  // active-term label was already hidden below `sm`, so the search trigger
  // added roughly 36px there with nothing given back.
  //
  // Asserting "no More button" is wrong here. Below `sm` the module row is
  // deliberately replaced by the hamburger menu, so More is legitimately
  // absent and the assertion would pass vacuously. What actually matters is
  // that the toolbar's own contents fit inside it, so the pill never spills
  // sideways and never forces the page to scroll horizontally.
  await devSignIn(page);
  await page.setViewportSize({ width: 375, height: 812 });

  const overflow = await page.evaluate(() => {
    const bar = document.querySelector(".glass-bar") as HTMLElement | null;
    if (!bar) return null;
    return {
      barOverflow: bar.scrollWidth - bar.clientWidth,
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });

  expect(overflow, "expected a .glass-bar toolbar to be present").not.toBeNull();
  expect(overflow!.barOverflow, "toolbar contents overflow the toolbar at 375px").toBeLessThanOrEqual(0);
  expect(overflow!.documentOverflow, "page scrolls horizontally at 375px").toBeLessThanOrEqual(0);
});

test("Escape closes an open dropdown and returns focus to its chevron", async ({ page }) => {
  // Not unit-testable: vitest runs in node with no jsdom, so GlobalNav's
  // interaction lives here. See src/platform/ui/global-nav.test.tsx.
  await devSignIn(page);
  await page.goto("/schedule");
  const adminChevron = chevron(page, "Admin");
  await adminChevron.click();
  await expect(panel(page, "Admin").getByRole("link", { name: "Onboarding contract" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel(page, "Admin")).toHaveCount(0);
  await expect(adminChevron).toBeFocused();
});

test("opening one dropdown closes any other", async ({ page }) => {
  await devSignIn(page);
  // Run from /schedule and drive Admin + Volunteers: neither module's sub-pages
  // are on screen here, so each assertion is about the panel and nothing else.
  await page.goto("/schedule");
  await chevron(page, "Admin").click();
  await expect(panel(page, "Admin").getByRole("link", { name: "Onboarding contract" })).toBeVisible();
  await chevron(page, "Volunteers").click();
  await expect(panel(page, "Admin")).toHaveCount(0);
  await expect(panel(page, "Volunteers").getByRole("link", { name: "Offboarding" })).toBeVisible();
});

test("navigating to another module closes an open dropdown", async ({ page }) => {
  // The app shell persists across soft navigation, so a panel left open would
  // otherwise still be hanging over the page you just landed on.
  await devSignIn(page);
  await page.goto("/schedule");
  await chevron(page, "Admin").click();
  await expect(panel(page, "Admin")).toBeVisible();
  await page.getByRole("navigation", { name: "Modules" }).getByRole("link", { name: "Volunteers" }).click();
  await page.waitForURL((url) => url.pathname === "/volunteers");
  await expect(panel(page, "Admin")).toHaveCount(0);
});

test("the Schedule dropdown offers no link that bounces to /no-access", async ({ page }) => {
  // Builder, Approvals and Attendings gate on a data-driven capability, so the
  // registry marks them dynamicGate and the global nav shows them only to a
  // viewer the app layout resolved them TRUE for. This is the other half of
  // that: a plain volunteer holds schedule.view (every seeded volunteer role
  // does) and can open none of the three, so none of them may appear.
  //
  // The guarantee used to be enforced by dropping the links for EVERYONE, which
  // also hid them from the admin who could open them -- see the case below.
  await devLogin(page, "dev.volunteer@yale.edu");
  await page.goto("/schedule");
  await chevron(page, "Schedule").click();
  const schedulePanel = panel(page, "Schedule");
  await expect(schedulePanel.getByRole("link", { name: "Full schedule" })).toBeVisible();
  await expect(schedulePanel.getByRole("link", { name: "Builder" })).toHaveCount(0);
  await expect(schedulePanel.getByRole("link", { name: "Attendings" })).toHaveCount(0);
  await expect(schedulePanel.getByRole("link", { name: "Approvals" })).toHaveCount(0);
});

test("a department director can reach the Approvals page they are emailed about", async ({ page }) => {
  // dev.director is an ACTIVE DIRECTOR of VADM and holds no schedule.manage_*
  // permission -- the shipped Director role grants neither. That is exactly the
  // persona /schedule/requests admits (manageableRequestDepartmentIds unions
  // manageableDepartmentIds, which needs a directorship and nothing else) and
  // exactly the persona the nav used to hide it from, because the item carried
  // a permission that filterNavItems applied BEFORE the layout's canApprove
  // check -- and filterNavItems can only remove.
  //
  // The daily reminder email and the dashboard card both link here off the same
  // permission-free authority, so the destination existed and the route to it
  // did not.
  await devLogin(page, "dev.director@yale.edu");
  await page.goto("/schedule");
  await chevron(page, "Schedule").click();
  await panel(page, "Schedule").getByRole("link", { name: "Approvals", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/schedule/requests");
  // ...and the page admits them rather than bouncing, which is the half that
  // proves the nav and the page now agree.
  await expect(page).toHaveURL(/\/schedule\/requests$/);
});

test("the Schedule dropdown DOES offer a dynamically-gated link to someone who can open it", async ({ page }) => {
  // The same three links, for a viewer the gates resolve true for. Together
  // with the case above this pins both directions: the dropdown mirrors what
  // the schedule tab row would show, rather than being permanently blind to it.
  await devSignIn(page);
  await page.goto("/volunteers");
  await chevron(page, "Schedule").click();
  const schedulePanel = panel(page, "Schedule");
  await expect(schedulePanel.getByRole("link", { name: "Builder", exact: true })).toBeVisible();
});

test("sign out still works from the account menu", async ({ page }) => {
  await devSignIn(page);
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/login");
  await expect(page).toHaveURL(/\/login$/);
});

test("the phone menu offers the sub-pages of the module you are in", async ({ page }) => {
  // The desktop row puts sub-pages behind a per-module chevron. The phone menu
  // used to drop them entirely, which left the TabRow strip as the only route
  // to them -- a strip whose scrollbar is hidden and which auto-scrolls to the
  // active tab, so on a 13-tab cycle a director could see three and no sign of
  // the rest.
  await devSignIn(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/schedule");
  await page.waitForURL((url) => url.pathname === "/schedule");

  await page.getByRole("button", { name: "Open navigation menu" }).click();
  const menu = page.getByRole("navigation", { name: "Modules (menu)" });
  await expect(menu).toBeVisible();

  // The module you are in expands; its sub-pages are reachable without the strip.
  const scheduleSubPages = menu.getByRole("group", { name: "Schedule sub-pages" });
  await expect(scheduleSubPages).toBeVisible();
  await expect(scheduleSubPages.getByRole("link", { name: "Full schedule" })).toBeVisible();

  // A module you are NOT in stays collapsed, so the menu does not become a wall.
  await expect(menu.getByRole("group", { name: "Admin sub-pages" })).toHaveCount(0);
});
