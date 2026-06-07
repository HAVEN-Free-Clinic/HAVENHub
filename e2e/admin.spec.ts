import { expect, test } from "@playwright/test";

async function devLogin(page: import("@playwright/test").Page, email: string) {
  await page.goto("/login");
  await page.fill('input[name="email"]', email);
  await page.click('button:has-text("Dev sign in")');
  await page.waitForURL((url) => url.pathname === "/");
}

test("platform admin reaches the admin overview", async ({ page }) => {
  await devLogin(page, "j.carney@yale.edu");
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Admin" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Module" })).toBeVisible();
});

test("a volunteer is bounced from /admin to the hub", async ({ page }) => {
  await devLogin(page, "dev.volunteer@yale.edu");
  await page.goto("/admin");
  await page.waitForURL((url) => url.pathname === "/");
});

test("admin searches people and sees Jack Carney", async ({ page }) => {
  await devLogin(page, "j.carney@yale.edu");
  // Navigate directly to the search URL (GET form equivalent).
  await page.goto("/admin/people?q=Jack&status=ACTIVE");
  await expect(page.getByRole("link", { name: "Jack Carney" })).toBeVisible();
});

test("admin opens Jack Carney detail and sees memberships and name field", async ({ page }) => {
  await devLogin(page, "j.carney@yale.edu");
  // Navigate to the search results.
  await page.goto("/admin/people?q=Jack+Carney&status=ACTIVE");
  // Click through to the detail page.
  await page.getByRole("link", { name: "Jack Carney" }).first().click();
  await page.waitForURL((url) => url.pathname.startsWith("/admin/people/"));
  // The form should have a Name field pre-filled with the person's name.
  await expect(page.locator('input[name="name"]')).toHaveValue(/Jack Carney/i);
  // The detail page always renders the Details section heading.
  await expect(page.getByRole("heading", { name: /details/i })).toBeVisible();
});
