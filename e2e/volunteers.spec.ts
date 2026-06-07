import { expect, test } from "@playwright/test";

async function devLogin(page: import("@playwright/test").Page, email: string) {
  await page.goto("/login");
  await page.fill('input[name="email"]', email);
  await page.click('button:has-text("Dev sign in")');
  await page.waitForURL((url) => url.pathname === "/");
}

test("Jack (ITCM director) opens /volunteers and sees the ITCM department card", async ({ page }) => {
  await devLogin(page, "j.carney@yale.edu");
  await page.goto("/volunteers");
  await page.waitForURL((url) => url.pathname === "/volunteers");

  // Page heading must be present (exact match to avoid matching ITCM department h2)
  await expect(page.getByRole("heading", { name: "Compliance", exact: true })).toBeVisible();

  // ITCM department section heading must be visible
  const itcmHeading = page.locator("h2").filter({ hasText: /ITCM/ });
  await expect(itcmHeading).toBeVisible();
});

test("Jack sees at least one status Badge on the ITCM compliance page", async ({ page }) => {
  await devLogin(page, "j.carney@yale.edu");
  await page.goto("/volunteers");
  await page.waitForURL((url) => url.pathname === "/volunteers");

  // At least one status badge must be visible in the table
  // Status labels: Compliant, Expiring Soon, Expired, Date Unknown, No Certificate
  const statusBadge = page
    .locator("td span")
    .filter({
      hasText: /^(Compliant|Expiring Soon|Expired|Date Unknown|No Certificate)$/,
    })
    .first();
  await expect(statusBadge).toBeVisible();
});

test("dev.volunteer is bounced from /volunteers to the hub", async ({ page }) => {
  await devLogin(page, "dev.volunteer@yale.edu");
  await page.goto("/volunteers");
  await page.waitForURL((url) => url.pathname === "/");
});

test("Jack (Platform Admin) opens /volunteers/master and sees the summary cards", async ({ page }) => {
  await devLogin(page, "j.carney@yale.edu");
  await page.goto("/volunteers/master");
  await page.waitForURL((url) => url.pathname === "/volunteers/master");

  // Page heading must be visible
  await expect(page.getByRole("heading", { name: "Master Compliance View" })).toBeVisible();

  // Summary stat cards must be visible (one per status, identified by aria-label)
  await expect(page.locator('[aria-label^="Compliant:"]')).toBeVisible();
  await expect(page.locator('[aria-label^="No Certificate:"]')).toBeVisible();
});

test("Jack sees the filter bar on /volunteers/master", async ({ page }) => {
  await devLogin(page, "j.carney@yale.edu");
  await page.goto("/volunteers/master");
  await page.waitForURL((url) => url.pathname === "/volunteers/master");

  // Filter bar inputs must be present
  await expect(page.getByPlaceholder("Name or NetID...")).toBeVisible();
});

test("dev.volunteer is bounced from /volunteers/master to the hub", async ({ page }) => {
  await devLogin(page, "dev.volunteer@yale.edu");
  await page.goto("/volunteers/master");
  await page.waitForURL((url) => url.pathname === "/");
});
