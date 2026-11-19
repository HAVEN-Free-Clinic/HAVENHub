import { expect, test, type Page } from "@playwright/test";
import { selectDepartments } from "./recruitment-helpers";

test.setTimeout(120_000);

async function devLogin(page: Page, email: string) {
  await page.goto("/login");
  await page.fill('input[name="email"]', email);
  await page.click('button:has-text("Dev sign in")');
  await page.waitForURL((url) => url.pathname === "/");
}

// Staff format a question in the builder with the B / I / highlight buttons,
// and the question then shows real bold, italic and highlighted text (not the
// ** markers) in the builder's own preview of the form.
test("form builder: bold, italic and highlight buttons format a question", async ({ page }) => {
  await devLogin(page, "j.carney@yale.edu");

  await page.goto("/recruitment/cycles/new");
  await page.fill('input[name="title"]', "Formatting E2E");
  await page.fill('input[name="publicSlug"]', `formatting-e2e-${Date.now()}`);
  await selectDepartments(page, ["SRHD"]);
  await page.uncheck('input[name="seedDefaultForm"]');
  await page.click('button:has-text("Create")');
  await page.waitForURL((url) => url.pathname.includes("/builder"));

  const section = page
    .locator("section")
    .filter({ has: page.locator("h2").filter({ hasText: "Your information" }) })
    .first();
  await section.getByRole("button", { name: /Add field/ }).click();
  await page.getByRole("button", { name: "Paragraph", exact: true }).click();
  await expect(section.getByText("Paragraph", { exact: true })).toBeVisible();

  // Open the new question's editor and write a label.
  await section.getByRole("button", { name: "Edit field" }).last().click();
  // Field puts its hint outside the <label>, so the box's name is just "Label".
  const label = section.getByLabel("Label", { exact: true });
  await label.fill("Please upload a PDF before Friday");
  await label.press("Tab");
  await expect(section.getByText("Please upload a PDF before Friday")).toBeVisible();

  // Select "PDF" and press Bold, then select "Friday" and press Highlight.
  await label.evaluate((el: HTMLInputElement) => { el.focus(); const i = el.value.indexOf("PDF"); el.setSelectionRange(i, i + 3); });
  await section.getByRole("button", { name: "Bold" }).first().click();
  await expect(label).toHaveValue("Please upload a **PDF** before Friday");

  await label.evaluate((el: HTMLInputElement) => { el.focus(); const i = el.value.indexOf("Friday"); el.setSelectionRange(i, i + 6); });
  await section.getByRole("button", { name: "Highlight" }).first().click();
  await expect(label).toHaveValue("Please upload a **PDF** before ==Friday==");

  // The question's preview shows the formatting, and no markers.
  await expect(section.locator("strong", { hasText: "PDF" }).first()).toBeVisible();
  await expect(section.locator("mark", { hasText: "Friday" }).first()).toBeVisible();
  await expect(section.getByText("**PDF**")).toHaveCount(0);

  // Pressing Bold again on the same word takes it off.
  await label.evaluate((el: HTMLInputElement) => { el.focus(); const i = el.value.indexOf("PDF"); el.setSelectionRange(i, i + 3); });
  await section.getByRole("button", { name: "Bold" }).first().click();
  await expect(label).toHaveValue("Please upload a PDF before ==Friday==");

  // It was saved, not just typed: it survives a reload.
  await page.reload();
  await expect(section.locator("mark", { hasText: "Friday" }).first()).toBeVisible();
});
