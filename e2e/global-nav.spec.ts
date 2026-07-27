import { expect, test } from "@playwright/test";

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

test("a full admin sees every module inline, with nothing pushed behind More", async ({ page }) => {
  await devSignIn(page);
  // The whole point of shortening titles: overflow must not fire at desktop width.
  await page.setViewportSize({ width: 1280, height: 800 });
  const nav = page.getByRole("navigation", { name: "Modules" });
  // Assert the nav itself first: without this, renaming the "Modules" aria-label
  // would make the count assertion below pass vacuously instead of failing.
  await expect(nav).toBeVisible();
  await expect(nav.getByRole("button", { name: "More" })).toHaveCount(0);
});

// TEMPORARY DIAGNOSTIC. Dumps the real width budget from CI so the overflow fix
// is computed from measurements rather than estimates. Remove once the fix lands.
test("DIAGNOSTIC: nav width budget", async ({ page }) => {
  await devSignIn(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  // Web fonts change text metrics after first paint; GlobalNav remeasures on
  // fonts.ready, so wait for that before reading any width.
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  const data = await page.evaluate(() => {
    const nav = document.querySelector('nav[aria-label="Modules"]') as HTMLElement | null;
    const items = Array.from(document.querySelectorAll("[data-measure-item]")).map((el) => ({
      text: (el as HTMLElement).innerText.trim().replace(/\s+/g, " "),
      w: (el as HTMLElement).offsetWidth,
    }));
    const more = document.querySelector("[data-measure-more]") as HTMLElement | null;
    const pill = nav?.closest(".glass-bar") as HTMLElement | null;
    const termLabel = pill?.querySelector("span.hidden.whitespace-nowrap") as HTMLElement | null;
    return {
      viewport: window.innerWidth,
      pillClientWidth: pill?.clientWidth ?? -1,
      navClientWidth: nav?.clientWidth ?? -1,
      termLabelText: termLabel?.innerText ?? "(none)",
      termLabelWidth: termLabel?.offsetWidth ?? 0,
      items,
      moreWidth: more?.offsetWidth ?? -1,
      totalWithGaps: items.reduce((s, it, i) => s + it.w + (i > 0 ? 4 : 0), 0),
      renderedInlineLinks: Array.from(nav?.querySelectorAll(":scope > div > a") ?? []).map((a) =>
        (a as HTMLElement).innerText.trim(),
      ),
    };
  });
  console.log("NAVDIAG_START");
  console.log(JSON.stringify(data, null, 2));
  console.log("NAVDIAG_END");
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
  // Builder, Approvals and Attendings gate on a data-driven capability the
  // global nav cannot evaluate (dynamicGate in the registry), so they are
  // deliberately absent here even for a full admin who can open all three.
  await devSignIn(page);
  await page.goto("/volunteers");
  await chevron(page, "Schedule").click();
  const schedulePanel = panel(page, "Schedule");
  await expect(schedulePanel.getByRole("link", { name: "Full schedule" })).toBeVisible();
  await expect(schedulePanel.getByRole("link", { name: "Builder" })).toHaveCount(0);
  await expect(schedulePanel.getByRole("link", { name: "Attendings" })).toHaveCount(0);
  await expect(schedulePanel.getByRole("link", { name: "Approvals" })).toHaveCount(0);
});

test("sign out still works from the account menu", async ({ page }) => {
  await devSignIn(page);
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/login");
  await expect(page).toHaveURL(/\/login$/);
});
