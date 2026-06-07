import { expect, test } from "@playwright/test";

async function devLogin(page: import("@playwright/test").Page, email: string) {
  await page.goto("/login");
  await page.fill('input[name="email"]', email);
  await page.click('button:has-text("Dev sign in")');
  await page.waitForURL((url) => url.pathname === "/");
}

test("admin login: hub My Info tile links to /my-info and page renders read-only rows and HIPAA section", async ({ page }) => {
  await devLogin(page, "j.carney@yale.edu");

  // Hub must show a My Info tile with a link to /my-info.
  const tile = page.getByRole("link", { name: /Open My Info/i });
  await expect(tile).toBeVisible();
  await expect(tile).toHaveAttribute("href", "/my-info");

  // Navigate to /my-info.
  await tile.click();
  await page.waitForURL((url) => url.pathname === "/my-info");

  // The Name read-only row must be present (label text "Name").
  await expect(page.getByText("Name", { exact: true })).toBeVisible();

  // The HIPAA certificate section heading must be present.
  await expect(
    page.getByRole("heading", { name: /HIPAA Certificate/i })
  ).toBeVisible();
});

test("volunteer login: /my-info renders the profile form", async ({ page }) => {
  await devLogin(page, "dev.volunteer@yale.edu");

  // Navigate directly to /my-info (session-only access -- no special permission needed).
  await page.goto("/my-info");
  await page.waitForURL((url) => url.pathname === "/my-info");

  // The page heading must be visible.
  await expect(page.getByRole("heading", { name: "My Info" })).toBeVisible();

  // The Profile section must render (editable form is present).
  await expect(page.getByText("Profile", { exact: true })).toBeVisible();

  // The Name read-only row must be present.
  await expect(page.getByText("Name", { exact: true })).toBeVisible();
});

test("Jack's HIPAA panel shows UNKNOWN_DATE status badge and date-entry form for imported cert with no completionDate", async ({ page }) => {
  await devLogin(page, "j.carney@yale.edu");

  await page.goto("/my-info");
  await page.waitForURL((url) => url.pathname === "/my-info");

  // The HIPAA certificate section must be visible
  await expect(
    page.getByRole("heading", { name: /HIPAA Certificate/i })
  ).toBeVisible();

  // Jack's imported cert has no completionDate -> UNKNOWN_DATE status badge
  await expect(page.getByText("Completion date needed")).toBeVisible();

  // The date-entry form must be rendered with a date input
  await expect(
    page.getByText("We could not read a completion date from your certificate")
  ).toBeVisible();
});
