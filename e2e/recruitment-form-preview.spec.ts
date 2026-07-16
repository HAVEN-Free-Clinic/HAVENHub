import { expect, test } from "@playwright/test";
import { devLogin } from "./auth";

test.setTimeout(120_000);

// The form builder's "Preview form" button opens a modal that renders the
// applicant-facing form through the shared FieldPreview renderer + visibility
// engine. This covers the button -> modal -> rendered-form path end to end.
test("form builder: preview modal renders the applicant form", async ({ page }) => {
  await devLogin(page, "j.carney@yale.edu");

  // Create a volunteer cycle from the default template so there are real
  // sections/fields to preview (seedDefaultForm ships checked).
  await page.goto("/recruitment/cycles/new");
  await page.fill('input[name="title"]', "Preview E2E");
  const slug = `preview-e2e-${Date.now()}`;
  await page.fill('input[name="publicSlug"]', slug);
  await page.click('button:has-text("Create")');
  await page.waitForURL((url) => url.pathname.includes("/builder"));

  // Open the preview.
  await page.getByRole("button", { name: "Preview form" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/this is how applicants see/i)).toBeVisible();

  // The seeded identity section (shown to a NEW applicant) renders its fields
  // through the real applicant renderer -- assert on the input itself, since the
  // visible label carries a required-asterisk suffix.
  await expect(dialog.locator('input[name="first_name"]')).toBeVisible();

  // Close the preview.
  await dialog.getByRole("button", { name: "Close preview" }).click();
  await expect(dialog).toBeHidden();
});
