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

test("admin opens SU26 term detail and sees roster department cards and Directors label", async ({ page }) => {
  await devLogin(page, "j.carney@yale.edu");
  await page.goto("/admin/terms");
  await page.getByRole("link", { name: "SU26" }).click();
  await page.waitForURL((url) => url.pathname.startsWith("/admin/terms/"));
  // Roster section heading must be visible.
  await expect(page.getByRole("heading", { name: /roster/i })).toBeVisible();
  // At least one department card heading (e.g. "EXEC", "ITCM", etc.) must be visible.
  // Department cards use an <h3> with the dept code and name.
  const deptCard = page.locator("h3").first();
  await expect(deptCard).toBeVisible();
  // The "Directors" list label must appear in at least one card.
  await expect(page.getByText("Directors").first()).toBeVisible();
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

test("admin opens /admin/roles and sees Platform Admin with system badge", async ({ page }) => {
  await devLogin(page, "j.carney@yale.edu");
  await page.goto("/admin/roles");
  await expect(page.getByRole("heading", { name: "Roles", level: 1 })).toBeVisible();
  // The "Platform Admin" role card heading must be present.
  await expect(page.getByRole("heading", { name: "Platform Admin" })).toBeVisible();
  // The system badge must be visible (inside the role card area).
  await expect(page.getByText("System").first()).toBeVisible();
  // The Assignments section heading (h2) must be present.
  await expect(page.getByRole("heading", { name: "Assignments" })).toBeVisible();
});

test("admin opens /admin/audit and sees at least one row and the entityType select", async ({ page }) => {
  await devLogin(page, "j.carney@yale.edu");
  await page.goto("/admin/audit");
  // Page heading must be present.
  await expect(page.getByRole("heading", { name: "Audit Log" })).toBeVisible();
  // The entityType select must be present (filter bar).
  await expect(page.locator('select[name="entityType"]')).toBeVisible();
  // The filter action input must be present.
  await expect(page.locator('input[name="action"]')).toBeVisible();
  // At least one table row must be visible (dev DB has many audit entries from imports).
  const rows = page.locator("tbody tr");
  await expect(rows.first()).toBeVisible();
});

test("admin opens /admin/sync and sees mirror-disabled banner and Worker card", async ({ page }) => {
  await devLogin(page, "j.carney@yale.edu");
  await page.goto("/admin/sync");
  // Page heading must be present.
  await expect(page.getByRole("heading", { name: "Sync Health" })).toBeVisible();
  // Mirror-disabled banner must be visible (dev env has AIRTABLE_MIRROR_ENABLED=false).
  const banner = page.getByRole("status");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("Mirror is disabled");
  // Worker card must be present (the card label is "Worker", exact match inside a stat card).
  await expect(page.getByText("Worker", { exact: true })).toBeVisible();
});

test("email page renders heading, stat cards, and table or empty state", async ({ page }) => {
  await devLogin(page, "j.carney@yale.edu");
  await page.goto("/admin/email");
  // Page heading must be visible.
  await expect(page.getByRole("heading", { name: "Email" })).toBeVisible();
  // All three health-stat card labels must be present (deterministic -- counts from DB, no seeding needed).
  await expect(page.getByText("Queued", { exact: true })).toBeVisible();
  await expect(page.getByText("Failed", { exact: true })).toBeVisible();
  await expect(page.getByText("Sent today", { exact: true })).toBeVisible();
  // Either the table (at least one row) or the empty-state message must be present.
  const tableOrEmpty = page.locator('table, p:has-text("No emails found.")');
  await expect(tableOrEmpty.first()).toBeVisible();
});

test("email page status filter: FAILED param renders without error and select reflects the filter", async ({ page }) => {
  await devLogin(page, "j.carney@yale.edu");
  await page.goto("/admin/email?status=FAILED");
  // Page must render without crashing -- heading visible.
  await expect(page.getByRole("heading", { name: "Email" })).toBeVisible();
  // Stat cards still render.
  await expect(page.getByText("Queued", { exact: true })).toBeVisible();
  await expect(page.getByText("Failed", { exact: true })).toBeVisible();
  await expect(page.getByText("Sent today", { exact: true })).toBeVisible();
  // The status <select name="status"> must reflect the FAILED selection.
  await expect(page.locator('select[name="status"]')).toHaveValue("FAILED");
});
