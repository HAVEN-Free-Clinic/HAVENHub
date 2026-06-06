import { expect, test } from "@playwright/test";

test("dev login reaches the permission-gated hub at the root", async ({ page }) => {
  await page.goto("/login");
  await page.fill('input[name="email"]', "j.carney@yale.edu");
  await page.click('button:has-text("Dev sign in")');
  await page.waitForURL((url) => url.pathname === "/");
  await expect(page.getByRole("heading", { name: /Welcome/ })).toBeVisible();
  await expect(page.getByText("Clinic Schedule")).toBeVisible();
  await expect(page.getByText("Volunteer Management")).toBeVisible();
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
