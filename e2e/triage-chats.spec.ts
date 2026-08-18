import { expect, test } from "@playwright/test";
import { loginAs } from "./auth";

test.describe("triage chats tab", () => {
  test("is hidden from a schedule viewer without the permission", async ({ page }) => {
    await loginAs(page, "volunteer");
    await page.goto("/schedule");
    // Exact name match: "Triage chats" must not be satisfied by some other
    // control whose label merely contains the word.
    await expect(page.getByRole("link", { name: /^Triage chats$/ })).toHaveCount(0);

    await page.goto("/schedule/triage-chats");
    await expect(page).toHaveURL(/\/no-access/);
  });

  test("is reachable by a permission holder", async ({ page }) => {
    await loginAs(page, "admin");
    await page.goto("/schedule");
    await expect(page.getByRole("link", { name: /^Triage chats$/ })).toBeVisible();

    await page.goto("/schedule/triage-chats");
    await expect(page.getByRole("heading", { name: /^Triage chats$/ })).toBeVisible();
  });
});
