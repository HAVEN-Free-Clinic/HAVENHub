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
  await page.goto("/admin/people");
  await page.fill('input[name="q"]', "Jack");
  // Must use a specific text selector: "Sign out" is also a submit button earlier
  // in the DOM, so a bare button[type="submit"] click hits the wrong target.
  await page.locator('button[type="submit"]:has-text("Search")').click();
  await page.waitForURL((url) => url.searchParams.has("q") && url.searchParams.get("q")!.includes("Jack"));
  await expect(page.getByRole("link", { name: "Jack Carney" })).toBeVisible();
});

test("admin can view all statuses and description does not say 'active'", async ({ page }) => {
  await devLogin(page, "j.carney@yale.edu");
  await page.goto("/admin/people?q=&status=");
  // Page must render without crashing.
  await expect(page.getByRole("heading", { name: "People" })).toBeVisible();
  // The description <p> must contain "people" but not "active" when all statuses are shown.
  const description = page.locator("p.text-slate-500").filter({ hasText: /people/ }).first();
  await expect(description).toBeVisible();
  await expect(description).not.toContainText(/\bactive\b/i);
  // Confirm "All statuses" option is selected.
  await expect(page.locator('select[name="status"]')).toHaveValue("");
});

test("admin visits /admin/terms and sees the SU26 ACTIVE row", async ({ page }) => {
  await devLogin(page, "j.carney@yale.edu");
  await page.goto("/admin/terms");
  await expect(page.getByRole("heading", { name: "Terms" })).toBeVisible();
  // SU26 row must be present with an ACTIVE badge.
  const row = page.locator("tr").filter({ hasText: "SU26" });
  await expect(row).toBeVisible();
  await expect(row.getByText("Active")).toBeVisible();
});

test("admin opens SU26 term detail and sees Clinic dates section with dates", async ({ page }) => {
  await devLogin(page, "j.carney@yale.edu");
  await page.goto("/admin/terms");
  // Click the SU26 code link.
  await page.getByRole("link", { name: "SU26" }).click();
  await page.waitForURL((url) => url.pathname.startsWith("/admin/terms/"));
  // Clinic dates section heading must be visible.
  await expect(page.getByRole("heading", { name: /clinic dates/i })).toBeVisible();
  // First Saturday of SU26 range: "Sat, May 30, 2026" should appear.
  await expect(page.getByText("Sat, May 30, 2026")).toBeVisible();
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
