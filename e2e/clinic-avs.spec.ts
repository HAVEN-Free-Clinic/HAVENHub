import { expect, test } from "@playwright/test";
import { loginAs } from "./auth";

/**
 * Journey: Clinic AVS (After Visit Summary) PDF generation.
 *
 * The tool lives at /clinic/avs and produces an ephemeral client-side PDF via
 * @react-pdf/renderer. No data is persisted (zero PHI), so no DB fixtures are
 * needed - the bare seed is sufficient.
 *
 * Required fields (from validate()):
 *   - Last name
 *   - Visit date
 *   - Reason for visit
 *
 * Language toggle: a native <select> labeled "Summary language" with options
 * "English" (en) and "Espanol" (es).
 *
 * Download mechanism: handleGenerate() creates a temporary <a> with a blob
 * URL and a.download set, then calls a.click(). Playwright captures this via
 * page.waitForEvent("download").
 */

const VISIT_DATE = "2026-01-15";

test("clinic AVS: fill form and download the summary (English)", async ({ page }) => {
  await loginAs(page, "admin");
  await page.goto("/clinic/avs");
  await page.waitForURL("/clinic/avs");

  // Fill required fields
  await page.getByLabel(/last name/i).fill("TestPatient");
  await page.getByLabel(/visit date/i).fill(VISIT_DATE);
  await page.getByLabel(/reason for visit/i).fill("Annual check-up");

  // Language select defaults to English - no change needed
  const langSelect = page.getByLabel(/summary language/i);
  await expect(langSelect).toHaveValue("en");

  // Generate PDF - expect a download event
  const downloadPromise = page.waitForEvent("download");
  // Click the bottom "Generate PDF" button (last one on page)
  await page.getByRole("button", { name: /generate pdf/i }).last().click();
  const download = await downloadPromise;

  // Assert the downloaded filename ends in .pdf
  expect(download.suggestedFilename()).toMatch(/\.pdf$/i);
  expect(download.suggestedFilename()).toContain("TestPatient");
});

test("clinic AVS: fill form and download the summary (Espanol)", async ({ page }) => {
  await loginAs(page, "admin");
  await page.goto("/clinic/avs");
  await page.waitForURL("/clinic/avs");

  // Fill required fields
  await page.getByLabel(/last name/i).fill("PacienteTest");
  await page.getByLabel(/visit date/i).fill(VISIT_DATE);
  await page.getByLabel(/reason for visit/i).fill("Control anual");

  // Switch to Spanish
  const langSelect = page.getByLabel(/summary language/i);
  await langSelect.selectOption("es");
  await expect(langSelect).toHaveValue("es");

  // Generate PDF - expect a download event
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: /generate pdf/i }).last().click();
  const download = await downloadPromise;

  // Assert the downloaded filename ends in .pdf
  expect(download.suggestedFilename()).toMatch(/\.pdf$/i);
  expect(download.suggestedFilename()).toContain("PacienteTest");
});
