import { expect, test } from "@playwright/test";
import { devLogin } from "./auth";

// Cycle the toggle until the preference reaches the target, using the data-theme-pref attribute.
async function setTheme(
  page: import("@playwright/test").Page,
  target: "light" | "dark" | "system",
) {
  const toggle = page.getByRole("button", { name: /current theme/i });
  for (let i = 0; i < 3; i++) {
    const pref = await page.locator("html").getAttribute("data-theme-pref");
    if (pref === target) return;
    await toggle.click();
    // allow the optimistic DOM update + attribute change to settle
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme-pref",
      /light|dark|system/,
    );
  }
}

test("user can switch to dark and it persists across reload", async ({
  page,
}) => {
  // Force a deterministic starting OS scheme.
  await page.emulateMedia({ colorScheme: "light" });
  await devLogin(page, "j.carney@yale.edu");

  await setTheme(page, "dark");
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.locator("html")).toHaveAttribute("data-theme-pref", "dark");

  // The toggle fires the server action via startTransition (fire-and-forget).
  // Give the DB write a moment to land before reloading so the layout reads "dark".
  await page.waitForTimeout(1500);

  // Persisted to the DB -> survives a full reload with no flash to light.
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme-pref", "dark");
  await expect(page.locator("html")).toHaveClass(/dark/);
});

test("system preference follows the OS color scheme", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await devLogin(page, "j.carney@yale.edu");

  await setTheme(page, "system");
  await expect(page.locator("html")).toHaveAttribute("data-theme-pref", "system");
  // OS is dark -> system resolves to the dark class.
  await expect(page.locator("html")).toHaveClass(/dark/);

  // Flip OS to light -> the live listener removes the dark class.
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).not.toHaveClass(/dark/);
});

// Reset this user's stored preference back to system so the test is idempotent
// across runs (the toggle persists to the shared dev DB).
test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  await page.emulateMedia({ colorScheme: "light" });
  await devLogin(page, "j.carney@yale.edu");
  const toggle = page.getByRole("button", { name: /current theme/i });
  for (let i = 0; i < 3; i++) {
    const pref = await page.locator("html").getAttribute("data-theme-pref");
    if (pref === "system") break;
    await toggle.click();
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme-pref",
      /light|dark|system/,
    );
  }
  await page.close();
});
