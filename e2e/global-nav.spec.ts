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
