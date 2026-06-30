import { expect, test } from "@playwright/test";

test("dev login reaches the permission-gated hub at the root", async ({ page }) => {
  await page.goto("/login");
  await page.fill('input[name="email"]', "j.carney@yale.edu");
  await page.click('button:has-text("Dev sign in")');
  await page.waitForURL((url) => url.pathname === "/");
  // Hub h1 is a time-of-day greeting: "Good morning, Jack." (no "Welcome" heading)
  await expect(page.getByRole("heading", { name: /Good (morning|afternoon|evening)/ })).toBeVisible();
  // Use the module tile link's unique aria-label to avoid strict-mode violation
  // (getByText("Clinic Schedule") matches 3 elements: nav link, overflow span, and tile)
  await expect(page.getByRole("link", { name: "Open Clinic Schedule" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Volunteer Management" })).toBeVisible();
});

test("unknown routes render the branded 404 page", async ({ page }) => {
  await page.goto("/this-page-does-not-exist");
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to Hub" })).toBeVisible();
});

test("unknown email cannot dev-sign-in and sees a friendly error", async ({ page }) => {
  await page.goto("/login");
  await page.fill('input[name="email"]', "stranger@yale.edu");
  await page.click('button:has-text("Dev sign in")');
  await expect(page).toHaveURL(/\/login/);
  await expect(
    page.getByRole("alert").filter({ hasText: /couldn't sign you in/i })
  ).toBeVisible();
});
