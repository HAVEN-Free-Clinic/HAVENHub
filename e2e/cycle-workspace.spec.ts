import { expect, test } from "@playwright/test";
import { selectDepartments } from "./recruitment-helpers";

test.setTimeout(120_000);

async function devSignIn(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', "j.carney@yale.edu");
  await page.click('button:has-text("Dev sign in")');
  await page.waitForURL((url) => url.pathname === "/");
}

/**
 * The persistent cycle-workspace tab row (src/modules/recruitment/components/cycle-nav-tabs.tsx).
 * Scope EVERY tab lookup to this landmark: sub-page content routinely repeats a
 * tab's own label as a heading, table column, or body copy, and this branch has
 * already broken CI twice on an unscoped getByRole("link", { name: ... })
 * matching more than one element under Playwright's strict mode. See
 * e2e/recruitment-speed-routing.spec.ts:115 for the concrete case: "Speed route"
 * used to be both this nav's tab label AND a second, unscoped launcher link on
 * the Applicants page, until the duplicate launcher was removed for this exact
 * reason.
 */
function cycleNav(page: import("@playwright/test").Page) {
  return page.getByRole("navigation", { name: "Cycle sections" });
}

/** Creates a minimal DRAFT volunteer cycle and returns its id, landing in the Form tab. */
async function createCycle(page: import("@playwright/test").Page, title: string): Promise<string> {
  await page.goto("/recruitment/cycles/new");
  await page.fill('input[name="title"]', title);
  await page.fill('input[name="publicSlug"]', `cycle-workspace-e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  await selectDepartments(page, ["SRHD"]);
  // Build the form ourselves; the seeded default form is irrelevant to nav coverage.
  await page.uncheck('input[name="seedDefaultForm"]');
  await page.click('button:has-text("Create")');
  await page.waitForURL((url) => url.pathname.includes("/builder"));
  return page.url().split("/cycles/")[1].split("/")[0];
}

test("cycle nav renders on the overview and persists on the Applicants sub-page", async ({ page }) => {
  await devSignIn(page);
  const cycleId = await createCycle(page, "Cycle Workspace Nav E2E");

  await page.goto(`/recruitment/cycles/${cycleId}`);
  await expect(cycleNav(page)).toBeVisible();
  await expect(cycleNav(page).getByRole("link", { name: "Applicants" })).toBeVisible();

  // This is the whole point of the stage: the nav is not overview-only chrome,
  // it is workspace chrome that survives navigating into a sub-page.
  await page.goto(`/recruitment/cycles/${cycleId}/applicants`);
  await expect(cycleNav(page)).toBeVisible();
  await expect(cycleNav(page).getByRole("link", { name: "Applicants" })).toBeVisible();
  await expect(cycleNav(page).getByRole("link", { name: "Waitlist" })).toBeVisible();
});

test("clicking a tab navigates and marks it current", async ({ page }) => {
  await devSignIn(page);
  const cycleId = await createCycle(page, "Cycle Workspace Tab Click E2E");

  await page.goto(`/recruitment/cycles/${cycleId}`);
  await expect(cycleNav(page).getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");

  await cycleNav(page).getByRole("link", { name: "Applicants" }).click();
  await page.waitForURL((url) => url.pathname === `/recruitment/cycles/${cycleId}/applicants`);
  await expect(cycleNav(page).getByRole("link", { name: "Applicants" })).toHaveAttribute("aria-current", "page");
  // The previously-current tab is no longer marked current now that we navigated away.
  await expect(cycleNav(page).getByRole("link", { name: "Overview" })).not.toHaveAttribute("aria-current", "page");
});

test("a sub-page is reachable from another sub-page without returning to the overview", async ({ page }) => {
  await devSignIn(page);
  const cycleId = await createCycle(page, "Cycle Workspace Cross-Tab E2E");

  // Land directly on a sub-page (never touching the overview) and hop to a
  // second sub-page from there. Before TabRow, the sub-page links only lived on
  // the overview's button wall, so this hop was impossible without detouring
  // back through it.
  await page.goto(`/recruitment/cycles/${cycleId}/applicants`);
  await expect(cycleNav(page)).toBeVisible();
  await cycleNav(page).getByRole("link", { name: "Waitlist" }).click();
  await page.waitForURL((url) => url.pathname === `/recruitment/cycles/${cycleId}/waitlist`);
  await expect(page.getByRole("heading", { name: "Waitlist" })).toBeVisible();
  await expect(cycleNav(page)).toBeVisible();
  await expect(cycleNav(page).getByRole("link", { name: "Waitlist" })).toHaveAttribute("aria-current", "page");
});

test("the overview renders the nav landmark but no duplicate button-wall links outside it", async ({ page }) => {
  await devSignIn(page);
  const cycleId = await createCycle(page, "Cycle Workspace No Button Wall E2E");

  await page.goto(`/recruitment/cycles/${cycleId}`);
  const nav = cycleNav(page);
  await expect(nav).toBeVisible();

  const labels = await nav.getByRole("link").allTextContents();
  expect(labels.length).toBeGreaterThan(0);
  for (const label of labels) {
    // Exactly one link with this name should exist on the whole page: the nav
    // tab itself. The old overview rendered an identical set of section links a
    // second time as a button wall; a count of 2 here would be that wall back.
    await expect(page.getByRole("link", { name: label, exact: true })).toHaveCount(1);
  }
});
